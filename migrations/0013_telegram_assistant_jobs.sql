-- Durable idempotency/retry state for free-form Telegram assistant messages.
-- The webhook only enqueues work; model/catalog calls and final replies run in Queue.
CREATE TABLE IF NOT EXISTS telegram_assistant_jobs (
  update_id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  input_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'completed')),
  lease_token TEXT,
  lease_until TEXT,
  task_id TEXT,
  book_enqueued INTEGER NOT NULL DEFAULT 0,
  response_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_assistant_jobs_state
  ON telegram_assistant_jobs(state, lease_until);
