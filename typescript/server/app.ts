// The app's routes: sign-in, the notes API, health. Shared by the production server (main.ts) and the dev server
// (dev.ts), which add the UI around it.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { signIn, session, type Env } from './auth.ts';
import { pool, tx } from './db.ts';
import { event, log } from './log.ts';

export const app = new Hono<Env>();

// Every response: no content sniffing; a page is never framed by another site.
app.use(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  if ((c.res.headers.get('content-type') ?? '').startsWith('text/html')) c.header('Content-Security-Policy', "frame-ancestors 'none'");
});

// Changes need a JSON body. Apps on agent.cloud share a site, so a neighbour's page could post a plain form here with
// this app's cookies; a JSON body would need a CORS preflight, which this app never grants.
app.use(async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !(c.req.header('content-type') ?? '').startsWith('application/json')) {
    return c.json({ error: { code: 'json_required', message: 'Send a JSON body (Content-Type: application/json).' } }, 415);
  }
  await next();
});

// Health answers as soon as the server can serve, without touching the database: agent.cloud asks every 2 seconds.
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Only the API and sign-in look up the session: the UI's files never wait on the database.
app.use('/api/*', session);
app.use('/auth/*', session);
signIn(app);

const signedIn = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
  const user = c.get('user');
  if (!user) throw new HTTPException(401, { message: 'Sign in first.' });
  return user;
};

app.get('/api/me', (c) => c.json({ user: signedIn(c) }));

app.get('/api/notes', async (c) => {
  const user = signedIn(c);
  const { rows } = await pool.query('SELECT id, title, created_at FROM notes WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [user.id]);
  return c.json(rows);
});

app.post('/api/notes', async (c) => {
  const user = signedIn(c);
  const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 200) return c.json({ error: { code: 'bad_title', message: 'A title is 1 to 200 characters.' } }, 400);
  try {
    // The note and the job that emails about it are saved together, or not at all.
    const note = await tx(async (db) => {
      const { rows } = await db.query<{ id: string; title: string; created_at: string }>(
        'INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at', [user.id, title]);
      await db.query(`INSERT INTO jobs (kind, payload) VALUES ('note_email', $1)`, [{ note_id: rows[0]!.id }]);
      await db.query('NOTIFY jobs');
      return rows[0]!;
    });
    event('note.created', `note:${note.id}`, { related: [`user:${user.id}`] });
    return c.json(note, 201);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return c.json({ error: { code: 'duplicate', message: 'You already have a note with that title.' } }, 409);
    throw e;
  }
});

// Only for agent.cloud's conformance suite: an error and a slow request, to prove logging and graceful shutdown.
if (process.env.AGENTCLOUD_CONFORMANCE === '1') {
  app.get('/api/debug/error', () => { throw new Error('a deliberate failure, for the conformance suite'); });
  app.get('/api/debug/slow', async (c) => {
    log.info('slow request started');
    await new Promise((r) => setTimeout(r, Math.min(Number(c.req.query('ms')) || 0, 10_000)));
    return c.json({ ok: true });
  });
}

app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'No such API route.' } }, 404));

app.onError((e, c) => {
  if (e instanceof HTTPException) return c.json({ error: { code: 'http', message: e.message } }, e.status);
  log.error('request failed', { method: c.req.method, path: c.req.routePath, error: e.message, stack: e.stack });
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});
