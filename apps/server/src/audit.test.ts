import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AuditLogger } from './audit.js';

describe('审计日志', () => {
  it('保存操作者、动作和有限业务元数据', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, actor_user_id INTEGER, action TEXT, target_type TEXT, target_id TEXT, metadata TEXT, created_at TEXT)');
    new AuditLogger(db).record({ actorUserId: 7, action: 'test_action', targetType: 'song', targetId: 3, metadata: { count: 1 } });
    expect(db.prepare('SELECT * FROM audit_logs').get()).toMatchObject({ actor_user_id: 7, action: 'test_action', target_type: 'song', target_id: '3', metadata: '{"count":1}' });
    db.close();
  });
});
