CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  default_language TEXT NOT NULL DEFAULT 'zh',
  preferred_format TEXT NOT NULL DEFAULT 'epub',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_settings_updated_at
  ON user_settings (updated_at DESC);
