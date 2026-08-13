import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from './db.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fullMigrations = resolve(projectRoot, 'migrations');
const temporaryDirectories: string[] = [];

function createLegacyMigrations(): string {
  const directory = mkdtempSync(join(tmpdir(), 'picknext-migrations-'));
  temporaryDirectories.push(directory);
  for (const filename of readdirSync(fullMigrations).filter((name) => /^000[1-5]_.*\.sql$/.test(name))) {
    copyFileSync(join(fullMigrations, filename), join(directory, filename));
  }
  return directory;
}

function createLegacyDatabase(rows: Array<{ title: string; artist: string; version?: string | null; status?: 'active' | 'deleted' }>): { directory: string; filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'picknext-db-'));
  temporaryDirectories.push(directory);
  const filename = join(directory, 'picknext.db');
  const migrations = createLegacyMigrations();
  const database = new Database(filename);
  database.exec(`
    CREATE TABLE schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  for (const filename of readdirSync(migrations).sort()) {
    database.exec(readFileSync(join(migrations, filename), 'utf8'));
    database.prepare('INSERT INTO schema_migrations(filename) VALUES (?)').run(filename);
  }
  const user = database.prepare("INSERT INTO users(username, password_hash, role) VALUES ('fixture', 'hash', 'admin')").run();
  const insert = database.prepare(`
    INSERT INTO songs(title, artist, version, status, added_by) VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of rows) insert.run(row.title, row.artist, row.version ?? null, row.status ?? 'active', user.lastInsertRowid);
  database.close();
  return { directory, filename };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('数据库歌曲身份迁移', () => {
  it('历史活动歌曲存在重复身份时拒绝启动且不删除数据', () => {
    const fixture = createLegacyDatabase([
      { title: ' 晴天 ', artist: '周杰伦' },
      { title: '晴天', artist: '周杰伦' }
    ]);

    expect(() => new AppDatabase(fixture.filename, fullMigrations)).toThrow(/身份重复.*歌曲 ID/);

    const database = new Database(fixture.filename, { readonly: true });
    expect(database.prepare('SELECT count(*) AS count FROM songs').get()).toMatchObject({ count: 2 });
    expect(database.prepare('SELECT count(*) AS count FROM songs WHERE normalized_title = \'晴天\'').get()).toMatchObject({ count: 2 });
    database.close();
  });

  it('无重复身份时建立唯一索引并阻止新的活动重复歌曲', () => {
    const fixture = createLegacyDatabase([{ title: '晴天', artist: '周杰伦' }]);
    const database = new AppDatabase(fixture.filename, fullMigrations);

    expect(database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'songs_normalized_identity_unique'").get()).toBeTruthy();
    expect(() => database.db.prepare(`
      INSERT INTO songs(title, artist, normalized_title, normalized_artist, normalized_version, added_by)
      VALUES ('晴天', '周杰伦', '晴天', '周杰伦', '', 1)
    `).run()).toThrow();
    database.close();
  });

  it('只有软删除歌曲时允许重新建立同身份的活动歌曲', () => {
    const fixture = createLegacyDatabase([{ title: '晴天', artist: '周杰伦', status: 'deleted' }]);
    const database = new AppDatabase(fixture.filename, fullMigrations);

    expect(() => database.db.prepare(`
      INSERT INTO songs(title, artist, normalized_title, normalized_artist, normalized_version, added_by)
      VALUES ('晴天', '周杰伦', '晴天', '周杰伦', '', 1)
    `).run()).not.toThrow();
    database.close();
  });
});
