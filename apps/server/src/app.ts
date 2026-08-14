import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
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
  importTaskSchema,
  loginSchema,
  notePickSchema,
  pickContextResponseSchema,
  pickRequestSchema,
  pickResponseSchema,
  registrationSettingSchema,
  reorderPlaylistSchema,
  reviewDecisionSchema,
  searchSongsQuerySchema,
  setupSchema,
  snoozeSchema,
  userSongBatchSchema,
  updateProfileSchema,
  updatePlaylistSchema,
  updateSongUserMetaSchema,
  updateSongSchema
} from '@picknext/shared';
import type { SearchSongsMetaResponse } from '@picknext/shared';
import { hashPassword, verifyPassword } from './auth.js';
import { AuditLogError, AuditLogger } from './audit.js';
import { ImportTaskQueue } from './import-task-queue.js';
import { LoginRateLimiter } from './login-rate-limit.js';
import { PickError, PickService } from './pick-service.js';
import { buildSongIndex, normalizedSongIdentity } from './song-utils.js';
import { rebuildSongSearchIndex, rebuildUserSongSearchIndex, toFtsQuery } from './search-index.js';
import { searchSongsMeta, searchSongsQuick, type SearchQuery } from './search-service.js';
import { CatalogService, type CatalogCandidate } from './services/catalog-service.js';
import { CoverStorage } from './services/cover-storage.js';
import { MtwClient, type MtwScanProgress } from './services/mtw-client.js';
import { ProfileStorage } from './services/profile-storage.js';
import type { AppContext, UserPayload } from './types.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const eventParamSchema = z.object({ eventId: z.string().uuid() });
const taskParamSchema = z.object({ id: z.string().uuid() });

class SetupAlreadyCompletedError extends Error {
  readonly code = 'ALREADY_SETUP';

  constructor() {
    super('系统已经完成初始化。');
  }
}

class UserSongBatchError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'USER_SONG_NOT_FOUND', statusCode = 404) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function currentUser(request: FastifyRequest): UserPayload {
  return request.user as UserPayload;
}

function toUserPayload(row: any): UserPayload {
  const nickname = typeof row.nickname === 'string' && row.nickname.trim() ? row.nickname.trim() : null;
  const avatarUrl = row.avatarPath ? `/api/auth/avatar?v=${encodeURIComponent(row.profileUpdatedAt ?? '')}` : null;
  return {
    id: Number(row.id), username: row.username, nickname, displayName: nickname ?? row.username, avatarUrl,
    role: row.role, isMaintainer: Boolean(row.isMaintainer), canAddSongs: Boolean(row.canAddSongs)
  };
}

/**
 * 只有浏览器通过 HTTPS 访问时才设置 Secure Cookie。
 *
 * PickNext 支持直接以 HTTP 部署在内网；生产环境标记本身不能代表当前请求
 * 一定使用 HTTPS，否则浏览器会拒绝保存登录会话，导致登录接口成功后仍回到登录页。
 * 反向代理场景下同时读取 X-Forwarded-Proto，兼容 HTTPS 代理到 HTTP 应用进程。
 */
function isHttpsRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proxyProtocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return request.protocol === 'https' || proxyProtocol?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/**
 * 会话签名密钥属于服务内部数据，不要求非技术部署者手工配置。
 * 首次启动时生成高强度随机值并写入 SQLite，数据库卷保留期间会稳定复用。
 */
function getOrCreateSessionSecret(db: AppContext['db']): string {
  const existing = db.prepare("SELECT value FROM app_settings WHERE key = 'session_secret'").get() as { value: string } | undefined;
  if (existing?.value) return existing.value;
  const generated = randomBytes(32).toString('hex');
  const userCount = (db.prepare('SELECT count(*) AS count FROM users WHERE is_system = 0').get() as { count: number }).count;
  if (userCount > 0) {
    db.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES ('session_secret', ?, datetime('now'))
      ON CONFLICT(key) DO NOTHING
    `).run(generated);
    const stored = db.prepare("SELECT value FROM app_settings WHERE key = 'session_secret'").get() as { value: string } | undefined;
    if (!stored?.value) throw new Error('无法生成会话安全密钥，请检查 SQLite 数据库写入权限。');
    return stored.value;
  }
  // 初次初始化前只在应用实例内暂存；真正落库由 setup 的账号/歌单事务完成。
  return generated;
}

/** Fastify 应用工厂保持无全局状态，测试可用 inject() 连接独立内存数据库。 */
export async function buildApp(context: AppContext) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const pickService = new PickService(context.db);
  const catalog = new CatalogService(context.db);
  const coverStorage = new CoverStorage(context.db, resolve(context.dataRoot ?? process.cwd(), 'covers'));
  const profileStorage = new ProfileStorage(resolve(context.dataRoot ?? process.cwd(), 'avatars'));
  const audit = new AuditLogger(context.db);
  const loginLimiter = new LoginRateLimiter();
  const sessionSecret = getOrCreateSessionSecret(context.db);
  const searchMetaCache = new Map<string, { expiresAt: number; value: SearchSongsMetaResponse }>();
  const invalidateSearchMeta = (userId?: number) => {
    if (userId === undefined) {
      searchMetaCache.clear();
      return;
    }
    for (const key of searchMetaCache.keys()) if (key.startsWith(`${userId}|`)) searchMetaCache.delete(key);
  };
  const readMtwSettings = () => ({
    baseUrl: (context.db.prepare("SELECT value FROM app_settings WHERE key = 'mtw_base_url'").get() as { value: string } | undefined)?.value ?? '',
    token: (context.db.prepare("SELECT value FROM app_settings WHERE key = 'mtw_token'").get() as { value: string } | undefined)?.value ?? '',
    username: (context.db.prepare("SELECT value FROM app_settings WHERE key = 'mtw_username'").get() as { value: string } | undefined)?.value ?? '',
    password: (context.db.prepare("SELECT value FROM app_settings WHERE key = 'mtw_password'").get() as { value: string } | undefined)?.value ?? ''
  });
  const mtwClient = () => {
    const settings = readMtwSettings();
    if (!settings.baseUrl) throw new Error('尚未配置 MTW 服务地址。');
    return new MtwClient(settings);
  };
  const invalidateQueues = (userId: number) => {
    invalidateSearchMeta(userId);
    return context.db.prepare(`
      UPDATE pick_queue_items SET status = 'invalidated' WHERE status = 'pending' AND session_id IN (
        SELECT id FROM pick_sessions WHERE user_id = ? AND ended_at IS NULL
      )
    `).run(userId).changes;
  };
  const processImportTask = async (taskId: string): Promise<void> => {
    const task = context.db.prepare('SELECT user_id AS userId, payload, status FROM tasks WHERE id = ? AND type = \'song_import\'').get(taskId) as {
      userId: number;
      payload: string;
      status: string;
    } | undefined;
    if (!task || task.status === 'cancelled') return;
    const started = context.db.prepare(`
      UPDATE tasks SET status = 'running', updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(taskId);
    if (!started.changes) return;
    try {
      const body = importSchema.parse(JSON.parse(task.payload));
      const entries = parseImport(body.format, body.content);
      let imported = 0;
      let reused = 0;
      const needsConfirmation: ImportEntry[] = [];
      for (const entry of entries) {
        const current = context.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
        if (current?.status === 'cancelled') return;
        context.db.transaction(() => {
          const matches = catalog.findCandidates(entry);
          if (matches.exact) {
            context.db.prepare(`UPDATE songs SET album = coalesce(?, album), lyrics = coalesce(?, lyrics) WHERE id = ? AND status = 'active'`)
              .run(entry.album ?? null, (entry as ImportEntry & { lyrics?: string }).lyrics ?? null, matches.exact.id);
            rebuildSongSearchIndex(context.db, matches.exact.id);
            catalog.collectUserSong(task.userId, matches.exact.id, { collectionType: body.collectionType });
            reused += 1;
            return;
          }
          if (matches.similar.length) {
            needsConfirmation.push(entry);
            return;
          }
          const songId = catalog.createSong({ ...entry, performanceType: 'solo', addedBy: task.userId });
          catalog.collectUserSong(task.userId, songId, { collectionType: body.collectionType });
          imported += 1;
        })();
        if (body.collectionType) invalidateQueues(task.userId);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      context.db.prepare(`
        UPDATE tasks SET status = 'done', result = ?, error = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'running'
      `).run(JSON.stringify({ imported, reused, needsConfirmation }), taskId);
      audit.record({ actorUserId: task.userId, action: 'song_import_completed', targetType: 'task', targetId: taskId, metadata: { imported, reused } });
    } catch (error) {
      context.db.prepare(`
        UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now')
        WHERE id = ? AND status <> 'cancelled'
      `).run(error instanceof Error ? error.message : '导入失败', taskId);
    }
  };
  const importQueue = new ImportTaskQueue(context.db, { processTask: processImportTask });
  await app.register(cookie);
  await app.register(jwt, {
    secret: sessionSecret,
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
        SELECT id, username, nickname, avatar_path AS avatarPath, profile_updated_at AS profileUpdatedAt,
          role, is_maintainer AS isMaintainer, can_add_songs AS canAddSongs
        FROM users WHERE id = ? AND is_system = 0
      `).get(token.id) as any;
      if (!row) throw new Error('账号不存在');
      request.user = toUserPayload(row);
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

  const issueSession = async (request: FastifyRequest, reply: FastifyReply, user: UserPayload) => {
    const token = await reply.jwtSign(user, { expiresIn: '30d' });
    reply.setCookie('picknext_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttpsRequest(request),
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
    const passwordHash = await hashPassword(body.password);
    let user: UserPayload;
    try {
      user = context.db.transaction(() => {
        if ((context.db.prepare('SELECT count(*) AS count FROM users WHERE is_system = 0').get() as { count: number }).count > 0) {
          throw new SetupAlreadyCompletedError();
        }
        const result = context.db.prepare(`
          INSERT INTO users(username, password_hash, role, last_login_at) VALUES (?, ?, 'admin', datetime('now'))
        `).run(body.username, passwordHash);
        const created: UserPayload = { id: Number(result.lastInsertRowid), username: body.username, nickname: null, displayName: body.username, avatarUrl: null, role: 'admin', isMaintainer: false, canAddSongs: true };
        context.db.prepare(`INSERT INTO playlists(owner_id, name, kind) VALUES (?, '下一次 KTV', 'next_ktv')`).run(created.id);
        context.db.prepare(`
          INSERT INTO app_settings(key, value, updated_at) VALUES ('session_secret', ?, datetime('now'))
          ON CONFLICT(key) DO NOTHING
        `).run(sessionSecret);
        audit.record({ actorUserId: created.id, action: 'setup_completed', targetType: 'system' });
        return created;
      })();
    } catch (error) {
      if (error instanceof SetupAlreadyCompletedError) return reply.code(409).send({ code: error.code, message: error.message });
      throw error;
    }
    await issueSession(request, reply, user);
    return { user };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const loginKey = `${request.ip}|${body.username.trim().toLocaleLowerCase('zh-CN')}`;
    const rate = loginLimiter.check(loginKey);
    if (!rate.allowed) {
      reply.header('retry-after', rate.retryAfterSeconds);
      return reply.code(429).send({ code: 'RATE_LIMITED', message: `登录失败次数过多，请 ${rate.retryAfterSeconds} 秒后重试。` });
    }
    const row = context.db.prepare(`
      SELECT id, username, nickname, avatar_path AS avatarPath, profile_updated_at AS profileUpdatedAt,
        role, password_hash, is_maintainer, can_add_songs
      FROM users WHERE username = ? COLLATE NOCASE AND is_system = 0
    `).get(body.username) as any;
    if (!row || !(await verifyPassword(body.password, row.password_hash))) {
      loginLimiter.failed(loginKey);
      try { audit.record({ action: 'login_failed', targetType: 'user', metadata: { username: body.username } }); } catch (error) { app.log.error(error, '登录失败审计日志写入失败'); }
      return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: '用户名或密码不正确。' });
    }
    loginLimiter.succeeded(loginKey);
    const user = toUserPayload({ ...row, isMaintainer: row.is_maintainer, canAddSongs: row.can_add_songs });
    context.db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    audit.record({ actorUserId: user.id, action: 'login_succeeded', targetType: 'user', targetId: user.id });
    await issueSession(request, reply, user);
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
      const created: UserPayload = { id: Number(result.lastInsertRowid), username: body.username, nickname: null, displayName: body.username, avatarUrl: null, role: 'user', isMaintainer: false, canAddSongs: true };
      context.db.prepare(`INSERT INTO playlists(owner_id, name, kind) VALUES (?, '下一次 KTV', 'next_ktv')`).run(created.id);
      return created;
    })();
    await issueSession(request, reply, user);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('picknext_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', { preHandler: requireUser }, async (request) => ({ user: currentUser(request) }));

  app.patch('/api/auth/profile', { preHandler: requireUser, bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const user = currentUser(request);
    const body = updateProfileSchema.parse(request.body);
    const existing = context.db.prepare('SELECT nickname, avatar_path AS avatarPath, avatar_mime_type AS avatarMimeType FROM users WHERE id = ?').get(user.id) as { nickname: string | null; avatarPath: string | null; avatarMimeType: string | null } | undefined;
    if (!existing) return reply.code(404).send({ code: 'USER_NOT_FOUND', message: '当前用户不存在。' });
    const nickname = body.nickname === undefined ? existing.nickname : body.nickname?.trim() || null;
    let avatarPath = existing.avatarPath;
    let avatarMimeType = existing.avatarMimeType;
    let newAvatarPath: string | null = null;
    try {
      if (body.avatar !== undefined) {
        if (body.avatar === null) {
          avatarPath = null;
          avatarMimeType = null;
        } else {
          const stored = profileStorage.save(user.id, body.avatar);
          avatarPath = stored.path;
          avatarMimeType = stored.mimeType;
          newAvatarPath = stored.path;
        }
      }
      context.db.prepare(`UPDATE users SET nickname = ?, avatar_path = ?, avatar_mime_type = ?, profile_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(nickname, avatarPath, avatarMimeType, user.id);
    } catch (error) {
      if (newAvatarPath) profileStorage.remove(newAvatarPath);
      return reply.code(400).send({ code: 'PROFILE_UPDATE_INVALID', message: error instanceof Error ? error.message : '个人资料更新失败。' });
    }
    if (existing.avatarPath && existing.avatarPath !== avatarPath) profileStorage.remove(existing.avatarPath);
    const row = context.db.prepare(`SELECT id, username, nickname, avatar_path AS avatarPath, profile_updated_at AS profileUpdatedAt,
      role, is_maintainer AS isMaintainer, can_add_songs AS canAddSongs FROM users WHERE id = ?`).get(user.id);
    return { user: toUserPayload(row) };
  });

  app.get('/api/auth/avatar', { preHandler: requireUser }, async (request, reply) => {
    const row = context.db.prepare('SELECT avatar_path AS avatarPath, avatar_mime_type AS avatarMimeType FROM users WHERE id = ?').get(currentUser(request).id) as { avatarPath: string | null; avatarMimeType: string | null } | undefined;
    if (!row?.avatarPath || !row.avatarMimeType) return reply.code(404).send({ code: 'AVATAR_NOT_FOUND', message: '当前用户还没有设置头像。' });
    try { return reply.type(row.avatarMimeType).send(profileStorage.read(row.avatarPath)); }
    catch { return reply.code(404).send({ code: 'AVATAR_NOT_FOUND', message: '头像文件不存在，请重新上传。' }); }
  });

  /**
   * 用户列表的筛选和分页全部在 SQLite 中完成，避免大量账号一次性传到移动端。
   * “曲库管家”仍是普通用户的权限状态，不扩展数据库 role 枚举。
   */
  app.get('/api/admin/users', { preHandler: requireAdmin }, async (request) => {
    const query = adminUsersQuerySchema.parse(request.query);
    const params = { term: `%${query.q}%`, limit: query.limit, offset: query.offset };
    const clauses = ['is_system = 0', query.q ? '(username LIKE @term OR coalesce(nickname, \'\') LIKE @term)' : '1 = 1'];
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
      SELECT id, username, nickname, role, is_maintainer AS isMaintainer, can_add_songs AS canAddSongs,
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
      SELECT u.id, u.username, u.nickname, u.role, u.is_maintainer AS isMaintainer, u.can_add_songs AS canAddSongs,
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
    audit.record({ actorUserId: currentUser(request).id, action: 'user_permissions_updated', targetType: 'user_batch', metadata: { userIds: body.userIds, updated: result.changes } });
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
    audit.record({ actorUserId: currentUser(request).id, action: 'users_deleted', targetType: 'user_batch', metadata: { userIds: body.userIds } });
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
    audit.record({ actorUserId: currentUser(request).id, action: 'user_deleted', targetType: 'user', targetId: id });
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

  app.get('/api/admin/settings/mtw', { preHandler: requireAdmin }, async () => {
    const settings = readMtwSettings();
    return { baseUrl: settings.baseUrl, tokenConfigured: Boolean(settings.token), usernameConfigured: Boolean(settings.username), passwordConfigured: Boolean(settings.password) };
  });

  app.put('/api/admin/settings/mtw', { preHandler: requireAdmin }, async (request) => {
    const body = z.object({ baseUrl: z.string().trim().url().max(500), token: z.string().trim().max(1000).optional(), username: z.string().trim().max(200).optional(), password: z.string().max(500).optional() }).parse(request.body);
    context.db.prepare(`INSERT INTO app_settings(key, value, updated_at) VALUES ('mtw_base_url', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(body.baseUrl.replace(/\/$/, ''));
    if (body.token !== undefined && body.token !== '') {
      context.db.prepare(`INSERT INTO app_settings(key, value, updated_at) VALUES ('mtw_token', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(body.token);
    }
    if (body.username !== undefined && body.username !== '') {
      context.db.prepare(`INSERT INTO app_settings(key, value, updated_at) VALUES ('mtw_username', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(body.username);
    }
    if (body.password !== undefined && body.password !== '') {
      context.db.prepare(`INSERT INTO app_settings(key, value, updated_at) VALUES ('mtw_password', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(body.password);
    }
    audit.record({ actorUserId: currentUser(request).id, action: 'mtw_settings_updated', targetType: 'system' });
    const settings = readMtwSettings();
    return { ok: true, baseUrl: body.baseUrl.replace(/\/$/, ''), tokenConfigured: Boolean(settings.token), usernameConfigured: Boolean(settings.username), passwordConfigured: Boolean(settings.password) };
  });

  app.get('/api/admin/mtw/health', { preHandler: requireAdmin }, async (_request, reply) => {
    try { return await mtwClient().health(); }
    catch (error) { return reply.code(400).send({ code: 'MTW_NOT_CONFIGURED', message: error instanceof Error ? error.message : 'MTW 健康检查失败。' }); }
  });

  const runMtwScan = async (batchId: string, path: string): Promise<void> => {
    const saveProgress = (progress: MtwScanProgress) => {
      context.db.prepare("UPDATE mtw_batches SET result = ?, progress = ?, updated_at = datetime('now') WHERE id = ? AND status = 'scanning'").run(JSON.stringify(progress), JSON.stringify(progress), batchId);
    };
    try {
      const scanned = await mtwClient().scanMetadata(path, saveProgress);
      const images = scanned.files.map((item) => item.path ?? item.file_full_path ?? '').filter((value) => /\.(?:jpe?g|png|webp)$/i.test(value));
      const insert = context.db.prepare(`INSERT INTO mtw_batch_items(batch_id, source_path, cover_path, title, artist, album, version, language, genre, lyrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      context.db.transaction(() => {
        for (const item of scanned.metadata) {
          const sourcePath = item.path;
          const parent = sourcePath?.replace(/[\\/][^\\/]*$/, '') ?? '';
          const coverPath = images.find((value) => value.replace(/[\\/][^\\/]*$/, '') === parent) ?? (item.artworkAvailable ? sourcePath : null);
          insert.run(batchId, sourcePath, coverPath, item.title, item.artist, item.album, item.version, item.language, item.genre, item.lyrics);
        }
        const completed = { phase: 'completed', completed: scanned.metadata.length, total: scanned.metadata.length, message: `目录扫描完成，共找到 ${scanned.metadata.length} 首歌曲。`, count: scanned.metadata.length };
        context.db.prepare("UPDATE mtw_batches SET status = 'ready', result = ?, progress = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(completed), JSON.stringify(completed), batchId);
      })();
    } catch (error) {
      context.db.prepare("UPDATE mtw_batches SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'cancelled'").run(error instanceof Error ? error.message : 'MTW 扫描失败。', batchId);
    }
  };

  /** 管理后台的 MTW 导入任务在服务端执行，避免移动端请求长时间占用连接。 */
  const runMtwImport = async (batchId: string, itemIds: number[], userId: number): Promise<void> => {
    let created = 0; let updated = 0; let similarSkipped = 0; let covers = 0; let coverFailed = 0; let processed = 0;
    try {
      const rows = context.db.prepare(`SELECT * FROM mtw_batch_items WHERE batch_id = ? AND id IN (${itemIds.map(() => '?').join(',')}) ORDER BY id`).all(batchId, ...itemIds) as any[];
      for (const item of rows) {
        const state = context.db.prepare('SELECT status FROM mtw_batches WHERE id = ?').get(batchId) as { status: string } | undefined;
        if (!state || state.status === 'cancelled') break;
        const matches = catalog.findCandidates(item);
        if (matches.similar.length && !matches.exact) {
          context.db.prepare("UPDATE mtw_batch_items SET action = 'similar_skipped' WHERE id = ?").run(item.id); similarSkipped += 1;
        } else {
          let songId: number;
          if (matches.exact) {
            songId = matches.exact.id;
            context.db.prepare(`UPDATE songs SET album = coalesce(?, album), language = coalesce(?, language), genre = coalesce(?, genre), lyrics = coalesce(?, lyrics) WHERE id = ?`).run(item.album, item.language, item.genre, item.lyrics, songId);
            rebuildSongSearchIndex(context.db, songId); updated += 1;
            context.db.prepare("UPDATE mtw_batch_items SET song_id = ?, action = 'updated' WHERE id = ?").run(songId, item.id);
          } else {
            songId = catalog.createSong({ title: item.title, artist: item.artist, version: item.version, album: item.album, language: item.language, genre: item.genre, lyrics: item.lyrics, performanceType: 'solo', addedBy: userId });
            context.db.prepare("UPDATE mtw_batch_items SET song_id = ?, action = 'created' WHERE id = ?").run(songId, item.id); created += 1;
          }
          // 先报告歌曲资料已经处理，封面下载失败或超时不会让进度长期停在 0%。
          context.db.prepare("UPDATE mtw_batches SET progress = ?, updated_at = datetime('now') WHERE id = ? AND status = 'importing'").run(JSON.stringify({ phase: 'importing', completed: processed + 1, total: rows.length, itemIds, message: '歌曲资料已处理，正在获取封面' }), batchId);
          if (item.cover_path) {
            try {
              const cover = await mtwClient().fetchImage(item.cover_path);
              coverStorage.save(songId, cover.bytes, cover.mimeType, item.cover_path); covers += 1;
              context.db.prepare("UPDATE mtw_batch_items SET cover_status = 'ready', error = NULL WHERE id = ?").run(item.id);
            } catch (error) {
              coverFailed += 1;
              context.db.prepare("UPDATE mtw_batch_items SET cover_status = 'failed', error = ? WHERE id = ?").run(error instanceof Error ? error.message : '封面下载失败。', item.id);
            }
          } else context.db.prepare("UPDATE mtw_batch_items SET cover_status = 'missing' WHERE id = ?").run(item.id);
        }
        processed += 1;
        context.db.prepare("UPDATE mtw_batches SET progress = ?, updated_at = datetime('now') WHERE id = ? AND status = 'importing'").run(JSON.stringify({ phase: 'importing', completed: processed, total: rows.length, itemIds, message: `正在导入 ${item.title} · ${item.artist}`, created, updated, similarSkipped, covers, coverFailed }), batchId);
      }
      const cancelled = (context.db.prepare('SELECT status FROM mtw_batches WHERE id = ?').get(batchId) as { status: string } | undefined)?.status === 'cancelled';
      const remaining = (context.db.prepare("SELECT count(*) AS count FROM mtw_batch_items WHERE batch_id = ? AND action = 'candidate'").get(batchId) as { count: number }).count;
      const finalStatus = cancelled ? 'cancelled' : coverFailed > 0 ? 'partial_failed' : remaining > 0 ? 'ready' : 'done';
      context.db.prepare("UPDATE mtw_batches SET status = ?, result = ?, progress = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('importing', 'cancelled')").run(finalStatus, JSON.stringify({ created, updated, similarSkipped, covers, coverFailed, processed }), JSON.stringify({ phase: finalStatus, completed: processed, total: rows.length, message: cancelled ? '导入已取消。' : `导入完成，共处理 ${processed} 首。`, created, updated, similarSkipped, covers, coverFailed }), batchId);
    } catch (error) {
      context.db.prepare("UPDATE mtw_batches SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'importing'").run(error instanceof Error ? error.message : 'MTW 导入失败。', batchId);
    }
  };

  /** 服务重启后恢复未完成的 MTW 导入，避免前端看到 importing 却永远停在 0%。 */
  const recoverMtwImports = (): void => {
    // 旧版数据库的状态约束不包含 partial_failed，避免一次导入已处理完却被错误标记为失败。
    context.db.prepare("UPDATE mtw_batches SET status = 'partial_failed', error = '歌曲资料已导入，但部分封面失败，可在批次中重试封面。', updated_at = datetime('now') WHERE status = 'failed' AND error LIKE 'CHECK constraint failed:%' AND progress LIKE '%\"phase\":\"importing\"%'").run();
    const batches = context.db.prepare("SELECT id, created_by AS createdBy, progress FROM mtw_batches WHERE status = 'importing'").all() as Array<{ id: string; createdBy: number; progress: string | null }>;
    for (const batch of batches) {
      let total = 0;
      try { total = Number((batch.progress ? JSON.parse(batch.progress) : {}).total ?? 0); } catch { total = 0; }
      const rows = context.db.prepare('SELECT id FROM mtw_batch_items WHERE batch_id = ? ORDER BY id LIMIT ?').all(batch.id, Math.max(1, total)) as Array<{ id: number }>;
      if (!rows.length) {
        context.db.prepare("UPDATE mtw_batches SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'importing'").run('服务重启后没有找到待恢复的歌曲，请重新选择候选歌曲导入。', batch.id);
        continue;
      }
      void runMtwImport(batch.id, rows.map((row) => row.id), batch.createdBy);
    }
  };

  const mtwItemFilters = (query: { q?: string; artist?: string; album?: string; coverStatus?: string; lyricsStatus?: string; action?: string }) => {
    const clauses = ['batch_id = @batchId'];
    const params: Record<string, string | number> = { batchId: '' };
    if (query.q) { clauses.push('(title LIKE @q OR artist LIKE @q OR coalesce(album, \'\') LIKE @q)'); params.q = `%${query.q}%`; }
    if (query.artist) { clauses.push('artist LIKE @artist'); params.artist = `%${query.artist}%`; }
    if (query.album) { clauses.push('coalesce(album, \'\') LIKE @album'); params.album = `%${query.album}%`; }
    if (query.coverStatus && ['pending', 'ready', 'missing', 'failed'].includes(query.coverStatus)) { clauses.push('cover_status = @coverStatus'); params.coverStatus = query.coverStatus; }
    if (query.lyricsStatus === 'present') clauses.push("trim(coalesce(lyrics, '')) <> ''");
    if (query.lyricsStatus === 'missing') clauses.push("trim(coalesce(lyrics, '')) = ''");
    if (query.action && ['candidate', 'created', 'updated', 'similar_skipped', 'failed', 'revoked', 'review'].includes(query.action)) { clauses.push('action = @action'); params.action = query.action; }
    return { where: clauses.join(' AND '), params };
  };

  app.post('/api/admin/mtw/scans', { preHandler: requireReviewer }, async (request, reply) => {
    const body = z.object({ path: z.string().trim().min(1).max(1000) }).parse(request.body);
    const batchId = randomUUID();
    context.db.prepare("INSERT INTO mtw_batches(id, created_by, status, result) VALUES (?, ?, 'scanning', ?)").run(batchId, currentUser(request).id, JSON.stringify({ phase: 'listing', completed: 0, total: 0, message: '正在准备 MTW 扫描...' }));
    void runMtwScan(batchId, body.path);
    return reply.code(202).send({ batchId, status: 'scanning' });
  });

  app.get('/api/admin/mtw/scans/:id', { preHandler: requireReviewer }, async (request, reply) => {
    const { id } = taskParamSchema.parse(request.params);
    const batch = context.db.prepare('SELECT id, status, result, error, created_at AS createdAt, updated_at AS updatedAt FROM mtw_batches WHERE id = ?').get(id) as any;
    if (!batch) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到 MTW 扫描批次。' });
    let progress: MtwScanProgress | null = null;
    try { progress = batch.result ? JSON.parse(batch.result) as MtwScanProgress : null; } catch { progress = null; }
    const items = context.db.prepare('SELECT id, title, artist, album, version, language, genre, song_id AS songId, action, cover_status AS coverStatus, error FROM mtw_batch_items WHERE batch_id = ? ORDER BY id').all(id);
    return { batch, progress, items };
  });

  app.get('/api/admin/mtw/scans/:id/items', { preHandler: requireReviewer }, async (request, reply) => {
    const { id } = taskParamSchema.parse(request.params);
    const query = z.object({ q: z.string().trim().max(120).default(''), artist: z.string().trim().max(120).default(''), album: z.string().trim().max(200).default(''), coverStatus: z.string().default(''), lyricsStatus: z.enum(['all', 'present', 'missing']).default('all'), action: z.string().default(''), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30), sort: z.enum(['id', 'title', 'artist', 'album']).default('id') }).parse(request.query);
    const batch = context.db.prepare('SELECT id, status, result, progress, error, created_at AS createdAt, updated_at AS updatedAt FROM mtw_batches WHERE id = ?').get(id) as any;
    if (!batch) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到 MTW 扫描批次。' });
    const filters = mtwItemFilters(query); filters.params.batchId = id;
    const order = { id: 'id', title: 'title COLLATE NOCASE, id', artist: 'artist COLLATE NOCASE, title COLLATE NOCASE, id', album: 'album COLLATE NOCASE, title COLLATE NOCASE, id' }[query.sort];
    const items = context.db.prepare(`SELECT id, title, artist, album, version, language, genre, song_id AS songId, action, cover_status AS coverStatus, trim(coalesce(lyrics, '')) <> '' AS hasLyrics, error FROM mtw_batch_items WHERE ${filters.where} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all({ ...filters.params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
    const total = (context.db.prepare(`SELECT count(*) AS count FROM mtw_batch_items WHERE ${filters.where}`).get(filters.params) as { count: number }).count;
    const summary = context.db.prepare('SELECT count(*) AS total, sum(CASE WHEN action = \'candidate\' THEN 1 ELSE 0 END) AS candidates, sum(CASE WHEN cover_status = \'ready\' THEN 1 ELSE 0 END) AS covers, sum(CASE WHEN cover_status = \'failed\' THEN 1 ELSE 0 END) AS coverFailures, sum(CASE WHEN trim(coalesce(lyrics, \'\')) = \'\' THEN 1 ELSE 0 END) AS lyricMissing FROM mtw_batch_items WHERE batch_id = ?').get(id) as any;
    return { batch, items, total, hasMore: query.page * query.pageSize < total, page: query.page, pageSize: query.pageSize, summary: Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Number(value ?? 0)])) };
  });

  app.post('/api/admin/mtw/import-batches', { preHandler: requireReviewer }, async (request, reply) => {
    const user = currentUser(request);
    const body = z.object({ scanId: z.string().uuid(), itemIds: z.array(z.number().int().positive()).min(1).max(5000) }).parse(request.body);
    const batch = context.db.prepare("SELECT id, status FROM mtw_batches WHERE id = ? AND status = 'ready'").get(body.scanId) as { id: string; status: string } | undefined;
    if (!batch) return reply.code(409).send({ code: 'MTW_BATCH_NOT_READY', message: 'MTW 批次尚未准备好或已经处理。' });
    let created = 0; let updated = 0; let similarSkipped = 0; let covers = 0; let coverFailed = 0;
    const rows = context.db.prepare(`SELECT * FROM mtw_batch_items WHERE batch_id = ? AND id IN (${body.itemIds.map(() => '?').join(',')})`).all(body.scanId, ...body.itemIds) as any[];
    for (const item of rows) {
        const matches = catalog.findCandidates(item);
        if (matches.similar.length && !matches.exact) {
          context.db.prepare("UPDATE mtw_batch_items SET action = 'similar_skipped' WHERE id = ?").run(item.id); similarSkipped += 1; continue;
        }
        let songId: number;
        if (matches.exact) {
          songId = matches.exact.id;
          context.db.prepare(`UPDATE songs SET album = coalesce(?, album), language = coalesce(?, language), genre = coalesce(?, genre), lyrics = coalesce(?, lyrics) WHERE id = ?`).run(item.album, item.language, item.genre, item.lyrics, songId);
          rebuildSongSearchIndex(context.db, songId); updated += 1;
          context.db.prepare("UPDATE mtw_batch_items SET song_id = ?, action = 'updated' WHERE id = ?").run(songId, item.id);
        } else {
          songId = catalog.createSong({ title: item.title, artist: item.artist, version: item.version, album: item.album, language: item.language, genre: item.genre, lyrics: item.lyrics, performanceType: 'solo', addedBy: user.id });
          context.db.prepare("UPDATE mtw_batch_items SET song_id = ?, action = 'created' WHERE id = ?").run(songId, item.id); created += 1;
        }
      if (item.cover_path) {
        try {
          const cover = await mtwClient().fetchImage(item.cover_path);
          coverStorage.save(songId, cover.bytes, cover.mimeType, item.cover_path); covers += 1;
          context.db.prepare("UPDATE mtw_batch_items SET cover_status = 'ready' WHERE id = ?").run(item.id);
        } catch (error) {
          coverFailed += 1;
          context.db.prepare("UPDATE mtw_batch_items SET cover_status = 'failed', error = ? WHERE id = ?").run(error instanceof Error ? error.message : '封面下载失败。', item.id);
        }
      } else context.db.prepare("UPDATE mtw_batch_items SET cover_status = 'missing' WHERE id = ?").run(item.id);
    }
    context.db.prepare("UPDATE mtw_batches SET status = 'done', result = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify({ created, updated, similarSkipped, covers, coverFailed }), body.scanId);
    return { batchId: body.scanId, created, updated, similarSkipped, covers, coverFailed };
  });

  app.post('/api/admin/mtw/import-batches/:id/import', { preHandler: requireReviewer }, async (request, reply) => {
    const user = currentUser(request); const { id } = taskParamSchema.parse(request.params);
    const body = z.object({
      itemIds: z.array(z.number().int().positive()).min(1).max(5000).optional(),
      filters: z.object({ q: z.string().trim().max(120).default(''), artist: z.string().trim().max(120).default(''), album: z.string().trim().max(200).default(''), coverStatus: z.string().default(''), lyricsStatus: z.enum(['all', 'present', 'missing']).default('all'), action: z.string().default('') }).optional(),
      excludeItemIds: z.array(z.number().int().positive()).max(5000).default([])
    }).refine((value) => value.itemIds?.length || value.filters, { message: '必须指定歌曲或筛选条件。' }).parse(request.body);
    const batch = context.db.prepare("SELECT id, status FROM mtw_batches WHERE id = ? AND status IN ('ready', 'partial_failed', 'cancelled', 'failed')").get(id) as { id: string; status: string } | undefined;
    if (!batch) return reply.code(409).send({ code: 'MTW_BATCH_NOT_READY', message: 'MTW 批次尚未准备好，或已经在处理中。' });
    let itemIds = body.itemIds ?? [];
    if (!body.itemIds && body.filters) {
      const filters = mtwItemFilters(body.filters); filters.params.batchId = id;
      if (body.excludeItemIds.length) { body.excludeItemIds.forEach((value, index) => { filters.params[`exclude${index}`] = value; }); filters.where += ` AND id NOT IN (${body.excludeItemIds.map((_, index) => `@exclude${index}`).join(',')})`; }
      itemIds = (context.db.prepare(`SELECT id FROM mtw_batch_items WHERE ${filters.where} AND action = 'candidate' ORDER BY id`).all(filters.params) as Array<{ id: number }>).map((row) => row.id);
    }
    if (!itemIds.length) return reply.code(400).send({ code: 'EMPTY_SELECTION', message: '没有符合条件的待导入歌曲。' });
    context.db.prepare("UPDATE mtw_batches SET status = 'importing', progress = ?, error = NULL, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify({ phase: 'importing', completed: 0, total: itemIds.length, itemIds, message: '导入任务已排队。' }), id);
    void runMtwImport(id, itemIds, user.id);
    return reply.code(202).send({ batchId: id, status: 'importing', selected: itemIds.length });
  });

  app.post('/api/admin/mtw/import-batches/:id/cancel', { preHandler: requireReviewer }, async (request, reply) => {
    const { id } = taskParamSchema.parse(request.params);
    const result = context.db.prepare("UPDATE mtw_batches SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status IN ('scanning', 'importing')").run(id);
    if (!result.changes) return reply.code(409).send({ code: 'TASK_NOT_RUNNING', message: '当前批次没有正在运行的任务。' });
    return { ok: true, batchId: id, status: 'cancelled' };
  });

  app.get('/api/admin/overview', { preHandler: requireReviewer }, async () => {
    const count = (sql: string) => Number((context.db.prepare(sql).get() as { count: number }).count ?? 0);
    return {
      songs: count("SELECT count(*) AS count FROM songs WHERE status = 'active'"), deletedSongs: count("SELECT count(*) AS count FROM songs WHERE status = 'deleted'"),
      covers: count("SELECT count(*) AS count FROM cover_assets WHERE status = 'ready'"), songsWithoutCover: count("SELECT count(*) AS count FROM songs s WHERE s.status = 'active' AND NOT EXISTS (SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id)"), songsWithoutLyrics: count("SELECT count(*) AS count FROM songs WHERE status = 'active' AND trim(coalesce(lyrics, '')) = ''"),
      pendingDeletionReviews: count("SELECT count(*) AS count FROM song_deletion_requests WHERE status = 'pending'"), pendingLyricsReviews: count("SELECT count(*) AS count FROM lyric_submissions WHERE status = 'pending'"), pendingSongReviews: count("SELECT count(*) AS count FROM song_submissions WHERE status = 'pending'"),
      runningTasks: count("SELECT count(*) AS count FROM mtw_batches WHERE status IN ('scanning', 'importing', 'revoking')") + count("SELECT count(*) AS count FROM tasks WHERE status IN ('pending', 'running')"),
      recentBatches: context.db.prepare('SELECT id, status, result, progress, error, created_at AS createdAt, updated_at AS updatedAt FROM mtw_batches ORDER BY created_at DESC LIMIT 8').all()
    };
  });

  app.get('/api/admin/tasks', { preHandler: requireReviewer }, async () => ({
    mtw: context.db.prepare('SELECT id, status, result, progress, error, created_at AS createdAt, updated_at AS updatedAt FROM mtw_batches ORDER BY updated_at DESC LIMIT 30').all(),
    imports: context.db.prepare("SELECT id, type, status, result, error, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE type = 'song_import' ORDER BY updated_at DESC LIMIT 30").all()
  }));

  app.get('/api/admin/songs', { preHandler: requireReviewer }, async (request) => {
    const query = z.object({ q: z.string().trim().max(120).default(''), status: z.enum(['all', 'active', 'deleted']).default('active'), source: z.enum(['all', 'mtw', 'manual']).default('all'), completeness: z.enum(['all', 'missing_album', 'missing_lyrics', 'missing_cover']).default('all'), deletionStatus: z.enum(['all', 'pending']).default('all'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(10).max(100).default(30), sort: z.enum(['id', 'title', 'artist', 'updated']).default('updated') }).parse(request.query);
    const clauses = ['1 = 1']; const params: Record<string, string | number> = {};
    if (query.q) { clauses.push('(s.title LIKE @q OR s.artist LIKE @q OR coalesce(s.album, \'\') LIKE @q)'); params.q = `%${query.q}%`; }
    if (query.status !== 'all') { clauses.push('s.status = @status'); params.status = query.status; }
    if (query.source === 'mtw') clauses.push('EXISTS (SELECT 1 FROM mtw_batch_items mi WHERE mi.song_id = s.id)');
    if (query.source === 'manual') clauses.push('NOT EXISTS (SELECT 1 FROM mtw_batch_items mi WHERE mi.song_id = s.id)');
    if (query.completeness === 'missing_album') clauses.push("trim(coalesce(s.album, '')) = ''");
    if (query.completeness === 'missing_lyrics') clauses.push("trim(coalesce(s.lyrics, '')) = ''");
    if (query.completeness === 'missing_cover') clauses.push('NOT EXISTS (SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id)');
    if (query.deletionStatus === 'pending') clauses.push("EXISTS (SELECT 1 FROM song_deletion_requests dr WHERE dr.song_id = s.id AND dr.status = 'pending')");
    const where = clauses.join(' AND '); const order = { id: 's.id DESC', title: 's.title COLLATE NOCASE, s.id DESC', artist: 's.artist COLLATE NOCASE, s.title COLLATE NOCASE', updated: 's.id DESC' }[query.sort];
    const songs = context.db.prepare(`SELECT s.id, s.title, s.artist, s.version, s.album, s.language, s.genre, s.status, s.added_by AS addedBy, EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) AS hasCover, trim(coalesce(s.lyrics, '')) <> '' AS hasLyrics, EXISTS(SELECT 1 FROM mtw_batch_items mi WHERE mi.song_id = s.id) AS fromMtw, EXISTS(SELECT 1 FROM song_deletion_requests dr WHERE dr.song_id = s.id AND dr.status = 'pending') AS deletionPending FROM songs s WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all({ ...params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
    const total = (context.db.prepare(`SELECT count(*) AS count FROM songs s WHERE ${where}`).get(params) as { count: number }).count;
    return { songs, total, hasMore: query.page * query.pageSize < total, page: query.page, pageSize: query.pageSize };
  });

  app.post('/api/admin/songs/bulk-delete', { preHandler: requireReviewer }, async (request) => {
    const body = z.object({ songIds: z.array(z.number().int().positive()).min(1).max(5000) }).parse(request.body); const ids = [...new Set(body.songIds)];
    const result = context.db.prepare(`UPDATE songs SET status = 'deleted' WHERE status = 'active' AND id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    audit.record({ actorUserId: currentUser(request).id, action: 'songs_bulk_deleted', targetType: 'song_batch', metadata: { requested: ids.length, updated: result.changes } }); return { ok: true, updated: result.changes };
  });

  app.post('/api/admin/songs/bulk-restore', { preHandler: requireReviewer }, async (request) => {
    const body = z.object({ songIds: z.array(z.number().int().positive()).min(1).max(5000) }).parse(request.body); const ids = [...new Set(body.songIds)];
    const result = context.db.prepare(`UPDATE songs SET status = 'active' WHERE status = 'deleted' AND id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    audit.record({ actorUserId: currentUser(request).id, action: 'songs_bulk_restored', targetType: 'song_batch', metadata: { requested: ids.length, updated: result.changes } }); return { ok: true, updated: result.changes };
  });

  app.get('/api/admin/reviews', { preHandler: requireReviewer }, async (request) => {
    const query = z.object({ type: z.enum(['all', 'deletion', 'lyrics', 'song']).default('all'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(10).max(100).default(30) }).parse(request.query); const rows: any[] = [];
    if (query.type === 'all' || query.type === 'deletion') rows.push(...context.db.prepare("SELECT 'deletion' AS type, r.id, r.status, r.created_at AS createdAt, s.id AS songId, s.title, s.artist, s.album, u.username AS submitter, r.review_note AS note FROM song_deletion_requests r JOIN songs s ON s.id = r.song_id JOIN users u ON u.id = r.requested_by WHERE r.status = 'pending' ORDER BY r.created_at").all());
    if (query.type === 'all' || query.type === 'lyrics') rows.push(...context.db.prepare("SELECT 'lyrics' AS type, l.id, l.status, l.created_at AS createdAt, s.id AS songId, s.title, s.artist, s.album, u.username AS submitter, l.source, l.lyrics, NULL AS note FROM lyric_submissions l JOIN songs s ON s.id = l.song_id JOIN users u ON u.id = l.submitted_by WHERE l.status = 'pending' ORDER BY l.created_at").all());
    if (query.type === 'all' || query.type === 'song') rows.push(...context.db.prepare("SELECT 'song' AS type, ss.id, ss.status, ss.created_at AS createdAt, ss.matched_song_id AS songId, u.username AS submitter, NULL AS title, NULL AS artist, NULL AS album, NULL AS note FROM song_submissions ss JOIN users u ON u.id = ss.submitted_by WHERE ss.status = 'pending' ORDER BY ss.created_at").all());
    rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || Number(a.id) - Number(b.id)); const start = (query.page - 1) * query.pageSize;
    return { reviews: rows.slice(start, start + query.pageSize), total: rows.length, hasMore: start + query.pageSize < rows.length, page: query.page, pageSize: query.pageSize };
  });

  const reviewBatchAction = async (request: FastifyRequest, reply: FastifyReply, decision: 'approve' | 'reject') => {
    const reviewer = currentUser(request); const body = z.object({ type: z.enum(['deletion', 'lyrics']), reviewIds: z.array(z.number().int().positive()).min(1).max(5000), reviewNote: z.string().trim().max(1000).optional() }).parse(request.body); let updated = 0;
    for (const id of [...new Set(body.reviewIds)]) {
      if (body.type === 'deletion') {
        if (decision === 'approve') { const changed = context.db.transaction(() => { const row = context.db.prepare("SELECT song_id AS songId FROM song_deletion_requests WHERE id = ? AND status = 'pending'").get(id) as { songId: number } | undefined; if (!row) return false; const result = context.db.prepare("UPDATE song_deletion_requests SET status = 'approved', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, body.reviewNote ?? null, id); if (!result.changes) return false; context.db.prepare("UPDATE songs SET status = 'deleted' WHERE id = ? AND status = 'active'").run(row.songId); return true; })(); if (changed) updated += 1; }
        else updated += context.db.prepare("UPDATE song_deletion_requests SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, body.reviewNote ?? null, id).changes;
      } else if (decision === 'approve') { const changed = context.db.transaction(() => { const row = context.db.prepare("SELECT song_id AS songId, lyrics FROM lyric_submissions WHERE id = ? AND status = 'pending'").get(id) as { songId: number; lyrics: string } | undefined; if (!row) return false; const result = context.db.prepare("UPDATE lyric_submissions SET status = 'approved', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, body.reviewNote ?? null, id); if (!result.changes) return false; context.db.prepare('UPDATE songs SET lyrics = ? WHERE id = ?').run(row.lyrics, row.songId); rebuildSongSearchIndex(context.db, row.songId); return true; })(); if (changed) updated += 1; }
      else updated += context.db.prepare("UPDATE lyric_submissions SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, body.reviewNote ?? null, id).changes;
    }
    return reply.send({ ok: true, updated });
  };
  app.post('/api/admin/reviews/bulk-approve', { preHandler: requireReviewer }, async (request, reply) => reviewBatchAction(request, reply, 'approve'));
  app.post('/api/admin/reviews/bulk-reject', { preHandler: requireReviewer }, async (request, reply) => reviewBatchAction(request, reply, 'reject'));

  app.get('/api/admin/mtw/import-batches', { preHandler: requireReviewer }, async () => ({ batches: context.db.prepare('SELECT id, status, result, progress, error, created_at AS createdAt, updated_at AS updatedAt FROM mtw_batches ORDER BY created_at DESC').all() }));

  app.get('/api/admin/mtw/import-batches/:id', { preHandler: requireReviewer }, async (request, reply) => {
    const { id } = taskParamSchema.parse(request.params);
    const batch = context.db.prepare('SELECT id, status, result, error, created_at AS createdAt, updated_at AS updatedAt FROM mtw_batches WHERE id = ?').get(id) as any;
    if (!batch) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到 MTW 导入批次。' });
    return { batch, items: context.db.prepare('SELECT * FROM mtw_batch_items WHERE batch_id = ? ORDER BY id').all(id) };
  });

  app.get('/api/admin/mtw/import-batches/:id/items', { preHandler: requireReviewer }, async (request) => {
    const { id } = taskParamSchema.parse(request.params);
    const query = z.object({ q: z.string().trim().max(120).default(''), artist: z.string().trim().max(120).default(''), album: z.string().trim().max(200).default(''), coverStatus: z.string().default(''), lyricsStatus: z.enum(['all', 'present', 'missing']).default('all'), action: z.string().default(''), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30), sort: z.enum(['id', 'title', 'artist', 'album']).default('id') }).parse(request.query);
    const filters = mtwItemFilters(query); filters.params.batchId = id;
    const order = { id: 'id', title: 'title COLLATE NOCASE, id', artist: 'artist COLLATE NOCASE, title COLLATE NOCASE, id', album: 'album COLLATE NOCASE, title COLLATE NOCASE, id' }[query.sort];
    const items = context.db.prepare(`SELECT id, title, artist, album, version, language, genre, song_id AS songId, action, cover_status AS coverStatus, error FROM mtw_batch_items WHERE ${filters.where} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all({ ...filters.params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
    const total = (context.db.prepare(`SELECT count(*) AS count FROM mtw_batch_items WHERE ${filters.where}`).get(filters.params) as { count: number }).count;
    return { items, total, hasMore: query.page * query.pageSize < total, page: query.page, pageSize: query.pageSize };
  });

  app.post('/api/admin/mtw/import-batches/:id/retry-covers', { preHandler: requireReviewer }, async (request) => {
    const { id } = taskParamSchema.parse(request.params);
    const items = context.db.prepare("SELECT id, song_id AS songId, cover_path AS coverPath FROM mtw_batch_items WHERE batch_id = ? AND cover_path IS NOT NULL AND cover_status IN ('failed', 'pending')").all(id) as Array<{ id: number; songId: number | null; coverPath: string }>;
    let imported = 0; let failed = 0;
    for (const item of items) {
      if (!item.songId) continue;
      try {
        const cover = await mtwClient().fetchImage(item.coverPath);
        coverStorage.save(item.songId, cover.bytes, cover.mimeType, item.coverPath);
        context.db.prepare("UPDATE mtw_batch_items SET cover_status = 'ready', error = NULL WHERE id = ?").run(item.id); imported += 1;
      } catch (error) {
        context.db.prepare("UPDATE mtw_batch_items SET cover_status = 'failed', error = ? WHERE id = ?").run(error instanceof Error ? error.message : '封面下载失败。', item.id); failed += 1;
      }
    }
    return { batchId: id, imported, failed };
  });

  app.post('/api/admin/mtw/import-batches/:id/revoke', { preHandler: requireReviewer }, async (request) => {
    const { id } = taskParamSchema.parse(request.params);
    const items = context.db.prepare("SELECT id, song_id AS songId, action FROM mtw_batch_items WHERE batch_id = ? AND action = 'created' AND song_id IS NOT NULL").all(id) as Array<{ id: number; songId: number; action: string }>;
    let revoked = 0; let needsReview = 0;
    for (const item of items) {
      const used = context.db.prepare(`
        SELECT EXISTS(SELECT 1 FROM user_songs WHERE song_id = ? AND removed_at IS NULL)
          OR EXISTS(SELECT 1 FROM plays WHERE song_id = ?)
          OR EXISTS(SELECT 1 FROM pick_events WHERE song_id = ?)
          OR EXISTS(SELECT 1 FROM playlist_songs WHERE song_id = ?) AS used
      `).get(item.songId, item.songId, item.songId, item.songId) as { used: number };
      if (used.used) {
        const existing = context.db.prepare("SELECT id FROM song_deletion_requests WHERE song_id = ? AND status = 'pending'").get(item.songId);
        if (!existing) context.db.prepare("INSERT INTO song_deletion_requests(song_id, requested_by, review_note) VALUES (?, ?, 'MTW 批次撤销发现该歌曲已有使用记录，请审核。')").run(item.songId, currentUser(request).id);
        context.db.prepare("UPDATE mtw_batch_items SET action = 'review' WHERE id = ?").run(item.id);
        needsReview += 1;
      } else {
        const cover = context.db.prepare('SELECT cover_id AS coverId FROM song_covers WHERE song_id = ?').get(item.songId) as { coverId: number } | undefined;
        context.db.prepare('DELETE FROM song_covers WHERE song_id = ?').run(item.songId);
        context.db.prepare("UPDATE songs SET status = 'deleted' WHERE id = ? AND status = 'active'").run(item.songId);
        context.db.prepare("UPDATE mtw_batch_items SET action = 'revoked' WHERE id = ?").run(item.id);
        if (cover) coverStorage.removeIfUnused(cover.coverId);
        revoked += 1;
      }
    }
    context.db.prepare("UPDATE mtw_batches SET status = 'revoked', result = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('done', 'ready', 'partial_failed')").run(JSON.stringify({ revoked, needsReview }), id);
    return { batchId: id, revoked, needsReview };
  });

  app.get('/api/songs', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = z.object({ collection: z.enum(['repertoire', 'learning']).optional() }).parse(request.query);
    const rows = context.db.prepare(`
      SELECT s.id, s.title, s.artist, s.version, s.album, s.language, s.genre,
             EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) AS hasCover,
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
    return { songs: (rows as any[]).map((row) => ({ ...row, coverUrl: row.hasCover ? `/api/songs/${row.id}/cover` : null })) };
  });

  app.post('/api/songs', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const body = createSongSchema.parse(request.body);
    const matches = catalog.findCandidates(body);
    const publicCandidate = (song: CatalogCandidate) => ({
      id: song.id, title: song.title, artist: song.artist, version: song.version, album: song.album,
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
        title: body.title, artist: body.artist, version: body.version ?? null, album: body.album ?? null,
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
        songId = catalog.createSong({ ...body, addedBy: user.id });
        status = 'created';
        const aliasInsert = context.db.prepare('INSERT INTO song_aliases(song_id, alias) VALUES (?, ?)');
        for (const alias of body.aliases) aliasInsert.run(songId, alias);
        rebuildSongSearchIndex(context.db, songId);
      }
      catalog.collectUserSong(user.id, songId, personalPayload);
      return { songId, status };
    })();
    if (result.status === 'created') invalidateSearchMeta();
    return reply.code(result.status === 'created' ? 201 : 200).send(result);
  });

  /** 首屏歌曲接口不执行总数、筛选项和字母索引查询，避免全部曲库被慢元数据拖住。 */
  app.get('/api/search/quick', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = searchSongsQuerySchema.parse(request.query) as SearchQuery;
    return searchSongsQuick(context.db, user.id, query);
  });

  /** 元数据允许独立失败，并按用户和完整筛选条件短时缓存，不能跨用户复用。 */
  app.get('/api/search/meta', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = searchSongsQuerySchema.parse(request.query) as SearchQuery;
    const cacheKey = `${user.id}|${JSON.stringify(query)}`;
    const cached = searchMetaCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = searchSongsMeta(context.db, user.id, query);
    searchMetaCache.set(cacheKey, { value, expiresAt: Date.now() + 20_000 });
    return value;
  });

  /** 旧接口继续保留完整响应，供旧客户端和后台测试兼容使用。 */
  app.get('/api/search', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const query = searchSongsQuerySchema.parse(request.query);
    const term = `%${query.q}%`;
    const compactTerm = `%${query.q.replace(/\s+/g, '')}%`;
    const params: Record<string, unknown> = {
      userId: user.id,
      collection: query.collection ?? null,
      query: query.q,
      term,
      compactTerm,
      ftsQuery: toFtsQuery(query.q),
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
        SELECT DISTINCT s.id, s.title, s.artist, s.version, s.album, s.language, s.genre,
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
          ss.pinyin_compact AS indexedPinyin,
          EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) AS hasCover
        FROM songs s
        LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
        LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
        LEFT JOIN song_search ss ON ss.song_id = s.id
        WHERE s.status = 'active' AND ${scopeFilter}
        GROUP BY s.id
      ), filtered AS (
        SELECT * FROM catalog WHERE (
          @query = '' OR (
            @ftsQuery <> '' AND (
              id IN (SELECT song_id FROM song_search WHERE song_search MATCH @ftsQuery)
              OR id IN (SELECT song_id FROM user_song_search WHERE user_id = @userId AND user_song_search MATCH @ftsQuery)
            )
          ) OR indexedPinyin LIKE @compactTerm
          OR title LIKE @term OR artist LIKE @term OR coalesce(version, '') LIKE @term OR coalesce(album, '') LIKE @term
          OR coalesce(lyrics, '') LIKE @term OR coalesce(lyricsTranslit, '') LIKE @term
          OR coalesce(personalNote, '') LIKE @term OR coalesce(personalMemoryCue, '') LIKE @term
          OR EXISTS (SELECT 1 FROM song_aliases a WHERE a.song_id = catalog.id AND a.alias LIKE @term)
        ) AND ${advancedClauses}
      )`;
    const orderSql = `ORDER BY CASE WHEN titleInitial = '#' THEN 1 ELSE 0 END,
      CASE WHEN @query <> '' AND (lower(title) = lower(@query) OR lower(artist) = lower(@query)) THEN 0
        WHEN @query <> '' AND id IN (SELECT song_id FROM song_search WHERE song_search MATCH @ftsQuery) THEN 1 ELSE 2 END,
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
      album: song.album,
      coverUrl: song.hasCover ? `/api/songs/${song.id}/cover` : null,
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
      album: song.album,
      coverUrl: song.hasCover ? `/api/songs/${song.id}/cover` : null,
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
      SELECT s.id, s.title, s.artist, s.version, s.album, s.language, s.genre, s.difficulty,
             s.performance_type AS performanceType, s.lyrics, s.lyrics_translit AS lyricsTranslit,
             EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) AS hasCover,
             us.collection_type AS collectionType, m.rating, m.note, m.key_shift AS keyShift,
             m.override_diff AS personalDifficulty, m.memory_cue AS memoryCue, s.added_by AS addedBy,
             coalesce((SELECT json_group_array(alias) FROM song_aliases WHERE song_id = s.id), '[]') AS aliasesJson
      FROM songs s LEFT JOIN user_songs us ON us.song_id = s.id AND us.user_id = @userId AND us.removed_at IS NULL
      LEFT JOIN song_user_meta m ON m.song_id = s.id AND m.user_id = @userId
      WHERE s.id = @id AND s.status = 'active'
    `).get({ id, userId: user.id });
    if (!song) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这首歌。' });
    const value = song as any;
    return {
      ...value,
      aliases: JSON.parse(value.aliasesJson ?? '[]') as string[],
      album: value.album ?? null,
      coverUrl: value.hasCover ? `/api/songs/${value.id}/cover` : null,
      aliasesJson: undefined,
      canEditGlobal: user.role === 'admin' || user.isMaintainer,
      canEditLyrics: user.role === 'admin' || user.isMaintainer || value.addedBy === user.id,
      canRequestDeletion: value.addedBy === user.id
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
    const identity = normalizedSongIdentity(body);
    const result = context.db.prepare(`
      UPDATE songs SET title = @title, artist = @artist, version = @version, album = @album,
        normalized_title = @normalizedTitle, normalized_artist = @normalizedArtist, normalized_version = @normalizedVersion,
        language = @language, genre = @genre, difficulty = @difficulty,
        performance_type = @performanceType, lyrics = @lyrics,
        lyrics_translit = @lyricsTranslit, pinyin = @pinyin, title_initial = @titleInitial
      WHERE id = @id AND status = 'active'
    `).run({
      id,
      title: body.title,
      artist: body.artist,
      version: body.version || null,
      album: body.album || null,
      normalizedTitle: identity.title,
      normalizedArtist: identity.artist,
      normalizedVersion: identity.version,
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
    if (body.aliases !== undefined) {
      context.db.prepare('DELETE FROM song_aliases WHERE song_id = ?').run(id);
      const aliasInsert = context.db.prepare('INSERT INTO song_aliases(song_id, alias) VALUES (?, ?)');
      for (const alias of body.aliases) aliasInsert.run(id, alias);
    }
    rebuildSongSearchIndex(context.db, id);
    invalidateSearchMeta();
    audit.record({
      actorUserId: user.id,
      action: 'song_global_updated',
      targetType: 'song',
      targetId: id,
      ...(body.aliases === undefined ? {} : { metadata: { aliasCount: body.aliases.length } })
    });
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
    rebuildSongSearchIndex(context.db, id);
    invalidateSearchMeta();
    return { ok: true };
  });

  app.put('/api/user-songs/:id/collection', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const body = collectionUpdateSchema.parse(request.body);
    context.db.prepare(`
      INSERT INTO user_songs(user_id, song_id, collection_type, removed_at) VALUES (?, ?, ?, NULL)
      ON CONFLICT(user_id, song_id) DO UPDATE SET collection_type = excluded.collection_type, removed_at = NULL
    `).run(user.id, id, body.collectionType);
    rebuildUserSongSearchIndex(context.db, user.id, id);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.get('/api/songs/:id/cover', { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const cover = coverStorage.get(id);
    if (!cover) return reply.code(404).send({ code: 'NOT_FOUND', message: '这首歌还没有封面。' });
    try {
      return reply.type(cover.mimeType).send(coverStorage.read(cover.path));
    } catch {
      return reply.code(404).send({ code: 'COVER_NOT_FOUND', message: '封面文件不存在，请重新导入封面。' });
    }
  });

  app.get('/api/songs/:id/lyrics-candidates', { preHandler: requireUser }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const song = context.db.prepare('SELECT title, artist, album FROM songs WHERE id = ? AND status = \'active\'').get(id) as { title: string; artist: string; album: string | null } | undefined;
    if (!song) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这首歌。' });
    if (!song.album) return reply.code(400).send({ code: 'ALBUM_REQUIRED', message: '请先补充专辑名，再从 MTW 获取歌词。' });
    try { return { candidates: await mtwClient().lyrics(song.title, song.artist, song.album) }; }
    catch (error) { return reply.code(502).send({ code: 'MTW_LYRICS_FAILED', message: error instanceof Error ? error.message : 'MTW 歌词获取失败。' }); }
  });

  app.post('/api/songs/:id/lyrics-submissions', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = z.object({ lyrics: z.string().min(1).max(200_000), source: z.string().trim().max(100).default('mtw') }).parse(request.body);
    const song = context.db.prepare('SELECT id, added_by AS addedBy, status FROM songs WHERE id = ?').get(id) as { id: number; addedBy: number; status: string } | undefined;
    if (!song || song.status !== 'active') return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这首歌。' });
    const canEdit = user.role === 'admin' || user.isMaintainer || song.addedBy === user.id;
    if (canEdit) {
      context.db.prepare('UPDATE songs SET lyrics = ? WHERE id = ?').run(body.lyrics, id);
      rebuildSongSearchIndex(context.db, id);
      audit.record({ actorUserId: user.id, action: 'song_lyrics_updated', targetType: 'song', targetId: id, metadata: { source: body.source } });
      return { status: 'approved', songId: id };
    }
    const result = context.db.prepare('INSERT INTO lyric_submissions(song_id, submitted_by, lyrics, source) VALUES (?, ?, ?, ?)').run(id, user.id, body.lyrics, body.source);
    return reply.code(202).send({ status: 'pending_review', submissionId: Number(result.lastInsertRowid) });
  });

  app.post('/api/songs/:id/deletion-requests', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = z.object({ note: z.string().trim().max(1000).optional() }).parse(request.body ?? {});
    const song = context.db.prepare("SELECT id, added_by AS addedBy, status FROM songs WHERE id = ?").get(id) as { id: number; addedBy: number; status: string } | undefined;
    if (!song || song.status !== 'active') return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到可申请删除的歌曲。' });
    if (song.addedBy !== user.id) return reply.code(403).send({ code: 'FORBIDDEN', message: '只能申请删除自己创建的歌曲。' });
    if (context.db.prepare("SELECT id FROM song_deletion_requests WHERE song_id = ? AND status = 'pending'").get(id)) return reply.code(409).send({ code: 'REQUEST_EXISTS', message: '这首歌已经有待处理的删除申请。' });
    const result = context.db.prepare('INSERT INTO song_deletion_requests(song_id, requested_by, review_note) VALUES (?, ?, ?)').run(id, user.id, body.note ?? null);
    audit.record({ actorUserId: user.id, action: 'song_deletion_requested', targetType: 'song', targetId: id });
    return reply.code(202).send({ requestId: Number(result.lastInsertRowid) });
  });

  app.get('/api/reviews/deletion-requests', { preHandler: requireReviewer }, async () => ({ requests: context.db.prepare(`
    SELECT r.id, r.song_id AS songId, r.status, r.review_note AS note, r.created_at AS createdAt,
      s.title, s.artist, s.version, s.album, u.username AS requester
    FROM song_deletion_requests r JOIN songs s ON s.id = r.song_id JOIN users u ON u.id = r.requested_by
    WHERE r.status = 'pending' ORDER BY r.created_at
  `).all() }));

  app.post('/api/reviews/deletion-requests/:id/approve', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = reviewDecisionSchema.parse(request.body ?? {});
    const result = context.db.transaction(() => {
      const row = context.db.prepare("SELECT song_id AS songId FROM song_deletion_requests WHERE id = ? AND status = 'pending'").get(id) as { songId: number } | undefined;
      if (!row) return false;
      const changed = context.db.prepare("UPDATE song_deletion_requests SET status = 'approved', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, body.reviewNote ?? null, id);
      if (!changed.changes) return false;
      context.db.prepare("UPDATE songs SET status = 'deleted' WHERE id = ? AND status = 'active'").run(row.songId);
      return true;
    })();
    if (!result) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条删除申请已被处理。' });
    audit.record({ actorUserId: reviewer.id, action: 'song_deletion_approved', targetType: 'deletion_request', targetId: id });
    return { ok: true };
  });

  app.post('/api/reviews/deletion-requests/:id/reject', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params); const body = reviewDecisionSchema.parse(request.body ?? {});
    const result = context.db.prepare("UPDATE song_deletion_requests SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, body.reviewNote ?? null, id);
    if (!result.changes) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条删除申请已被处理。' });
    audit.record({ actorUserId: reviewer.id, action: 'song_deletion_rejected', targetType: 'deletion_request', targetId: id });
    return { ok: true };
  });

  app.post('/api/songs/:id/restore', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const result = context.db.prepare("UPDATE songs SET status = 'active' WHERE id = ? AND status = 'deleted'").run(id);
    if (!result.changes) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到可恢复的歌曲。' });
    audit.record({ actorUserId: reviewer.id, action: 'song_restored', targetType: 'song', targetId: id });
    return { ok: true };
  });

  app.get('/api/reviews/lyrics', { preHandler: requireReviewer }, async () => ({ submissions: context.db.prepare(`
    SELECT l.id, l.song_id AS songId, l.lyrics, l.source, l.created_at AS createdAt,
      s.title, s.artist, s.album, u.username AS submitter
    FROM lyric_submissions l JOIN songs s ON s.id = l.song_id JOIN users u ON u.id = l.submitted_by
    WHERE l.status = 'pending' ORDER BY l.created_at
  `).all() }));

  app.post('/api/reviews/lyrics/:id/approve', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params); const body = reviewDecisionSchema.parse(request.body ?? {});
    const result = context.db.transaction(() => {
      const row = context.db.prepare("SELECT song_id AS songId, lyrics FROM lyric_submissions WHERE id = ? AND status = 'pending'").get(id) as { songId: number; lyrics: string } | undefined;
      if (!row) return false;
      const changed = context.db.prepare("UPDATE lyric_submissions SET status = 'approved', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, body.reviewNote ?? null, id);
      if (!changed.changes) return false;
      context.db.prepare('UPDATE songs SET lyrics = ? WHERE id = ?').run(row.lyrics, row.songId); rebuildSongSearchIndex(context.db, row.songId); return true;
    })();
    if (!result) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条歌词审核已被处理。' });
    return { ok: true };
  });

  app.post('/api/reviews/lyrics/:id/reject', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params); const body = reviewDecisionSchema.parse(request.body ?? {});
    const result = context.db.prepare("UPDATE lyric_submissions SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'").run(reviewer.id, body.reviewNote ?? null, id);
    if (!result.changes) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条歌词审核已被处理。' });
    return { ok: true };
  });

  /**
   * 个人曲库批量操作必须先验证整批归属，再在一个事务中更新。
   * 这样任意歌曲不存在、已移除或不属于当前用户时，都不会留下半套结果。
   */
  app.post('/api/user-songs/batch', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const body = userSongBatchSchema.parse(request.body);
    return context.db.transaction(() => {
      const placeholders = body.songIds.map(() => '?').join(', ');
      const owned = context.db.prepare(`
        SELECT us.song_id AS songId
        FROM user_songs us JOIN songs s ON s.id = us.song_id
        WHERE us.user_id = ? AND us.removed_at IS NULL AND s.status = 'active'
          AND us.song_id IN (${placeholders})
      `).all(user.id, ...body.songIds) as Array<{ songId: number }>;
      if (owned.length !== body.songIds.length) {
        throw new UserSongBatchError('批量操作未保存：其中至少一首歌曲不在你的当前曲库中。');
      }

      if (body.action === 'set_collection') {
        context.db.prepare(`UPDATE user_songs SET collection_type = ? WHERE user_id = ? AND song_id IN (${placeholders})`)
          .run(body.collectionType!, user.id, ...body.songIds);
      } else if (body.action === 'snooze') {
        const upsert = context.db.prepare(`
          INSERT INTO song_user_meta(user_id, song_id, pick_snoozed_until) VALUES (?, ?, ?)
          ON CONFLICT(user_id, song_id) DO UPDATE SET pick_snoozed_until = excluded.pick_snoozed_until, updated_at = datetime('now')
        `);
        for (const songId of body.songIds) upsert.run(user.id, songId, body.until!);
      } else if (body.action === 'unsnooze') {
        context.db.prepare(`UPDATE song_user_meta SET pick_snoozed_until = NULL, updated_at = datetime('now') WHERE user_id = ? AND song_id IN (${placeholders})`)
          .run(user.id, ...body.songIds);
      } else {
        context.db.prepare(`UPDATE user_songs SET removed_at = datetime('now') WHERE user_id = ? AND song_id IN (${placeholders})`)
          .run(user.id, ...body.songIds);
      }

      for (const songId of body.songIds) rebuildUserSongSearchIndex(context.db, user.id, songId);
      const invalidatedQueues = invalidateQueues(user.id);
      audit.record({
        actorUserId: user.id,
        action: 'user_songs_batch_updated',
        targetType: 'user_song_batch',
        metadata: { action: body.action, songCount: body.songIds.length }
      });
      return { ok: true, updated: body.songIds.length, invalidatedQueues };
    })();
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
    rebuildUserSongSearchIndex(context.db, user.id, id);
    if ('rating' in body || 'personalDifficulty' in body) invalidateQueues(user.id);
    return { ok: true };
  });

  app.delete('/api/user-songs/:id', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    context.db.prepare(`UPDATE user_songs SET removed_at = datetime('now') WHERE user_id = ? AND song_id = ?`).run(user.id, id);
    rebuildUserSongSearchIndex(context.db, user.id, id);
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
    rebuildUserSongSearchIndex(context.db, user.id, id);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.delete('/api/user-songs/:id/snooze', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    context.db.prepare(`UPDATE song_user_meta SET pick_snoozed_until = NULL, updated_at = datetime('now') WHERE user_id = ? AND song_id = ?`).run(user.id, id);
    rebuildUserSongSearchIndex(context.db, user.id, id);
    invalidateQueues(user.id);
    return { ok: true };
  });

  app.post('/api/picks', { preHandler: requireUser }, async (request) =>
    pickResponseSchema.parse(pickService.pick(currentUser(request).id, pickRequestSchema.parse(request.body)))
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
        SELECT 'event:' || e.id AS id, e.song_id AS songId, s.title, s.artist, s.version, s.album,
          CASE WHEN EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) THEN '/api/songs/' || s.id || '/cover' END AS coverUrl,
          e.status AS status, coalesce(e.completed_at, e.created_at) AS occurredAt,
          p.rating_snapshot AS rating, coalesce(p.note, e.note) AS note
        FROM pick_events e JOIN songs s ON s.id = e.song_id
        LEFT JOIN plays p ON p.pick_event_id = e.id
        WHERE e.user_id = @userId AND e.status IN ('played', 'skipped')
        UNION ALL
        SELECT 'play:' || p.id, p.song_id, s.title, s.artist, s.version, s.album,
          CASE WHEN EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) THEN '/api/songs/' || s.id || '/cover' END,
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
      SELECT s.id, s.title, s.artist, s.version, s.album,
        CASE WHEN EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) THEN '/api/songs/' || s.id || '/cover' END AS coverUrl
        FROM playlist_songs ps JOIN songs s ON s.id = ps.song_id
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
    SELECT pl.id, pl.name, pl.owner_id AS ownerId, coalesce(owner.nickname, owner.username) AS ownerName,
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
      SELECT pl.id, pl.name, coalesce(owner.nickname, owner.username) AS ownerName,
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
      SELECT id, coalesce(nickname, username) AS username, nickname, users.username AS loginUsername, coalesce(nickname, username) AS displayName FROM users WHERE id <> @userId AND is_system = 0
        AND (@query = '' OR username LIKE @term OR coalesce(nickname, '') LIKE @term)
      ORDER BY coalesce(nickname, username) COLLATE NOCASE LIMIT 20
    `).all({ userId: user.id, query: query.q, term: `%${query.q}%` }) };
  });

  app.get('/api/playlists/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = idParamSchema.parse(request.params);
    const playlist = playlistAccess(id, user.id);
    if (!playlist) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个歌单或你无权查看。' });
    const songs = context.db.prepare(`
      SELECT s.id, s.title, s.artist, s.version, s.album,
        CASE WHEN EXISTS(SELECT 1 FROM song_covers sc WHERE sc.song_id = s.id) THEN '/api/songs/' || s.id || '/cover' END AS coverUrl,
        ps.position FROM playlist_songs ps JOIN songs s ON s.id = ps.song_id
      WHERE ps.playlist_id = ? AND s.status = 'active' ORDER BY ps.position, ps.created_at
    `).all(id);
    const collaborators = context.db.prepare(`
      SELECT u.id, coalesce(u.nickname, u.username) AS username, u.nickname, u.username AS loginUsername, coalesce(u.nickname, u.username) AS displayName FROM playlist_collaborators pc JOIN users u ON u.id = pc.user_id
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
      + (context.db.prepare("SELECT count(*) AS count FROM song_deletion_requests WHERE status = 'pending'").get() as { count: number }).count
      + (context.db.prepare("SELECT count(*) AS count FROM lyric_submissions WHERE status = 'pending'").get() as { count: number }).count
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
    if (catalog.collectUserSong(submission.submitted_by, songId, personal)) {
      invalidateQueues(submission.submitted_by);
    }
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
      audit.record({ actorUserId: reviewer.id, action: 'song_review_merged', targetType: 'submission', targetId: id, metadata: { songId: submission.matched_song_id } });
      return { ok: true, songId: submission.matched_song_id };
    })();
  });

  app.post('/api/reviews/:id/approve', { preHandler: requireReviewer }, async (request, reply) => {
    const reviewer = currentUser(request); const { id } = idParamSchema.parse(request.params);
    const body = approveReviewSchema.parse(request.body);
    if (catalog.findCandidates(body).exact) {
      return reply.code(409).send({ code: 'DUPLICATE_IDENTITY', message: '批准为独立版本前，请修改版本或歌曲身份。' });
    }
    return context.db.transaction(() => {
      const submission = context.db.prepare("SELECT * FROM song_submissions WHERE id = ? AND status = 'pending'").get(id) as any;
      if (!submission) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条审核已被其他人处理。' });
      const changed = context.db.prepare(`UPDATE song_submissions SET status = 'approved', reviewed_by = ?,
        review_note = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'`)
        .run(reviewer.id, body.reviewNote ?? null, id);
      if (!changed.changes) return reply.code(409).send({ code: 'REVIEW_ALREADY_RESOLVED', message: '这条审核已被其他人处理。' });
      const songId = catalog.createSong({ ...body, addedBy: reviewer.id });
      context.db.prepare('UPDATE song_submissions SET resolved_song_id = ? WHERE id = ?').run(songId, id);
       collectSubmissionSong(submission, songId);
      audit.record({ actorUserId: reviewer.id, action: 'song_review_approved', targetType: 'submission', targetId: id, metadata: { songId } });
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
    audit.record({ actorUserId: reviewer.id, action: 'song_review_rejected', targetType: 'submission', targetId: id });
    return { ok: true };
  });

  app.post('/api/imports', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    if (!user.canAddSongs) return reply.code(403).send({ code: 'FORBIDDEN', message: '管理员已关闭你的歌曲添加权限。' });
    const body = importSchema.parse(request.body);
    const taskId = randomUUID();
    context.db.prepare(`INSERT INTO tasks(id, user_id, type, payload, status) VALUES (?, ?, 'song_import', ?, 'pending')`).run(taskId, user.id, JSON.stringify(body));
    importQueue.enqueue(taskId);
    audit.record({ actorUserId: user.id, action: 'song_import_created', targetType: 'task', targetId: taskId });
    return reply.code(202).send({ taskId });
  });

  app.get('/api/tasks/:id', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const { id } = taskParamSchema.parse(request.params);
    const task = context.db.prepare(`SELECT id, type, status, result, error, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ? AND user_id = ?`).get(id, user.id);
    if (!task) return reply.code(404).send({ code: 'NOT_FOUND', message: '没有找到这个导入任务。' });
    return importTaskSchema.parse(task);
  });

  app.post('/api/tasks/:id/cancel', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const { id } = taskParamSchema.parse(request.params);
    const cancelled = importQueue.cancel(id, user.id);
    return { ok: true, cancelled };
  });

  app.get('/api/export', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    return {
      exportedAt: new Date().toISOString(),
      songs: context.db.prepare(`
        SELECT s.title, s.artist, s.version, s.album, s.language, s.genre, us.collection_type AS collectionType,
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
    if (error instanceof SetupAlreadyCompletedError) {
      return reply.code(409).send({ code: error.code, message: error.message });
    }
    if (error instanceof UserSongBatchError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (error instanceof AuditLogError) {
      app.log.error(error, '审计日志写入失败');
      return reply.code(500).send({ code: error.code, message: error.message });
    }
    if (error instanceof PickError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (errorCode === 'SQLITE_CONSTRAINT_UNIQUE') {
      return reply.code(409).send({ code: 'DUPLICATE_IDENTITY', message: '歌曲身份与现有活动歌曲重复，请修改歌名、歌手或版本。' });
    }
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
  recoverMtwImports();
  return app;
}

interface ImportEntry { title: string; artist: string; version?: string | undefined; album?: string | undefined }

/**
 * SQLite 用 0/1 保存布尔值。管理接口在统一出口完成类型归一化，避免各页面
 * 分别猜测数据库驱动的返回形式；同时把聚合查询可能返回的空值收敛为稳定值。
 */
function normalizeAdminUser(user: any) {
  const nickname = typeof user.nickname === 'string' && user.nickname.trim() ? user.nickname.trim() : null;
  return {
    ...user,
    nickname,
    displayName: nickname ?? user.username,
    isMaintainer: Boolean(user.isMaintainer),
    canAddSongs: Boolean(user.canAddSongs),
    personalSongCount: Number(user.personalSongCount ?? 0),
    lastLoginAt: user.lastLoginAt ?? null
  };
}

function parseImport(format: 'json' | 'csv' | 'text', content: string): ImportEntry[] {
  if (format === 'json') {
    const value = z.array(z.object({ title: z.string().min(1), artist: z.string().min(1), version: z.string().optional(), album: z.string().optional() })).parse(JSON.parse(content));
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
  const albumIndex = columns.indexOf('album');
  if (titleIndex < 0 || artistIndex < 0) throw new Error('CSV 必须包含 title 和 artist 列。');
  return data.map((line) => {
    const values = parseCsvLine(line);
    const title = values[titleIndex]?.trim();
    const artist = values[artistIndex]?.trim();
    if (!title || !artist) throw new Error('CSV 中存在缺少歌名或歌手的行。');
    const version = versionIndex >= 0 ? values[versionIndex]?.trim() : undefined;
    const album = albumIndex >= 0 ? values[albumIndex]?.trim() : undefined;
    return { title, artist, ...(version ? { version } : {}), ...(album ? { album } : {}) };
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
