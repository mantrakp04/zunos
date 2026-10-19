import type { Database } from "bun:sqlite";

/**
 * Schema versions, applied in order at startup. `PRAGMA user_version` records the last one applied.
 * Append new entries; never edit one that has shipped.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "init",
    sql: `
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
`,
  },
];

/** Applies every migration newer than the database's user_version, each in its own transaction. */
export function migrate(db: Database): number {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    })();
    console.log(JSON.stringify({ msg: "migrated", version: m.version, name: m.name }));
    applied++;
  }
  return applied;
}
