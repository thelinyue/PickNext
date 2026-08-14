import type Database from 'better-sqlite3';
import type {
  CollectionType,
  SearchSongsMetaResponse,
  SearchSongsQuickResponse,
  SongListItem,
  SongListScope
} from '@picknext/shared';
import { toFtsQuery } from './search-index.js';

type SearchQuery = {
  scope: SongListScope;
  collection?: CollectionType;
  q: string;
  languages: string[];
  genres: string[];
  difficulties: Array<'easy' | 'medium' | 'hard'>;
  minRating?: number;
  scene: string;
  limit: number;
  offset: number;
};

type SearchSql = { cte: string; params: Record<string, unknown>; order: string };

function bindList(params: Record<string, unknown>, prefix: string, values: string[]): string {
  return values.map((value, index) => {
    const key = `${prefix}${index}`;
    params[key] = value;
    return `@${key}`;
  }).join(', ');
}

function buildSearchSql(userId: number, query: SearchQuery): SearchSql {
  const params: Record<string, unknown> = {
    userId,
    collection: query.collection ?? null,
    query: query.q,
    term: `%${query.q}%`,
    compactTerm: `%${query.q.replace(/\s+/g, '')}%`,
    ftsQuery: toFtsQuery(query.q),
    minRating: query.minRating ?? null
  };
  const languageList = bindList(params, 'language', query.languages);
  const genreList = bindList(params, 'genre', query.genres);
  const difficultyList = bindList(params, 'difficulty', query.difficulties);
  const personal = query.scope === 'personal';
  const scopeFilter = personal ? 'us.collection_type = @collection' : '1 = 1';
  const scopeRating = personal ? 'rating' : 'aggregateRating';
  const scopeDifficulty = personal ? 'personalDifficulty' : 'referenceDifficulty';
  const sceneClauses: Record<string, string> = {
    all: '1 = 1', custom: '1 = 1',
    strong: personal ? 'rating >= 4' : '1 = 1',
    challenge: personal ? "personalDifficulty = 'hard'" : '1 = 1',
    recent: personal ? "lastPlayedAt >= datetime('now', '-7 days')" : '1 = 1',
    note: personal ? '(hasNote = 1 OR hasMemoryCue = 1)' : '1 = 1',
    new: personal ? "personalAddedAt >= datetime('now', '-30 days')" : "songCreatedAt >= datetime('now', '-30 days')",
    high: personal ? '1 = 1' : 'aggregateRating >= 4',
    hard: personal ? '1 = 1' : "referenceDifficulty = 'hard'"
  };
  const advancedClauses = [
    languageList ? `language IN (${languageList})` : '1 = 1',
    genreList ? `genre IN (${genreList})` : '1 = 1',
    difficultyList ? `${scopeDifficulty} IN (${difficultyList})` : '1 = 1',
    query.minRating ? `${scopeRating} >= @minRating` : '1 = 1',
    sceneClauses[query.scene] ?? '1 = 1'
  ].join(' AND ');
  const searchClauses = personal ? `
    @query = '' OR (
      @ftsQuery <> '' AND (id IN (SELECT song_id FROM song_search WHERE song_search MATCH @ftsQuery)
        OR id IN (SELECT song_id FROM user_song_search WHERE user_id = @userId AND user_song_search MATCH @ftsQuery))
    ) OR indexedPinyin LIKE @compactTerm OR title LIKE @term OR artist LIKE @term
    OR coalesce(version, '') LIKE @term OR coalesce(album, '') LIKE @term
    OR coalesce(lyrics, '') LIKE @term OR coalesce(lyricsTranslit, '') LIKE @term
    OR coalesce(personalNote, '') LIKE @term OR coalesce(personalMemoryCue, '') LIKE @term
    OR EXISTS (SELECT 1 FROM song_aliases a WHERE a.song_id = catalog.id AND a.alias LIKE @term)` : `
    @query = '' OR (
      @ftsQuery <> '' AND id IN (SELECT song_id FROM song_search WHERE song_search MATCH @ftsQuery)
    ) OR indexedPinyin LIKE @compactTerm OR title LIKE @term OR artist LIKE @term
    OR coalesce(version, '') LIKE @term OR coalesce(album, '') LIKE @term
    OR coalesce(lyrics, '') LIKE @term OR coalesce(lyricsTranslit, '') LIKE @term
    OR EXISTS (SELECT 1 FROM song_aliases a WHERE a.song_id = catalog.id AND a.alias LIKE @term)`;

  const personalColumns = personal ? `
    us.created_at AS personalAddedAt,
    coalesce(m.override_diff, s.difficulty) AS personalDifficulty,
    m.rating, m.key_shift AS keyShift, m.pick_snoozed_until AS snoozedUntil,
    m.note AS personalNote, m.memory_cue AS personalMemoryCue,
    CASE WHEN coalesce(m.note, '') <> '' THEN 1 ELSE 0 END AS hasNote,
    CASE WHEN coalesce(m.memory_cue, '') <> '' THEN 1 ELSE 0 END AS hasMemoryCue,
    coalesce(playStats.playCount, 0) AS playCount,
    playStats.lastPlayedAt,
    NULL AS aggregateRating, NULL AS aggregateRatingCount,` : `
    NULL AS personalAddedAt, NULL AS personalDifficulty,
    NULL AS rating, NULL AS keyShift, NULL AS snoozedUntil,
    NULL AS personalNote, NULL AS personalMemoryCue,
    0 AS hasNote, 0 AS hasMemoryCue, 0 AS playCount, NULL AS lastPlayedAt,
    ratings.aggregateRating, ratings.aggregateRatingCount,`;
  const personalJoin = personal ? `
    LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
    LEFT JOIN (
      SELECT song_id, count(*) AS playCount, max(played_at) AS lastPlayedAt
      FROM plays WHERE user_id = @userId GROUP BY song_id
    ) playStats ON playStats.song_id = s.id` : `
    LEFT JOIN (
      SELECT song_id, round(avg(rating), 1) AS aggregateRating, count(*) AS aggregateRatingCount
      FROM song_user_meta WHERE rating IS NOT NULL GROUP BY song_id HAVING count(*) >= 3
    ) ratings ON ratings.song_id = s.id`;
  const cte = `
    WITH catalog AS (
      SELECT s.id, s.title, s.artist, s.version, s.album, s.language, s.genre,
        s.difficulty AS referenceDifficulty, s.performance_type AS performanceType,
        s.pinyin, coalesce(s.title_initial, '#') AS titleInitial, s.created_at AS songCreatedAt,
        s.lyrics, s.lyrics_translit AS lyricsTranslit,
        us.collection_type AS collectionType,
        ${personalColumns}
        CASE WHEN coalesce(s.lyrics, '') <> '' THEN 1 ELSE 0 END AS hasLyrics,
        replace(coalesce(s.pinyin, ''), ' ', '') AS indexedPinyin,
        EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) AS hasCover
      FROM songs s
      LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
      ${personalJoin}
      WHERE s.status = 'active' AND ${scopeFilter}
    ), filtered AS (
      SELECT * FROM catalog WHERE (${searchClauses}) AND ${advancedClauses}
    )`;
  const order = query.q ? `ORDER BY CASE WHEN titleInitial = '#' THEN 1 ELSE 0 END,
    CASE WHEN lower(title) = lower(@query) OR lower(artist) = lower(@query) THEN 0
      WHEN id IN (SELECT song_id FROM song_search WHERE song_search MATCH @ftsQuery) THEN 1 ELSE 2 END,
    titleInitial, pinyin COLLATE NOCASE, title COLLATE NOCASE, artist COLLATE NOCASE` :
    'ORDER BY CASE WHEN titleInitial = \'#\' THEN 1 ELSE 0 END, titleInitial, pinyin COLLATE NOCASE, title COLLATE NOCASE, artist COLLATE NOCASE';
  return { cte, params, order };
}

function mapSong(row: any, scope: SongListScope): SongListItem {
  const base = {
    id: row.id, title: row.title, artist: row.artist, version: row.version, album: row.album,
    coverUrl: row.hasCover ? `/api/songs/${row.id}/cover` : null, language: row.language,
    genre: row.genre, performanceType: row.performanceType, titleInitial: row.titleInitial
  };
  return scope === 'personal' ? {
    ...base, scope, collectionType: row.collectionType, personalDifficulty: row.personalDifficulty,
    rating: row.rating, keyShift: row.keyShift, playCount: Number(row.playCount ?? 0),
    lastPlayedAt: row.lastPlayedAt ?? null, hasLyrics: Boolean(row.hasLyrics), hasNote: Boolean(row.hasNote),
    hasMemoryCue: Boolean(row.hasMemoryCue), snoozedUntil: row.snoozedUntil ?? null
  } : {
    ...base, scope, collectionType: row.collectionType ?? null, referenceDifficulty: row.referenceDifficulty ?? null,
    aggregateRating: row.aggregateRating ?? null, aggregateRatingCount: row.aggregateRatingCount ?? null
  };
}

/** 歌曲优先查询只做列表所需工作，limit + 1 用于判断下一页。 */
export function searchSongsQuick(db: Database.Database, userId: number, query: SearchQuery): SearchSongsQuickResponse {
  const sql = buildSearchSql(userId, query);
  const rows = db.prepare(`${sql.cte} SELECT * FROM filtered ${sql.order} LIMIT @fetchLimit OFFSET @offset`)
    .all({ ...sql.params, fetchLimit: query.limit + 1, offset: query.offset }) as any[];
  return { songs: rows.slice(0, query.limit).map((row) => mapSong(row, query.scope)), hasMore: rows.length > query.limit };
}

function splitFacet(value: string | null): string[] {
  return value ? [...new Set(value.split(',').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')) : [];
}

/** 元数据单独查询，歌曲接口慢时仍可先展示列表；缓存由应用层按用户维度管理。 */
export function searchSongsMeta(db: Database.Database, userId: number, query: SearchQuery): SearchSongsMetaResponse {
  const sql = buildSearchSql(userId, query);
  const grouped = db.prepare(`${sql.cte} SELECT titleInitial AS initial, count(*) AS count FROM filtered GROUP BY titleInitial ORDER BY CASE WHEN initial = '#' THEN 1 ELSE 0 END, initial`).all(sql.params) as Array<{ initial: string; count: number }>;
  const alphabetIndex = grouped.map((item, index) => ({
    initial: item.initial,
    count: Number(item.count),
    offset: grouped.slice(0, index).reduce((total, current) => total + Number(current.count), 0)
  }));
  const totals = db.prepare(`
    SELECT
      (SELECT count(*) FROM songs WHERE status = 'active') AS global,
      (SELECT count(*) FROM user_songs us JOIN songs s ON s.id = us.song_id
        WHERE us.user_id = @userId AND us.removed_at IS NULL AND s.status = 'active') AS personal,
      (SELECT count(*) FROM user_songs us JOIN songs s ON s.id = us.song_id
        WHERE us.user_id = @userId AND us.removed_at IS NULL AND s.status = 'active' AND us.collection_type = 'repertoire') AS repertoire,
      (SELECT count(*) FROM user_songs us JOIN songs s ON s.id = us.song_id
        WHERE us.user_id = @userId AND us.removed_at IS NULL AND s.status = 'active' AND us.collection_type = 'learning') AS learning
  `).get({ userId }) as { global: number; personal: number; repertoire: number; learning: number };
  const facetScope = query.scope === 'personal' ? 'AND us.collection_type = @collection' : '';
  const facets = db.prepare(`
    SELECT group_concat(DISTINCT s.language) AS languages, group_concat(DISTINCT s.genre) AS genres
    FROM songs s LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
    WHERE s.status = 'active' ${facetScope}
  `).get({ userId, collection: query.collection ?? null }) as { languages: string | null; genres: string | null };
  const total = grouped.reduce((sum, item) => sum + Number(item.count), 0);
  return {
    total,
    counts: { global: Number(totals.global), personal: Number(totals.personal), repertoire: Number(totals.repertoire), learning: Number(totals.learning) },
    facets: { languages: splitFacet(facets.languages), genres: splitFacet(facets.genres) },
    alphabetIndex
  };
}

export type { SearchQuery };
