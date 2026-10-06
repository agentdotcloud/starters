import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';

export interface Config {
  token?: string;
  controlUrl: string;
}

// The login token lives outside the repo; AGC_TOKEN and AGC_CONTROL_URL override it for CI and tests.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = join(stateRoot(env), 'config.json');
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>) : {};
  return {
    token: env.AGC_TOKEN ?? saved.token,
    controlUrl: env.AGC_CONTROL_URL ?? saved.controlUrl ?? 'https://agent.cloud',
  };
}

// Saves the agent token for this machine (0600), keeping anything else already in the file.
export function saveConfig(change: Partial<Config>, env: NodeJS.ProcessEnv = process.env): void {
  const dir = stateRoot(env);
  const file = join(dir, 'config.json');
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...saved, ...change }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export interface Manifest {
  path: string;
  app: { name?: string };
  raw: Record<string, unknown>;
}

// agentcloud.toml is found by walking up from the working directory, like git does.
export function findManifest(start = process.cwd()): { path: string } | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, 'agentcloud.toml');
    if (existsSync(candidate)) return { path: candidate };
    if (dirname(dir) === dir) return null;
  }
}

export function readManifest(path: string): Manifest {
  const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return { path, app: (raw.app as { name?: string }) ?? {}, raw };
}

// Typed view of the fields M1 uses, with the spec's defaults.
export interface AppConfig {
  name: string;
  root: string;
  web: { port: number; command?: string; dev?: string; health?: string };
  worker?: { command: string; dev?: string; instances: number }; // background work: the same image, another command
  db: { env: string; migrations: string; mask: string[] };
  expireIdleDays: number;
}

export function appConfig(m: Manifest): AppConfig {
  const t = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  const web = t(t(m.raw.service).web);
  const worker = t(t(m.raw.service).worker);
  const db = t(t(m.raw.data).db);
  const idle = /^(\d+)d$/.exec(String(t(m.raw.mirror).expire_idle ?? '3d'));
  return {
    name: String(m.app.name ?? ''),
    root: dirname(m.path),
    web: { port: Number(web.port ?? 8080), command: web.command as string | undefined, dev: web.dev as string | undefined, health: web.health as string | undefined },
    ...(typeof worker.command === 'string' && worker.command.trim()
      ? { worker: { command: worker.command.trim(), dev: typeof worker.dev === 'string' ? worker.dev : undefined, instances: Math.min(Math.max(Number(worker.instances ?? 1) || 1, 1), 4) } } : {}),
    db: { env: String(db.env ?? 'DATABASE_URL'), migrations: String(db.migrations ?? 'migrations/'), mask: (db.mask as string[]) ?? [] },
    expireIdleDays: idle ? Number(idle[1]) : 3,
  };
}

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGC_HOME ?? join(homedir(), '.agentcloud');
}
