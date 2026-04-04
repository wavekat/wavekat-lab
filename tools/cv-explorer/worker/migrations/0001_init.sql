CREATE TABLE IF NOT EXISTS datasets (
  id          TEXT PRIMARY KEY,
  dataset_id  TEXT NOT NULL,
  version     TEXT NOT NULL,
  locale      TEXT NOT NULL,
  split       TEXT NOT NULL,
  clip_count  INTEGER DEFAULT 0,
  size_bytes  INTEGER DEFAULT 0,
  status      TEXT NOT NULL,
  synced_at   TEXT
);

CREATE TABLE IF NOT EXISTS clips (
  id         TEXT PRIMARY KEY,
  version    TEXT NOT NULL,
  locale     TEXT NOT NULL,
  split      TEXT NOT NULL,
  path       TEXT NOT NULL,
  sentence   TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  char_count INTEGER NOT NULL,
  up_votes   INTEGER DEFAULT 0,
  down_votes INTEGER DEFAULT 0,
  age        TEXT,
  gender     TEXT,
  accent     TEXT,
  has_audio  INTEGER DEFAULT 0
);
