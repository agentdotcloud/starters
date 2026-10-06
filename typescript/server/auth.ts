// Sign-in through agent.cloud: Google or an email link, no passwords (docs: Sign-in in AGENTS.md).
//   GET  /auth/sign-in    a fresh state in a short cookie, then off to $AGC_AUTH_URL/authorize
//   GET  /auth/callback   check state FIRST, then trade the code (once, within a minute) for the person
//   POST /auth/sign-out   end this session
// Sessions are rows in the database (only a hash of the token is stored) and last a day.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { pool } from './db.ts';
import { onMirror, required } from './env.ts';
import { log } from './log.ts';

const { AGC_AUTH_URL, AGC_AUTH_TOKEN } = required('AGC_AUTH_URL', 'AGC_AUTH_TOKEN');
// __Host- cookies outside a mirror: apps share the agent.cloud site, and only this app's own host can set one, so a
// neighbour app can't plant a session or a sign-in state here. On a mirror (plain http) the prefix isn't allowed.
const STATE = onMirror ? 'auth_state' : '__Host-auth_state';
const SESSION = onMirror ? 'session' : '__Host-session';
const DAY = 86_400;

export interface User { id: string; email: string | null; name: string | null }
export type Env = { Variables: { user: User | null } };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
// Byte lengths, not string lengths: timingSafeEqual throws on unequal buffers, and 'é' is one character but two bytes.
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const cookie = { httpOnly: true, sameSite: 'Lax', secure: !onMirror, path: '/' } as const;

// Who's signed in, for every request: their session cookie, if it's live.
export const session: MiddlewareHandler<Env> = async (c, next) => {
  const token = getCookie(c, SESSION);
  c.set('user', null);
  if (token) {
    const { rows } = await pool.query<User>(
      'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [hash(token)]);
    c.set('user', rows[0] ?? null);
  }
  await next();
};

export function signIn(app: Hono<Env>) {
  app.get('/auth/sign-in', (c) => {
    const state = randomBytes(24).toString('base64url');
    setCookie(c, STATE, state, { ...cookie, maxAge: 600 });
    return c.redirect(`${AGC_AUTH_URL}/authorize?state=${state}`);
  });

  app.get('/auth/callback', async (c) => {
    // State first: it's what stops someone else's code from signing this person in to the wrong account.
    const expected = getCookie(c, STATE) ?? '';
    const state = c.req.query('state') ?? '';
    deleteCookie(c, STATE, { path: '/', secure: !onMirror });
    if (!expected || !same(state, expected)) return c.text('Sign-in expired. Try again.', 400);
    const res = await fetch(`${AGC_AUTH_URL}/token`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${AGC_AUTH_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: c.req.query('code') ?? '' }),
    });
    if (!res.ok) {
      log.warn('sign-in code refused', { status: res.status });
      return c.text('Sign-in failed. Try again.', 400);
    }
    const { user } = (await res.json()) as { user: User };
    await pool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET email = coalesce(EXCLUDED.email, users.email), name = coalesce(EXCLUDED.name, users.name), last_seen_at = now()`,
      [user.id, user.email, user.name]);
    const token = randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [hash(token), user.id]);
    setCookie(c, SESSION, token, { ...cookie, maxAge: DAY });
    log.info('signed in', { user: user.id });
    return c.redirect('/');
  });

  app.post('/auth/sign-out', async (c: Context<Env>) => {
    const token = getCookie(c, SESSION);
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
    deleteCookie(c, SESSION, { path: '/', secure: !onMirror });
    return c.json({ ok: true });
  });
}
