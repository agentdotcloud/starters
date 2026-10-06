// Running commands: docker, git, openssl. Arguments are passed as an array, never through a shell.
import { spawn } from 'node:child_process';

export interface Ran { code: number; stdout: string; stderr: string }

export function run(cmd: string, args: string[], opts: { input?: string; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const piped = opts.input !== undefined;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => { stdout += d; });
    child.stderr!.on('data', (d) => { stderr += d; });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    // A child can exit before it reads its input (EPIPE): its exit code and stderr already say why, so don't crash on it.
    if (piped) child.stdin!.on('error', () => {}).end(opts.input);
  });
}

// The same, but a non-zero exit is an error carrying the command's own last lines.
export async function must(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n')}`);
  return r.stdout;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Polls until `probe` returns a value (not undefined), or the time runs out.
export async function until<T>(ms: number, probe: () => Promise<T | undefined>, every = 250): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const got = await probe().catch(() => undefined);
    if (got !== undefined) return got;
  }
  return undefined;
}
