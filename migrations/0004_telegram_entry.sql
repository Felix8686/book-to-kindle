CREATE TABLE IF NOT EXISTS telegram_task_links (
  task_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_message_id INTEGER,
  last_notified_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_task_links_user_created
  ON telegram_task_links(user_id, created_at DESC);
