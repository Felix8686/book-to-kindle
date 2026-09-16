-- Optional Idempotency-Key support for POST /api/v1/tasks.
-- A stable key maps client retries to one logical task instead of creating
-- duplicate Queue work and duplicate downstream delivery attempts.
CREATE TABLE IF NOT EXISTS api_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_idempotency_created_at
  ON api_idempotency(created_at);
