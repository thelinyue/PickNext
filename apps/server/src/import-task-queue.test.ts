import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ImportTaskQueue } from './import-task-queue.js';

describe('进程内导入任务队列', () => {
  it('同一时间只执行一个任务，并在重启时失败未完成任务', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, user_id INTEGER, type TEXT, status TEXT, error TEXT, updated_at TEXT)');
    db.prepare("INSERT INTO tasks(id, user_id, type, status) VALUES ('old', 1, 'song_import', 'running'), ('one', 1, 'song_import', 'pending'), ('two', 1, 'song_import', 'pending')").run();
    const active: string[] = [];
    let maximum = 0;
    const completed: string[] = [];
    const queue = new ImportTaskQueue(db, {
      processTask: async (taskId) => {
        active.push(taskId); maximum = Math.max(maximum, active.length);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        active.splice(active.indexOf(taskId), 1); completed.push(taskId);
      }
    });
    queue.enqueue('one');
    queue.enqueue('two');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(maximum).toBe(1);
    expect(completed).toEqual(['one', 'two']);
    expect((db.prepare("SELECT status FROM tasks WHERE id = 'old'").get() as { status: string }).status).toBe('failed');
    db.close();
  });
});
