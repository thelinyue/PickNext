CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE songs (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  version TEXT,
  language TEXT,
  genre TEXT,
  difficulty TEXT CHECK (difficulty IN ('easy', 'medium', 'hard')),
  performance_type TEXT NOT NULL DEFAULT 'solo' CHECK (performance_type IN ('solo', 'duet', 'chorus')),
  lyrics TEXT,
  lyrics_translit TEXT,
  pinyin TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  added_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX songs_identity_idx ON songs(title COLLATE NOCASE, artist COLLATE NOCASE);

CREATE TABLE song_aliases (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  alias TEXT NOT NULL
);
CREATE INDEX song_aliases_song_idx ON song_aliases(song_id);

CREATE TABLE user_songs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  collection_type TEXT NOT NULL CHECK (collection_type IN ('repertoire', 'learning')),
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, song_id)
);
CREATE INDEX user_songs_collection_idx ON user_songs(user_id, collection_type, removed_at);

CREATE TABLE song_user_meta (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  note TEXT,
  override_diff TEXT CHECK (override_diff IN ('easy', 'medium', 'hard')),
  key_shift INTEGER CHECK (key_shift BETWEEN -12 AND 12),
  memory_cue TEXT,
  pick_snoozed_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, song_id)
);

CREATE TABLE playlists (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'next_ktv')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX playlists_single_ktv_idx ON playlists(owner_id, kind) WHERE kind = 'next_ktv';

CREATE TABLE playlist_songs (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (playlist_id, song_id)
);

CREATE TABLE pick_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  random_seed INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX pick_sessions_user_idx ON pick_sessions(user_id, ended_at, last_activity_at);

CREATE TABLE pick_queue_items (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pick_sessions(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  source TEXT NOT NULL CHECK (source IN ('ktv', 'repertoire', 'global')),
  position INTEGER NOT NULL,
  filter_hash TEXT NOT NULL,
  recency_weight REAL NOT NULL,
  artist_factor REAL NOT NULL,
  genre_factor REAL NOT NULL,
  difficulty_factor REAL NOT NULL,
  final_weight REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'picked', 'skipped', 'played', 'invalidated')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX pick_queue_next_idx ON pick_queue_items(session_id, status, filter_hash, position);

CREATE TABLE pick_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pick_sessions(id) ON DELETE CASCADE,
  queue_item_id INTEGER NOT NULL REFERENCES pick_queue_items(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  source TEXT NOT NULL CHECK (source IN ('ktv', 'repertoire', 'global')),
  candidate_count INTEGER NOT NULL,
  filter_snapshot TEXT NOT NULL,
  recent_filter_relaxed INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL UNIQUE,
  algorithm_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'picked' CHECK (status IN ('picked', 'skipped', 'played')),
  response_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX pick_events_session_idx ON pick_events(session_id, created_at);
CREATE INDEX pick_events_song_idx ON pick_events(user_id, song_id, created_at);

CREATE TABLE plays (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id),
  pick_session_id TEXT REFERENCES pick_sessions(id),
  pick_event_id TEXT UNIQUE REFERENCES pick_events(id),
  note TEXT,
  rating_snapshot INTEGER CHECK (rating_snapshot BETWEEN 1 AND 5),
  played_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX plays_recent_idx ON plays(user_id, played_at DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
