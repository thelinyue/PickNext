import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSongIndex, normalizedSongIdentity } from './song-utils.js';
import { rebuildAllSearchIndexes } from './search-index.js';

/**
 * SQLite 生命周期入口：统一启用外键、WAL 和迁移事务。
 * 迁移只允许追加，已执行文件不会再次运行，避免部署升级时破坏用户数据。
 */
export class AppDatabase {
  readonly db: Database.Database;

  constructor(filename: string, migrationsDirectory: string) {
    this.db = new Database(filename);
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.migrate(migrationsDirectory);
      this.backfillSongIndexes();
      this.backfillSongIdentities();
      this.ensureSongIdentityConstraint();
      rebuildAllSearchIndexes(this.db);
    } catch (error) {
      // 启动阶段失败时主动释放句柄，避免 Windows 锁住数据库导致部署者无法备份或修复。
      this.db.close();
      throw error;
    }
  }

  /**
   * SQL migration 无法可靠计算中文拼音，因此在结构迁移后用同一套 TypeScript 规则补齐旧数据。
   * 整批更新放在事务中，失败时直接阻止服务启动，避免用户看到只完成一半的字母索引。
   */
  private backfillSongIndexes(): void {
    const rows = this.db.prepare(`SELECT id, title, pinyin, title_initial AS titleInitial FROM songs`).all() as
      Array<{ id: number; title: string; pinyin: string | null; titleInitial: string | null }>;
    if (!rows.length) return;
    const update = this.db.prepare('UPDATE songs SET pinyin = ?, title_initial = ? WHERE id = ?');
    try {
      this.db.transaction(() => {
        for (const row of rows) {
          const index = buildSongIndex(row.title);
          if (row.pinyin !== index.pinyin || row.titleInitial !== index.titleInitial) update.run(index.pinyin, index.titleInitial, row.id);
        }
      })();
    } catch (error) {
      throw new Error(`歌曲拼音索引回填失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 回填歌曲精确身份索引。该步骤只更新规范化字段，不合并或删除旧歌曲。
   * 规范化规则与新增歌曲共用 song-utils，避免迁移前后查重结果不一致。
   */
  private backfillSongIdentities(): void {
    const rows = this.db.prepare('SELECT id, title, artist, version FROM songs').all() as Array<{
      id: number;
      title: string;
      artist: string;
      version: string | null;
    }>;
    const update = this.db.prepare(`
      UPDATE songs SET normalized_title = ?, normalized_artist = ?, normalized_version = ? WHERE id = ?
    `);
    try {
      this.db.transaction(() => {
        for (const row of rows) {
          const identity = normalizedSongIdentity(row);
          update.run(identity.title, identity.artist, identity.version, row.id);
        }
      })();
    } catch (error) {
      throw new Error(`歌曲身份索引回填失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 历史数据若存在相同规范化身份，启动时拒绝建立唯一约束并给出人工处理提示。
   * 这样可以阻止新数据继续扩大问题，同时绝不替部署者自动删除歌曲。
   */
  private ensureSongIdentityConstraint(): void {
    const conflicts = this.db.prepare(`
      SELECT normalized_title AS title, normalized_artist AS artist, normalized_version AS version,
             group_concat(id) AS ids, count(*) AS count
      FROM songs
      WHERE status = 'active'
      GROUP BY normalized_title, normalized_artist, normalized_version
      HAVING count(*) > 1
      ORDER BY min(id)
      LIMIT 20
    `).all() as Array<{ title: string; artist: string; version: string; ids: string; count: number }>;
    if (conflicts.length) {
      const summary = conflicts.map((item) => `歌曲 ID [${item.ids}]`).join('；');
      throw new Error(`检测到 ${conflicts.length} 组活动歌曲身份重复，未启动服务。请人工审核后再升级，不会自动删除或合并歌曲：${summary}`);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS songs_normalized_identity_unique
      ON songs(normalized_title, normalized_artist, normalized_version)
      WHERE status = 'active'
    `);
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
