// Each app's code on GitHub: a private repo in agent.cloud's org with one commit per release that went live, so the repo
// is production's history. The owner can join it as a maintainer, or transfer it to their own account: once GitHub moves
// it, agent.cloud stops pushing. One-way: agc ship stays the way in, and pushes to the repo don't deploy. A sync problem
// never touches a release: it's recorded on the repo's row, backed off, and retried on the next release or sweep.
//
// A commit can't be pulled back once it's shared, so what goes in is filtered twice: by file name (secrets files, keys,
// local databases) and by content (high-confidence secret shapes). A file left out is named in an event, never its value.
import { createHash, createSign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { AppRow, Store } from './store.ts';

export interface GitHubConfig {
  org: string; // where every app's repo is made, e.g. agentcloud-apps
  appId: string;
  installationId: string;
  privateKey: string; // the GitHub App's PEM
  api?: string; // tests point this at a fake
}

export interface RepoRow {
  app_id: string; repo: string; synced_version: number; head_sha: string | null; error: string | null;
  transferred_to: string | null; moved_at: string | null; transfer_requested_at: string | null;
  failures: number; failed_version: number | null; next_try_at: string | null; created_at: string; updated_at: string;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/; // GitHub's own rule for users and orgs
const MAX_FILE = 50 * 1024 * 1024; // GitHub refuses 100 MB; past 50 it warns
const TRANSFER_EXPIRES_MS = 25 * 3_600_000; // GitHub: "If the new owner doesn't accept the transfer within one day, the invitation will expire."

// Names that never go into history: secrets and credentials files, keys, local databases and dumps. Committed env
// templates (.env.example, .env.sample, .env.template) go in, still through the content scan like every file.
const NEVER = /(^|\/)(\.env(?!\.(example|sample|template)$)(\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|jks|keystore|db|sqlite|sqlite3|db-journal|db-wal|db-shm|dump)|[^/]*(service[-_]?account|credentials)[^/]*\.json)$|(^|\/)\.(aws|ssh|gnupg|docker)\//i;

// A path git, GitHub or a customer's checkout would refuse; one such file would block every later release.
export function badPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.length > 1024 || /[\\\u0000-\u001f]/.test(path)) return true;
  return path.split('/').some((seg) => ['', '.', '..', '.git', '.git.', 'git~1'].includes(seg.toLowerCase()) || /^\._/.test(seg));
}

// Content that is almost certainly a secret. Each pattern is linear: no two adjacent quantifiers can share characters.
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})/, 'a GitHub token'],
  [/\b(?:sk-(?:live|proj|ant)-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,})/, 'an API secret key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bagc[ea]_[A-Za-z0-9_-]{16,}/, 'an agent.cloud token'],
];
const LOCAL_DB = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|postgres|db|database)(:|\/|$)/i;
export function secretIn(data: Buffer): string | null {
  const text = data.toString('latin1');
  for (const [re, what] of SECRETS) if (re.test(text)) return what;
  // A database URL with a password, unless it points at a local or docker-compose database (that's dev config).
  for (const m of text.matchAll(/\bpostgres(?:ql)?:\/\/[^:\s/@'"]{1,100}:[^@\s'"]{1,200}@([^\s'"`/?]{1,255})/g)) if (!LOCAL_DB.test(m[1]!)) return 'a database URL with a password';
  return null;
}

type File = { path: string; mode: '100644' | '100755'; data: Buffer };

// The release's files from the snapshot agc uploaded, with git's modes. Unpacking is capped: the tarball is the agent's.
export function snapshotFiles(tgz: Uint8Array, limit = 200 * 1024 * 1024): File[] {
  const tar = gunzipSync(tgz, { maxOutputLength: limit });
  const out: File[] = [];
  let longName = '';
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a: number, b: number) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = h[124]! & 0x80 ? Number(h.readBigUInt64BE(128)) : parseInt(field(124, 136).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0[\s\S]*$/, '');
    else if (type === 'x') longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? '';
    else if (type !== 'g') {
      const path = (longName || ((field(345, 500) ? `${field(345, 500)}/` : '') + field(0, 100))).replace(/^\.\//, '');
      longName = '';
      if (type === '0' || type === '7') out.push({ path, mode: parseInt(field(100, 108).trim() || '0', 8) & 0o111 ? '100755' : '100644', data: Buffer.from(body) });
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// What of a release may go to GitHub, and why each other file stays behind (never its content).
export function shareable(files: File[]): { keep: File[]; left: { path: string; why: string }[] } {
  const keep: File[] = [];
  const left: { path: string; why: string }[] = [];
  for (const f of files) {
    if (badPath(f.path)) left.push({ path: f.path.slice(0, 200), why: 'a path GitHub would refuse' });
    else if (NEVER.test(f.path)) left.push({ path: f.path, why: 'a secrets or local data file' });
    else if (f.data.length > MAX_FILE) left.push({ path: f.path, why: 'over 50 MB' });
    else {
      const secret = secretIn(f.data);
      if (secret) left.push({ path: f.path, why: `it looks like it holds ${secret}` });
      else keep.push(f);
    }
  }
  return { keep, left };
}

// A release's commit title: the ship message's first line, without a "vN:" the agent already put in front of it.
export function commitTitle(message: string | undefined, version: number): string {
  const line = String(message ?? '').split('\n')[0]!.trim().replace(new RegExp(`^v${version}(?!\\.?\\d)[\\s:.\\-]*`, 'i'), '').trim();
  return line || (version === 1 ? 'First release' : `Release v${version}`);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const gitSha = (data: Buffer) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

export function appRepos(store: Store, cfg: GitHubConfig, publicUrl: string) {
  const api = cfg.api ?? 'https://api.github.com';
  let token: { value: string; until: number } | null = null;
  const running = new Map<string, Promise<void>>(); // one sync per app at a time

  // A GitHub App acts through installation tokens: an hour each, minted with a ten-minute JWT signed by the app's key.
  async function auth(): Promise<string> {
    if (token && token.until > Date.now() + 300_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId }))}`;
    const jwt = `${unsigned}.${b64url(createSign('RSA-SHA256').update(unsigned).sign(cfg.privateKey))}`;
    const got = await call<{ token: string; expires_at: string }>('POST', `/app/installations/${cfg.installationId}/access_tokens`, undefined, jwt);
    token = { value: got.token, until: Date.parse(got.expires_at) };
    return got.token;
  }

  async function call<T>(method: string, path: string, body?: unknown, bearer?: string): Promise<T> {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer ?? await auth()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent.cloud', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path.split('?')[0]}: ${res.status} ${(() => { try { return (JSON.parse(text) as { message?: string }).message ?? ''; } catch { return ''; } })()}`.trim());
    return (text ? JSON.parse(text) : {}) as T;
  }

  const row = (appId: string) => store.one<RepoRow>('SELECT * FROM app_repos WHERE app_id = $1', [appId]);
  const event = (app: string, op: string | null, kind: string, text: string) => store.event(app, op, 'agent.cloud', kind, text).catch(() => {});
  const readme = (name: string, host: string) => `# ${name}\n\nThis repository mirrors ${name}'s production releases on agent.cloud, one commit per release that went live.\nThe app runs at https://${host}. Its releases and approvals are at ${publicUrl}/console/apps/${name}.\n\nShip changes with \`agc ship\`. Changes pushed straight to this repository don't deploy, and the next release replaces them.\n`;

  // Made with a README so the Git Data API has a branch to build on (it refuses an empty repository). The description
  // carries the app's id: a repo already called <org>/<name> is used only if it is this app's, never a former app's.
  async function ensure(app: AppRow): Promise<RepoRow> {
    const have = await row(app.id);
    if (have) return have;
    const full = `${cfg.org}/${app.name}`;
    try {
      await call('POST', `/orgs/${cfg.org}/repos`, {
        name: app.name, private: true, auto_init: true, has_issues: false, has_wiki: false, has_projects: false,
        description: `${app.name} on agent.cloud (${app.id}): production's releases, one commit each. Ship with agc; pushes here don't deploy.`,
        homepage: `https://${app.host}`,
      });
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
      const existing = await call<{ description?: string | null }>('GET', `/repos/${full}`);
      if (!String(existing.description ?? '').includes(`(${app.id})`)) throw new GitHubError(409, `github.com/${full} exists and isn't this app's repo`);
    }
    await store.q('INSERT INTO app_repos (app_id, repo) VALUES ($1, $2) ON CONFLICT (app_id) DO NOTHING', [app.id, full]);
    await event(app.name, null, 'repo.created', `Made github.com/${full} for the app's code`);
    return (await row(app.id))!;
  }

  async function pushRelease(full: string, app: AppRow, r: { version: number; op: string; live_at: string }, parent: string): Promise<string | null> {
    const op = await store.op(r.op);
    const tgz = op?.snapshot ? await store.snapshot(op.snapshot) : undefined;
    if (!op || !tgz) return null; // nothing to push for this version
    let files: File[];
    try {
      files = snapshotFiles(tgz);
    } catch (e) {
      // An unreadable snapshot can't hold the history up: this version is skipped, the next ones still land.
      await event(app.name, op.id, 'repo.skipped', `v${r.version} isn't in the repo: its snapshot couldn't be read (${(e as Error).message})`);
      return null;
    }
    const { keep, left } = shareable(files);
    for (const l of left) await event(app.name, op.id, 'repo.file_skipped', `v${r.version}: left ${l.path} out of the repo: ${l.why}`);
    if (!keep.some((f) => /^readme(\.md)?$/i.test(f.path))) keep.push({ path: 'README.md', mode: '100644', data: Buffer.from(readme(app.name, app.host)) });

    // Only blobs the repo doesn't have yet are uploaded: git's own blob id, computed here, against the parent's tree.
    const parentTree = (await call<{ tree: { sha: string } }>('GET', `/repos/${full}/git/commits/${parent}`)).tree.sha;
    const have = await call<{ tree: { sha: string; type: string }[]; truncated?: boolean }>('GET', `/repos/${full}/git/trees/${parentTree}?recursive=1`);
    const known = new Set(have.truncated ? [] : have.tree.filter((e) => e.type === 'blob').map((e) => e.sha));
    const tree = keep.map((f) => ({ path: f.path, mode: f.mode, type: 'blob' as const, sha: gitSha(f.data), data: f.data }));
    const missing = [...new Map(tree.filter((t) => !known.has(t.sha)).map((t) => [t.sha, t])).values()];
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(missing.slice(i, i + 8).map(async (t) => {
        const got = await call<{ sha: string }>('POST', `/repos/${full}/git/blobs`, { content: t.data.toString('base64'), encoding: 'base64' });
        if (got.sha !== t.sha) throw new GitHubError(500, `GitHub stored ${t.path} as a different blob`);
      }));
    }
    const { sha: treeSha } = await call<{ sha: string }>('POST', `/repos/${full}/git/trees`, { tree: tree.map(({ data: _d, ...e }) => e) });

    const decision = op.plan.decision as { human?: boolean; reason?: string } | undefined;
    const approval = await store.one<{ decided_by: string }>("SELECT decided_by FROM approvals WHERE op = $1 AND state = 'approved' ORDER BY decided_at DESC LIMIT 1", [op.id]);
    // The approver by name; an email goes into history only when it's the owner's own (their repo, their address).
    const approver = approval && (await store.one<{ name: string }>('SELECT name FROM sessions WHERE person = $1 ORDER BY created_at DESC LIMIT 1', [approval.decided_by]))?.name;
    const agent = await store.one<{ label: string }>('SELECT label FROM agents WHERE id = $1', [op.created_by]);
    const title = commitTitle(op.plan.message, r.version);
    const owner = approval?.decided_by === app.owner;
    const approved = !approval ? `Went-live: on its own${decision?.reason ? ` (${decision.reason})` : ''}`
      : approver ? `Approved-by: ${approver}${owner ? ` <${approval.decided_by}>` : ''}` : `Approved-by: ${owner ? approval.decided_by : 'a person'}`;
    const message = `v${r.version} ${title}\n\nRelease: v${r.version}\n${approved}\nShipped-by: ${agent?.label ?? 'an agent'}\nRelease-page: ${publicUrl}/console/apps/${app.name}/releases/${op.id}\n`;
    const who = { name: `${agent?.label ?? 'agent'} via agent.cloud`, email: 'releases@agent.cloud', date: new Date(r.live_at).toISOString() };
    const commit = await call<{ sha: string }>('POST', `/repos/${full}/git/commits`, { message, tree: treeSha, parents: [parent], author: who, committer: who });
    await call('PATCH', `/repos/${full}/git/refs/heads/main`, { sha: commit.sha, force: false });
    return commit.sha;
  }

  // Pushes every live release the repo doesn't have yet, oldest first, recording progress after each one.
  async function syncNow(name: string, fromSweep: boolean): Promise<void> {
    const app = await store.app(name);
    if (!app) return;
    const releases = (await store.releases(name, 1000)).sort((a, b) => a.version - b.version);
    if (!releases.length) return;
    let repo = await ensure(app);
    if (repo.moved_at) return;
    if (fromSweep && repo.next_try_at && Date.parse(repo.next_try_at) > Date.now()) return;
    if (repo.transferred_to) {
      // A transfer waits for the new owner to accept it; until GitHub moves the repo, releases keep landing in it.
      const there = await call('GET', `/repos/${repo.repo}`).then(() => true, (e) => (e instanceof GitHubError && e.status === 404 ? false : Promise.reject(e)));
      if (!there) {
        await store.q('UPDATE app_repos SET moved_at = now(), updated_at = now() WHERE app_id = $1', [app.id]);
        return;
      }
      if (repo.transfer_requested_at && Date.now() - Date.parse(repo.transfer_requested_at) > TRANSFER_EXPIRES_MS) {
        await store.q('UPDATE app_repos SET transferred_to = NULL, transfer_requested_at = NULL, updated_at = now() WHERE app_id = $1', [app.id]);
        await event(app.name, null, 'repo.transfer_expired', `The transfer to ${repo.transferred_to} wasn't accepted within a day; the repo stays with agent.cloud and can be transferred again`);
      }
    }
    const pending = releases.filter((r) => r.version > repo.synced_version);
    if (!pending.length) return;
    let current: number | null = null;
    try {
      let head = (await call<{ object: { sha: string } }>('GET', `/repos/${repo.repo}/git/ref/heads/main`)).object.sha;
      for (const r of pending) {
        current = r.version;
        const sha = await pushRelease(repo.repo, app, r, head);
        if (sha) head = sha;
        await store.q('UPDATE app_repos SET synced_version = $2, head_sha = $3, error = NULL, failures = 0, failed_version = NULL, next_try_at = NULL, updated_at = now() WHERE app_id = $1', [app.id, r.version, head]);
        repo = { ...repo, synced_version: r.version, failures: 0, failed_version: null };
      }
    } catch (e) {
      // Back off (10, 20, 40… minutes, at most 6 h). Five failures on one version skip it, so later ones still land.
      const message = (e as Error).message.slice(0, 300);
      const failures = current !== null && repo.failed_version === current ? repo.failures + 1 : 1;
      if (current !== null && failures >= 5) {
        await store.q('UPDATE app_repos SET synced_version = $2, error = $3, failures = 0, failed_version = NULL, next_try_at = NULL, updated_at = now() WHERE app_id = $1', [app.id, current, message]);
        await event(app.name, null, 'repo.skipped', `v${current} isn't in the repo: GitHub refused it five times (${message})`);
      } else {
        await store.q('UPDATE app_repos SET error = $2, failures = $3, failed_version = $4, next_try_at = now() + make_interval(mins => $5), updated_at = now() WHERE app_id = $1',
          [app.id, message, failures, current, Math.min(10 * 2 ** (failures - 1), 360)]);
      }
      throw e;
    }
  }

  return {
    org: cfg.org,
    row,
    // After a release (fromSweep false) a sync always tries; the sweep respects the back-off.
    sync(name: string, fromSweep = false): Promise<void> {
      const prev = running.get(name) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(() => syncNow(name, fromSweep));
      running.set(name, next);
      return next.finally(() => { if (running.get(name) === next) running.delete(name); });
    },
    // Every app with a live release the repo hasn't caught up with, no repo yet, or a transfer pending: at start, then
    // every ten minutes, one app after another.
    async sweep(): Promise<void> {
      const due = await store.q<{ name: string }>(`SELECT a.name FROM apps a JOIN (SELECT app, max(version) AS v FROM releases GROUP BY app) r ON r.app = a.name
        LEFT JOIN app_repos g ON g.app_id = a.id
        WHERE g.app_id IS NULL OR (g.moved_at IS NULL AND (g.next_try_at IS NULL OR g.next_try_at <= now()) AND (g.synced_version < r.v OR g.transferred_to IS NOT NULL))`);
      for (const { name } of due) await this.sync(name, true).catch(() => {});
    },
    async invite(app: AppRow, username: string): Promise<void> {
      if (!USERNAME.test(username)) throw new GitHubError(422, 'not a GitHub username');
      const repo = await ensure(app);
      if (repo.transferred_to || repo.moved_at) throw new GitHubError(409, 'transferred');
      // Maintain, not admin: while the repo is in agent.cloud's org, nobody can make it public or delete it. Transfer is for that.
      await call('PUT', `/repos/${repo.repo}/collaborators/${username}`, { permission: 'maintain' });
    },
    async transfer(app: AppRow, newOwner: string): Promise<void> {
      if (!USERNAME.test(newOwner)) throw new GitHubError(422, 'not a GitHub account');
      const repo = await ensure(app);
      if (repo.transferred_to || repo.moved_at) throw new GitHubError(409, 'transferred');
      await call('POST', `/repos/${repo.repo}/transfer`, { new_owner: newOwner });
      await store.q('UPDATE app_repos SET transferred_to = $2, transfer_requested_at = now(), updated_at = now() WHERE app_id = $1', [app.id, newOwner]);
    },
  };
}
export type AppRepos = ReturnType<typeof appRepos>;
