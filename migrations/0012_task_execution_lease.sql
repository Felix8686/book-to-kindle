-- Serialize duplicate/replayed Queue book jobs. The lease is recoverable after
-- expiry; the permanent delivery_fences table remains the final side-effect guard.
CREATE TABLE IF NOT EXISTS task_execution_leases (
  task_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_execution_leases_until
  ON task_execution_leases(lease_until);
