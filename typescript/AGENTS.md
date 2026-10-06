# This app: the TypeScript stack

A React UI (Vite) and one Node 24 server (Hono) that serves the UI and the API on `$PORT`, a worker for background jobs, and Postgres through plain SQL. Node runs the server's TypeScript directly: there's no server build step.

## Commands

```text
agc up --detach      the app on your mirror: UI and API on one port, reloading on save
npm run typecheck    tsc over the server and the UI
npm run build        the UI into web/dist (agent.cloud runs this when it builds the image)
```

## Where things are

```text
server/app.ts       every route: /api/*, health, the JSON-only rule for changes, error handling
server/auth.ts      sign-in through agent.cloud, and sessions
server/worker.ts    the job loop, and one handler per job kind
server/db.ts        the pool, and tx() for writes that belong together
server/log.ts       JSON logs, and event() for workflow steps
server/main.ts      production: the API plus web/dist          server/dev.ts  development: the API plus Vite
web/src/            the UI (App.tsx, api.ts)
migrations/         schema changes, as plain SQL (agc migration new <slug>)
```

## How to add things

- **An API route:** in `server/app.ts`, under `/api/`. Call `signedIn(c)` for anything personal. Changes take a JSON body (any other body gets 415).
- **A table or column:** `agc migration new <slug>`, then plain SQL in the new file, then `agc migrate`. Key things on `uuid`. Use `CHECK (status IN (…))` for fixed sets of values, so mirrors show them. Never change the schema from code.
- **A background job:** insert into `jobs` inside the same `tx()` as the write it belongs to, and add a handler in `server/worker.ts`. The worker polls every 10 s while busy and backs off to 10 minutes when idle, so the database can sleep: don't make a person wait on a job. A job can run twice, so make it safe to: emails carry a `key` that names the message for good, like `note-<id>/created`.
- **A workflow step:** `event('order.paid', 'order:<id>', { related: ['user:<id>'] })`. Ids only, never emails or names.
- **Logging:** `log.info('what happened', { ids })`. Never log emails, names, tokens or request bodies.

## Rules this stack keeps

- Health (`/api/health`) never touches the database. agent.cloud asks it every 2 seconds.
- Sign-in checks `state` before trading the code. Sessions last a day. Cookies are `__Host-` cookies outside a mirror: apps share the agent.cloud site, and the prefix stops a neighbour app from planting one. Any cookie you add keeps that rule (`Secure`, `Path=/`, no `Domain`).
- On SIGTERM, web and the worker finish what's in flight and exit.
- Nothing writes inside the app's folder. Use `/tmp`, or better, the database.
