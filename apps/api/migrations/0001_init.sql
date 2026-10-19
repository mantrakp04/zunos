-- One row per training run. Timestamps are milliseconds since the epoch.
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  email             TEXT NOT NULL,
  langs             TEXT NOT NULL,                  -- JSON array of "en" | "hi" | "gu"
  status            TEXT NOT NULL CHECK (status IN ('uploading', 'queued', 'running', 'done', 'failed', 'stopped')),
  stage             TEXT,                           -- setup | data | gen | filter | train | export | upload
  pod_id            TEXT,
  gpu               TEXT,
  price_per_hour    REAL,
  events_token_hash TEXT,                           -- SHA-256 hex of the pod's bearer token
  evals             TEXT NOT NULL DEFAULT '[]',     -- JSON [{step, score, res}]
  steps             TEXT NOT NULL DEFAULT '[]',     -- JSON [{step, loss}], last 500
  logs              TEXT NOT NULL DEFAULT '[]',     -- JSON [string], last 200
  error             TEXT,
  best_step         INTEGER,
  best_score        REAL,
  model_bytes       INTEGER,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,                        -- pod created (billing starts)
  finished_at       INTEGER,
  last_event_at     INTEGER
);

CREATE INDEX runs_user ON runs (user_id, created_at);
CREATE INDEX runs_status ON runs (status);

-- At most one active run per user, enforced by the database.
CREATE UNIQUE INDEX runs_one_active_per_user ON runs (user_id) WHERE status IN ('uploading', 'queued', 'running');
