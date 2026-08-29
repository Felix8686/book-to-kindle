CREATE TABLE IF NOT EXISTS telegram_image_choices (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_message_id INTEGER,
  choices_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_image_choices_user_created
  ON telegram_image_choices (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_image_choices_expires
  ON telegram_image_choices (expires_at);
