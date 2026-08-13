import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

const MAX_COVER_BYTES = 10 * 1024 * 1024;

function isSupportedImage(bytes: Uint8Array, mimeType: string): boolean {
  const png = bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  return (mimeType === 'image/png' && png) || (mimeType === 'image/jpeg' && jpeg) || (mimeType === 'image/webp' && webp);
}

/** 封面二进制保存在 data/covers，SQLite 只保存哈希、文件属性和歌曲关联。 */
export class CoverStorage {
  constructor(private readonly db: Database.Database, private readonly rootDirectory: string) {
    mkdirSync(rootDirectory, { recursive: true });
  }

  save(songId: number, bytes: Uint8Array, mimeType: string, sourcePath?: string | null): { coverId: number; url: string } {
    if (!isSupportedImage(bytes, mimeType)) throw new Error('封面格式或图片内容无效，仅支持 JPG、PNG、WEBP。');
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) throw new Error('封面为空或超过 10 MB 限制。');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const storagePath = join(this.rootDirectory, `${sha256}.${extension}`);
    const previous = this.db.prepare('SELECT cover_id AS coverId FROM song_covers WHERE song_id = ?').get(songId) as { coverId: number } | undefined;
    const existing = this.db.prepare('SELECT id, storage_path AS storagePath FROM cover_assets WHERE sha256 = ?').get(sha256) as { id: number; storagePath: string } | undefined;
    if (!existing || !existsSync(existing.storagePath)) writeFileSync(storagePath, bytes);
    const cover = this.db.prepare(`
      INSERT INTO cover_assets(sha256, mime_type, byte_size, storage_path, source_path, status, error)
      VALUES (?, ?, ?, ?, ?, 'ready', NULL)
      ON CONFLICT(sha256) DO UPDATE SET mime_type = excluded.mime_type, byte_size = excluded.byte_size, storage_path = excluded.storage_path, source_path = coalesce(excluded.source_path, cover_assets.source_path), status = 'ready', error = NULL
    `).run(sha256, mimeType, bytes.length, storagePath, sourcePath ?? null);
    const coverId = Number(cover.lastInsertRowid || (this.db.prepare('SELECT id FROM cover_assets WHERE sha256 = ?').get(sha256) as { id: number }).id);
    this.db.prepare(`INSERT INTO song_covers(song_id, cover_id) VALUES (?, ?) ON CONFLICT(song_id) DO UPDATE SET cover_id = excluded.cover_id`).run(songId, coverId);
    if (previous && previous.coverId !== coverId) this.removeIfUnused(previous.coverId);
    return { coverId, url: `/api/songs/${songId}/cover` };
  }

  get(songId: number): { path: string; mimeType: string } | undefined {
    return this.db.prepare(`SELECT ca.storage_path AS path, ca.mime_type AS mimeType FROM song_covers sc JOIN cover_assets ca ON ca.id = sc.cover_id WHERE sc.song_id = ? AND ca.status = 'ready'`).get(songId) as { path: string; mimeType: string } | undefined;
  }

  removeIfUnused(coverId: number): void {
    const row = this.db.prepare('SELECT storage_path FROM cover_assets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM song_covers WHERE cover_id = ?)').get(coverId, coverId) as { storage_path: string } | undefined;
    if (!row) return;
    try { unlinkSync(row.storage_path); } catch { /* 文件已经不存在时仍清理数据库记录。 */ }
    this.db.prepare('DELETE FROM cover_assets WHERE id = ?').run(coverId);
  }

  read(path: string): Buffer { return readFileSync(path); }
}
