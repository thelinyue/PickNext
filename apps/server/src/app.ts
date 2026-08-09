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
  adminBulkDeletionSchema,
  adminBulkPermissionsSchema,
  adminDeletionPreviewSchema,
  adminDeletionSchema,
  adminResetPasswordSchema,
  adminUpdateUserSchema,
  adminUsersQuerySchema,
  approveReviewSchema,
  collectionUpdateSchema,
  completePickSchema,
  createPlaylistSchema,
  createSongSchema,
  importSchema,
  loginSchema,
  notePickSchema,
  pickContextResponseSchema,
  pickRequestSchema,
  registrationSettingSchema,
  reorderPlaylistSchema,
  reviewDecisionSchema,
  searchSongsQuerySchema,
  setupSchema,
  snoozeSchema,
  updatePlaylistSchema,
  updateSongUserMetaSchema,
  updateSongSchema
} from '@picknext/shared';
import { hashPassword, verifyPassword } from './auth.js';
import { PickError, PickService } from './pick-service.js';
import { buildSongIndex, similarityScore, songIdentityKey, type SongIdentityInput } from './song-utils.js';
import type { AppContext, UserPayload } from './types.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const eventParamSchema = z.object({ eventId: z.string().uuid() });
const taskParamSchema = z.object({ id: z.string().uuid() });

interface CandidateSong extends SongIdentityInput {
  id: number;
  language: string | null;
  genre: string | null;
  difficulty: 'easy' | 'medium' | 'hard' | null;
  performanceType: 'solo' | 'duet' | 'chorus';
}

function songCandidates(db: AppContext['db'], input: SongIdentityInput) {
  const songs = db.prepare(`
    SELECT id, title, artist, version, language, genre, difficulty,
           performance_type AS performanceType
    FROM songs WHERE status = 'active'
  `).all() as CandidateSong[];
  const key = songIdentityKey(input);
  const exact = songs.find((song) => songIdentityKey(song) === key);
  const similar = songs
    .filter((song) => song.id !== exact?.id)
    .map((song) => ({ song, score: similarityScore(input, song) }))
    .filter((item) => item.score >= 3)
    .sort((left, right) => right.score - left.score || left.song.id - right.song.id)
    .slice(0, 5)
    .map((item) => item.song);
  return { exact, similar };
}

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
        FROM users WHERE id = ? AND is_system = 0
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

  const requireReviewer = async (request: FastifyRequest, reply: FastifyReply) => {
    await requireUser(request, reply);
    if (reply.sent) return;
    const user = currentUser(request);
    if (user.role !== 'admin' && !user.isMaintainer) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: '只有管理员或曲库管家可以处理歌曲审核。' });
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
    required: (context.db.prepare('SELECT count(*) AS count FROM users WHERE is_system = 0').get() as { count: number }).count === 0,
    registrationOpen: (context.db.prepare("SELECT value FROM app_settings WHERE key = 'registration_open'").get() as { value: string } | undefined)?.value === 'true'
  }));

  app.post('/api/setup', async (request, reply) => {
    const body = setupSchema.parse(request.body);
    if ((context.db.prepare('SELECT count(*) AS count FROM users WHERE is_system = 0').get() as { count: number }).count > 0) {
      return reply.code(409).send({ code: 'ALREADY_SETUP', message: '系统已经完成初始化。' });
    }
    const result = context.db.prepare(`
      INSERT INTO users(username, password_hash, role, last_login_at) VALUES (?, ?, 'admin', datetime('now'))
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
      FROM users WHERE username = ? COLLATE NOCASE AND is_system = 0
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
    context.db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    await issueSession(reply, user);
    return { user };
  });

  /** 开放注册默认关闭；管理员开启后，注册事务同时创建用户和专属的下一次 KTV 歌单。 */
  app.post('/api/auth/register', async (request, reply) => {
    const registrationOpen = (context.db.prepare("SELECT value FROM app_settings WHERE key = 'registration_open'").get() as { value: string } | undefined)?.value === 'true';
    if (!registrationOpen) return reply.code(403).send({ code: 'REGISTRATION_CLOSED', message: '当前未开放注册，请联系管理员创建账号。' });
    const body = setupSchema.parse(request.body);
    if (context.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(body.username)) {
      return reply.code(409).send({ code: 'USERNAME_EXISTS', message: '这个用户名已经存在。' });
    }
    const passwordHash = await hashPassword(body.password);
    const user = context.db.transaction(() => {
      const result = context.db.prepare(`
        INSERT INTO users(username, password_hash, role, is_maintainer, can_add_songs, last_login_at)
        VALUES (?, ?, 'user', 0, 1, datetime('now'))
      `).run(body.username, passwordHash);
      const created: UserPayload = { id: Number(result.lastInsertRowid), username: body.username, role: 'user', isMaintainer: false, canAddSongs: true };
      context.db.prepare(`INSERT INTO playlists(owner_id, name, kind) VALUES (?, '下一次 KTV', 'next_ktv')`).run(created.id);
      return created;
    })();
    await issueSession(reply, user);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('picknext_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', { preHandler: requireUser }, async (request) => ({ user: currentUser(request) }));

  /**
   * 用户列表的筛选和分页全部在 SQLite 中完成，避免大量账号一次性传到移动端。
   * “曲库管家”仍是普通用户的权限状态，不扩展数据库 role 枚举。
   */
  app.get('/api/admin/users', { preHandler: requireAdmin }, async (request) => {
    const query = adminUsersQuerySchema.parse(request.query);
    const params = { term: `%${query.q}%`, limit: query.limit, offset: query.offset };
    const clauses = ['is_system = 0', query.q ? 'username LIKE @term' : '1 = 1'];
    if (query.type === 'admin') clauses.push("role = 'admin'");
    if (query.type === 'maintainer') clauses.push("role = 'user' AND is_maintainer = 1");
    if (query.type === 'user') clauses.push("role = 'user' AND is_maintainer = 0");
    if (query.canAddSongs === 'allowed') clauses.push('can_add_songs = 1');
    if (query.canAddSongs === 'denied') clauses.push('can_add_songs = 0');
    if (query.login === 'logged') clauses.push('last_login_at IS NOT NULL');
    if (query.login === 'never') clauses.push('last_login_at IS NULL');
    const where = clauses.join(' AND ');
    const order = {
      created_desc: 'created_at DESC, id DESC',
      username_asc: 'username COLLATE NOCASE, id',
      last_login_desc: 'last_login_at IS NULL, last_login_at DESC, id DESC'
    }[query.sort];
    const users = (context.db.prepare(`
      SELECT id, username, role, is_maintainer AS isMaintainer, can_add_songs AS canAddSongs,
        created_at AS createdAt, last_login_at AS lastLoginAt,
        (SELECT count(*) FROM user_songs us WHERE us.user_id = users.id AND us.removed_at IS NULL) AS personalSongCount
      FROM users WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset
    `).all(params) as any[]).map(normalizeAdminUser);
    const total = (context.db.prepare(`SELECT count(*) AS count FROM users WHERE ${where}`).get(params) as { count: number }).count;
    const summary = context.db.prepare(`
      SELECT count(*) AS total,
        sum(CASE WHEN role = 'user' AND is_maintainer = 1 THEN 1 ELSE 0 END) AS maintainers,
        sum(CASE WHEN can_add_songs = 0 THEN 1 ELSE 0 END) AS addSongsDenied,
        sum(CASE WHEN last_login_at IS NULL THEN 1 ELSE 0 END) AS neverLoggedIn
      FROM users WHERE is_system = 0
    `).get() as any;
    return { users, total, hasMore: query.offset + users.length < total, summary: {
      total: Number(summary.total ?? 0), maintainers: Number(summary.maintainers ?? 0),
      addSongsDenied: Number(summary.addSongsDenied ?? 0), neverLoggedIn: Number(summary.neverLoggedIn ?? 0)
    } };
  });

  app.get('/api/admin/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const row = context.db.prepare(`
      SELECT u.id, u.username, u.role, u.is_maintainer AS isMaintainer, u.can_add_songs AS canAddSongs,
        u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
        (SELECT count(*) FROM user_songs us WHERE us.user_id = u.id AND us.removed_at IS NULL) AS personalSongCount,
        (SELECT count(*) FROM user_songs us WHERE us.user_id = u.id AND us.removed_at IS NULL AND us.collection_type = 'repertoire') AS repertoireCount,
        (SELECT count(*) FROM user_songs us WHERE us.user_id = u.id AND us.removed_at IS NULL AND us.collection_type = 'learning') AS learningCount,
        (SELECT count(*) FROM plays p WHERE p.user_id = u.id) AS playCount,
        (SELECT count(*) FROM playlists p WHERE p.owner_id = u.id) AS playlistCount,
        (SELECT count(*) FROM pick_sessions ps WHERE ps.user_id = u.id) AS pickSessionCount,
        (SELECT count(*) FROM songs s WHERE s.added_by = u.id) AS contributedSongCount
      FROM users u WHERE u.id = ? AND u.is_system = 0
    `).get(id) as any;
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个用户。' });
    return { user: { ...normalizeAdminUser(row), repertoireCount: row.repertoireCount, learningCount: row.learningCount,
      playCount: row.playCount, playlistCount: row.playlistCount, pickSessionCount: row.pickSessionCount,
      contributedSongCount: row.contributedSongCount } };
  });

  const validateDeletionTargets = (actorId: number, userIds: number[]) => {
    const placeholders = userIds.map(() => '?').join(', ');
    const rows = context.db.prepare(`SELECT id, username, role, is_system AS isSystem FROM users WHERE id IN (${placeholders})`).all(...userIds) as Array<{ id: number; username: string; role: string; isSystem: number }>;
    if (rows.length !== userIds.length) return { status: 404, code: 'USER_NOT_FOUND', message: '待删除用户中包含不存在的账号。' } as const;
    if (rows.some((row) => row.id === actorId)) return { status: 409, code: 'CANNOT_DELETE_SELF', message: '不能删除当前登录的管理员账号。' } as const;
    if (rows.some((row) => row.role === 'admin' || row.isSystem)) return { status: 409, code: 'PROTECTED_USER', message: '管理员或系统内部账号不能删除。' } as const;
    return { rows };
  };

  const deletionImpact = (userIds: number[]) => {
    const values = userIds.map(() => '(?)').join(', ');
    const impact = context.db.prepare(`
      WITH target_ids(id) AS (VALUES ${values})
      SELECT
        (SELECT count(*) FROM users u JOIN target_ids t ON t.id = u.id) AS userCount,
        (SELECT count(*) FROM user_songs us JOIN target_ids t ON t.id = us.user_id) AS personalSongCount,
        (SELECT count(*) FROM plays p JOIN target_ids t ON t.id = p.user_id) AS playCount,
        (SELECT count(*) FROM playlists p JOIN target_ids t ON t.id = p.owner_id) AS playlistCount,
        (SELECT count(*) FROM pick_sessions ps JOIN target_ids t ON t.id = ps.user_id) AS pickSessionCount,
        (SELECT count(*) FROM songs s JOIN target_ids t ON t.id = s.added_by) AS contributedSongCount
    `).get(...userIds) as any;
    const usernames = (context.db.prepare(`SELECT username FROM users WHERE id IN (${userIds.map(() => '?').join(', ')}) ORDER BY username COLLATE NOCASE`).all(...userIds) as Array<{ username: string }>).map((row) => row.username);
    return { userCount: Number(impact.userCount), usernames, personalSongCount: Number(impact.personalSongCount),
      playCount: Number(impact.playCount), playlistCount: Number(impact.playlistCount),
      pickSessionCount: Number(impact.pickSessionCount), contributedSongCount: Number(impact.contributedSongCount) };
  };

  /**
   * 永久删除只清除个人数据；全局歌曲与协作邀请先转给隐藏归属账号，再级联删除用户数据。
   * 校验与写入位于同一事务边界，任一步骤失败都会完整回滚。
   */
  const permanentlyDeleteUsers = async (actor: UserPayload, userIds: number[], adminPassword: string) => {
    const actorRow = context.db.prepare("SELECT password_hash AS passwordHash FROM users WHERE id = ? AND role = 'admin' AND is_system = 0").get(actor.id) as { passwordHash: string } | undefined;
    if (!actorRow || !(await verifyPassword(adminPassword, actorRow.passwordHash))) return { error: { status: 403, code: 'INVALID_ADMIN_PASSWORD', message: '管理员密码不正确，未执行删除。' } } as const;
    const checked = validateDeletionTargets(actor.id, userIds);
    if ('status' in checked) return { error: checked } as const;
    const impact = deletionImpact(userIds);
    context.db.transaction(() => {
      let systemOwner = context.db.prepare('SELECT id FROM users WHERE is_system = 1 LIMIT 1').get() as { id: number } | undefined;
      if (!systemOwner) {
        const result = context.db.prepare(`INSERT INTO users(username, password_hash, role, is_maintainer, can_add_songs, is_system) VALUES (?, '!', 'user', 0, 0, 1)`).run(`__picknext_deleted_owner_${randomUUID()}`);
        systemOwner = { id: Number(result.lastInsertRowid) };
      }
      const placeholders = userIds.map(() => '?').join(', ');
      context.db.prepare(`UPDATE songs SET added_by = ? WHERE added_by IN (${placeholders})`).run(systemOwner.id, ...userIds);
      context.db.prepare(`UPDATE playlist_collaborators SET invited_by = ? WHERE invited_by IN (${placeholders})`).run(systemOwner.id, ...userIds);
      context.db.prepare(`UPDATE song_submissions SET reviewed_by = NULL WHERE reviewed_by IN (${placeholders})`).run(...userIds);
      const removed = context.db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...userIds);
      if (removed.changes !== userIds.length) throw new Error('永久删除用户时目标数量发生变化，事务已回滚。');
    })();
    return { impact } as const;
  };

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

  app.put('/api/admin/users/bulk-permissions', { preHandler: requireAdmin }, async (request, reply) => {
    const body = adminBulkPermissionsSchema.parse(request.body);
    const placeholders = body.userIds.map(() => '?').join(', ');
    const targets = context.db.prepare(`SELECT id, role, is_system AS isSystem FROM users WHERE id IN (${placeholders})`).all(...body.userIds) as Array<{ id: number; role: string; isSystem: number }>;
    if (targets.length !== body.userIds.length) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: '所选用户中包含不存在的账号。' });
    if (targets.some((target) => target.role === 'admin' || target.isSystem)) return reply.code(409).send({ code: 'PROTECTED_USER', message: '不能批量修改管理员或系统账号。' });
    const result = context.db.prepare(`UPDATE users SET is_maintainer = coalesce(?, is_maintainer), can_add_songs = coalesce(?, can_add_songs) WHERE id IN (${placeholders})`).run(
      body.isMaintainer === undefined ? null : body.isMaintainer ? 1 : 0,
      body.canAddSongs === undefined ? null : body.canAddSongs ? 1 : 0,
      ...body.userIds
    );
    return { ok: true, updated: result.changes };
  });

  app.post('/api/admin/users/deletion-preview', { preHandler: requireAdmin }, async (request, reply) => {
    const actor = currentUser(request);
    const body = adminDeletionPreviewSchema.parse(request.body);
    const checked = validateDeletionTargets(actor.id, body.userIds);
    if ('status' in checked) return reply.code(checked.status).send({ code: checked.code, message: checked.message });
    return { impact: deletionImpact(body.userIds) };
  });

  app.post('/api/admin/users/bulk-delete', { preHandler: requireAdmin }, async (request, reply) => {
    const body = adminBulkDeletionSchema.parse(request.body);
    const result = await permanentlyDeleteUsers(currentUser(request), body.userIds, body.adminPassword);
    if ('error' in result) return reply.code(result.error.status as 403 | 404 | 409).send({ code: result.error.code, message: result.error.message });
    return { ok: true, deleted: result.impact.userCount, impact: result.impact };
  });

  app.put('/api/admin/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = adminUpdateUserSchema.parse(request.body);
    const target = context.db.prepare('SELECT role FROM users WHERE id = ? AND is_system = 0').get(id) as { role: string } | undefined;
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
    const result = context.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND is_system = 0').run(await hashPassword(body.password), id);
    if (!result.changes) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个用户。' });
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = adminDeletionSchema.parse(request.body);
    const result = await permanentlyDeleteUsers(currentUser(request), [id], body.adminPassword);
    if ('error' in result) return reply.code(result.error.status as 403 | 404 | 409).send({ code: result.error.code, message: result.error.message });
    return { ok: true, deleted: 1, impact: result.impact };
  });

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => ({
    registrationOpen: (context.db.prepare("SELECT value FROM app_settings WHERE key = 'registration_open'").get() as { value: string } | undefined)?.value === 'true'
  }));

  app.put('/api/admin/settings/registration', { preHandler: requireAdmin }, async (request) => {
    const body = registrationSettingSchema.parse(request.body);
    context.db.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES ('registration_open', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(body.open ? 'true' : 'false');
    return { ok: true, registrationOpen: body.open };
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
    const body = createSongSchema.parse(request.body);
    const matches = songCandidates(context.db, body);
    const publicCandidate = (song: CandidateSong) => ({
      id: song.id, title: song.title, artist: song.artist, version: song.version,
      language: song.language, genre: song.genre, difficulty: song.difficulty,
      performanceType: song.performanceType
    });

    if (matches.exact && !body.duplicateAction) {
      return reply.code(409).send({
        code: 'EXACT_DUPLICATE', message: '曲库中已有这首歌，请选择复用或提交审核。',
        matches: [publicCandidate(matches.exact)]
      });
    }
    if (!matches.exact && matches.similar.length && !body.duplicateAction) {
      return reply.code(409).send({
        code: 'SIMILAR_SONGS_FOUND', message: '发现可能相似的歌曲，请确认是否复用。',
        matches: matches.similar.map(publicCandidate)
      });
    }

    const reusable = [...(matches.exact ? [matches.exact] : []), ...matches.similar]
      .find((song) => song.id === body.matchedSongId);
    if (body.duplicateAction === 'reuse' && !reusable) {
      return reply.code(400).send({ code: 'INVALID_DUPLICATE_TARGET', message: '选择复用的歌曲不在本次候选中。' });
    }
    if (body.duplicateAction === 'submit_review' && !matches.exact) {
      return reply.code(400).send({ code: 'REVIEW_NOT_REQUIRED', message: '只有精确重复的歌曲需要提交审核。' });
    }
    if (!user.canAddSongs && body.duplicateAction !== 'reuse') {
      return reply.code(403).send({ code: 'FORBIDDEN', message: '管理员已关闭你的歌曲添加权限，但仍可复用全部曲库中的歌曲。' });
    }

    const personalPayload = {
      collectionType: body.collectionType,
      personalDifficulty: body.personalDifficulty ?? null,
      note: body.note ?? null,
      memoryCue: body.memoryCue ?? null,
      keyShift: body.keyShift ?? null
    };
    if (body.duplicateAction === 'submit_review' && matches.exact) {
      const publicPayload = {
        title: body.title, artist: body.artist, version: body.version ?? null,
        language: body.language ?? null, genre: body.genre ?? null,
        difficulty: body.difficulty ?? null, performanceType: body.performanceType,
        lyrics: body.lyrics ?? null, lyricsTranslit: body.lyricsTranslit ?? null,
        aliases: body.aliases
      };
      const submission = context.db.prepare(`
        INSERT INTO song_submissions(submitted_by, matched_song_id, public_payload, personal_payload)
        VALUES (?, ?, ?, ?)
      `).run(user.id, matches.exact.id, JSON.stringify(publicPayload), JSON.stringify(personalPayload));
      return reply.code(202).send({ status: 'pending_review', submissionId: Number(submission.lastInsertRowid) });
    }

    const result = context.db.transaction(() => {
      let songId: number;
      let status: 'created' | 'reused';
      if (body.duplicateAction === 'reuse' && reusable) {
        songId = reusable.id;
        status = 'reused';
      } else {
        const index = buildSongIndex(body.title);
        const inserted = context.db.prepare(`
          INSERT INTO songs(title, artist, version, language, genre, difficulty, performance_type,
                            lyrics, lyrics_translit, pinyin, title_initial, added_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          body.title, body.artist, body.version ?? null, body.language ?? null, body.genre ?? null,
          body.difficulty ?? null, body.performanceType, body.lyrics ?? null, body.lyricsTranslit ?? null,
          index.pinyin, index.titleInitial, user.id
        );
        songId = Number(inserted.lastInsertRowid);
        status = 'created';
        const aliasInsert = context.db.prepare('INSERT INTO song_aliases(song_id, alias) VALUES (?, ?)');
        for (const alias of body.aliases) aliasInsert.run(songId, alias);
      }
      context.db.prepare(`
        INSERT INTO user_songs(user_id, song_id, collection_type, removed_at) VALUES (?, ?, ?, NULL)
        ON CONFLICT(user_id, song_id) DO UPDATE SET collection_type = excluded.collection_type, removed_at = NULL
      `).run(user.id, songId, body.collectionType);
      context.db.prepare(`
        INSERT INTO song_user_meta(user_id, song_id, override_diff, note, memory_cue, key_shift)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, song_id) DO UPDATE SET
          override_diff = coalesce(excluded.override_diff, override_diff),
          note = coalesce(excluded.note, note), memory_cue = coalesce(excluded.memory_cue, memory_cue),
          key_shift = coalesce(excluded.key_shift, key_shift), updated_at = datetime('now')
      `).run(user.id, songId, personalPayload.personalDifficulty, personalPayload.note, personalPayload.memoryCue, personalPayload.keyShift);
      return { songId, status };
    })();
    return reply.code(result.status === 'created' ? 201 : 200).send(result);
  });

  app.get('/api/search', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = searchSongsQuerySchema.parse(request.query);
    const term = `%${query.q}%`;
    const params: Record<string, unknown> = {
      userId: user.id,
      collection: query.collection ?? null,
      query: query.q,
      term,
      minRating: query.minRating ?? null,
      limit: query.limit,
      offset: query.offset
    };
    const bindList = (prefix: string, values: string[]) => values.map((value, index) => {
      const key = `${prefix}${index}`;
      params[key] = value;
      return `@${key}`;
    }).join(', ');
    const languageList = bindList('language', query.languages);
    const genreList = bindList('genre', query.genres);
    const difficultyList = bindList('difficulty', query.difficulties);
    const scopeFilter = query.scope === 'personal' ? 'us.collection_type = @collection' : '1 = 1';
    const scopeRating = query.scope === 'personal' ? 'rating' : 'aggregateRating';
    const scopeDifficulty = query.scope === 'personal' ? 'personalDifficulty' : 'referenceDifficulty';
    const sceneClauses: Record<string, string> = {
      all: '1 = 1', custom: '1 = 1',
      strong: query.scope === 'personal' ? 'rating >= 4' : '1 = 1',
      challenge: query.scope === 'personal' ? "personalDifficulty = 'hard'" : '1 = 1',
      recent: query.scope === 'personal' ? "lastPlayedAt >= datetime('now', '-7 days')" : '1 = 1',
      note: query.scope === 'personal' ? '(hasNote = 1 OR hasMemoryCue = 1)' : '1 = 1',
      new: query.scope === 'personal' ? "personalAddedAt >= datetime('now', '-30 days')" : "songCreatedAt >= datetime('now', '-30 days')",
      high: query.scope === 'global' ? 'aggregateRating >= 4' : '1 = 1',
      hard: query.scope === 'global' ? "referenceDifficulty = 'hard'" : '1 = 1'
    };
    const advancedClauses = [
      languageList ? `language IN (${languageList})` : '1 = 1',
      genreList ? `genre IN (${genreList})` : '1 = 1',
      difficultyList ? `${scopeDifficulty} IN (${difficultyList})` : '1 = 1',
      query.minRating ? `${scopeRating} >= @minRating` : '1 = 1',
      sceneClauses[query.scene] ?? '1 = 1'
    ].join(' AND ');
    const queryCte = `
      WITH catalog AS (
        SELECT DISTINCT s.id, s.title, s.artist, s.version, s.language, s.genre,
          s.difficulty AS referenceDifficulty, s.performance_type AS performanceType,
          s.pinyin, coalesce(s.title_initial, '#') AS titleInitial, s.created_at AS songCreatedAt,
          s.lyrics, s.lyrics_translit AS lyricsTranslit,
          us.collection_type AS collectionType, us.created_at AS personalAddedAt,
          coalesce(m.override_diff, s.difficulty) AS personalDifficulty,
          m.rating, m.key_shift AS keyShift, m.pick_snoozed_until AS snoozedUntil,
          m.note AS personalNote, m.memory_cue AS personalMemoryCue,
          CASE WHEN coalesce(s.lyrics, '') <> '' THEN 1 ELSE 0 END AS hasLyrics,
          CASE WHEN coalesce(m.note, '') <> '' THEN 1 ELSE 0 END AS hasNote,
          CASE WHEN coalesce(m.memory_cue, '') <> '' THEN 1 ELSE 0 END AS hasMemoryCue,
          (SELECT count(*) FROM plays p WHERE p.user_id = @userId AND p.song_id = s.id) AS playCount,
          (SELECT max(played_at) FROM plays p WHERE p.user_id = @userId AND p.song_id = s.id) AS lastPlayedAt,
          CASE WHEN (SELECT count(*) FROM song_user_meta am WHERE am.song_id = s.id AND am.rating IS NOT NULL) >= 3
            THEN round((SELECT avg(am.rating) FROM song_user_meta am WHERE am.song_id = s.id AND am.rating IS NOT NULL), 1)
            ELSE NULL END AS aggregateRating,
          CASE WHEN (SELECT count(*) FROM song_user_meta am WHERE am.song_id = s.id AND am.rating IS NOT NULL) >= 3
            THEN (SELECT count(*) FROM song_user_meta am WHERE am.song_id = s.id AND am.rating IS NOT NULL)
            ELSE NULL END AS aggregateRatingCount,
          group_concat(a.alias, ' ') AS aliases
        FROM songs s
        LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
        LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
        LEFT JOIN song_aliases a ON a.song_id = s.id
        WHERE s.status = 'active' AND ${scopeFilter}
        GROUP BY s.id
      ), filtered AS (
        SELECT * FROM catalog WHERE (
          @query = '' OR title LIKE @term OR artist LIKE @term OR coalesce(version, '') LIKE @term
          OR coalesce(pinyin, '') LIKE @term
          OR replace(coalesce(pinyin, ''), ' ', '') LIKE replace(@term, ' ', '')
          OR coalesce(aliases, '') LIKE @term OR coalesce(lyrics, '') LIKE @term
          OR coalesce(lyricsTranslit, '') LIKE @term OR coalesce(personalNote, '') LIKE @term
          OR coalesce(personalMemoryCue, '') LIKE @term
        ) AND ${advancedClauses}
      )`;
    const orderSql = `ORDER BY CASE WHEN titleInitial = '#' THEN 1 ELSE 0 END,
      titleInitial, pinyin COLLATE NOCASE, title COLLATE NOCASE, artist COLLATE NOCASE`;
    const rawSongs = context.db.prepare(`${queryCte} SELECT * FROM filtered ${orderSql} LIMIT @limit OFFSET @offset`).all(params) as any[];
    const total = (context.db.prepare(`${queryCte} SELECT count(*) AS count FROM filtered`).get(params) as { count: number }).count;
    const alphabetIndex = context.db.prepare(`${queryCte}, ordered AS (
      SELECT titleInitial, row_number() OVER (${orderSql}) - 1 AS position FROM filtered
    ) SELECT titleInitial AS initial, count(*) AS count, min(position) AS offset
      FROM ordered GROUP BY titleInitial
      ORDER BY CASE WHEN initial = '#' THEN 1 ELSE 0 END, initial
    `).all(params) as Array<{ initial: string; count: number; offset: number }>;
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
    const facetScope = query.scope === 'personal' ? 'AND us.collection_type = @collection' : '';
    const facets = context.db.prepare(`
      SELECT group_concat(DISTINCT s.language) AS languages, group_concat(DISTINCT s.genre) AS genres
      FROM songs s LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
      WHERE s.status = 'active' ${facetScope}
    `).get({ userId: user.id, collection: query.collection ?? null }) as { languages: string | null; genres: string | null };
    const songs = rawSongs.map((song) => query.scope === 'personal' ? {
      scope: 'personal' as const,
      id: song.id,
      title: song.title,
      artist: song.artist,
      version: song.version,
      language: song.language,
      genre: song.genre,
      performanceType: song.performanceType,
      titleInitial: song.titleInitial,
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
      titleInitial: song.titleInitial,
      collectionType: song.collectionType,
      referenceDifficulty: song.referenceDifficulty,
      aggregateRating: song.aggregateRating,
      aggregateRatingCount: song.aggregateRatingCount
    });
    const splitFacet = (value: string | null) => value ? [...new Set(value.split(',').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')) : [];
    return {
      songs, total, hasMore: query.offset + songs.length < total, counts,
      facets: { languages: splitFacet(facets.languages), genres: splitFacet(facets.genres) },
      alphabetIndex
    };
  });

  app.get('/api/songs/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const song = context.db.prepare(`
      SELECT s.id, s.title, s.artist, s.version, s.language, s.genre, s.difficulty,
             s.performance_type AS performanceType, s.lyrics, s.lyrics_translit AS lyricsTranslit,
             us.collection_type AS collectionType, m.rating, m.note, m.key_shift AS keyShift,
             m.override_diff AS personalDifficulty, m.memory_cue AS memoryCue, s.added_by AS addedBy
      FROM songs s LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
      LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
      WHERE s.id = @id AND s.status = 'active'
    `).get({ id, userId: user.id });
    if (!song) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这首歌。' });
    return {
      ...(song as object),
      canEditGlobal: user.role === 'admin' || user.isMaintainer,
      canEditLyrics: user.role === 'admin' || user.isMaintainer || (song as any).addedBy === user.id
    };
  });

  /**
   * 全局歌曲身份资料会影响所有用户，因此只允许管理员和曲库管家修改。
   * 个人评分、难度、调号和备注继续保存在 song_user_meta，不会在这里被覆盖。
   */
  app.put('/api/songs/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    if (user.role !== 'admin' && !user.isMaintainer) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: '只有管理员或曲库管家可以编辑全部曲库歌曲。' });
    }
    const { id } = idParamSchema.parse(request.params);
    const body = updateSongSchema.parse(request.body);
    const index = buildSongIndex(body.title);
    const result = context.db.prepare(`
      UPDATE songs SET title = @title, artist = @artist, version = @version,
        language = @language, genre = @genre, difficulty = @difficulty,
        performance_type = @performanceType, lyrics = @lyrics,
        lyrics_translit = @lyricsTranslit, pinyin = @pinyin, title_initial = @titleInitial
      WHERE id = @id AND status = 'active'
    `).run({
      id,
      title: body.title,
      artist: body.artist,
      version: body.version || null,
      language: body.language || null,
      genre: body.genre || null,
      difficulty: body.difficulty ?? null,
      performanceType: body.performanceType,
      lyrics: body.lyrics || null,
      lyricsTranslit: body.lyricsTranslit || null,
      pinyin: index.pinyin,
      titleInitial: index.titleInitial
    });
    if (!result.changes) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这首歌。' });
    return { ok: true };
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

  /** 个人歌曲设置只更新当前用户自己的元数据，绝不能写回全局 songs 表。 */
  app.patch('/api/user-songs/:id/meta', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const body = updateSongUserMetaSchema.parse(request.body);
    const collected = context.db.prepare(`
      SELECT 1 FROM user_songs us JOIN songs s ON s.id = us.song_id
      WHERE us.user_id = ? AND us.song_id = ? AND us.removed_at IS NULL AND s.status = 'active'
    `).get(user.id, id);
    if (!collected) return reply.code(404).send({ code: 'NOT_FOUND', message: '请先把这首歌收录到我的曲库。' });
    const current = context.db.prepare(`
      SELECT rating, override_diff AS personalDifficulty, key_shift AS keyShift, note, memory_cue AS memoryCue
      FROM song_user_meta WHERE user_id = ? AND song_id = ?
    `).get(user.id, id) as any ?? {};
    const value = (key: keyof typeof body) => Object.prototype.hasOwnProperty.call(body, key) ? body[key] : current[key];
    context.db.prepare(`
      INSERT INTO song_user_meta(user_id, song_id, rating, override_diff, key_shift, note, memory_cue)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, song_id) DO UPDATE SET rating = excluded.rating,
        override_diff = excluded.override_diff, key_shift = excluded.key_shift,
        note = excluded.note, memory_cue = excluded.memory_cue, updated_at = datetime('now')
    `).run(user.id, id, value('rating') ?? null, value('personalDifficulty') ?? null,
      value('keyShift') ?? null, value('note') ?? null, value('memoryCue') ?? null);
    if ('rating' in body || 'personalDifficulty' in body) invalidateQueues(user.id);
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

  app.get('/api/picks/context', { preHandler: requireUser }, async (request) =>
    pickContextResponseSchema.parse(pickService.getContext(currentUser(request).id))
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
    const query = z.object({
      period: z.enum(['all', 'week', 'played']).default('all'),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      timezoneOffset: z.coerce.number().int().min(-840).max(840).default(0)
    }).parse(request.query);
    const timezoneModifier = `${-query.timezoneOffset} minutes`;
    const historyCte = `
      WITH history AS (
        SELECT 'event:' || e.id AS id, e.song_id AS songId, s.title, s.artist, s.version,
          e.status AS status, coalesce(e.completed_at, e.created_at) AS occurredAt,
          p.rating_snapshot AS rating, coalesce(p.note, e.note) AS note
        FROM pick_events e JOIN songs s ON s.id = e.song_id
        LEFT JOIN plays p ON p.pick_event_id = e.id
        WHERE e.user_id = @userId AND e.status IN ('played', 'skipped')
        UNION ALL
        SELECT 'play:' || p.id, p.song_id, s.title, s.artist, s.version,
          'played', p.played_at, p.rating_snapshot, p.note
        FROM plays p JOIN songs s ON s.id = p.song_id
        WHERE p.user_id = @userId AND p.pick_event_id IS NULL
      ), filtered AS (
        SELECT * FROM history WHERE
          (@period <> 'played' OR status = 'played') AND
          (@period <> 'week' OR occurredAt >= datetime('now', '-7 days'))
      )`;
    const params = { userId: user.id, period: query.period, limit: query.limit, offset: query.offset };
    const items = context.db.prepare(`${historyCte}
      SELECT * FROM filtered ORDER BY occurredAt DESC LIMIT @limit OFFSET @offset
    `).all(params);
    const total = (context.db.prepare(`${historyCte} SELECT count(*) AS count FROM filtered`).get(params) as { count: number }).count;
    const summary = context.db.prepare(`
      SELECT
        (SELECT count(*) FROM plays WHERE user_id = @userId) AS playedTotal,
        (SELECT count(*) FROM plays WHERE user_id = @userId
          AND date(datetime(played_at, @timezoneModifier)) = date(datetime('now', @timezoneModifier))) AS playedToday,
        (SELECT s.artist FROM plays p JOIN songs s ON s.id = p.song_id
          WHERE p.user_id = @userId GROUP BY s.artist ORDER BY count(*) DESC, s.artist COLLATE NOCASE LIMIT 1) AS favoriteArtist
    `).get({ userId: user.id, timezoneModifier }) as { playedTotal: number; playedToday: number; favoriteArtist: string | null };
    // plays 兼容旧版 Web/第三方调用；新界面使用包含跳过事件的 items。
    const plays = (items as any[]).filter((item) => item.status === 'played').map((item) => ({ ...item, playedAt: item.occurredAt }));
    return { items, plays, total, hasMore: query.offset + items.length < total, summary };
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

  const playlistAccess = (playlistId: number, userId: number) => context.db.prepare(`
    SELECT pl.id, pl.name, pl.owner_id AS ownerId, owner.username AS ownerName,
      CASE WHEN pl.owner_id = @userId THEN 'owner' ELSE 'collaborator' END AS access
    FROM playlists pl JOIN users owner ON owner.id = pl.owner_id
    WHERE pl.id = @playlistId AND pl.kind = 'normal' AND (
      pl.owner_id = @userId OR EXISTS (
        SELECT 1 FROM playlist_collaborators pc WHERE pc.playlist_id = pl.id AND pc.user_id = @userId
      )
    )
  `).get({ playlistId, userId }) as { id: number; name: string; ownerId: number; ownerName: string; access: 'owner' | 'collaborator' } | undefined;

  app.get('/api/playlists', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    return { playlists: context.db.prepare(`
      SELECT pl.id, pl.name, owner.username AS ownerName,
        CASE WHEN pl.owner_id = @userId THEN 'owner' ELSE 'collaborator' END AS access,
        count(DISTINCT ps.song_id) AS songCount, count(DISTINCT members.user_id) AS collaboratorCount
      FROM playlists pl JOIN users owner ON owner.id = pl.owner_id
      LEFT JOIN playlist_songs ps ON ps.playlist_id = pl.id
      LEFT JOIN playlist_collaborators members ON members.playlist_id = pl.id
      WHERE pl.kind = 'normal' AND (pl.owner_id = @userId OR EXISTS (
        SELECT 1 FROM playlist_collaborators mine WHERE mine.playlist_id = pl.id AND mine.user_id = @userId
      ))
      GROUP BY pl.id ORDER BY pl.created_at DESC
    `).all({ userId: user.id }) };
  });

  app.post('/api/playlists', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const body = createPlaylistSchema.parse(request.body);
    const collaboratorIds = [...new Set(body.collaboratorUserIds)].filter((id) => id !== user.id);
    if (collaboratorIds.length) {
      const placeholders = collaboratorIds.map(() => '?').join(',');
      const count = (context.db.prepare(`SELECT count(*) AS count FROM users WHERE id IN (${placeholders})`).get(...collaboratorIds) as { count: number }).count;
      if (count !== collaboratorIds.length) return reply.code(400).send({ code: 'INVALID_COLLABORATOR', message: '部分协作者账号不存在。' });
    }
    const playlistId = context.db.transaction(() => {
      const created = context.db.prepare(`INSERT INTO playlists(owner_id, name, kind) VALUES (?, ?, 'normal')`).run(user.id, body.name);
      const id = Number(created.lastInsertRowid);
      const add = context.db.prepare('INSERT INTO playlist_collaborators(playlist_id, user_id, invited_by) VALUES (?, ?, ?)');
      for (const collaboratorId of collaboratorIds) add.run(id, collaboratorId, user.id);
      return id;
    })();
    return reply.code(201).send({ playlistId });
  });

  app.get('/api/users/search', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ q: z.string().trim().max(40).default('') }).parse(request.query);
    return { users: context.db.prepare(`
      SELECT id, username FROM users WHERE id <> @userId AND is_system = 0
        AND (@query = '' OR username LIKE @term)
      ORDER BY username COLLATE NOCASE LIMIT 20
    `).all({ userId: user.id, query: query.q, term: `%${query.q}%` }) };
  });

  app.get('/api/playlists/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const playlist = playlistAccess(id, user.id);
    if (!playlist) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单或你无权查看。' });
    const songs = context.db.prepare(`
      SELECT s.id, s.title, s.artist, s.version, ps.position FROM playlist_songs ps JOIN songs s ON s.id = ps.song_id
      WHERE ps.playlist_id = ? AND s.status = 'active' ORDER BY ps.position, ps.created_at
    `).all(id);
    const collaborators = context.db.prepare(`
      SELECT u.id, u.username FROM playlist_collaborators pc JOIN users u ON u.id = pc.user_id
      WHERE pc.playlist_id = ? ORDER BY pc.created_at
    `).all(id);
    return { playlist, songs, collaborators };
  });

  app.patch('/api/playlists/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = updatePlaylistSchema.parse(request.body); const access = playlistAccess(id, user.id);
    if (!access) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    if (access.access !== 'owner') return reply.code(403).send({ code: 'FORBIDDEN', message: '只有歌单所有者可以修改名称。' });
    context.db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(body.name, id);
    return { ok: true };
  });

  app.delete('/api/playlists/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const access = playlistAccess(id, user.id);
    if (!access) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    if (access.access !== 'owner') return reply.code(403).send({ code: 'FORBIDDEN', message: '只有歌单所有者可以删除歌单。' });
    context.db.prepare("DELETE FROM playlists WHERE id = ? AND kind = 'normal'").run(id);
    return { ok: true };
  });

  app.put('/api/playlists/:id/order', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = reorderPlaylistSchema.parse(request.body); const access = playlistAccess(id, user.id);
    if (!access) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    const existing = (context.db.prepare('SELECT song_id AS songId FROM playlist_songs WHERE playlist_id = ?').all(id) as Array<{ songId: number }>).map((item) => item.songId).sort((a, b) => a - b);
    const requested = [...new Set(body.songIds)].sort((a, b) => a - b);
    if (existing.length !== requested.length || existing.some((songId, index) => songId !== requested[index])) {
      return reply.code(409).send({ code: 'PLAYLIST_CHANGED', message: '歌单内容已变化，请刷新后重试排序。' });
    }
    const update = context.db.prepare('UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?');
    context.db.transaction(() => body.songIds.forEach((songId, position) => update.run(position, id, songId)))();
    return { ok: true };
  });

  app.put('/api/playlists/:id/collaborators/:userId', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const params = z.object({ id: z.coerce.number().int().positive(), userId: z.coerce.number().int().positive() }).parse(request.params);
    const access = playlistAccess(params.id, user.id);
    if (!access) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    if (access.access !== 'owner') return reply.code(403).send({ code: 'FORBIDDEN', message: '只有歌单所有者可以管理协作者。' });
    if (params.userId === user.id || !context.db.prepare('SELECT 1 FROM users WHERE id = ?').get(params.userId)) {
      return reply.code(400).send({ code: 'INVALID_COLLABORATOR', message: '无法邀请这个账号。' });
    }
    context.db.prepare('INSERT OR IGNORE INTO playlist_collaborators(playlist_id, user_id, invited_by) VALUES (?, ?, ?)').run(params.id, params.userId, user.id);
    return { ok: true };
  });

  app.delete('/api/playlists/:id/collaborators/:userId', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const params = z.object({ id: z.coerce.number().int().positive(), userId: z.coerce.number().int().positive() }).parse(request.params);
    const access = playlistAccess(params.id, user.id);
    if (!access) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    if (access.access !== 'owner') return reply.code(403).send({ code: 'FORBIDDEN', message: '只有歌单所有者可以管理协作者。' });
    context.db.prepare('DELETE FROM playlist_collaborators WHERE playlist_id = ? AND user_id = ?').run(params.id, params.userId);
    return { ok: true };
  });

  app.put('/api/playlists/:playlistId/songs/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const params = z.object({ playlistId: z.coerce.number().int().positive(), id: z.coerce.number().int().positive() }).parse(request.params);
    if (!playlistAccess(params.playlistId, user.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    const position = (context.db.prepare('SELECT coalesce(max(position), -1) + 1 AS value FROM playlist_songs WHERE playlist_id = ?').get(params.playlistId) as { value: number }).value;
    context.db.prepare('INSERT OR IGNORE INTO playlist_songs(playlist_id, song_id, position) VALUES (?, ?, ?)').run(params.playlistId, params.id, position);
    return { ok: true };
  });

  app.delete('/api/playlists/:playlistId/songs/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const params = z.object({ playlistId: z.coerce.number().int().positive(), id: z.coerce.number().int().positive() }).parse(request.params);
    if (!playlistAccess(params.playlistId, user.id)) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单。' });
    context.db.prepare('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?').run(params.playlistId, params.id);
    return { ok: true };
  });

  app.get('/api/reviews/count', { preHandler: requireReviewer }, async () => ({
    count: (context.db.prepare("SELECT count(*) AS count FROM song_submissions WHERE status = 'pending'").get() as { count: number }).count
  }));

  app.get('/api/reviews', { preHandler: requireReviewer }, async (request) => {
    const query = z.object({ status: z.enum(['pending', 'merged', 'approved', 'rejected']).default('pending') }).parse(request.query);
    const rows = context.db.prepare(`
      SELECT ss.id, ss.status, ss.public_payload AS publicPayload, ss.created_at AS createdAt,
        submitter.username AS submitter, ss.matched_song_id AS matchedSongId,
        s.title AS matchedTitle, s.artist AS matchedArtist, s.version AS matchedVersion,
        s.language AS matchedLanguage, s.genre AS matchedGenre, s.difficulty AS matchedDifficulty,
        s.performance_type AS matchedPerformanceType
      FROM song_submissions ss JOIN users submitter ON submitter.id = ss.submitted_by
      LEFT JOIN songs s ON s.id = ss.matched_song_id
      WHERE ss.status = ? ORDER BY ss.created_at ASC
    `).all(query.status) as any[];
    return { reviews: rows.map((row) => ({
      id: row.id, status: row.status, submitter: row.submitter, createdAt: row.createdAt,
      submitted: JSON.parse(row.publicPayload),
      matched: row.matchedSongId ? {
        id: row.matchedSongId, title: row.matchedTitle, artist: row.matchedArtist,
        version: row.matchedVersion, language: row.matchedLanguage, genre: row.matchedGenre,
        difficulty: row.matchedDifficulty, performanceType: row.matchedPerformanceType
      } : null
    })) };
  });

  const collectSubmissionSong = (submission: any, songId: number) => {
    const personal = JSON.parse(submission.personal_payload) as any;
    context.db.prepare(`
      INSERT INTO user_songs(user_id, song_id, collection_type, removed_at) VALUES (?, ?, ?, NULL)
      ON CONFLICT(user_id, song_id) DO UPDATE SET collection_type = excluded.collection_type, removed_at = NULL
    `).run(submission.submitted_by, songId, personal.collectionType);
    context.db.prepare(`
      INSERT INTO song_user_meta(user_id, song_id, override_diff, key_shift, note, memory_cue)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, song_id) DO UPDATE SET override_diff = coalesce(excluded.override_diff, override_diff),
        key_shift = coalesce(excluded.key_shift, key_shift), note = coalesce(excluded.note, note),
        memory_cue = coalesce(excluded.memory_cue, memory_cue), updated_at = datetime('now')
    `).run(submission.submitted_by, songId, personal.personalDifficulty ?? null, personal.keyShift ?? null,
      personal.note ?? null, personal.memoryCue ?? null);
    invalidateQueues(submission.submitted_by);
  };

  app.post('/api/reviews/:id/merge', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = reviewDecisionSchema.parse(request.body ?? {});
    return context.db.transaction(() => {
      const submission = context.db.prepare("SELECT * FROM song_submissions WHERE id = ? AND status = 'pending'").get(id) as any;
      if (!submission) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条审核已被其他人处理。' });
      if (!submission.matched_song_id || !context.db.prepare("SELECT 1 FROM songs WHERE id = ? AND status = 'active'").get(submission.matched_song_id)) {
        return reply.code(409).send({ code: 'MATCHED_SONG_MISSING', message: '原有歌曲已不存在，无法合并。' });
      }
      const changed = context.db.prepare(`UPDATE song_submissions SET status = 'merged', resolved_song_id = matched_song_id,
        reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'`)
        .run(reviewer.id, body.reviewNote ?? null, id);
      if (!changed.changes) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条审核已被其他人处理。' });
      collectSubmissionSong(submission, submission.matched_song_id);
      return { ok: true, songId: submission.matched_song_id };
    })();
  });

  app.post('/api/reviews/:id/approve', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = approveReviewSchema.parse(request.body);
    if (songCandidates(context.db, body).exact) {
      return reply.code(409).send({ code: 'DUPLICATE_IDENTITY', message: '批准为独立版本前，请修改版本或歌曲身份。' });
    }
    return context.db.transaction(() => {
      const submission = context.db.prepare("SELECT * FROM song_submissions WHERE id = ? AND status = 'pending'").get(id) as any;
      if (!submission) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条审核已被其他人处理。' });
      const changed = context.db.prepare(`UPDATE song_submissions SET status = 'approved', reviewed_by = ?,
        review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'`)
        .run(reviewer.id, body.reviewNote ?? null, id);
      if (!changed.changes) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条审核已被其他人处理。' });
      const index = buildSongIndex(body.title);
      const created = context.db.prepare(`
        INSERT INTO songs(title, artist, version, language, genre, difficulty, performance_type,
          lyrics, lyrics_translit, pinyin, title_initial, added_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(body.title, body.artist, body.version ?? null, body.language ?? null, body.genre ?? null,
        body.difficulty ?? null, body.performanceType, body.lyrics ?? null, body.lyricsTranslit ?? null,
        index.pinyin, index.titleInitial, reviewer.id);
      const songId = Number(created.lastInsertRowid);
      context.db.prepare('UPDATE song_submissions SET resolved_song_id = ? WHERE id = ?').run(songId, id);
      collectSubmissionSong(submission, songId);
      return { ok: true, songId };
    })();
  });

  app.post('/api/reviews/:id/reject', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = reviewDecisionSchema.parse(request.body ?? {});
    const result = context.db.prepare(`UPDATE song_submissions SET status = 'rejected', reviewed_by = ?,
      review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'`)
      .run(reviewer.id, body.reviewNote ?? null, id);
    if (!result.changes) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条审核已被其他人处理。' });
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
      const insertSong = context.db.prepare(`
        INSERT INTO songs(title, artist, version, pinyin, title_initial, added_by) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const collect = context.db.prepare(`
        INSERT INTO user_songs(user_id, song_id, collection_type, removed_at) VALUES (?, ?, ?, NULL)
        ON CONFLICT(user_id, song_id) DO UPDATE SET collection_type = excluded.collection_type, removed_at = NULL
      `);
      let imported = 0; let reused = 0;
      const needsConfirmation: ImportEntry[] = [];
      context.db.transaction(() => {
        for (const entry of entries) {
          const matches = songCandidates(context.db, entry);
          if (matches.exact) {
            collect.run(user.id, matches.exact.id, body.collectionType); reused += 1; continue;
          }
          if (matches.similar.length) { needsConfirmation.push(entry); continue; }
          const index = buildSongIndex(entry.title);
          const inserted = insertSong.run(entry.title, entry.artist, entry.version ?? null, index.pinyin, index.titleInitial, user.id);
          collect.run(user.id, Number(inserted.lastInsertRowid), body.collectionType); imported += 1;
        }
      })();
      context.db.prepare(`UPDATE tasks SET status = 'done', result = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(JSON.stringify({ imported, reused, needsConfirmation }), taskId);
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

/**
 * SQLite 用 0/1 保存布尔值。管理接口在统一出口完成类型归一化，避免各页面
 * 分别猜测数据库驱动的返回形式；同时把聚合查询可能返回的空值收敛为稳定值。
 */
function normalizeAdminUser(user: any) {
  return {
    ...user,
    isMaintainer: Boolean(user.isMaintainer),
    canAddSongs: Boolean(user.canAddSongs),
    personalSongCount: Number(user.personalSongCount ?? 0),
    lastLoginAt: user.lastLoginAt ?? null
  };
}

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
