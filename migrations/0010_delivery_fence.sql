-- Prevent duplicate Send-to-Kindle side effects when Queue messages are replayed
-- or two consumers race on the same task. A fence is permanent once claimed:
-- an uncertain first attempt must never be followed by a blind automatic resend.
CREATE TABLE IF NOT EXISTS delivery_fences (
  task_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('started', 'accepted', 'unknown')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  provider_message_id TEXT,
  provider_thread_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_fences_state
  ON delivery_fences(state, updated_at);
