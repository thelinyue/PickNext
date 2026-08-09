ALTER TABLE songs ADD COLUMN title_initial TEXT;

CREATE INDEX songs_title_sort_idx
  ON songs(title_initial, pinyin COLLATE NOCASE, title COLLATE NOCASE);

CREATE TABLE playlist_collaborators (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (playlist_id, user_id)
);
CREATE INDEX playlist_collaborators_user_idx ON playlist_collaborators(user_id, playlist_id);

CREATE TABLE song_submissions (
  id INTEGER PRIMARY KEY,
  submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matched_song_id INTEGER REFERENCES songs(id),
  resolved_song_id INTEGER REFERENCES songs(id),
  public_payload TEXT NOT NULL,
  personal_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'merged', 'approved', 'rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX song_submissions_status_idx ON song_submissions(status, created_at);
