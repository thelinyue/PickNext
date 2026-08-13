import type Database from 'better-sqlite3';

function hasSearchTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * 搜索索引同步器：公共歌曲资料和个人记忆字段分开维护。
 *
 * FTS5 表不是业务真相，songs、song_aliases、user_songs 和 song_user_meta
 * 才是唯一数据源。每次相关事务提交前同步对应行，启动时由 AppDatabase
 * 全量重建，既能兼容旧版本数据，也能避免搜索索引残留个人字段。
 */
export function rebuildSongSearchIndex(db: Database.Database, songId: number): void {
  if (!hasSearchTable(db, 'song_search')) return;
  db.prepare('DELETE FROM song_search WHERE song_id = ?').run(songId);
  const song = db.prepare(`
    SELECT s.id, s.title, s.artist, s.version, s.pinyin, s.lyrics,
           s.lyrics_translit AS lyricsTranslit,
           coalesce(group_concat(a.alias, ' '), '') AS aliases
    FROM songs s LEFT JOIN song_aliases a ON a.song_id = s.id
    WHERE s.id = ? AND s.status = 'active'
    GROUP BY s.id
  `).get(songId) as {
    id: number;
    title: string;
    artist: string;
    version: string | null;
    pinyin: string | null;
    lyrics: string | null;
    lyricsTranslit: string | null;
    aliases: string;
  } | undefined;
  if (!song) return;
  db.prepare(`
    INSERT INTO song_search(song_id, title, artist, version, pinyin, pinyin_compact, aliases, lyrics, lyrics_translit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(song.id, song.title, song.artist, song.version ?? '', song.pinyin ?? '', (song.pinyin ?? '').replace(/\s+/g, ''),
    song.aliases, song.lyrics ?? '', song.lyricsTranslit ?? '');
}

export function rebuildUserSongSearchIndex(db: Database.Database, userId: number, songId: number): void {
  if (!hasSearchTable(db, 'user_song_search')) return;
  db.prepare('DELETE FROM user_song_search WHERE user_id = ? AND song_id = ?').run(userId, songId);
  const row = db.prepare(`
    SELECT us.user_id AS userId, us.song_id AS songId, coalesce(m.note, '') AS note,
           coalesce(m.memory_cue, '') AS memoryCue
    FROM user_songs us
    JOIN songs s ON s.id = us.song_id AND s.status = 'active'
    LEFT JOIN song_user_meta m ON m.user_id = us.user_id AND m.song_id = us.song_id
    WHERE us.user_id = ? AND us.song_id = ? AND us.removed_at IS NULL
  `).get(userId, songId) as { userId: number; songId: number; note: string; memoryCue: string } | undefined;
  if (!row) return;
  db.prepare('INSERT INTO user_song_search(user_id, song_id, note, memory_cue) VALUES (?, ?, ?, ?)')
    .run(row.userId, row.songId, row.note, row.memoryCue);
}

/** 启动时重建两类索引，确保从旧版本升级或人工修复数据库后搜索仍然可信。 */
export function rebuildAllSearchIndexes(db: Database.Database): void {
  if (!hasSearchTable(db, 'song_search') || !hasSearchTable(db, 'user_song_search')) return;
  db.transaction(() => {
    db.exec('DELETE FROM song_search; DELETE FROM user_song_search;');
    const songs = db.prepare('SELECT id FROM songs WHERE status = \'active\' ORDER BY id').all() as Array<{ id: number }>;
    for (const song of songs) rebuildSongSearchIndex(db, song.id);
    const userSongs = db.prepare(`
      SELECT us.user_id AS userId, us.song_id AS songId
      FROM user_songs us JOIN songs s ON s.id = us.song_id AND s.status = 'active'
      WHERE us.removed_at IS NULL ORDER BY us.user_id, us.song_id
    `).all() as Array<{ userId: number; songId: number }>;
    for (const row of userSongs) rebuildUserSongSearchIndex(db, row.userId, row.songId);
  })();
}

/** 将用户输入转为无 SQL 注入风险的 FTS5 前缀查询；空值由调用方单独处理。 */
export function toFtsQuery(value: string): string {
  return value.normalize('NFKC').trim().split(/\s+/).filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"*`).join(' AND ');
}
