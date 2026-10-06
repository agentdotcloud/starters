// Checks from agentcloud.toml: smoke flows (HTTP steps against the running app) and invariants (SQL that must
// return no rows). The same engine runs on the copy (`agc check`) and in GCP during a release's rehearsal.
//
//   [[check.smoke]]
//   name  = "twenty parents race for the last spot"
//   steps = [
//     "POST /api/camps {name: 'Race {run}', capacity: 1, price_cents: 100} -> 201 as camp",
//     "POST /api/camps/{camp.id}/bookings {parent_email: 'p{i}@example.test'} -> 201|409 x20",
//   ]
//
//   [[check.invariant]]
//   name = "never overbooked"
//   sql  = "SELECT c.id FROM camps c JOIN bookings b ON b.camp_id = c.id GROUP BY c.id HAVING count(*) > c.capacity"

export interface SmokeFlow {
  name: string;
  steps: string[];
  headers?: Record<string, string>;
}

export interface Invariant {
  name: string;
  sql: string;
  after?: string; // runs only once this migration is applied
  until?: string; // retired once this migration is applied
  hold?: string; // 'empty' (default), 'unchanged', or 'equal:<check>'
}

export interface Checks {
  smoke: SmokeFlow[];
  invariant: Invariant[];
}

export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

export interface CheckResult {
  name: string;
  kind: 'smoke' | 'invariant';
  ok: boolean;
  detail: string;
  steps?: StepResult[];
}

export function readChecks(raw: Record<string, unknown>): Checks {
  const check = (raw.check && typeof raw.check === 'object' ? raw.check : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, unknown>[];
  return {
    smoke: list(check.smoke).map((s, i) => ({
      name: String(s.name ?? `smoke ${i + 1}`),
      steps: (Array.isArray(s.steps) ? s.steps : []).map(String),
      headers: s.headers && typeof s.headers === 'object' ? Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, String(v)])) : undefined,
    })),
    invariant: list(check.invariant).map((s, i) => ({
      name: String(s.name ?? `invariant ${i + 1}`), sql: String(s.sql ?? ''),
      ...(s.after ? { after: String(s.after) } : {}), ...(s.until ? { until: String(s.until) } : {}),
      ...(typeof s.hold === 'string' ? { hold: s.hold } : {}),
    })),
  };
}

const READS: Record<string, Set<string>> = {
  invariant: new Set(['name', 'sql', 'after', 'until', 'hold']),
  smoke: new Set(['name', 'steps', 'headers']),
};

// What agentcloud.toml asks for that agent.cloud won't do, so nothing is silently ignored, and what's missing for the
// invariants to mean anything.
export function lintChecks(raw: Record<string, unknown>, migrations: string[]): string[] {
  const check = (raw.check && typeof raw.check === 'object' ? raw.check : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v : []) as Record<string, unknown>[];
  const out: string[] = [];
  for (const kind of Object.keys(check)) {
    if (!READS[kind]) {
      out.push(`[[check.${kind}]] isn't a check agent.cloud runs (it runs invariant and smoke checks), so it was ignored.${kind === 'browser' ? ' For a feature tested end to end in a browser, see `agc help verify`.' : ''}`);
      continue;
    }
    for (const c of list(check[kind])) {
      const extra = Object.keys(c).filter((k) => !READS[kind].has(k));
      if (extra.length) out.push(`Check "${c.name}": ${extra.join(', ')} ${extra.length === 1 ? "isn't read, so it was" : "aren't read, so they were"} ignored.`);
      for (const k of ['after', 'until'] as const) {
        if (c[k] && !migrations.includes(String(c[k]))) out.push(`Check "${c.name}": ${k} = "${c[k]}" names no migration in this app.`);
      }
      const hold = c.hold === undefined ? 'empty' : String(c.hold);
      if (hold.startsWith('equal:')) {
        if (!list(check.invariant).some((o) => o.name === hold.slice('equal:'.length))) out.push(`Check "${c.name}": hold = "${hold}" names no invariant called "${hold.slice('equal:'.length)}".`);
      } else if (hold !== 'empty' && hold !== 'unchanged') out.push(`Check "${c.name}": hold = "${hold}" isn't supported; use "empty", "unchanged" or "equal:<check>".`);
    }
  }
  const checks = readChecks(raw);
  const races = checks.smoke.some((f) => f.steps.some((s) => {
    try { const p = parseStep(s); return p.times > 1 && p.method !== 'GET'; } catch { return false; }
  }));
  if (checks.invariant.length && !races) {
    out.push('No smoke flow tries to break your invariants under concurrency. Limits (capacity, uniqueness, balances) usually break only when requests race, so add a flow whose write step runs at once, e.g. "POST /api/camps/{camp.id}/bookings {…} -> 201|409 x20". Agents\' own tests don\'t count: agent.cloud runs only the checks in agentcloud.toml, on every release.');
  }
  return out;
}

// Whether an invariant runs against a database whose applied migrations are `applied`.
export function invariantSkip(inv: Invariant, applied: Set<string>): string | null {
  if (inv.until && applied.has(inv.until)) return `retired by ${inv.until}`;
  if (inv.after && !applied.has(inv.after)) return `waits for ${inv.after}`;
  return null;
}

interface Step {
  method: string;
  path: string;
  body?: string;
  statuses: number[];
  as?: string;
  times: number;
}

const STEP = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(?:\s+(.*?))?\s*->\s*(\d{3}(?:\|\d{3})*)(?:\s+as\s+([A-Za-z_]\w*))?(?:\s+x(\d+))?\s*$/;

// A step only ever talks to the app under test: a path, never a host.
export const safePath = (path: string) => path.startsWith('/') && !path.startsWith('//') && !/[@\\\s]/.test(path);

export function parseStep(line: string): Step {
  const m = STEP.exec(line.trim());
  if (!m) throw new Error(`can't read step "${line}": expected METHOD /path [body] -> STATUS[|STATUS] [as name] [xN]`);
  if (!safePath(m[2])) throw new Error(`step "${line}": the path must start with / and stay on the app`);
  return { method: m[1], path: m[2], body: m[3]?.trim() || undefined, statuses: m[4].split('|').map(Number), as: m[5], times: Math.min(Number(m[6] ?? 1), 100) };
}

// Bodies are written loosely, like JavaScript: unquoted keys and single-quoted strings become JSON.
export function looseJson(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1, s = '';
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\' && j + 1 < text.length) { s += text[j + 1]; j += 2; continue; }
        s += text[j++];
      }
      out += JSON.stringify(s);
      i = j + 1;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (ident) {
      const word = ident[0];
      const after = text.slice(i + word.length).trimStart();
      out += after.startsWith(':') && !['true', 'false', 'null'].includes(word) ? JSON.stringify(word) : word;
      i += word.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

type Vars = Record<string, unknown>;

function lookup(vars: Vars, expr: string): unknown {
  return expr.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), vars);
}

const fill = (text: string, vars: Vars) => text.replace(/\{([A-Za-z_][\w.]*)\}/g, (all, expr) => {
  const v = lookup(vars, expr);
  return v === undefined || v === null ? all : String(v);
});

// A string that is exactly "{expr}" keeps the value's type, so an id that's a number stays a number.
function fillValue(value: unknown, vars: Vars): unknown {
  if (typeof value === 'string') {
    const whole = /^\{([A-Za-z_][\w.]*)\}$/.exec(value);
    if (whole) {
      const v = lookup(vars, whole[1]);
      if (v !== undefined) return v;
    }
    return fill(value, vars);
  }
  if (Array.isArray(value)) return value.map((v) => fillValue(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillValue(v, vars)]));
  return value;
}

// MAIL <address> -> N [xM] [within Ss]: exactly N messages captured to the address (each of M, with {i}), and still N
// after a quiet moment, so a duplicate sent late by a retried job is caught too.
const MAIL = /^MAIL\s+(\S+)\s*->\s*(\d+)(?:\s+x(\d+))?(?:\s+within\s+(\d+)s)?\s*$/;
export const isMailStep = (line: string) => MAIL.test(line.trim());

export interface MailAccess {
  url: string; // AGC_EMAIL_URL
  token: string; // AGC_EMAIL_TOKEN
}

export interface SignInAccess {
  url: string; // AGC_AUTH_URL: test mode on mirrors and rehearsals
  token: string; // AGC_AUTH_TOKEN
}

const SIGN_IN = /^SIGN IN\s+(\S{1,200})\s*$/;
const keepCookies = (res: Response, cookies: Map<string, string>) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const at = pair!.indexOf('=');
    if (at > 0) cookies.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim());
  }
};
const jar = (cookies: Map<string, string>): Record<string, string> => (cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {});

// A sign-in, as a browser does it: the app's /auth/sign-in sets its state cookie and sends the browser to agent.cloud;
// test mode signs in as `who` at once; the app's callback finishes it. Returns the code and where it came back.
async function signInAs(base: string, who: string, auth: SignInAccess, cookies: Map<string, string>, fetchImpl: typeof fetch, state?: (s: string) => string) {
  const start = await fetchImpl(new URL('/auth/sign-in', base).toString(), { redirect: 'manual', headers: jar(cookies), signal: AbortSignal.timeout(15_000) });
  keepCookies(start, cookies);
  const to = start.headers.get('location') ?? '';
  if (!to.startsWith(`${auth.url}/authorize?`)) return { problem: `GET /auth/sign-in should redirect to $AGC_AUTH_URL/authorize?state=… (it answered ${start.status})` };
  const minted = await fetchImpl(`${to}&as=${encodeURIComponent(who)}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const back = minted.headers.get('location');
  if (!back) return { problem: `agent.cloud's test sign-in answered ${minted.status}` };
  const url = new URL(back);
  const code = url.searchParams.get('code') ?? '';
  if (state) url.searchParams.set('state', state(url.searchParams.get('state') ?? ''));
  const done = await fetchImpl(new URL(`${url.pathname}${url.search}`, base).toString(), { redirect: 'manual', headers: jar(cookies), signal: AbortSignal.timeout(15_000) });
  keepCookies(done, cookies);
  return { code, path: url.pathname, status: done.status };
}

// Whether the app checks `state` before trading a code: a real test code comes back with a different state. An app that
// trades it lets an attacker's code sign a victim in to the attacker's account. Null when the app doesn't use
// agent.cloud sign-in (no /auth/sign-in that leads to AGC_AUTH_URL).
export async function checkSignInState(base: string, auth: SignInAccess, fetchImpl: typeof fetch = fetch): Promise<CheckResult | null> {
  const name = 'sign-in checks state';
  try {
    const got = await signInAs(base, 'state-check@agent.cloud.test', auth, new Map(), fetchImpl, (s) => `not-${s}`);
    if ('problem' in got) return null;
    const res = await fetchImpl(`${auth.url}/codes/${encodeURIComponent(got.code)}`, { headers: { authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(15_000) });
    const traded = res.ok ? ((await res.json()) as { traded?: boolean }).traded : undefined;
    if (traded === undefined) return { name, kind: 'smoke', ok: false, detail: 'agent.cloud couldn’t tell whether the app traded the code' };
    return traded
      ? { name, kind: 'smoke', ok: false, detail: `${got.path} traded a sign-in code that came back with the wrong state. Compare state with the cookie /auth/sign-in set before calling /token: checking only after trading still uses up the code` }
      : { name, kind: 'smoke', ok: true, detail: 'refused a code that came back with the wrong state' };
  } catch {
    return null;
  }
}

// Messages to an address saved after `since` (the server's clock), so each run counts only its own mail.
export async function mailCounts(mail: MailAccess, to: string, since = ''): Promise<number> {
  return (await mailCall(mail, to, since)).messages;
}

async function mailCall(mail: MailAccess, to: string, since: string): Promise<{ messages: number; now: string }> {
  const res = await fetch(`${mail.url.replace(/\/messages$/, '/count')}?to=${encodeURIComponent(to)}&since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${mail.token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the outbox answered ${res.status}`);
  return (await res.json()) as { messages: number; now: string };
}

// The outbox's own clock, to count from.
export const mailNow = async (mail: MailAccess) => (await mailCall(mail, '', '')).now;

// Polls until every address has `want` messages (or, with no target, any number) and has held still for quietMs, any
// has more (it can only grow), or time's up.
export async function settleMail(mail: MailAccess, addresses: string[], want: number | null, withinMs: number, quietMs = 3000, since = ''): Promise<Map<string, number>> {
  const deadline = Date.now() + withinMs;
  let last = '';
  let still = Date.now();
  for (;;) {
    const counts = new Map(await Promise.all(addresses.map(async (a) => [a, await mailCounts(mail, a, since)] as const)));
    const key = JSON.stringify([...counts]);
    if (key !== last) { last = key; still = Date.now(); }
    const done = want === null || [...counts.values()].every((n) => n === want);
    if (want !== null && [...counts.values()].some((n) => n > want)) return counts;
    if (done && Date.now() - still >= quietMs) return counts;
    if (Date.now() > deadline) return counts;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// excerpts: false hides response bodies from the evidence, for rehearsals that run on production's real data.
// mail: the environment's outbox, for MAIL steps. onBody: every request body as sent, by flow, step and copy.
export async function runFlow(base: string, flow: SmokeFlow, fetchImpl: typeof fetch = fetch,
  opts: { excerpts?: boolean; mail?: MailAccess; mailSince?: string; auth?: SignInAccess; onBody?: (pos: string, body: unknown) => void } = {}): Promise<CheckResult> {
  const quiet = opts.excerpts === false;
  const excerpt = quiet ? () => '(hidden: this ran on a branch of production)' : (text: string) => text.replace(/\s+/g, ' ').slice(0, 160);
  const vars: Vars = { run: Math.random().toString(36).slice(2, 8) };
  const cookies = new Map<string, string>();
  const steps: StepResult[] = [];
  const fail = (detail: string): CheckResult => ({ name: flow.name, kind: 'smoke', ok: false, detail, steps });
  // MAIL steps count only what this run sent: from the given moment, or from the flow's start.
  // Without the outbox's clock a MAIL step can't count this run alone, so it fails rather than count everything.
  const mailSince = opts.mail && flow.steps.some((l) => MAIL.test(l.trim())) ? opts.mailSince ?? await mailNow(opts.mail).catch(() => null) : '';
  for (const line of flow.steps) {
    const signIn = SIGN_IN.exec(line.trim());
    if (signIn) {
      if (!opts.auth) {
        steps.push({ step: line, ok: false, detail: 'SIGN IN steps need agent.cloud sign-in: run the app with `agc up`' });
        return fail(`step ${steps.length}: no sign-in to use`);
      }
      const got = await signInAs(base, fill(signIn[1]!, vars), opts.auth, cookies, fetchImpl).catch(() => ({ problem: 'the sign-in request failed' }));
      // On a rehearsal the identity may come from a response: never echo it.
      const problem = 'problem' in got ? got.problem : got.status >= 400 ? `the app's ${got.path} answered ${quiet ? 'with an error' : got.status}` : '';
      steps.push({ step: line, ok: !problem, detail: problem || 'signed in' });
      if (problem) return fail(`step ${steps.length}: ${problem}`);
      continue;
    }
    const mailStep = MAIL.exec(line.trim());
    if (mailStep) {
      if (!opts.mail) {
        steps.push({ step: line, ok: false, detail: 'MAIL steps need platform email: run the app with `agc up`' });
        return fail(`step ${steps.length}: no outbox to check`);
      }
      const want = Number(mailStep[2]);
      const addresses = Array.from({ length: Math.min(Number(mailStep[3] ?? 1), 100) }, (_, i) => fill(mailStep[1], { ...vars, i }).toLowerCase());
      const counts = mailSince === null ? null : await settleMail(opts.mail, addresses, want, Math.min(Number(mailStep[4] ?? 30), 120) * 1000, 3000, mailSince).catch(() => null);
      const off = counts ? addresses.filter((a) => counts.get(a) !== want) : addresses;
      const detail = !counts ? 'the outbox couldn’t be read'
        : quiet ? (off.length ? "the mail didn't match" : 'matched')
        : off.length ? `expected ${want} to each; got ${off.slice(0, 3).map((a) => `${counts.get(a)} to ${a}`).join(', ')}` : `${want} to each of ${addresses.length}`;
      steps.push({ step: line, ok: !off.length, detail });
      if (off.length) return fail(`step ${steps.length}: ${detail}`);
      continue;
    }
    let step: Step;
    let template: unknown;
    try {
      step = parseStep(line);
      template = step.body ? JSON.parse(looseJson(step.body)) : undefined;
    } catch (e) {
      return fail((e as Error).message);
    }
    const once = async (i: number) => {
      const local = { ...vars, i };
      const headers: Record<string, string> = { accept: 'application/json' };
      for (const [k, v] of Object.entries(flow.headers ?? {})) headers[k] = fill(v, local);
      if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (template !== undefined) headers['content-type'] = 'application/json';
      const sent = template === undefined ? undefined : fillValue(template, local);
      opts.onBody?.(`${flow.name}#${steps.length}#${i}`, sent);
      const path = fill(step.path, local);
      const target = new URL(path, base);
      // Never echo the filled-in path: its values may come from responses (on a rehearsal, from production).
      if (!safePath(path) || target.origin !== new URL(base).origin) throw new Error('the path would leave the app');
      const res = await fetchImpl(target.toString(), {
        method: step.method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
        body: sent === undefined ? undefined : JSON.stringify(sent),
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const at = pair.indexOf('=');
        if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
      }
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, body, text };
    };
    try {
      if (step.times === 1) {
        const r = await once(0);
        if (!step.statuses.includes(r.status)) {
          // On a rehearsal the app answers with production's data in reach: report the outcome, never its status or body.
          const why = quiet ? "the response didn't match" : `expected ${step.statuses.join(' or ')}, got ${r.status}: ${excerpt(r.text)}`;
          steps.push({ step: line, ok: false, detail: why });
          return fail(`step ${steps.length}: ${quiet ? "the response didn't match" : `expected ${step.statuses.join(' or ')}, got ${r.status}`}`);
        }
        if (step.as) vars[step.as] = r.body;
        steps.push({ step: line, ok: true, detail: quiet ? 'matched' : String(r.status) });
      } else {
        const all = await Promise.all(Array.from({ length: step.times }, (_, i) => once(i)));
        const counts = new Map<number, number>();
        for (const r of all) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        const tally = [...counts].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${n}×${s}`).join(', ');
        const bad = all.find((r) => !step.statuses.includes(r.status));
        steps.push({ step: line, ok: !bad, detail: quiet ? (bad ? `${step.times} at once: some responses didn't match` : `${step.times} at once: all matched`) : `${step.times} at once: ${tally}${bad ? `; unexpected: ${excerpt(bad.text)}` : ''}` });
        if (bad) return fail(`step ${steps.length}: ${step.times} at once ${quiet ? "didn't all match" : `gave ${tally}`}`);
        if (step.as) vars[step.as] = all.map((r) => r.body);
      }
    } catch (e) {
      // On a rehearsal, an error's text may carry filled-in values; say only what kind of failure it was.
      const what = opts.excerpts === false && (e as Error).message !== 'the path would leave the app'
        ? `the request failed (${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name})` : (e as Error).message;
      steps.push({ step: line, ok: false, detail: what });
      return fail(`step ${steps.length}: ${what}`);
    }
  }
  return { name: flow.name, kind: 'smoke', ok: true, detail: `${steps.length} step${steps.length === 1 ? '' : 's'} passed`, steps };
}

// What an invariant reports when it finds rows: how many, and the first few with text blanked out, so evidence
// from a copy of production never carries anyone's personal details.
export function invariantResult(name: string, rows: Record<string, unknown>[]): CheckResult {
  if (rows.length === 0) return { name, kind: 'invariant', ok: true, detail: 'no violations' };
  const shown = rows.slice(0, 3).map((r) => Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : v === null ? 'null' : '‹text›'}`).join(' '));
  return { name, kind: 'invariant', ok: false, detail: `${rows.length} violating row${rows.length === 1 ? '' : 's'}: ${shown.join('; ')}${rows.length > 3 ? '; …' : ''}` };
}
