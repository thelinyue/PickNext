-- 管理后台任务增强：允许 MTW 长任务在页面刷新后恢复状态，并为批次候选分页查询补充索引。
PRAGMA foreign_keys = OFF;

CREATE TABLE mtw_batches_admin_new (
  id TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scanning', 'ready', 'importing', 'done', 'partial_failed', 'failed', 'cancelled', 'revoking', 'revoked')),
  result TEXT,
  progress TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO mtw_batches_admin_new(id, created_by, status, result, error, created_at, updated_at)
SELECT id, created_by, status, result, error, created_at, updated_at FROM mtw_batches;

DROP TABLE mtw_batches;
ALTER TABLE mtw_batches_admin_new RENAME TO mtw_batches;
PRAGMA foreign_keys = ON;

CREATE INDEX mtw_batch_items_filter_idx
  ON mtw_batch_items(batch_id, action, cover_status, artist, album, id);

CREATE INDEX songs_admin_status_idx
  ON songs(status, added_by, id);

CREATE INDEX lyric_submissions_admin_idx
  ON lyric_submissions(status, created_at, id);

CREATE INDEX deletion_requests_admin_idx
  ON song_deletion_requests(status, created_at, id);
