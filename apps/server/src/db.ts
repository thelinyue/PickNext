import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SQLite 生命周期入口：统一启用外键、WAL 和迁移事务。
 * 迁移只允许追加，已执行文件不会再次运行，避免部署升级时破坏用户数据。
 */
export class AppDatabase {
  readonly db: Database.Database;

  constructor(filename: string, migrationsDirectory: string) {
    this.db = new Database(filename);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate(migrationsDirectory);
  }

  private migrate(directory: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const applied = new Set(
      this.db.prepare('SELECT filename FROM schema_migrations').all().map((row: any) => row.filename as string)
    );
    const apply = this.db.transaction((filename: string, sql: string) => {
      this.db.exec(sql);
      this.db.prepare('INSERT INTO schema_migrations(filename) VALUES (?)').run(filename);
    });
    for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      if (!applied.has(filename)) apply(filename, readFileSync(join(directory, filename), 'utf8'));
    }
  }

  close(): void {
    this.db.close();
  }
}
