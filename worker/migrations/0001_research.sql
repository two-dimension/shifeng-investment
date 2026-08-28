CREATE TABLE research_summaries (
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  PRIMARY KEY (kind, date)
);

CREATE INDEX research_summaries_latest
  ON research_summaries (kind, date DESC);

CREATE TABLE research_refresh_state (
  scope TEXT PRIMARY KEY,
  job_id TEXT,
  status TEXT NOT NULL,
  requested_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  last_success_at TEXT,
  last_error TEXT
);

INSERT OR IGNORE INTO research_refresh_state (scope, status)
VALUES ('all', 'idle');
