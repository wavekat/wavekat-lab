CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  github_id       INTEGER NOT NULL UNIQUE,
  username        TEXT NOT NULL,
  avatar_url      TEXT,
  terms_accepted  INTEGER DEFAULT 0,
  terms_version   TEXT,
  terms_accepted_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
