# agent.cloud starter: TypeScript

A small, complete app to grow from. People sign in with Google or an email link, keep notes, and get an email for each note. It covers everything an agent.cloud app needs: sign-in, a worker with a job queue, email, migrations, checks and observability. It passes the [starter spec](../SPEC.md).

## Run it

```sh
agc init --stack typescript --name <what-it-does>   # in an empty folder: copies this, creates the app
agc up --detach                                      # your mirror: http://localhost:<port>, reloading on save
agc check && agc ship
```

`agc up` runs `npm ci` itself the first time. You only need Node 24.

## Layout

The server is `server/app.ts` (routes), `auth.ts` (sign-in), `worker.ts` (jobs) and `db.ts`. The UI is in `web/src/`. Schema changes go in `migrations/`, and the checks in `agentcloud.toml`. AGENTS.md says how to add a route, a table or a job.
