-- 修复早期 0009 已执行但未重建约束的数据库，确保后台任务支持部分失败和恢复中状态。
PRAGMA foreign_keys = OFF;

CREATE TABLE mtw_batches_status_upgrade (
  id TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scanning', 'ready', 'importing', 'done', 'partial_failed', 'failed', 'cancelled', 'revoking', 'revoked')),
  result TEXT,
  progress TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO mtw_batches_status_upgrade(id, created_by, status, result, progress, error, created_at, updated_at)
SELECT id, created_by, status, result, progress, error, created_at, updated_at FROM mtw_batches;

DROP TABLE mtw_batches;
ALTER TABLE mtw_batches_status_upgrade RENAME TO mtw_batches;
PRAGMA foreign_keys = ON;
