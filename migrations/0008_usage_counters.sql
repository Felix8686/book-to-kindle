-- 0008_usage_counters.sql
-- Monthly application usage counters for Free Tier Guard

CREATE TABLE IF NOT EXISTS usage_counters (
  month_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (month_key, metric)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_month ON usage_counters(month_key);
