import { createHash, randomInt, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  buildWeightedQueue,
  createSeededRandom,
  PICK_ALGORITHM_VERSION,
  selectCandidatePool,
  type PickCandidate
} from '@picknext/pick-engine';
import type { PickContextResponse, PickFilters, PickRequest, PickResponse, PickSource } from '@picknext/shared';

interface CandidateRow {
  id: number;
  title: string;
  artist: string;
  version: string | null;
  language: string | null;
  genre: string | null;
  difficulty: 'easy' | 'medium' | 'hard' | null;
  performance_type: 'solo' | 'duet' | 'chorus';
  rating: number | null;
  key_shift: number | null;
  last_played_at: string | null;
}

interface QueueRow extends CandidateRow {
  queue_item_id: number;
  source: PickSource;
}

interface SessionRow {
  id: string;
  random_seed: number;
  last_activity_at: string;
  ended_at: string | null;
}

export class PickError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 409
  ) {
    super(message);
  }
}

/**
 * PickService 把“跳过当前项、选择来源、构建队列、取出下一项、记录事件”包在同一事务中。
 * 算法本身保留在纯 TypeScript 包中；此类只负责 SQLite 状态与幂等边界。
 */
export class PickService {
  constructor(private readonly db: Database.Database) {}

  /**
   * 从数据库恢复用户唯一的活动场次，并同时提供 Pick 首页所需的轻量上下文。
   * 这里不创建新场次，避免用户仅打开页面就污染历史；超过四小时的场次会被统一结束。
   */
  getContext(userId: number): PickContextResponse {
    return this.db.transaction(() => {
      const expired = this.db.prepare(`
        SELECT id FROM pick_sessions
        WHERE user_id = ? AND ended_at IS NULL
          AND last_activity_at < datetime('now', '-4 hours')
      `).all(userId) as Array<{ id: string }>;
      if (expired.length) {
        const ids = expired.map((item) => item.id);
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`UPDATE pick_sessions SET ended_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
        this.db.prepare(`UPDATE pick_queue_items SET status = 'invalidated' WHERE status = 'pending' AND session_id IN (${placeholders})`).run(...ids);
      }

      const session = this.db.prepare(`
        SELECT id FROM pick_sessions
        WHERE user_id = ? AND ended_at IS NULL
        ORDER BY last_activity_at DESC LIMIT 1
      `).get(userId) as { id: string } | undefined;
      if (session) {
        this.db.prepare(`UPDATE pick_sessions SET ended_at = datetime('now') WHERE user_id = ? AND ended_at IS NULL AND id <> ?`)
          .run(userId, session.id);
        this.db.prepare(`
          UPDATE pick_queue_items SET status = 'invalidated'
          WHERE status = 'pending' AND session_id IN (
            SELECT id FROM pick_sessions WHERE user_id = ? AND ended_at IS NOT NULL AND id <> ?
          )
        `).run(userId, session.id);
      }

      const currentRow = session ? this.db.prepare(`
        SELECT response_json FROM pick_events
        WHERE session_id = ? AND user_id = ? AND status = 'picked'
        ORDER BY created_at DESC LIMIT 1
      `).get(session.id, userId) as { response_json: string } | undefined : undefined;
      const latestEvent = session ? this.db.prepare(`
        SELECT source, status, filter_snapshot FROM pick_events
        WHERE session_id = ? AND user_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(session.id, userId) as { source: PickSource; status: string; filter_snapshot: string } | undefined : undefined;

      const emptyFilters: PickFilters = { languages: [], genres: [], difficulties: [], ratings: [], performanceTypes: [] };
      let filters = emptyFilters;
      let avoidRecent = true;
      if (latestEvent) {
        try {
          const snapshot = JSON.parse(latestEvent.filter_snapshot) as { filters?: PickFilters; avoidRecent?: boolean };
          filters = snapshot.filters ?? emptyFilters;
          avoidRecent = snapshot.avoidRecent ?? true;
        } catch {
          // 旧版本或手工数据的快照损坏时使用安全默认值，不影响场次恢复。
        }
      }

      const counts = this.db.prepare(`
        SELECT
          (SELECT count(*) FROM user_songs us JOIN songs s ON s.id = us.song_id
            WHERE us.user_id = @userId AND us.collection_type = 'repertoire'
              AND us.removed_at IS NULL AND s.status = 'active') AS repertoire,
          (SELECT count(*) FROM songs WHERE status = 'active') AS global,
          (SELECT count(*) FROM playlist_songs ps JOIN playlists p ON p.id = ps.playlist_id
            JOIN songs s ON s.id = ps.song_id
            WHERE p.owner_id = @userId AND p.kind = 'next_ktv' AND s.status = 'active') AS nextKtv
      `).get({ userId }) as { repertoire: number; global: number; nextKtv: number };
      const facets = this.db.prepare(`
        SELECT DISTINCT s.language, s.genre
        FROM user_songs us JOIN songs s ON s.id = us.song_id
        WHERE us.user_id = ? AND us.collection_type = 'repertoire'
          AND us.removed_at IS NULL AND s.status = 'active'
      `).all(userId) as Array<{ language: string | null; genre: string | null }>;

      return {
        sessionId: session?.id ?? null,
        current: currentRow ? this.parseStoredResponse(currentRow.response_json) : null,
        filters,
        avoidRecent,
        ktvExhausted: Boolean(session && !currentRow && latestEvent?.source === 'ktv' && counts.nextKtv === 0),
        counts,
        facets: {
          languages: [...new Set(facets.map((item) => item.language).filter((value): value is string => Boolean(value)))].sort(),
          genres: [...new Set(facets.map((item) => item.genre).filter((value): value is string => Boolean(value)))].sort()
        }
      };
    })();
  }

  pick(userId: number, input: PickRequest): PickResponse {
    try {
      return this.db.transaction(() => this.pickInTransaction(userId, input))();
    } catch (reason) {
      const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : null;
      if (code === 'NO_CANDIDATES' && input.sessionId && input.currentEventId) {
        /**
         * “跳过最后一首”没有下一首可返回，但跳过本身仍是有效操作。
         * 主事务因 NO_CANDIDATES 回滚后，在独立事务中只落跳过事件，再把耗尽状态返回给客户端。
         */
        this.db.transaction(() => {
          this.skipCurrentEvent(userId, input.sessionId!, input.currentEventId!);
          this.db.prepare(`UPDATE pick_sessions SET last_activity_at = datetime('now') WHERE id = ? AND user_id = ?`)
            .run(input.sessionId, userId);
        })();
      }
      throw reason;
    }
  }

  private pickInTransaction(userId: number, input: PickRequest): PickResponse {
    const duplicate = this.db
      .prepare('SELECT response_json FROM pick_events WHERE request_id = ? AND user_id = ?')
      .get(input.requestId, userId) as { response_json: string } | undefined;
    if (duplicate) return this.parseStoredResponse(duplicate.response_json);

    const session = this.resolveSession(userId, input.sessionId);
    const skippedSongId = input.currentEventId
      ? this.skipCurrentEvent(userId, session.id, input.currentEventId)
      : null;
    const filterSnapshot = JSON.stringify({ filters: input.filters, avoidRecent: input.avoidRecent });
    const filterHash = createHash('sha256').update(filterSnapshot).digest('hex');

    this.db
      .prepare(`UPDATE pick_queue_items SET status = 'invalidated'
                WHERE session_id = ? AND status = 'pending' AND filter_hash <> ?`)
      .run(session.id, filterHash);

    let next = this.nextQueuedSong(session.id, filterHash);
    let recentFilterRelaxed = false;
    let candidateCount = this.pendingCount(session.id, filterHash);

    if (!next) {
      const pools = this.loadPools(userId, session.id);
      const recentIds = new Set(
        (this.db.prepare(`
          SELECT song_id FROM plays WHERE user_id = ?
          GROUP BY song_id ORDER BY max(played_at) DESC LIMIT 10
        `).all(userId) as Array<{ song_id: number }>).map((row) => row.song_id)
      );
      const selection = selectCandidatePool(
        pools,
        input.filters,
        recentIds,
        input.avoidRecent,
        input.continueFromRepertoire
      );
      if (!selection.source || selection.candidates.length === 0) {
        const repertoireTotal = pools.repertoireTotal;
        throw new PickError(
          repertoireTotal > 0 ? '当前筛选下没有可 Pick 的歌曲，请调整筛选或结束本场。' : '曲库中还没有可 Pick 的歌曲，请先添加歌曲。',
          'NO_CANDIDATES'
        );
      }
      recentFilterRelaxed = selection.recentFilterRelaxed;
      candidateCount = selection.candidates.length;
      const priorEvents = this.db
        .prepare('SELECT count(*) AS count FROM pick_events WHERE session_id = ?')
        .get(session.id) as { count: number };
      const queue = buildWeightedQueue(
        selection.candidates,
        createSeededRandom(session.random_seed + priorEvents.count)
      );
      const insert = this.db.prepare(`
        INSERT INTO pick_queue_items(
          session_id, song_id, source, position, filter_hash, recency_weight,
          artist_factor, genre_factor, difficulty_factor, final_weight, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `);
      for (const item of queue) {
        insert.run(
          session.id,
          item.songId,
          selection.source,
          item.position,
          filterHash,
          item.recencyWeight,
          item.artistFactor,
          item.genreFactor,
          item.difficultyFactor,
          item.finalWeight
        );
      }
      next = this.nextQueuedSong(session.id, filterHash);
    }

    if (!next) throw new PickError('Pick 队列生成失败，请稍后重试。', 'QUEUE_BUILD_FAILED', 500);
    this.db.prepare(`UPDATE pick_queue_items SET status = 'picked' WHERE id = ? AND status = 'pending'`).run(next.queue_item_id);

    const eventId = randomUUID();
    const reason = this.pickReason(next, recentFilterRelaxed);
    const response: PickResponse = {
      sessionId: session.id,
      eventId,
      source: next.source,
      song: {
        id: next.id,
        title: next.title,
        artist: next.artist,
        version: next.version,
        language: next.language,
        genre: next.genre,
        difficulty: next.difficulty,
        performanceType: next.performance_type,
        rating: next.rating,
        keyShift: next.key_shift
      },
      candidateCount,
      reason,
      recentFilterRelaxed,
      algorithmVersion: PICK_ALGORITHM_VERSION,
      skipSuggestion: skippedSongId === null ? null : this.getSkipSuggestion(userId, skippedSongId)
    };
    this.db.prepare(`
      INSERT INTO pick_events(
        id, session_id, queue_item_id, user_id, song_id, source, candidate_count,
        filter_snapshot, recent_filter_relaxed, request_id, algorithm_version, response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      session.id,
      next.queue_item_id,
      userId,
      next.id,
      next.source,
      candidateCount,
      filterSnapshot,
      recentFilterRelaxed ? 1 : 0,
      input.requestId,
      PICK_ALGORITHM_VERSION,
      JSON.stringify(response)
    );
    this.db.prepare(`UPDATE pick_sessions SET last_activity_at = datetime('now') WHERE id = ?`).run(session.id);
    return response;
  }

  private resolveSession(userId: number, requestedId?: string): SessionRow {
    if (requestedId) {
      const existing = this.db
        .prepare('SELECT id, random_seed, last_activity_at, ended_at FROM pick_sessions WHERE id = ? AND user_id = ?')
        .get(requestedId, userId) as SessionRow | undefined;
      if (existing && !existing.ended_at) {
        const inactiveMs = Date.now() - new Date(`${existing.last_activity_at}Z`).getTime();
        if (inactiveMs <= 4 * 60 * 60 * 1000) return existing;
        this.db.prepare(`UPDATE pick_sessions SET ended_at = datetime('now') WHERE id = ?`).run(existing.id);
      }
    }
    const created: SessionRow = {
      id: randomUUID(),
      random_seed: randomInt(1, 2_147_483_647),
      last_activity_at: new Date().toISOString(),
      ended_at: null
    };
    this.db.prepare(`
      INSERT INTO pick_sessions(id, user_id, random_seed, algorithm_version, started_at, last_activity_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(created.id, userId, created.random_seed, PICK_ALGORITHM_VERSION);
    return created;
  }

  private skipCurrentEvent(userId: number, sessionId: string, eventId: string): number | null {
    const event = this.db.prepare(`
      SELECT song_id, queue_item_id FROM pick_events
      WHERE id = ? AND user_id = ? AND session_id = ? AND status = 'picked'
    `).get(eventId, userId, sessionId) as { song_id: number; queue_item_id: number } | undefined;
    if (!event) return null;
    this.db.prepare(`UPDATE pick_events SET status = 'skipped', completed_at = datetime('now') WHERE id = ?`).run(eventId);
    this.db.prepare(`UPDATE pick_queue_items SET status = 'skipped' WHERE id = ?`).run(event.queue_item_id);
    return event.song_id;
  }

  private loadPools(userId: number, sessionId: string) {
    const common = `
      SELECT s.id, s.title, s.artist, s.version, s.language, s.genre,
             coalesce(m.override_diff, s.difficulty) AS difficulty,
             s.performance_type, m.rating, m.key_shift,
             (SELECT max(p.played_at) FROM plays p WHERE p.user_id = @userId AND p.song_id = s.id) AS last_played_at
      FROM songs s
      LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
    `;
    const exclusions = `
      s.status = 'active'
      AND (m.pick_snoozed_until IS NULL OR m.pick_snoozed_until <= datetime('now'))
      AND NOT EXISTS (SELECT 1 FROM pick_events e WHERE e.session_id = @sessionId AND e.song_id = s.id)
    `;
    const map = (rows: CandidateRow[]): PickCandidate[] => rows.map((row) => ({
      id: row.id,
      artists: row.artist.split(/[、,&/]/).map((part) => part.trim()).filter(Boolean),
      language: row.language,
      genre: row.genre,
      difficulty: row.difficulty,
      performanceType: row.performance_type,
      rating: row.rating,
      lastPlayedAt: row.last_played_at
    }));
    const params = { userId, sessionId };
    const ktv = this.db.prepare(`${common}
      JOIN playlist_songs ps ON ps.song_id = s.id
      JOIN playlists pl ON pl.id = ps.playlist_id AND pl.owner_id = @userId AND pl.kind = 'next_ktv'
      WHERE ${exclusions}
    `).all(params) as CandidateRow[];
    const repertoire = this.db.prepare(`${common}
      JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId
        AND us.collection_type = 'repertoire' AND us.removed_at IS NULL
      WHERE ${exclusions}
    `).all(params) as CandidateRow[];
    const global = this.db.prepare(`${common} WHERE ${exclusions}`).all(params) as CandidateRow[];
    const total = this.db.prepare(`
      SELECT count(*) AS count FROM user_songs us JOIN songs s ON s.id = us.song_id
      WHERE us.user_id = ? AND us.collection_type = 'repertoire' AND us.removed_at IS NULL AND s.status = 'active'
    `).get(userId) as { count: number };
    return { ktv: map(ktv), repertoire: map(repertoire), global: map(global), repertoireTotal: total.count };
  }

  private nextQueuedSong(sessionId: string, filterHash: string): QueueRow | undefined {
    return this.db.prepare(`
      SELECT qi.id AS queue_item_id, qi.source, s.id, s.title, s.artist, s.version, s.language,
             s.genre, coalesce(m.override_diff, s.difficulty) AS difficulty, s.performance_type,
             m.rating, m.key_shift,
             (SELECT max(p.played_at) FROM plays p WHERE p.user_id = session.user_id AND p.song_id = s.id) AS last_played_at
      FROM pick_queue_items qi JOIN songs s ON s.id = qi.song_id
      JOIN pick_sessions session ON session.id = qi.session_id
      LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = session.user_id
      WHERE qi.session_id = ? AND qi.filter_hash = ? AND qi.status = 'pending' AND s.status = 'active'
      ORDER BY qi.position ASC, qi.id ASC LIMIT 1
    `).get(sessionId, filterHash) as QueueRow | undefined;
  }

  private pendingCount(sessionId: string, filterHash: string): number {
    return (this.db.prepare(`
      SELECT count(*) AS count FROM pick_queue_items WHERE session_id = ? AND filter_hash = ? AND status = 'pending'
    `).get(sessionId, filterHash) as { count: number }).count;
  }

  private pickReason(song: QueueRow, relaxed: boolean): string {
    if (relaxed) return '已放宽避近期';
    if (song.source === 'ktv') return '来自下一次 KTV';
    if (song.source === 'global') return '曲库为空 · 来自全部曲库';
    if (!song.last_played_at) return '从未记录演唱';
    const days = Math.max(0, Math.floor((Date.now() - new Date(song.last_played_at).getTime()) / 86_400_000));
    return days > 60 ? `好久没唱 · ${days}天` : '来自会唱曲库';
  }

  private hasThreeSessionSkips(userId: number, songId: number): boolean {
    const rows = this.db.prepare(`
      SELECT session_id, status FROM pick_events
      WHERE user_id = ? AND song_id = ? AND status IN ('skipped', 'played')
      ORDER BY created_at DESC
    `).all(userId, songId) as Array<{ session_id: string; status: string }>;
    const distinct = rows.filter((row, index) => rows.findIndex((other) => other.session_id === row.session_id) === index);
    return distinct.length >= 3 && distinct.slice(0, 3).every((row) => row.status === 'skipped');
  }

  /** 兼容 v0.2.0 已保存的布尔跳过建议，旧记录没有足够信息支持操作面板，因此安全降级为无建议。 */
  private parseStoredResponse(value: string): PickResponse {
    const response = JSON.parse(value) as PickResponse & { skipSuggestion?: PickResponse['skipSuggestion'] | boolean };
    return { ...response, skipSuggestion: typeof response.skipSuggestion === 'object' ? response.skipSuggestion : null };
  }

  /** 只有仍在会唱曲库中的歌曲才提供连续跳过建议，避免全局冷启动歌曲出现无效操作。 */
  private getSkipSuggestion(userId: number, songId: number): PickResponse['skipSuggestion'] {
    const song = this.db.prepare(`
      SELECT s.id AS songId, s.title, s.artist, s.version
      FROM user_songs us JOIN songs s ON s.id = us.song_id
      WHERE us.user_id = ? AND us.song_id = ? AND us.collection_type = 'repertoire'
        AND us.removed_at IS NULL AND s.status = 'active'
    `).get(userId, songId) as PickResponse['skipSuggestion'] | undefined;
    return song && this.hasThreeSessionSkips(userId, songId) ? song : null;
  }
}
