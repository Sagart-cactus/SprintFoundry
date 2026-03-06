CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  ticket_source TEXT NOT NULL,
  ticket_title TEXT NOT NULL,
  status TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  plan_classification TEXT NOT NULL,
  workspace_path TEXT,
  branch TEXT,
  pr_url TEXT,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_project_status ON runs (project_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_updated_at ON runs (updated_at DESC);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_run_timestamp ON events (run_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_events_type_timestamp ON events (event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_data_gin ON events USING GIN (data);

CREATE TABLE IF NOT EXISTS step_results (
  run_id TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  step_attempt INTEGER NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, step_number, step_attempt)
);

CREATE INDEX IF NOT EXISTS idx_step_results_run_step ON step_results (run_id, step_number ASC, step_attempt ASC);
CREATE INDEX IF NOT EXISTS idx_step_results_status ON step_results (status);

CREATE TABLE IF NOT EXISTS run_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  step_attempt INTEGER NOT NULL,
  agent TEXT NOT NULL,
  runtime_provider TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  stream TEXT NOT NULL,
  chunk TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  is_final BOOLEAN NOT NULL DEFAULT FALSE,
  timestamp TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT run_logs_dedupe_unique UNIQUE (run_id, step_number, step_attempt, sequence, stream)
);

CREATE INDEX IF NOT EXISTS idx_run_logs_stream_order
  ON run_logs (run_id, step_number ASC, step_attempt ASC, sequence ASC);
CREATE INDEX IF NOT EXISTS idx_run_logs_timestamp ON run_logs (run_id, timestamp ASC);
