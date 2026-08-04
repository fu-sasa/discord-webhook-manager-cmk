/**
 * Schema migrations, applied in order. Never edit a shipped migration —
 * append a new entry instead, so existing installs converge to the same state.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Named webhooks. The Discord URL is stored encrypted (AES-256-GCM); only a
-- masked hint is ever rendered in the UI or returned by the API.
CREATE TABLE named_webhooks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE,
  label               TEXT NOT NULL DEFAULT '',
  url_enc             BLOB NOT NULL,
  url_hint            TEXT NOT NULL,
  default_username    TEXT,
  default_avatar_url  TEXT,
  default_thread_id   TEXT,
  tags                TEXT NOT NULL DEFAULT '',
  enabled             INTEGER NOT NULL DEFAULT 1,
  note                TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT 'send',
  allow_raw_url INTEGER NOT NULL DEFAULT 1,
  last_used_at  TEXT,
  disabled_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE schedules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id    TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  cron         TEXT NOT NULL,
  tz           TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  target_type  TEXT NOT NULL CHECK (target_type IN ('named','url')),
  webhook_id   INTEGER REFERENCES named_webhooks(id) ON DELETE CASCADE,
  url_enc      BLOB,
  url_hint     TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_run_at  TEXT,
  next_run_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT NOT NULL UNIQUE,
  schedule_id        INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  target_type        TEXT NOT NULL CHECK (target_type IN ('named','url')),
  webhook_id         INTEGER REFERENCES named_webhooks(id) ON DELETE SET NULL,
  url_enc            BLOB,
  url_hint           TEXT NOT NULL DEFAULT '',
  target_label       TEXT NOT NULL DEFAULT '',
  payload_json       TEXT NOT NULL,
  scheduled_at       TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','canceled')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT,
  last_error         TEXT,
  response_status    INTEGER,
  discord_message_id TEXT,
  idempotency_key    TEXT,
  source             TEXT NOT NULL DEFAULT 'ui',
  alerted            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  sent_at            TEXT
);
CREATE UNIQUE INDEX idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jobs_due ON jobs(status, scheduled_at);
CREATE INDEX idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip         TEXT NOT NULL DEFAULT '',
  ua         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);

CREATE TABLE login_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip      TEXT NOT NULL,
  at      TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_login_ip_at ON login_attempts(ip, at DESC);
`,
  },
];
