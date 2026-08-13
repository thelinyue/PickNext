ALTER TABLE songs ADD COLUMN album TEXT;

CREATE TABLE cover_assets (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  source_path TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE song_covers (
  song_id INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
  cover_id INTEGER NOT NULL REFERENCES cover_assets(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE song_deletion_requests (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX song_deletion_requests_status_idx ON song_deletion_requests(status, created_at);

CREATE TABLE lyric_submissions (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lyrics TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'mtw',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX lyric_submissions_status_idx ON lyric_submissions(status, created_at);

CREATE TABLE mtw_batches (
  id TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scanning', 'ready', 'importing', 'done', 'failed', 'cancelled', 'revoked')),
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mtw_batch_items (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES mtw_batches(id) ON DELETE CASCADE,
  source_path TEXT,
  cover_path TEXT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  version TEXT,
  language TEXT,
  genre TEXT,
  lyrics TEXT,
  song_id INTEGER REFERENCES songs(id),
  action TEXT NOT NULL DEFAULT 'candidate' CHECK (action IN ('candidate', 'created', 'updated', 'similar_skipped', 'failed', 'revoked', 'review')),
  cover_status TEXT NOT NULL DEFAULT 'pending' CHECK (cover_status IN ('pending', 'ready', 'missing', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX mtw_batch_items_batch_idx ON mtw_batch_items(batch_id, id);
