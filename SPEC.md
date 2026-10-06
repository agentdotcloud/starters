# agent.cloud starter spec, v1

**Status:** draft, for review (phase 1 of the starters repo).
**For:** anyone writing an agent.cloud starter in any language, and the agents that grow apps from them. A starter that passes this spec builds and runs on agent.cloud with no Dockerfile, works on a mirror with auto-reload, signs people in, sends email, runs background jobs, and is legible in observability from its first release.

Every rule is **MUST** unless it says **SHOULD**. Each rule names the conformance test that proves it: `CONF:<name>` runs the built app against a fake platform; `LINT:<name>` reads the files. A rule with no test is marked `review`, and a person checks it in the starter's PR.

The platform facts behind each rule are cited as `repo:file` from [agent-cloud](https://github.com/summationai/agent-cloud), so this spec changes when the platform does.

## 0. What a starter is

A starter is a directory, `<language>/`, holding a complete, working app: a React + Vite UI, one server process serving the UI and the API on one port, a worker, SQL migrations, checks, and an `AGENTS.md` section. `agc init --stack <language>` copies it into an empty folder. It is a real app, small enough to read in ten minutes: people sign in, create a note, and get an email about it.

The same UI is shared by every stack, so stacks differ only in the server, the worker and the build.

## 1. Manifest

- **MAN-1:** `agentcloud.toml` at the starter's root has `[app] name = "starter"` (`agc init` replaces it), `[service.web]` with `port`, `dev` and `health`, `[service.worker]` with `command` and `dev`, and `[data.db]` with `env = "DATABASE_URL"` and `migrations = "migrations/"`. `LINT:manifest` (keys as `packages/cli/src/config.ts` appConfig reads them).
- **MAN-2:** `[service.web] command` is omitted when the language's default image already starts the app the standard way (Node: `npm start`); otherwise it is the production start command. `LINT:manifest`
- **MAN-3:** `[service.web] health = "/api/health"`. `LINT:manifest`
- **MAN-4:** The manifest's checks parse with no warnings: `lintChecks` from `packages/cli/src/checks.ts` returns nothing. `LINT:checks`

## 2. Build

- **BLD-1:** The starter has no Dockerfile. It builds with agent.cloud's default image for its language (Node: `packages/runner/src/build.ts` defaultDockerfile; Python: the default the platform adds next, mirrored in `conformance/images/`). `LINT:no-dockerfile`, `CONF:build`
- **BLD-2:** The image builds everything it runs, including the UI bundle. Build outputs (`dist/`, `build/`, `.venv/`, `node_modules/`) are in `.gitignore` and are never committed: `agc ship` sends only files git tracks or would track (`git ls-files --cached --others --exclude-standard`), so an ignored artifact is never shipped. `LINT:build-outputs`, `CONF:build`
- **BLD-3:** Dependencies are locked (`package-lock.json`, `uv.lock`), and the image installs them frozen. `LINT:lockfile`
- **BLD-4:** The build needs no secrets and no network beyond the language's package registry. `CONF:build` (built with the fake platform unreachable)
- **BLD-5 (SHOULD):** The image is under 400 MB. `CONF:build` (reported, not failed)

## 3. Processes

The platform runs `web` as a Deployment with a readiness probe on `health` every 2 s (`packages/runner/src/release.ts` webDeployment), a 512 MiB memory limit, all capabilities dropped, and a non-root user (`USER node` in the Node image).

- **PROC-1:** `web` listens on `0.0.0.0:$PORT`, never `127.0.0.1` or a fixed port. `CONF:bind` (reached from another container)
- **PROC-2:** One port serves both: the UI at `/` (HTML), and the API under `/api/`. An unknown `/api/...` path answers JSON 404; any other unknown path answers the UI's `index.html`, so client-side routes survive a reload. `CONF:routes`
- **PROC-3:** `GET /api/health` answers 200 with JSON, no sign-in, within 30 s of the process starting (the platform waits up to 3 minutes: `release.ts` ready). It answers 503 while the database is unreachable. `CONF:health`
- **PROC-4:** On SIGTERM, `web` stops taking new connections, finishes requests in flight, and exits within 25 s with status 0. The platform gives web the Kubernetes default of 30 s before SIGKILL. `CONF:sigterm-web` (a request in flight when SIGTERM arrives still completes)
- **PROC-5:** On SIGTERM, the worker finishes the job in hand, claims no new one, and exits within 50 s with status 0 (the worker's grace is 60 s: `terminationGracePeriodSeconds: 60`). `CONF:sigterm-worker`
- **PROC-6:** Signals reach the app through the platform's wrappers (`build.ts` forwarding and agc-start), so the app must not detach, fork into the background, or ignore SIGTERM. `CONF:sigterm-web`, `CONF:sigterm-worker` (run under the same wrapper)
- **PROC-7:** `web` and the worker each stay under 256 MiB at rest, and under 512 MiB while the checks run. `CONF:memory` (containers capped at 512 MiB; an OOM fails it)
- **PROC-8:** The app runs as the image's non-root user and writes only to `/tmp` and the database, never inside its own directory. `CONF:readonly` (the app directory is mounted read-only)
- **PROC-9:** If a required variable (`PORT`, `DATABASE_URL`) is missing, the process exits non-zero within 10 s and its last stderr line names the variable. That's what agent.cloud's crash causes read (`packages/control/src/startup.ts`). `CONF:missing-env`

## 4. Development and auto-reload

`agc up` runs `[service.web] dev` and `[service.worker] dev` with the mirror's environment: `PORT`, `DATABASE_URL`, `AGC_*`, and `AGENTCLOUD_MIRROR` (`packages/cli/src/commands/mirror.ts`).

- **DEV-1:** `dev` serves the whole app, UI and API, on `$PORT`. `CONF:dev-routes`
- **DEV-2:** Saving a server source file changes what the API serves within 5 s, with no manual restart. `CONF:reload-api`
- **DEV-3:** Saving a UI source file changes what the browser loads within 5 s (hot module reload, or the next page load), with no manual restart. `CONF:reload-ui`
- **DEV-4:** Saving a worker source file restarts the worker within 5 s. `CONF:reload-worker`
- **DEV-5:** `dev` needs nothing a fresh clone lacks beyond the language's toolchain: the first run installs dependencies itself, or the README says the one command that does. `CONF:dev-routes` (run from a clean copy)
- **DEV-6:** On a mirror (`AGENTCLOUD_MIRROR` set), cookies drop `Secure` so `http://localhost` works; in production they keep it. `CONF:cookies`

## 5. Data

- **DATA-1:** The app connects with `DATABASE_URL` exactly as given (it carries `sslmode=verify-full`). It never sets its own host, user, password or TLS options. For libpq-based drivers the platform sets `PGSSLROOTCERT=system`. `CONF:db-tls` (the fake database only accepts verified TLS), `LINT:db-config`
- **DATA-2:** The schema changes only through plain SQL files in `migrations/`, named `<digits>_<slug>.sql`, applied by `agc migrate` and recorded in `agentcloud_migrations` (`packages/cli/src/migrations.ts`). `LINT:migrations`
- **DATA-3:** The app runs no DDL at runtime, and depends on no ORM migrator (Prisma Migrate, drizzle-kit, Knex migrations, TypeORM, Sequelize CLI, Alembic, Django migrations, yoyo). `LINT:no-migrator`, `CONF:no-ddl` (the schema is the same before and after the app runs)
- **DATA-4:** Users and entities are keyed on `uuid` columns. Masking keeps uuids and masks high-cardinality text (`packages/control/src/policy.ts`), so a mirror's rows still line up with production's ids. `LINT:uuid-keys`
- **DATA-5:** The connection pool holds at most 10 connections per process. `review`
- **DATA-6:** Queries are parameterized; no SQL is built from request input by string concatenation. `review`

## 6. Platform services

### Sign-in (`docs/AGENTS.md` "Sign-in"; `packages/control/src/app-signin.ts`)
- **AUTH-1:** `GET /auth/sign-in` sets a state cookie (`HttpOnly`, `SameSite=Lax`, at least 128 bits of randomness, at most 10 minutes) and answers a redirect to `$AGC_AUTH_URL/authorize?state=<state>`. It may carry a `return_to` path, which must be relative. `CONF:signin`
- **AUTH-2:** `GET /auth/callback` compares `state` with the cookie before anything else. On a mismatch it answers 400 and never calls `/token`. `CONF:signin-state` (`checkSignInState`, the same probe rehearsals run)
- **AUTH-3:** The callback trades the code with `POST $AGC_AUTH_URL/token`, using `Authorization: Bearer $AGC_AUTH_TOKEN` and `{code}`, then finds or creates the user by `user.id` in a uuid column, and starts its own session. `CONF:signin`
- **AUTH-4:** The session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` outside a mirror, and lasts a day or less. Or the app rechecks `GET $AGC_AUTH_URL/users/<id>` at least daily and ends the session on 404. `CONF:cookies`
- **AUTH-5:** `GET /api/me` answers 200 with the signed-in user, or 401. `POST /auth/sign-out` ends the session. `CONF:signin`
- **AUTH-6:** No passwords. No password hashing (bcrypt, scrypt, argon2, PBKDF2) anywhere near the word "password" (`agc ship` warns on it). `LINT:no-passwords`

### Email (`docs/AGENTS.md` "Background work")
- **MAIL-1:** Email is sent by the worker, never in the request: `POST $AGC_EMAIL_URL` with `Authorization: Bearer $AGC_EMAIL_TOKEN` and `{to, subject, text, key}`. `CONF:mail`
- **MAIL-2:** `key` names the message for good (`note-<uuid>/created`), so a retried job never emails twice. `CONF:mail-once` (a worker killed mid-job: each key arrives once)

### Background jobs
- **JOB-1:** A `jobs` table, created by a migration, with the columns in `docs/AGENTS.md`. Work is inserted in the same transaction as the write it belongs to. `LINT:migrations`, `review`
- **JOB-2:** The worker claims with a lease (`FOR UPDATE SKIP LOCKED`, `locked_until`), so two workers never run one job at the same time, and a dead worker's job runs again. `CONF:jobs-race` (two workers, a batch of jobs, each email key exactly once)
- **JOB-3:** Every job is safe to run twice. `CONF:mail-once`

## 7. Observability (`infra/apps/observability/vector.yaml`)

- **OBS-1:** Logs go to stdout and stderr as one JSON object per line, with `level` (`debug`, `info`, `warn`, `error`) and `msg`. The platform classifies by `level`; plain text falls back to keyword guessing. `CONF:logs-json` (at least 95% of lines parse, and every line from app code parses)
- **OBS-2:** An unhandled error in a request is logged once, at `level: "error"`, on one line with the stack in a field. The request answers a JSON 500 without the stack. `CONF:error-log` (through `GET /api/debug/error`, which exists only when `AGENTCLOUD_CONFORMANCE` is set)
- **OBS-3:** Business steps emit workflow events: `{"agc":"event","name","entity","related","status","attrs"}`, with `name` matching `^[a-z][a-z0-9_.-]{0,63}$` and `entity` and each `related` matching `^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_.-]{1,64}$`. The starter emits `note.created` and `note.emailed` with `note:<uuid>`. `CONF:events`
- **OBS-4:** No personal data in logs or events: no emails, names or tokens, at any level. `CONF:no-pii` (a distinctive address signs in and creates notes; it never appears in any log line)
- **OBS-5 (SHOULD):** No per-request access log at `info`: Traefik already records every request with its status and latency. `CONF:logs-json` (reported)

## 8. Checks

- **CHK-1:** The manifest has at least one `[[check.smoke]]` flow that starts with `SIGN IN`, and one `[[check.invariant]]` paired with a smoke flow whose write step races (`xN`). `LINT:checks`
- **CHK-2:** Every smoke flow passes against the built app on the fake platform, run by agc's own `runFlow`. `CONF:smoke`
- **CHK-3:** Every invariant returns no rows after the smoke flows. `CONF:invariants`

## 9. Security

- **SEC-1:** No secrets in the repo: nothing matching agent.cloud's secret patterns (`packages/control/src/github.ts` secretIn), and no `.env` files. `LINT:secrets`
- **SEC-2:** No CORS for credentialed requests, and nothing trusts an `Origin`, `Referer` or redirect target because it ends in `.agent.cloud`: apps are neighbours on the same site. Every state-changing route checks the session and takes no GETs. `LINT:no-cors`, `review`
- **SEC-3 (SHOULD):** Responses carry `X-Content-Type-Options: nosniff`, and HTML responses a `frame-ancestors` CSP. `CONF:headers`

## 10. Documentation

- **DOC-1:** `README.md` says what the starter is, the one command to run it locally, where the server, worker, UI, migrations and checks live, and how to add an API route and a job. `review`
- **DOC-2:** `AGENTS.md` holds a stack section below agc's line (agc leaves everything below it alone): the commands, the layout, and the stack's idioms for sign-in, email, jobs and events. `LINT:agents-md`

## Out of scope for v1

- Per-app memory and readiness settings, and app secrets (the platform doesn't have them yet).
- Server-side rendering frameworks (Next.js, Remix, Django templates): v1 is one server plus a Vite UI.
- Single-language UIs (Streamlit, Dash, HTMX-only): possible later, as an explicitly lighter third kind.
- Custom domains and multiple web processes.

## Conformance: how it runs

```
conformance/
  run.ts              npx tsx conformance/run.ts <stack-dir> [--only RULE…] [--json report.json]
  lint/               the static rules (LINT:*), file reads only
  platform/           the fake platform: a Postgres 18 container that only accepts verified TLS,
                      a test-mode sign-in server (authorize, token, users, codes), and an email
                      endpoint that records each key once
  images/             the default image for each language, copied from agent-cloud's runner
  vendor/agc/         checks.ts and migrations.ts from agent-cloud at a pinned commit (sync.sh refreshes them)
```

1. **Lint** the stack directory (no Docker needed).
2. **Build** the image with the language's default Dockerfile, with no network to the fake platform.
3. **Start the fake platform** on a private Docker network, and apply `migrations/` the way `agc migrate` does.
4. **Run** `web` and the worker from the image, each capped at 512 MiB, with the app directory read-only and the environment the platform injects (`PORT`, `DATABASE_URL`, `PGSSLROOTCERT`, `AGC_EMAIL_*`, `AGC_AUTH_*`).
5. **Probe** each `CONF:*` rule over HTTP, signals, container logs and SQL, then the checks with agc's own `runFlow`, invariants and `checkSignInState`.
6. **Dev mode:** run `dev` on a copy of the source, edit a server file, a UI file and a worker file, and watch each change land without a restart.
7. **Report:** one line per rule (`PASS`, `FAIL` with evidence, or `SKIP` with the reason), JSON with `--json`, and exit 1 if any MUST fails.

CI runs the suite for every stack on every PR. A new stack is added by passing it ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Open questions

1. **Web grace period (platform):** web has the Kubernetes default of 30 s; the worker has 60 s set explicitly. Should web get 60 s too, or should PROC-4 keep its 25 s budget? (agent.cloud's call.)
2. **The Python default image (platform):** this spec assumes a Node stage builds the UI when `package.json` exists, then `python:3.12-slim` with uv: `uv sync --frozen --no-dev`, `.venv/bin` on `PATH`, `PYTHONUNBUFFERED=1` (OBS-1 needs unbuffered lines), a non-root user, and the manifest's `command` under the same signal wrapper.
3. **`/api/debug/error` (OBS-2):** a route that exists only under `AGENTCLOUD_CONFORMANCE` is the simplest way to prove error logging black-box. The alternative, a review-only rule, leaves the most common observability gap untested.
