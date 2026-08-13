import type Database from 'better-sqlite3';

/** 关键业务审计写入失败时阻止当前事务继续提交，避免产生无法解释的半套记录。 */
export class AuditLogError extends Error {
  readonly code = 'AUDIT_WRITE_FAILED';

  constructor(cause: unknown) {
    super(`审计日志写入失败，当前操作未完成：${cause instanceof Error ? cause.message : '未知错误'}`);
    this.name = 'AuditLogError';
  }
}

/**
 * 轻量审计记录器只依赖 SQLite，不引入额外日志服务。
 * metadata 只保存业务上下文，调用方不得写入密码、Cookie 或完整请求体。
 */
export class AuditLogger {
  constructor(private readonly db: Database.Database) {}

  record(input: {
    actorUserId?: number | null;
    action: string;
    targetType: string;
    targetId?: string | number | null;
    metadata?: Record<string, unknown>;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO audit_logs(actor_user_id, action, target_type, target_id, metadata)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        input.actorUserId ?? null,
        input.action,
        input.targetType,
        input.targetId === undefined || input.targetId === null ? null : String(input.targetId),
        input.metadata ? JSON.stringify(input.metadata) : null
      );
    } catch (error) {
      throw new AuditLogError(error);
    }
  }
}
