CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  credential_id TEXT NOT NULL CHECK (length(credential_id) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  revoked_at TEXT
);

CREATE INDEX idx_admin_sessions_expiry
  ON admin_sessions (expires_at, revoked_at);

CREATE TABLE admin_login_rate_limits (
  key_hash TEXT PRIMARY KEY
    CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  window_started_at TEXT NOT NULL CHECK (length(window_started_at) > 0),
  failure_count INTEGER NOT NULL
    CHECK (failure_count >= 0 AND failure_count <= 5),
  blocked_until TEXT,
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
);

CREATE INDEX idx_admin_login_rate_limits_cleanup
  ON admin_login_rate_limits (blocked_until, updated_at);
