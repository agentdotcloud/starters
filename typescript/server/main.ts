// Production: the API (app.ts) and the built UI (web/dist) on one port. On SIGTERM it stops taking connections,
// finishes the requests in flight, and exits well inside the 30 seconds agent.cloud gives it.
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { app } from './app.ts';
import { pool } from './db.ts';
import { required } from './env.ts';
import { log } from './log.ts';

const { PORT } = required('PORT');
const index = readFileSync('web/dist/index.html', 'utf8');

app.use('/*', serveStatic({ root: 'web/dist' }));
// Any other path is a page of the UI: it routes on the client, so a reload anywhere still loads the app.
app.get('*', (c) => c.html(index));

const server = serve({ fetch: app.fetch, port: Number(PORT), hostname: '0.0.0.0' }, () => log.info('listening', { port: Number(PORT) }));

process.on('SIGTERM', () => {
  log.info('shutting down');
  setTimeout(() => process.exit(0), 20_000).unref(); // never outlive the platform's grace period
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  if ('closeIdleConnections' in server) (server as { closeIdleConnections: () => void }).closeIdleConnections();
});
