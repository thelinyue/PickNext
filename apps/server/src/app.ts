import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import middie from '@fastify/middie';
import staticPlugin from '@fastify/static';
import { ZodError, z } from 'zod';
import {
  adminCreateUserSchema,
  adminResetPasswordSchema,
  adminUpdateUserSchema,
  collectionUpdateSchema,
  completePickSchema,
  createSongSchema,
  importSchema,
  loginSchema,
  notePickSchema,
  pickRequestSchema,
  searchSongsQuerySchema,
  setupSchema,
  snoozeSchema
} from '@picknext/shared';
import { hashPassword, verifyPassword } from './auth.js';
import { PickError, PickService } from './pick-service.js';
import type { AppContext, UserPayload } from './types.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const eventParamSchema = z.object({ eventId: z.string().uuid() });
const taskParamSchema = z.object({ id: z.string().uuid() });

function currentUser(request: FastifyRequest): UserPayload {
  return request.user as UserPayload;
}

/** Fastify 应用工厂保持无全局状态，测试可用 inject() 连接独立内存数据库。 */
export async function buildApp(context: AppContext) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const pickService = new PickService(context.db);
  await app.register(cookie);
  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? '仅供本地开发-生产环境必须设置-JWT_SECRET-至少32位',
    cookie: { cookieName: 'picknext_session', signed: false }
  });

  if (context.devWebRoot) {
    await app.register(middie);
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: context.devWebRoot,
      appType: 'spa',
      server: {
        middlewareMode: true,
        hmr: { server: app.server }
      }
    });
    app.use((request, response, next) => {
      const url = request.url ?? '/';
      if (url === '/api' || url.startsWith('/api/')) {
        next();
        return;
      }
      vite.middlewares(request, response, next);
    });
    app.addHook('onClose', async () => {
      await vite.close();
    });
  }

  const requireUser = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const token = await request.jwtVerify<UserPayload>();
      const row = context.db.prepare(`
        SELECT id, username, role, is_maintainer AS isMaintainer, can_add_songs AS canAddSongs
        FROM users WHERE id = ?
      `).get(token.id) as any;
      if (!row) throw new Error('账号不存在');
      request.user = { ...row, isMaintainer: Boolean(row.isMaintainer), canAddSongs: Boolean(row.canAddSongs) };
    } catch {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: '登录已失效，请重新登录。' });
    }
  };

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    await requireUser(request, reply);
    if (reply.sent) return;
    if (currentUser(request).role !== 'admin') {
      return reply.code(403).send({ code: 'FORBIDDEN', message: '只有管理员可以管理用户和权限。' });
    }
  };

  const issueSession = async (reply: FastifyReply, user: UserPayload) => {
    const token = await reply.jwtSign(user, { expiresIn: '30d' });
    reply.setCookie('picknext_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60
    });
  };

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/setup/status', async () => ({
    required: (context.db.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count === 0
  }));

  app.post('/api/setup', async (request, reply) => {
    const body = setupSchema.parse(request.body);
    if ((context.db.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count > 0) {
      return reply.code(409).send({ code: 'ALREADY_SETUP', message: '系统已经完成初始化。' });
    }
    const result = context.db.prepare(`
      INSERT INTO users(username, password_hash, role) VALUES (?, ?, 'admin')
    `).run(body.username, await hashPassword(body.password));
    const user: UserPayload = { id: Number(result.lastInsertRowid), username: body.username, role: 'admin', isMaintainer: false, canAddSongs: true };
    context.db.prepare(`INSERT INTO playlists(owner_id, name, kind) VALUES (?, '下一次 KTV', 'next_ktv')`).run(user.id);
    await issueSession(reply, user);
    return { user };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const row = context.db.prepare(`
      SELECT id, username, role, password_hash, is_maintainer, can_add_songs
      FROM users WHERE username = ? COLLATE NOCASE
    `).get(body.username) as any;
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: '用户名或密码不正确。' });
    }
    const user: UserPayload = {
      id: row.id,
      username: row.username,
      role: row.role,
      isMaintainer: Boolean(row.is_maintainer),
      canAddSongs: Boolean(row.can_add_songs)
    };
    await issueSession(reply, user);
    return { user };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('picknext_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', { preHandler: requireUser }, async (request) => ({ user: currentUser(request) }));

  /** 管理员用户管理保持最小闭环：创建账号、授予曲库管家、控制添加权限和重置密码。 */
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({
    users: (context.db.prepare(`
      SELECT id, username, role, is_maintainer AS isMaintainer, can_add_songs AS canAddSongs,
             created_at AS createdAt
      FROM users ORDER BY role = 'admin' DESC, created_at, username COLLATE NOCASE
    `).all() as any[]).map((user) => ({ ...user, isMaintainer: Boolean(user.isMaintainer), canAddSongs: Boolean(user.canAddSongs) }))
  }));

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
    const body = adminCreateUserSchema.parse(request.body);
    const existing = context.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(body.username);
    if (existing) return reply.code(409).send({ code: 'USERNAME_EXISTS', message: '这个用户名已经存在。' });
    const passwordHash = await hashPassword(body.password);
    const userId = context.db.transaction(() => {
      const result = context.db.prepare(`
        INSERT INTO users(username, password_hash, role, is_maintainer, can_add_songs)
        VALUES (?, ?, 'user', ?, ?)
      `).run(body.username, passwordHash, body.isMaintainer ? 1 : 0, body.canAddSongs ? 1 : 0);
      const id = Number(result.lastInsertRowid);
      context.db.prepare(`INSERT INTO playlists(owner_id, name, kind) VALUES (?, '下一次 KTV', 'next_ktv')`).run(id);
      return id;
    })();
    return reply.code(201).send({ userId });
  });

  app.put('/api/admin/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = adminUpdateUserSchema.parse(request.body);
    const target = context.db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | undefined;
    if (!target) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个用户。' });
    if (target.role === 'admin') return reply.code(409).send({ code: 'ADMIN_LOCKED', message: '管理员账号的权限不能在这里降级。' });
    context.db.prepare(`
      UPDATE users SET is_maintainer = coalesce(@isMaintainer, is_maintainer),
                       can_add_songs = coalesce(@canAddSongs, can_add_songs)
      WHERE id = @id
    `).run({ id, isMaintainer: body.isMaintainer === undefined ? null : body.isMaintainer ? 1 : 0, canAddSongs: body.canAddSongs === undefined ? null : body.canAddSongs ? 1 : 0 });
    return { ok: true };
  });

  app.put('/api/admin/users/:id/password', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = adminResetPasswordSchema.parse(request.body);
    const result = context.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.password), id);
    if (!result.changes) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个用户。' });
    return { ok: true };
  });

  app.get('/api/songs', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ collection: z.enum(['repertoire', 'learning']).optional() }).parse(request.query);
    const rows = context.db.prepare(`
      SELECT s.id, s.title, s.artist, s.version, s.language, s.genre,
             coalesce(m.override_diff, s.difficulty) AS difficulty, s.performance_type AS performanceType,
             us.collection_type AS collectionType, m.rating, m.key_shift AS keyShift,
             m.note, m.memory_cue AS memoryCue, m.pick_snoozed_until AS snoozedUntil,
             (SELECT max(played_at) FROM plays p WHERE p.user_id = @userId AND p.song_id = s.id) AS lastPlayedAt
      FROM user_songs us JOIN songs s ON s.id = us.song_id
      LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
      WHERE us.user_id = @userId AND us.removed_at IS NULL AND s.status = 'active'
        AND (@collection IS NULL OR us.collection_type = @collection)
      ORDER BY s.artist COLLATE NOCASE, s.title COLLATE NOCASE
    `).all({ userId: user.id, collection: query.collection ?? null });
    return { songs: rows };
  });

  app.post('/api/songs', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    if (!user.canAddSongs) return reply.code(403).send({ code: 'FORBIDDEN', message: '管理员已关闭你的歌曲添加权限。' });
    const body = createSongSchema.parse(request.body);
    const result = context.db.transaction(() => {
      let song = context.db.prepare(`
        SELECT id FROM songs WHERE title = ? COLLATE NOCASE AND artist = ? COLLATE NOCASE
          AND coalesce(version, '') = coalesce(?, '') AND status = 'active'
      `).get(body.title, body.artist, body.version ?? null) as { id: number } | undefined;
      if (!song) {
        const inserted = context.db.prepare(`
          INSERT INTO songs(title, artist, version, language, genre, difficulty, performance_type,
                            lyrics, lyrics_translit, added_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          body.title, body.artist, body.version ?? null, body.language ?? null, body.genre ?? null,
          body.difficulty ?? null, body.performanceType, body.lyrics ?? null, body.lyricsTranslit ?? null, user.id
        );
        song = { id: Number(inserted.lastInsertRowid) };
        const aliasInsert = context.db.prepare('INSERT INTO song_aliases(song_id, alias) VALUES (?, ?)');
        for (const alias of body.aliases) aliasInsert.run(song.id, alias);
      }
      context.db.prepare(`
        INSERT INTO user_songs(user_id, song_id, collection_type, removed_at) VALUES (?, ?, ?, NULL)
        ON CONFLICT(user_id, song_id) DO UPDATE SET collection_type = excluded.collection_type, removed_at = NULL
      `).run(user.id, song.id, body.collectionType);
      return song;
    })();
    return reply.code(201).send({ songId: result.id });
  });

  app.get('/api/search', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = searchSongsQuerySchema.parse(request.query);
    const term = `%${query.q}%`;
    const scopeFilter = query.scope === 'personal' ? 'AND us.collection_type = @collection' : '';
    const searchFilter = `
      s.status = 'active' ${scopeFilter} AND (
        @query = '' OR s.title LIKE @term OR s.artist LIKE @term OR coalesce(s.version, '') LIKE @term
        OR coalesce(s.lyrics, '') LIKE @term OR coalesce(s.lyrics_translit, '') LIKE @term
        OR coalesce(s.pinyin, '') LIKE @term OR coalesce(a.alias, '') LIKE @term
        OR coalesce(m.note, '') LIKE @term OR coalesce(m.memory_cue, '') LIKE @term
      )`;
    const params = {
      userId: user.id,
      collection: query.collection ?? null,
      query: query.q,
      term,
      limit: query.limit,
      offset: query.offset
    };
    const rawSongs = context.db.prepare(`
      SELECT DISTINCT s.id, s.title, s.artist, s.version, s.language, s.genre, s.difficulty,
             s.performance_type AS performanceType, us.collection_type AS collectionType,
             coalesce(m.override_diff, s.difficulty) AS personalDifficulty,
             m.rating, m.key_shift AS keyShift, m.pick_snoozed_until AS snoozedUntil,
             CASE WHEN coalesce(s.lyrics, '') <> '' THEN 1 ELSE 0 END AS hasLyrics,
             CASE WHEN coalesce(m.note, '') <> '' THEN 1 ELSE 0 END AS hasNote,
             CASE WHEN coalesce(m.memory_cue, '') <> '' THEN 1 ELSE 0 END AS hasMemoryCue,
             (SELECT count(*) FROM plays p WHERE p.user_id = @userId AND p.song_id = s.id) AS playCount,
             (SELECT max(played_at) FROM plays p WHERE p.user_id = @userId AND p.song_id = s.id) AS lastPlayedAt,
             CASE WHEN (SELECT count(*) FROM song_user_meta aggregate_meta
                         WHERE aggregate_meta.song_id = s.id AND aggregate_meta.rating IS NOT NULL) >= 3
                  THEN round((SELECT avg(aggregate_meta.rating) FROM song_user_meta aggregate_meta
                              WHERE aggregate_meta.song_id = s.id AND aggregate_meta.rating IS NOT NULL), 1)
                  ELSE NULL END AS aggregateRating,
             CASE WHEN (SELECT count(*) FROM song_user_meta aggregate_meta
                         WHERE aggregate_meta.song_id = s.id AND aggregate_meta.rating IS NOT NULL) >= 3
                  THEN (SELECT count(*) FROM song_user_meta aggregate_meta
                        WHERE aggregate_meta.song_id = s.id AND aggregate_meta.rating IS NOT NULL)
                  ELSE NULL END AS aggregateRatingCount
      FROM songs s
      LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
      LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
      LEFT JOIN song_aliases a ON a.song_id = s.id
      WHERE ${searchFilter}
      ORDER BY s.artist COLLATE NOCASE, s.title COLLATE NOCASE
      LIMIT @limit OFFSET @offset
    `).all(params) as any[];
    const total = (context.db.prepare(`
      SELECT count(DISTINCT s.id) AS count
      FROM songs s
      LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
      LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
      LEFT JOIN song_aliases a ON a.song_id = s.id
      WHERE ${searchFilter}
    `).get(params) as { count: number }).count;
    const counts = context.db.prepare(`
      SELECT
        (SELECT count(*) FROM songs WHERE status = 'active') AS global,
        (SELECT count(*) FROM user_songs us JOIN songs s ON s.id = us.song_id
          WHERE us.user_id = @userId AND us.removed_at IS NULL AND s.status = 'active') AS personal,
        (SELECT count(*) FROM user_songs us JOIN songs s ON s.id = us.song_id
          WHERE us.user_id = @userId AND us.removed_at IS NULL AND s.status = 'active' AND us.collection_type = 'repertoire') AS repertoire,
        (SELECT count(*) FROM user_songs us JOIN songs s ON s.id = us.song_id
          WHERE us.user_id = @userId AND us.removed_at IS NULL AND s.status = 'active' AND us.collection_type = 'learning') AS learning
    `).get({ userId: user.id }) as { global: number; personal: number; repertoire: number; learning: number };
    const songs = rawSongs.map((song) => query.scope === 'personal' ? {
      scope: 'personal' as const,
      id: song.id,
      title: song.title,
      artist: song.artist,
      version: song.version,
      language: song.language,
      genre: song.genre,
      performanceType: song.performanceType,
      collectionType: song.collectionType,
      personalDifficulty: song.personalDifficulty,
      rating: song.rating,
      keyShift: song.keyShift,
      playCount: song.playCount,
      lastPlayedAt: song.lastPlayedAt,
      hasLyrics: Boolean(song.hasLyrics),
      hasNote: Boolean(song.hasNote),
      hasMemoryCue: Boolean(song.hasMemoryCue),
      snoozedUntil: song.snoozedUntil
    } : {
      scope: 'global' as const,
      id: song.id,
      title: song.title,
      artist: song.artist,
      version: song.version,
      language: song.language,
      genre: song.genre,
      performanceType: song.performanceType,
      collectionType: song.collectionType,
      referenceDifficulty: song.difficulty,
      aggregateRating: song.aggregateRating,
      aggregateRatingCount: song.aggregateRatingCount
    });
    return { songs, total, hasMore: query.offset + songs.length < total, counts };
  });

  app.get('/api/songs/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const song = context.db.prepare(`
      SELECT s.id, s.title, s.artist, s.version, s.language, s.genre, s.difficulty,
             s.performance_type AS performanceType, s.lyrics, s.lyrics_translit AS lyricsTranslit,
             us.collection_type AS collectionType, m.rating, m.note, m.key_shift AS keyShift,
             m.memory_cue AS memoryCue
      FROM songs s LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
      LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
      WHERE s.id = @id AND s.status = 'active'
    `).get({ id, userId: user.id });
    return song ?? reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这首歌。' });
  });

  app.put('/api/songs/:id/lyrics', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const body = z.object({ lyrics: z.string().max(200_000), lyricsTranslit: z.string().max(200_000).optional() }).parse(request.body);
    const song = context.db.prepare('SELECT added_by FROM songs WHERE id = ? AND status = \'active\'').get(id) as { added_by: number } | undefined;
    if (!song) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这首歌。' });
    if (user.role !== 'admin' && !user.isMaintainer && song.added_by !== user.id) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: '只有歌曲创建者或管理员可以修改全局歌词。' });
    }
    context.db.prepare('UPDATE songs SET lyrics = ?, lyrics_translit = coalesce(?, lyrics_translit) WHERE id = ?').run(body.lyrics, body.lyricsTranslit ?? null, id);
    return { ok: true };
  });

  const invalidateQueues = (userId: number) => context.db.prepare(`
    UPDATE pick_queue_items SET status = 'invalidated' WHERE status = 'pending' AND session_id IN (
      SELECT id FROM pick_sessions WHERE user_id = ? AND ended_at IS NULL
    )
  `).run(userId);

  app.put('/api/user-songs/:id/collection', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const body = collectionUpdateSchema.parse(request.body);
    context.db.prepare(`
      INSERT INTO user_songs(user_id, song_id, collection_type, removed_at) VALUES (?, ?, ?, NULL)
      ON CONFLICT(user_id, song_id) DO UPDATE SET collection_type = excluded.collection_type, removed_at = NULL
    `).run(user.id, id, body.collectionType);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.delete('/api/user-songs/:id', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    context.db.prepare(`UPDATE user_songs SET removed_at = datetime('now') WHERE user_id = ? AND song_id = ?`).run(user.id, id);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.put('/api/user-songs/:id/snooze', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const body = snoozeSchema.parse(request.body);
    context.db.prepare(`
      INSERT INTO song_user_meta(user_id, song_id, pick_snoozed_until) VALUES (?, ?, ?)
      ON CONFLICT(user_id, song_id) DO UPDATE SET pick_snoozed_until = excluded.pick_snoozed_until, updated_at = datetime('now')
    `).run(user.id, id, body.until);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.delete('/api/user-songs/:id/snooze', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    context.db.prepare(`UPDATE song_user_meta SET pick_snoozed_until = NULL, updated_at = datetime('now') WHERE user_id = ? AND song_id = ?`).run(user.id, id);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.post('/api/picks', { preHandler: requireUser }, async (request) =>
    pickService.pick(currentUser(request).id, pickRequestSchema.parse(request.body))
  );

  app.post('/api/picks/:eventId/complete', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { eventId } = eventParamSchema.parse(request.params);
    const body = completePickSchema.parse(request.body);
    return context.db.transaction(() => {
      const event = context.db.prepare(`
        SELECT e.song_id, e.session_id, e.queue_item_id, e.status, m.rating AS current_rating
        FROM pick_events e LEFT JOIN song_user_meta m ON m.user_id = e.user_id AND m.song_id = e.song_id
        WHERE e.id = ? AND e.user_id = ?
      `).get(eventId, user.id) as any;
      if (!event) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这次 Pick 记录。' });
      if (event.status === 'played') return { ok: true, alreadyCompleted: true };
      if (event.status !== 'picked') return reply.code(409).send({ code: 'ALREADY_SKIPPED', message: '这首歌已经被跳过，无法再标记唱完。' });
      if (event.current_rating === null && body.rating === undefined) {
        return reply.code(422).send({ code: 'RATING_REQUIRED', message: '第一次唱完，请先记录长期演唱把握。' });
      }
      context.db.prepare(`
        INSERT INTO plays(user_id, song_id, pick_session_id, pick_event_id, note, rating_snapshot)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(user.id, event.song_id, event.session_id, eventId, body.note ?? null, body.rating ?? event.current_rating);
      context.db.prepare(`
        INSERT INTO song_user_meta(user_id, song_id, rating, note, key_shift) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, song_id) DO UPDATE SET
          rating = coalesce(excluded.rating, song_user_meta.rating),
          note = coalesce(excluded.note, song_user_meta.note),
          key_shift = coalesce(excluded.key_shift, song_user_meta.key_shift), updated_at = datetime('now')
      `).run(user.id, event.song_id, body.rating ?? null, body.note ?? null, body.keyShift ?? null);
      context.db.prepare(`UPDATE pick_events SET status = 'played', note = ?, completed_at = datetime('now') WHERE id = ?`).run(body.note ?? null, eventId);
      context.db.prepare(`UPDATE pick_queue_items SET status = 'played' WHERE id = ?`).run(event.queue_item_id);
      context.db.prepare(`
        DELETE FROM playlist_songs WHERE song_id = ? AND playlist_id IN (
          SELECT id FROM playlists WHERE owner_id = ? AND kind = 'next_ktv'
        )
      `).run(event.song_id, user.id);
      return { ok: true, alreadyCompleted: false };
    })();
  });

  app.post('/api/picks/:eventId/note', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { eventId } = eventParamSchema.parse(request.params);
    const body = notePickSchema.parse(request.body);
    const event = context.db.prepare('SELECT song_id FROM pick_events WHERE id = ? AND user_id = ?').get(eventId, user.id) as { song_id: number } | undefined;
    if (!event) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这次 Pick 记录。' });
    context.db.prepare(`
      INSERT INTO song_user_meta(user_id, song_id, rating, note, key_shift) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, song_id) DO UPDATE SET
        rating = coalesce(excluded.rating, song_user_meta.rating), note = coalesce(excluded.note, song_user_meta.note),
        key_shift = coalesce(excluded.key_shift, song_user_meta.key_shift), updated_at = datetime('now')
    `).run(user.id, event.song_id, body.rating ?? null, body.note ?? null, body.keyShift ?? null);
    context.db.prepare('UPDATE pick_events SET note = coalesce(?, note) WHERE id = ?').run(body.note ?? null, eventId);
    return { ok: true };
  });

  app.post('/api/pick-sessions/:id/end', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const sessionId = z.object({ id: z.string().uuid() }).parse(request.params).id;
    context.db.transaction(() => {
      context.db.prepare(`UPDATE pick_sessions SET ended_at = datetime('now') WHERE id = ? AND user_id = ? AND ended_at IS NULL`).run(sessionId, user.id);
      context.db.prepare(`UPDATE pick_queue_items SET status = 'invalidated' WHERE session_id = ? AND status = 'pending'`).run(sessionId);
    })();
    return { ok: true };
  });

  app.get('/api/history', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    return { plays: context.db.prepare(`
      SELECT p.id, p.played_at AS playedAt, p.note, p.rating_snapshot AS rating,
             s.id AS songId, s.title, s.artist, s.version
      FROM plays p JOIN songs s ON s.id = p.song_id WHERE p.user_id = ? ORDER BY p.played_at DESC LIMIT 200
    `).all(user.id) };
  });

  app.get('/api/playlists/next-ktv', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const playlist = context.db.prepare(`SELECT id, name FROM playlists WHERE owner_id = ? AND kind = 'next_ktv'`).get(user.id) as any;
    const songs = playlist ? context.db.prepare(`
      SELECT s.id, s.title, s.artist, s.version FROM playlist_songs ps JOIN songs s ON s.id = ps.song_id
      WHERE ps.playlist_id = ? ORDER BY ps.position, ps.created_at
    `).all(playlist.id) : [];
    return { playlist, songs };
  });

  app.put('/api/playlists/next-ktv/:id', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    let playlist = context.db.prepare(`SELECT id FROM playlists WHERE owner_id = ? AND kind = 'next_ktv'`).get(user.id) as { id: number } | undefined;
    if (!playlist) {
      const created = context.db.prepare(`INSERT INTO playlists(owner_id, name, kind) VALUES (?, '下一次 KTV', 'next_ktv')`).run(user.id);
      playlist = { id: Number(created.lastInsertRowid) };
    }
    context.db.prepare(`INSERT OR IGNORE INTO playlist_songs(playlist_id, song_id, position) VALUES (?, ?, 0)`).run(playlist.id, id);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.delete('/api/playlists/next-ktv/:id', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    context.db.prepare(`DELETE FROM playlist_songs WHERE song_id = ? AND playlist_id IN (SELECT id FROM playlists WHERE owner_id = ? AND kind = 'next_ktv')`).run(id, user.id);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.delete('/api/playlists/next-ktv', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const result = context.db.prepare(`
      DELETE FROM playlist_songs WHERE playlist_id IN (
        SELECT id FROM playlists WHERE owner_id = ? AND kind = 'next_ktv'
      )
    `).run(user.id);
    invalidateQueues(user.id);
    return { ok: true, removed: result.changes };
  });

  app.get('/api/playlists', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    return { playlists: context.db.prepare(`
      SELECT pl.id, pl.name, count(ps.song_id) AS songCount
      FROM playlists pl LEFT JOIN playlist_songs ps ON ps.playlist_id = pl.id
      WHERE pl.owner_id = ? AND pl.kind = 'normal' GROUP BY pl.id ORDER BY pl.created_at DESC
    `).all(user.id) };
  });

  app.post('/api/playlists', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const result = context.db.prepare(`INSERT INTO playlists(owner_id, name, kind) VALUES (?, ?, 'normal')`).run(user.id, body.name);
    return reply.code(201).send({ playlistId: Number(result.lastInsertRowid) });
  });

  app.get('/api/playlists/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const playlist = context.db.prepare(`SELECT id, name FROM playlists WHERE id = ? AND owner_id = ? AND kind = 'normal'`).get(id, user.id);
    if (!playlist) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    const songs = context.db.prepare(`
      SELECT s.id, s.title, s.artist, s.version FROM playlist_songs ps JOIN songs s ON s.id = ps.song_id
      WHERE ps.playlist_id = ? AND s.status = 'active' ORDER BY ps.position, ps.created_at
    `).all(id);
    return { playlist, songs };
  });

  app.put('/api/playlists/:playlistId/songs/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const params = z.object({ playlistId: z.coerce.number().int().positive(), id: z.coerce.number().int().positive() }).parse(request.params);
    const owned = context.db.prepare(`SELECT 1 FROM playlists WHERE id = ? AND owner_id = ? AND kind = 'normal'`).get(params.playlistId, user.id);
    if (!owned) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    const position = (context.db.prepare('SELECT coalesce(max(position), -1) + 1 AS value FROM playlist_songs WHERE playlist_id = ?').get(params.playlistId) as { value: number }).value;
    context.db.prepare('INSERT OR IGNORE INTO playlist_songs(playlist_id, song_id, position) VALUES (?, ?, ?)').run(params.playlistId, params.id, position);
    return { ok: true };
  });

  app.delete('/api/playlists/:playlistId/songs/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const params = z.object({ playlistId: z.coerce.number().int().positive(), id: z.coerce.number().int().positive() }).parse(request.params);
    const owned = context.db.prepare(`SELECT 1 FROM playlists WHERE id = ? AND owner_id = ? AND kind = 'normal'`).get(params.playlistId, user.id);
    if (!owned) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    context.db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?').run(params.playlistId, params.id);
    return { ok: true };
  });

  app.post('/api/imports', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    if (!user.canAddSongs) return reply.code(403).send({ code: 'FORBIDDEN', message: '管理员已关闭你的歌曲添加权限。' });
    const body = importSchema.parse(request.body);
    const taskId = randomUUID();
    context.db.prepare(`INSERT INTO tasks(id, user_id, type, payload, status) VALUES (?, ?, 'song_import', ?, 'running')`).run(taskId, user.id, JSON.stringify(body));
    try {
      const entries = parseImport(body.format, body.content);
      const insertSong = context.db.prepare(`INSERT INTO songs(title, artist, version, added_by) VALUES (?, ?, ?, ?)`);
      const collect = context.db.prepare(`INSERT INTO user_songs(user_id, song_id, collection_type) VALUES (?, ?, ?)`);
      context.db.transaction(() => {
        for (const entry of entries) {
          const inserted = insertSong.run(entry.title, entry.artist, entry.version ?? null, user.id);
          collect.run(user.id, Number(inserted.lastInsertRowid), body.collectionType);
        }
      })();
      context.db.prepare(`UPDATE tasks SET status = 'done', result = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify({ imported: entries.length }), taskId);
    } catch (error) {
      context.db.prepare(`UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run(error instanceof Error ? error.message : '导入失败', taskId);
    }
    return reply.code(202).send({ taskId });
  });

  app.get('/api/tasks/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = taskParamSchema.parse(request.params);
    const task = context.db.prepare(`SELECT id, type, status, result, error, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ? AND user_id = ?`).get(id, user.id);
    return task ?? reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个导入任务。' });
  });

  app.post('/api/tasks/:id/cancel', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = taskParamSchema.parse(request.params);
    context.db.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'pending'`).run(id, user.id);
    return { ok: true };
  });

  app.get('/api/export', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    return {
      exportedAt: new Date().toISOString(),
      songs: context.db.prepare(`
        SELECT s.title, s.artist, s.version, s.language, s.genre, us.collection_type AS collectionType,
               m.rating, m.note, m.key_shift AS keyShift, m.memory_cue AS memoryCue
        FROM user_songs us JOIN songs s ON s.id = us.song_id
        LEFT JOIN song_user_meta m ON m.user_id = us.user_id AND m.song_id = us.song_id
        WHERE us.user_id = ? AND us.removed_at IS NULL
      `).all(user.id),
      plays: context.db.prepare(`SELECT song_id AS songId, played_at AS playedAt, note FROM plays WHERE user_id = ?`).all(user.id)
    };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ code: 'INVALID_INPUT', message: '提交的数据格式不正确。', details: error.issues });
    }
    if (error instanceof PickError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    app.log.error(error, '请求处理失败');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务暂时遇到问题，请稍后重试。' });
  });

  if (context.webRoot && existsSync(context.webRoot)) {
    await app.register(staticPlugin, { root: context.webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在。' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

interface ImportEntry { title: string; artist: string; version?: string | undefined }

function parseImport(format: 'json' | 'csv' | 'text', content: string): ImportEntry[] {
  if (format === 'json') {
    const value = z.array(z.object({ title: z.string().min(1), artist: z.string().min(1), version: z.string().optional() })).parse(JSON.parse(content));
    return value;
  }
  const rows = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (format === 'text') {
    return rows.map((line) => {
      const [title, artist = '未知歌手'] = line.split(/\s*[-—|｜]\s*/, 2);
      if (!title) throw new Error('批量文本中存在空歌名。');
      return { title, artist };
    });
  }
  const [header, ...data] = rows;
  if (!header) return [];
  const columns = parseCsvLine(header).map((item) => item.toLowerCase());
  const titleIndex = columns.indexOf('title');
  const artistIndex = columns.indexOf('artist');
  const versionIndex = columns.indexOf('version');
  if (titleIndex < 0 || artistIndex < 0) throw new Error('CSV 必须包含 title 和 artist 列。');
  return data.map((line) => {
    const values = parseCsvLine(line);
    const title = values[titleIndex]?.trim();
    const artist = values[artistIndex]?.trim();
    if (!title || !artist) throw new Error('CSV 中存在缺少歌名或歌手的行。');
    const version = versionIndex >= 0 ? values[versionIndex]?.trim() : undefined;
    return version ? { title, artist, version } : { title, artist };
  });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { result.push(current); current = ''; }
    else current += char;
  }
  result.push(current);
  return result;
}
