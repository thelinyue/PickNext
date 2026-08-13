import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, checkDatabase } from './backup.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SQLite 备份与恢复检查', () => {
  it('使用原生备份 API 生成可通过完整性检查的快照', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'picknext-backup-'));
    temporaryDirectories.push(directory);
    const source = join(directory, 'source.db');
    const target = join(directory, 'backup.db');
    const database = new Database(source);
    database.exec('CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT NOT NULL); INSERT INTO songs(title) VALUES (\'晴天\');');
    database.close();

    await backupDatabase(source, target);

    expect(checkDatabase(target)).toBe('ok');
    const restored = new Database(target, { readonly: true });
    expect(restored.prepare('SELECT title FROM songs').pluck().get()).toBe('晴天');
    restored.close();
  });

  it('损坏或非 SQLite 文件不能通过恢复检查', () => {
    const directory = mkdtempSync(join(tmpdir(), 'picknext-backup-'));
    temporaryDirectories.push(directory);
    const corrupt = join(directory, 'corrupt.db');
    writeFileSync(corrupt, '这不是 SQLite 数据库');

    expect(() => checkDatabase(corrupt)).toThrow();
  });
});
