# agent.cloud starter: TypeScript

A small, complete app to grow from. People sign in with Google or an email link, keep notes, and get an email for each note. It covers everything an agent.cloud app needs: sign-in, a worker with a job queue, email, migrations, checks and observability. It passes the [starter spec](https://github.com/agentdotcloud/starters/blob/main/SPEC.md).

## Run it

```sh
agc init --stack typescript --name <what-it-does>   # in an empty folder: copies this, creates the app
npm ci                                               # once, and after a dependency changes
agc up --detach                                      # your mirror: http://localhost:<port>, reloading on save
agc check && agc ship
```

You only need Node 24. `agc up` doesn't install dependencies: run `npm ci` first.

## Layout

The server is `server/app.ts` (routes), `auth.ts` (sign-in), `worker.ts` (jobs) and `db.ts`. The UI is in `web/src/`. Schema changes go in `migrations/`, and the checks in `agentcloud.toml`. AGENTS.md says how to add a route, a table or a job.
