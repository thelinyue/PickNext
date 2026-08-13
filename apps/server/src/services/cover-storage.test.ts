import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CoverStorage } from './cover-storage.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('封面存储', () => {
  it('按 SHA-256 复用同一文件，并校验图片内容', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE cover_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, sha256 TEXT UNIQUE, mime_type TEXT, byte_size INTEGER, storage_path TEXT, source_path TEXT, status TEXT, error TEXT); CREATE TABLE song_covers (song_id INTEGER PRIMARY KEY, cover_id INTEGER);`);
    const directory = mkdtempSync(join(tmpdir(), 'picknext-cover-')); temporaryDirectories.push(directory);
    const storage = new CoverStorage(db, directory);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const first = storage.save(1, png, 'image/png', '/media/one.png');
    const second = storage.save(2, png, 'image/png', '/media/two.png');
    expect(first.coverId).toBe(second.coverId);
    expect(db.prepare('SELECT count(*) AS count FROM cover_assets').get()).toEqual({ count: 1 });
    expect(readdirSync(directory)).toHaveLength(1);
    expect(() => storage.save(3, new Uint8Array([1, 2, 3]), 'image/png')).toThrow('图片内容无效');
    db.close();
  });
});
