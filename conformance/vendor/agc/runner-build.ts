// Builds a release image: snapshot → Cloud Storage → Cloud Build (as the builder service account) → Artifact Registry.
// GCP credentials are the node's own, from the metadata server; they never leave GCP.
import { gunzipSync, gzipSync } from 'node:zlib';

// Files arrive with the modes they had on the agent's machine, and some agents' sandboxes make them owner-only (0600,
// 0660): the user the image runs as (node) then can't read the app's own package.json, and it crashes before starting.
// Every file becomes 0644 (0755 if anyone could run it) and every directory 0755, whatever tar wrote.
// The tarball is the agent's, so it's unpacked with a ceiling: a gzip bomb fails its own build, not the runner.
export function portableModes(tgz: Uint8Array, limit = 500 * 1024 * 1024): Uint8Array {
  let tar: Buffer;
  try {
    tar = Buffer.from(gunzipSync(tgz, { maxOutputLength: limit }));
  } catch (e) {
    throw new Error((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? `the source unpacks to more than ${Math.round(limit / 1024 / 1024)} MB` : "the source isn't a readable .tar.gz");
  }
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a: number, b: number) => h.subarray(a, b).toString('ascii').replace(/\0[\s\S]*$/, '').trim();
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!); // NUL is an old-style regular file
    const size = h[124]! & 0x80 ? Number(h.readBigUInt64BE(128)) : parseInt(field(124, 136) || '0', 8);
    if (type === '0' || type === '7' || type === '5') {
      const mode = type === '5' || parseInt(field(100, 108) || '0', 8) & 0o111 ? 0o755 : 0o644;
      h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
      h.fill(0x20, 148, 156); // the checksum counts its own field as spaces
      let sum = 0;
      for (const b of h) sum += b;
      h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return gzipSync(tar);
}

export interface BuildConfig {
  project: string;
  region: string;
  repository: string;
  builder: string; // builder service account email
  bucket: string; // sources and logs
}

let cached: { token: string; until: number } | undefined;

export async function gcpToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch('http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
  const t = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: t.access_token, until: Date.now() + t.expires_in * 1000 };
  return t.access_token;
}

// A short-lived token for a read-only identity, for pull secrets in tenant namespaces: never the node's own token.
let pulled: { token: string; until: number } | undefined;
export async function pullToken(puller: string): Promise<string> {
  if (pulled && pulled.until > Date.now() + 5 * 60_000) return pulled.token;
  const t = await gcp<{ accessToken: string; expireTime: string }>('POST', `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${puller}:generateAccessToken`, {
    scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '3600s',
  });
  pulled = { token: t.accessToken, until: new Date(t.expireTime).getTime() };
  return t.accessToken;
}

async function gcp<T>(method: string, url: string, body?: unknown, raw?: Uint8Array, type = 'application/json'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await gcpToken()}`, 'content-type': raw ? 'application/gzip' : type },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return (text.startsWith('{') ? JSON.parse(text) : text) as T;
}

// The image apps get when they bring no Dockerfile: Node 24, all dependencies for the build, then `npm run build`
// if there is one, then only production dependencies; `npm start` or the manifest's command.
// Resolved inside the image build, from the app's own package.json. When `scripts.start` is plain env assignments
// then `node …` (Campfire's `NODE_ENV=production node dist/server.js`) and there is no prestart/poststart, the image
// starts a tiny launcher instead of npm: it stays PID 1 (where an app without its own SIGTERM handler would ignore
// SIGTERM and wait out the grace period), runs the start command through sh like npm does, forwards TERM/INT/HUP, exits
// with the app's code, and sets npm_package_name/version as npm would. No "npm error signal SIGTERM" on every
// retirement. Anything else keeps `npm start`. No single quotes inside: the generator is passed in '…'.
export const START_SCRIPT_JS = [
  "const fs = require(\"fs\");",
  "let p = {};",
  "try { p = JSON.parse(fs.readFileSync(\"package.json\", \"utf8\")); } catch {}",
  "const sc = p.scripts || {};",
  "const s = String(sc.start || \"\").trim();",
  "const m = !sc.prestart && !sc.poststart && /^((?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|`$()<>]+\\s+)*)node\\s+([^;&|`$()<>\\n]+)$/.exec(s);",
  "const env = { npm_package_name: String(p.name || \"\"), npm_package_version: String(p.version || \"\") };",
  "const launcher = [",
  "  \"#!/usr/bin/env node\",",
  "  \"const { spawn } = require(\\\"child_process\\\");\",",
  "  \"const c = spawn(\\\"sh\\\", [\\\"-c\\\", \" + JSON.stringify(m ? m[1] + \"exec node \" + m[2] : \"\") + \"], { stdio: \\\"inherit\\\", env: Object.assign({}, process.env, \" + JSON.stringify(env) + \") });\",",
  "  \"for (const s of [\\\"SIGTERM\\\", \\\"SIGINT\\\", \\\"SIGHUP\\\"]) process.on(s, () => c.kill(s));\",",
  "  \"c.on(\\\"exit\\\", (code, sig) => process.exit(code === null ? 128 + (require(\\\"os\\\").constants.signals[sig] || 0) : code));\",",
  "  \"\"",
  "].join(\"\\n\");",
  "process.stdout.write(m ? launcher : \"#!/bin/sh\\nexec npm start\\n\");",
].join(" ");

// A shell command run as a container's PID 1. sh as PID 1 ignores SIGTERM and never passes it on, so the app would be
// SIGKILLed at the end of the grace period, mid-job. Measured on the cluster: 31 s instead of 1 s, and a worker's
// SIGTERM handler never ran. Here sh stays PID 1 but forwards TERM/INT to the command (dash runs a subshell's last
// command with exec, so `a && node worker.js` delivers to node), then exits with the command's status.
export function forwarding(command: string): string[] {
  // The command sits on its own lines, so a trailing `# comment` in it can't swallow the rest of the wrapper.
  return ['sh', '-c', `(\n${command}\n) & c=$!; trap 'kill -TERM $c 2>/dev/null' TERM INT; wait $c; trap - TERM INT; wait $c`];
}

export function defaultDockerfile(command: string | null): string {
  const cmd = command ? JSON.stringify(forwarding(command)) : '["/usr/local/bin/agc-start"]';
  return [
    'FROM node:24-slim',
    'WORKDIR /app',
    'ENV NPM_CONFIG_UPDATE_NOTIFIER=false',
    'COPY package*.json ./',
    'RUN if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi',
    'COPY . .',
    'RUN npm run build --if-present && npm prune --omit=dev',
    ...(command ? [] : [`RUN node -e '${START_SCRIPT_JS}' > /usr/local/bin/agc-start && chmod 755 /usr/local/bin/agc-start`]),
    'ENV NODE_ENV=production',
    'USER node',
    `CMD ${cmd}`,
    '',
  ].join('\n');
}

const FAILED = new Set(['FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED', 'EXPIRED']);

export async function build(cfg: BuildConfig, app: string, op: string, tarball: Uint8Array, command: string | null): Promise<{ image: string; build: string }> {
  const object = `agc-sources/${app}/${op}.tgz`;
  await gcp('POST', `https://storage.googleapis.com/upload/storage/v1/b/${cfg.bucket}/o?uploadType=media&name=${encodeURIComponent(object)}`, undefined, portableModes(tarball));
  const repo = `${cfg.region}-docker.pkg.dev/${cfg.project}/${cfg.repository}/app-${app}`;
  const dockerfile = Buffer.from(defaultDockerfile(command)).toString('base64');
  const api = `https://cloudbuild.googleapis.com/v1/projects/${cfg.project}/locations/${cfg.region}/builds`;
  const created = await gcp<{ metadata: { build: { id: string } } }>('POST', api, {
    source: { storageSource: { bucket: cfg.bucket, object } },
    steps: [
      // base64 has no "$", so Cloud Build's substitution leaves it alone
      { name: 'ubuntu', entrypoint: 'bash', args: ['-c', `test -f Dockerfile || echo ${dockerfile} | base64 -d > Dockerfile`] },
      { name: 'gcr.io/cloud-builders/docker', args: ['build', '-t', `${repo}:${op}`, '.'] },
    ],
    images: [`${repo}:${op}`],
    serviceAccount: `projects/${cfg.project}/serviceAccounts/${cfg.builder}`,
    logsBucket: `gs://${cfg.bucket}/agc-logs`,
    options: { logging: 'GCS_ONLY', machineType: 'E2_HIGHCPU_8' },
    timeout: '900s',
  });
  const id = created.metadata.build.id;
  for (const started = Date.now(); ; ) {
    await new Promise((r) => setTimeout(r, 3000));
    const b = await gcp<{ status: string; statusDetail?: string; results?: { images?: { name: string; digest: string }[] } }>('GET', `${api}/${id}`);
    if (b.status === 'SUCCESS') {
      const digest = b.results?.images?.[0]?.digest;
      if (!digest) throw new Error(`build ${id} succeeded without an image digest`);
      return { image: `${repo}@${digest}`, build: id };
    }
    if (FAILED.has(b.status) || Date.now() - started > 16 * 60_000) {
      const log = await gcp<string>('GET', `https://storage.googleapis.com/storage/v1/b/${cfg.bucket}/o/${encodeURIComponent(`agc-logs/log-${id}.txt`)}?alt=media`).catch(() => '');
      throw Object.assign(new Error(`${b.status.toLowerCase()}${b.statusDetail ? `: ${b.statusDetail}` : ''}`), { log: String(log).slice(-6000) });
    }
  }
}
