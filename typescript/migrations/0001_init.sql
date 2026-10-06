-- People who signed in, keyed on the id agent.cloud's sign-in gives them (a uuid: mirrors keep it, and mask emails).
CREATE TABLE users (
  id           uuid PRIMARY KEY,
  email        text,
  name         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Sessions last a day; only a hash of the token is kept.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, title)
);

-- Background work (AGENTS.md "Background work"): inserted in the same transaction as the write it belongs to.
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  done_at      timestamptz,
  last_error   text
);
CREATE INDEX jobs_due ON jobs (run_at, id) WHERE done_at IS NULL;
