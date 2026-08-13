ALTER TABLE songs ADD COLUMN normalized_title TEXT;
ALTER TABLE songs ADD COLUMN normalized_artist TEXT;
ALTER TABLE songs ADD COLUMN normalized_version TEXT;

CREATE INDEX songs_normalized_identity_lookup_idx
  ON songs(normalized_title, normalized_artist, normalized_version, status);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC, id DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs(target_type, target_id, created_at DESC);
