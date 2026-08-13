import type Database from 'better-sqlite3';
import type { CollectionType } from '@picknext/shared';
import { buildSongIndex, normalizedSongIdentity, similarityScore, type SongIdentityInput } from '../song-utils.js';
import { rebuildSongSearchIndex, rebuildUserSongSearchIndex } from '../search-index.js';

export interface CatalogCandidate extends SongIdentityInput {
  id: number;
  language: string | null;
  genre: string | null;
  difficulty: 'easy' | 'medium' | 'hard' | null;
  performanceType: 'solo' | 'duet' | 'chorus';
}

export interface PersonalSongPayload {
  collectionType: CollectionType | null;
  personalDifficulty?: 'easy' | 'medium' | 'hard' | null;
  note?: string | null;
  memoryCue?: string | null;
  keyShift?: number | null;
}

/**
 * 曲库领域服务集中维护歌曲身份查找和个人曲库副作用，路由层只负责 HTTP 映射。
 * 精确查重由数据库索引完成，相似候选只读取有限 SQL 结果，避免全表扫描。
 */
export class CatalogService {
  constructor(private readonly db: Database.Database) {}

  findCandidates(input: SongIdentityInput): { exact: CatalogCandidate | undefined; similar: CatalogCandidate[] } {
    const identity = normalizedSongIdentity(input);
    const exact = this.db.prepare(`
      SELECT id, title, artist, version, language, genre, difficulty,
             performance_type AS performanceType
      FROM songs
      WHERE status = 'active' AND normalized_title = @title
        AND normalized_artist = @artist AND normalized_version = @version
    `).get(identity) as CatalogCandidate | undefined;
    const candidates = this.db.prepare(`
      SELECT id, title, artist, version, language, genre, difficulty,
             performance_type AS performanceType
      FROM songs
      WHERE status = 'active' AND id <> coalesce(@exactId, -1)
        AND normalized_title LIKE @titleLike
      ORDER BY id LIMIT 50
    `).all({ ...identity, exactId: exact?.id ?? null, titleLike: `%${identity.title}%` }) as CatalogCandidate[];
    return {
      exact,
      similar: candidates
        .map((song) => ({ song, score: similarityScore(input, song) }))
        .filter((item) => item.score >= 3)
        .sort((left, right) => right.score - left.score || left.song.id - right.song.id)
        .slice(0, 5)
        .map((item) => item.song)
    };
  }

  collectUserSong(userId: number, songId: number, personal: PersonalSongPayload): boolean {
    if (!personal.collectionType) return false;
    const song = this.db.prepare("SELECT id FROM songs WHERE id = ? AND status = 'active'").get(songId);
    if (!song) throw new Error('歌曲不存在或已删除，无法收录到个人曲库。');
    this.db.prepare(`
      INSERT INTO user_songs(user_id, song_id, collection_type, removed_at) VALUES (?, ?, ?, NULL)
      ON CONFLICT(user_id, song_id) DO UPDATE SET collection_type = excluded.collection_type, removed_at = NULL
    `).run(userId, songId, personal.collectionType);
    this.db.prepare(`
      INSERT INTO song_user_meta(user_id, song_id, override_diff, note, memory_cue, key_shift)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, song_id) DO UPDATE SET
        override_diff = coalesce(excluded.override_diff, override_diff),
        note = coalesce(excluded.note, note), memory_cue = coalesce(excluded.memory_cue, memory_cue),
        key_shift = coalesce(excluded.key_shift, key_shift), updated_at = datetime('now')
    `).run(userId, songId, personal.personalDifficulty ?? null, personal.note ?? null, personal.memoryCue ?? null, personal.keyShift ?? null);
    rebuildUserSongSearchIndex(this.db, userId, songId);
    return true;
  }

  createSong(input: SongIdentityInput & { language?: string | null | undefined; genre?: string | null | undefined; difficulty?: string | null | undefined; performanceType: string; lyrics?: string | null | undefined; lyricsTranslit?: string | null | undefined; addedBy: number }): number {
    const identity = normalizedSongIdentity(input);
    const index = buildSongIndex(input.title);
    const result = this.db.prepare(`
      INSERT INTO songs(title, artist, version, normalized_title, normalized_artist, normalized_version,
        language, genre, difficulty, performance_type, lyrics, lyrics_translit, pinyin, title_initial, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.title, input.artist, input.version ?? null, identity.title, identity.artist, identity.version,
      input.language ?? null, input.genre ?? null, input.difficulty ?? null, input.performanceType,
      input.lyrics ?? null, input.lyricsTranslit ?? null, index.pinyin, index.titleInitial, input.addedBy);
    const songId = Number(result.lastInsertRowid);
    rebuildSongSearchIndex(this.db, songId);
    return songId;
  }
}
