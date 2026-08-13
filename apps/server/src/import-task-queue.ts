import type Database from 'better-sqlite3';

export interface ImportTaskQueueOptions {
  processTask(taskId: string): Promise<void>;
}

/**
 * 进程内导入任务队列：保持现有 tasks API 不变，但让 HTTP 请求先返回。
 * 队列不承诺跨进程持久执行；服务重启时未完成任务会被明确标记为失败。
 */
export class ImportTaskQueue {
  private readonly pending: string[] = [];
  private running = false;

  constructor(private readonly db: Database.Database, private readonly options: ImportTaskQueueOptions) {
    this.db.prepare(`
      UPDATE tasks SET status = 'failed', error = '服务重启，未完成的导入任务未继续执行。', updated_at = datetime('now')
      WHERE type = 'song_import' AND status IN ('pending', 'running')
    `).run();
  }

  enqueue(taskId: string): void {
    this.pending.push(taskId);
    this.schedule();
  }

  cancel(taskId: string, userId: number): boolean {
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'cancelled', error = '导入任务已取消。', updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'running')
    `).run(taskId, userId);
    return result.changes > 0;
  }

  private schedule(): void {
    if (this.running) return;
    setImmediate(() => void this.runNext());
  }

  private async runNext(): Promise<void> {
    if (this.running) return;
    const taskId = this.pending.shift();
    if (!taskId) return;
    this.running = true;
    try {
      await this.options.processTask(taskId);
    } catch {
      // 处理函数负责把可读错误写入 tasks；这里保证队列不会因单任务异常停止。
    } finally {
      this.running = false;
      if (this.pending.length) this.schedule();
    }
  }
}
