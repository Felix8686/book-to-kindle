CREATE TABLE IF NOT EXISTS telegram_conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_conversation_recent
  ON telegram_conversation_messages (chat_id, user_id, id DESC);
