import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { AppDatabase } from './db.js';
import { buildApp } from './app.js';

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
let database: AppDatabase;
let app: FastifyInstance;

beforeEach(async () => {
  process.env.NODE_ENV = 'test';
  database = new AppDatabase(':memory:', migrations);
  app = await buildApp({ db: database.db });
});

afterEach(async () => { await app.close(); database.close(); });

async function setup(): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'singer', password: 'password123' } });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  const cookie = Array.isArray(header) ? header[0] : header;
  return cookie!.split(';')[0]!;
}

async function waitForTask(cookie: string, taskId: string): Promise<any> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: { cookie } });
    const task = response.json();
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return task;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('导入任务在测试等待窗口内未完成。');
}

describe('核心 API 纵向闭环', () => {
  it('首次启动自动生成并稳定复用会话签名密钥', async () => {
    expect(database.db.prepare("SELECT value FROM app_settings WHERE key = 'session_secret'").get()).toBeUndefined();
    await setup();
    const first = database.db.prepare("SELECT value FROM app_settings WHERE key = 'session_secret'").get() as { value: string };
    expect(first.value).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
    app = await buildApp({ db: database.db });
    const second = database.db.prepare("SELECT value FROM app_settings WHERE key = 'session_secret'").get() as { value: string };
    expect(second.value).toBe(first.value);
  });

  it('未登录不能访问个人曲库', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/songs' });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toContain('重新登录');
  });

  it('普通用户只能在管理员开放注册后自助注册并直接登录', async () => {
    const adminCookie = await setup();
    const closed = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'new-user', password: 'password123' } });
    expect(closed.statusCode).toBe(403);
    await app.inject({ method: 'PUT', url: '/api/admin/settings/registration', headers: { cookie: adminCookie }, payload: { open: true } });
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json().registrationOpen).toBe(true);
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'new-user', password: 'password123' } });
    expect(registered.statusCode).toBe(201);
    expect(registered.json().user).toMatchObject({ username: 'new-user', role: 'user', isMaintainer: false });
    const cookieHeader = registered.headers['set-cookie'];
    const userCookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)!.split(';')[0]!;
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: userCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/playlists/next-ktv', headers: { cookie: userCookie } })).json().playlist).not.toBeNull();
  });

  it('会根据当前请求协议设置登录 Cookie 的 Secure 属性', async () => {
    const httpSetup = await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'singer', password: 'password123' } });
    const httpCookie = String(httpSetup.headers['set-cookie']);
    expect(httpCookie).not.toContain('; Secure');

    const httpsLogin = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-proto': 'https' },
      payload: { username: 'singer', password: 'password123' }
    });
    expect(String(httpsLogin.headers['set-cookie'])).toContain('; Secure');
  });

  it('初始化、收歌、幂等 Pick、唱完和历史可完整运行', async () => {
    const cookie = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '晴天', artist: '周杰伦', language: '国语', genre: '流行', difficulty: 'medium',
      performanceType: 'solo', collectionType: 'repertoire'
    } });
    expect(created.statusCode).toBe(201);

    const requestId = '0a25bf9e-0178-42db-9b85-721a7850a755';
    const first = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie }, payload: { requestId } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ source: 'repertoire', song: { title: '晴天' }, reason: '从未记录演唱' });
    const retry = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie }, payload: { requestId } });
    expect(retry.json()).toEqual(first.json());
    expect((database.db.prepare('SELECT count(*) AS count FROM pick_events').get() as any).count).toBe(1);

    const completed = await app.inject({ method: 'POST', url: `/api/picks/${first.json().eventId}/complete`, headers: { cookie }, payload: {
      requestId: 'f50bd736-86e4-42d2-8ca2-211d6e6ea2b0', rating: 4, note: '状态不错', keyShift: -1
    } });
    expect(completed.statusCode).toBe(200);
    const repeatedComplete = await app.inject({ method: 'POST', url: `/api/picks/${first.json().eventId}/complete`, headers: { cookie }, payload: {
      requestId: 'b4309c6e-e2ac-4ba6-b1f1-4ee878218b64'
    } });
    expect(repeatedComplete.json().alreadyCompleted).toBe(true);
    const history = await app.inject({ method: 'GET', url: '/api/history', headers: { cookie } });
    expect(history.json().plays).toHaveLength(1);
    expect(history.json().plays[0]).toMatchObject({ title: '晴天', rating: 4, note: '状态不错' });
  });

  it('新增和导入歌曲可以只维护全局资料而不收录个人曲库', async () => {
    const cookie = await setup();
    const globalOnly = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '只维护歌曲', artist: '维护歌手', collectionType: null
    } });
    expect(globalOnly.statusCode).toBe(201);
    const globalOnlyId = globalOnly.json().songId;
    expect((database.db.prepare('SELECT count(*) AS count FROM user_songs WHERE song_id = ?').get(globalOnlyId) as any).count).toBe(0);
    expect((database.db.prepare('SELECT count(*) AS count FROM song_user_meta WHERE song_id = ?').get(globalOnlyId) as any).count).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/search?scope=global&q=只维护歌曲', headers: { cookie } })).json().songs[0]).toMatchObject({ id: globalOnlyId, collectionType: null });

    const defaulted = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '默认待学歌曲', artist: '默认歌手'
    } });
    expect(defaulted.statusCode).toBe(201);
    expect((database.db.prepare('SELECT collection_type AS collectionType FROM user_songs WHERE song_id = ?').get(defaulted.json().songId) as any).collectionType).toBe('learning');

    const personal = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '复用保留歌曲', artist: '复用歌手', collectionType: 'repertoire'
    } });
    const reused = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '复用保留歌曲', artist: '复用歌手', collectionType: null,
      duplicateAction: 'reuse', matchedSongId: personal.json().songId
    } });
    expect(reused.statusCode).toBe(200);
    expect((database.db.prepare('SELECT collection_type AS collectionType FROM user_songs WHERE song_id = ?').get(personal.json().songId) as any).collectionType).toBe('repertoire');

    const imported = await app.inject({ method: 'POST', url: '/api/imports', headers: { cookie }, payload: {
      format: 'text', content: '批量全局歌曲一 - 批量歌手\n批量全局歌曲二 - 批量歌手', collectionType: null
    } });
    expect(imported.statusCode).toBe(202);
    const task = await waitForTask(cookie, imported.json().taskId);
    expect(task).toMatchObject({ status: 'done' });
    expect((database.db.prepare(`SELECT count(*) AS count FROM user_songs us JOIN songs s ON s.id = us.song_id WHERE s.title LIKE '批量全局歌曲%'`).get() as any).count).toBe(0);
  });

  it('Pick 上下文可以恢复当前歌曲、筛选、数量和个人筛选项', async () => {
    const cookie = await setup();
    const empty = await app.inject({ method: 'GET', url: '/api/picks/context', headers: { cookie } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({
      sessionId: null,
      current: null,
      counts: { repertoire: 0, global: 0, nextKtv: 0 },
      facets: { languages: [], genres: [] }
    });

    const first = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '恢复测试一', artist: '歌手甲', language: '国语', genre: '流行', collectionType: 'repertoire'
    } });
    await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '恢复测试二', artist: '歌手乙', language: '粤语', genre: '摇滚', collectionType: 'repertoire'
    } });
    await app.inject({ method: 'PUT', url: `/api/playlists/next-ktv/${first.json().songId}`, headers: { cookie }, payload: {} });
    const filters = { languages: ['国语'], genres: ['流行'], difficulties: [], ratings: [], performanceTypes: [] };
    const picked = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie }, payload: {
      requestId: crypto.randomUUID(), avoidRecent: false, filters
    } });

    const restored = await app.inject({ method: 'GET', url: '/api/picks/context', headers: { cookie } });
    expect(restored.json()).toMatchObject({
      sessionId: picked.json().sessionId,
      current: { eventId: picked.json().eventId, song: { title: '恢复测试一' } },
      filters,
      avoidRecent: false,
      counts: { repertoire: 2, global: 2, nextKtv: 1 },
      facets: { languages: ['国语', '粤语'], genres: ['摇滚', '流行'] }
    });
  });

  it('Pick 上下文会结束过期场次且不会泄露给其他用户', async () => {
    const adminCookie = await setup();
    await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: adminCookie }, payload: {
      title: '仅管理员场次', artist: '歌手', collectionType: 'repertoire'
    } });
    const picked = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie: adminCookie }, payload: { requestId: crypto.randomUUID() } });
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie }, payload: {
      username: 'context-user', password: 'password123'
    } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'context-user', password: 'password123' } });
    const userHeader = login.headers['set-cookie'];
    const userCookie = (Array.isArray(userHeader) ? userHeader[0] : userHeader)!.split(';')[0]!;
    expect((await app.inject({ method: 'GET', url: '/api/picks/context', headers: { cookie: userCookie } })).json().current).toBeNull();

    database.db.prepare(`UPDATE pick_sessions SET last_activity_at = datetime('now', '-5 hours') WHERE id = ?`).run(picked.json().sessionId);
    const expired = await app.inject({ method: 'GET', url: '/api/picks/context', headers: { cookie: adminCookie } });
    expect(expired.json()).toMatchObject({ sessionId: null, current: null });
    expect((database.db.prepare('SELECT ended_at FROM pick_sessions WHERE id = ?').get(picked.json().sessionId) as any).ended_at).not.toBeNull();
  });

  it('会唱曲库非空而筛选无结果时不会从全局曲库兜底', async () => {
    const cookie = await setup();
    await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: { title: '国语歌', artist: '甲', language: '国语', collectionType: 'repertoire' } });
    await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: { title: '粤语歌', artist: '乙', language: '粤语', collectionType: 'learning' } });
    const response = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie }, payload: {
      requestId: '808b7175-14f7-4523-9957-b05a05f27540',
      filters: { languages: ['粤语'], genres: [], difficulties: [], ratings: [], performanceTypes: [] }
    } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('NO_CANDIDATES');
  });

  it('跳过本场最后一首时仍记录跳过且不计为唱完', async () => {
    const cookie = await setup();
    await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '最后一首', artist: '歌手', collectionType: 'repertoire'
    } });
    const picked = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie }, payload: { requestId: crypto.randomUUID() } });
    const exhausted = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie }, payload: {
      requestId: crypto.randomUUID(), sessionId: picked.json().sessionId, currentEventId: picked.json().eventId
    } });
    expect(exhausted.statusCode).toBe(409);
    expect(exhausted.json().code).toBe('NO_CANDIDATES');
    expect((database.db.prepare('SELECT status FROM pick_events WHERE id = ?').get(picked.json().eventId) as any).status).toBe('skipped');
    const history = await app.inject({ method: 'GET', url: '/api/history', headers: { cookie } });
    expect(history.json().items).toEqual([expect.objectContaining({ title: '最后一首', status: 'skipped' })]);
    expect((database.db.prepare('SELECT count(*) AS count FROM plays').get() as any).count).toBe(0);
  });

  it('曲库搜索按数据范围隔离，并只在三人评分后返回匿名聚合', async () => {
    const cookie = await setup();
    const repertoire = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '会唱的歌', artist: '歌手甲', language: '国语', genre: '流行', difficulty: 'easy', collectionType: 'repertoire'
    } });
    await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '待学的歌', artist: '歌手乙', language: '粤语', genre: '摇滚', difficulty: 'hard', collectionType: 'learning'
    } });
    const ownerId = (database.db.prepare(`SELECT id FROM users WHERE username = 'singer'`).get() as { id: number }).id;
    const normalizedTitle = '全站歌曲';
    const normalizedArtist = '歌手丙';
    const globalSongId = Number(database.db.prepare(`
      INSERT INTO songs(title, artist, language, genre, difficulty, performance_type, status,
        normalized_title, normalized_artist, normalized_version, added_by)
      VALUES ('全站歌曲', '歌手丙', '英语', '民谣', 'medium', 'duet', 'active', ?, ?, '', ?)
    `).run(normalizedTitle, normalizedArtist, ownerId).lastInsertRowid);
    for (const [index, rating] of [5, 4, 4].entries()) {
      const userId = Number(database.db.prepare(`
        INSERT INTO users(username, password_hash, role) VALUES (?, 'test-hash', 'user')
      `).run(`reviewer-${index}`).lastInsertRowid);
      database.db.prepare(`INSERT INTO song_user_meta(user_id, song_id, rating) VALUES (?, ?, ?)`)
        .run(userId, globalSongId, rating);
    }

    const personal = await app.inject({
      method: 'GET',
      url: '/api/search?scope=personal&collection=repertoire&q=',
      headers: { cookie }
    });
    expect(personal.statusCode).toBe(200);
    expect(personal.json()).toMatchObject({
      total: 1,
      hasMore: false,
      counts: { personal: 2, repertoire: 1, learning: 1, global: 3 }
    });
    expect(personal.json().songs[0]).toMatchObject({
      scope: 'personal',
      id: repertoire.json().songId,
      collectionType: 'repertoire',
      playCount: 0,
      hasLyrics: false
    });

    const global = await app.inject({ method: 'GET', url: '/api/search?scope=global&q=全站歌曲', headers: { cookie } });
    expect(global.statusCode).toBe(200);
    expect(global.json().songs[0]).toMatchObject({
      scope: 'global',
      collectionType: null,
      referenceDifficulty: 'medium',
      aggregateRating: 4.3,
      aggregateRatingCount: 3
    });
    expect(global.json().songs[0]).not.toHaveProperty('keyShift');
    expect(global.json().songs[0]).not.toHaveProperty('personalDifficulty');

    const insufficient = await app.inject({ method: 'GET', url: '/api/search?scope=global&q=会唱的歌', headers: { cookie } });
    expect(insufficient.json().songs[0]).toMatchObject({ aggregateRating: null, aggregateRatingCount: null });
    const page = await app.inject({ method: 'GET', url: '/api/search?scope=global&limit=1&offset=0', headers: { cookie } });
    expect(page.json()).toMatchObject({ total: 3, hasMore: true });

    const invalid = await app.inject({ method: 'GET', url: '/api/search?scope=global&collection=repertoire', headers: { cookie } });
    expect(invalid.statusCode).toBe(400);
  });

  it('管理员可以创建用户、调整权限并重置密码', async () => {
    const adminCookie = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie }, payload: {
      username: 'new-singer', password: 'password123', isMaintainer: true, canAddSongs: true
    } });
    expect(created.statusCode).toBe(201);
    const userId = created.json().userId;
    const users = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie } });
    expect(users.json().users).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: userId, username: 'new-singer', isMaintainer: true, canAddSongs: true })
    ]));

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'new-singer', password: 'password123' } });
    const header = login.headers['set-cookie'];
    const userCookie = (Array.isArray(header) ? header[0] : header)!.split(';')[0]!;
    const song = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: adminCookie }, payload: {
      title: '待维护歌曲', artist: '原歌手', collectionType: 'learning'
    } });
    const songId = song.json().songId;
    expect((await app.inject({ method: 'PUT', url: `/api/songs/${songId}`, headers: { cookie: userCookie }, payload: {
      title: '管家维护歌曲', artist: '新歌手', performanceType: 'solo'
    } })).statusCode).toBe(200);
    await app.inject({ method: 'PUT', url: `/api/admin/users/${userId}`, headers: { cookie: adminCookie }, payload: { isMaintainer: false, canAddSongs: false } });
    const forbiddenAdd = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: userCookie }, payload: {
      title: '不能添加', artist: '测试', collectionType: 'learning'
    } });
    expect(forbiddenAdd.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: userCookie } })).statusCode).toBe(403);

    const maintained = await app.inject({ method: 'PUT', url: `/api/songs/${songId}`, headers: { cookie: adminCookie }, payload: {
      title: '已维护歌曲', artist: '新歌手', version: 'Live', language: '国语', genre: '流行',
      difficulty: 'medium', performanceType: 'solo', lyrics: '[00:01.00]第一句', lyricsTranslit: null
    } });
    expect(maintained.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/songs/${songId}`, headers: { cookie: adminCookie } })).json()).toMatchObject({ title: '已维护歌曲', lyrics: '[00:01.00]第一句' });
    expect((await app.inject({ method: 'PUT', url: `/api/songs/${songId}`, headers: { cookie: userCookie }, payload: {
      title: '越权修改', artist: '新歌手', performanceType: 'solo'
    } })).statusCode).toBe(403);

    expect((await app.inject({ method: 'PUT', url: `/api/admin/users/${userId}/password`, headers: { cookie: adminCookie }, payload: { password: 'changed123' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'new-singer', password: 'changed123' } })).statusCode).toBe(200);
  });

  it('用户管理对完整数据执行分页、筛选、排序和批量权限更新', async () => {
    const adminCookie = await setup();
    const insert = database.db.prepare(`
      INSERT INTO users(username, password_hash, role, is_maintainer, can_add_songs, last_login_at)
      VALUES (?, '不可登录测试哈希', 'user', ?, ?, ?)
    `);
    const ids: number[] = [];
    for (let index = 0; index < 1000; index += 1) {
      ids.push(Number(insert.run(`user-${String(index).padStart(3, '0')}`, index % 5 === 0 ? 1 : 0, index % 4 === 0 ? 0 : 1, index % 3 === 0 ? '2026-08-01 12:00:00' : null).lastInsertRowid));
    }

    const firstPage = await app.inject({ method: 'GET', url: '/api/admin/users?type=user&limit=30&sort=username_asc', headers: { cookie: adminCookie } });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({ total: 800, hasMore: true });
    expect(firstPage.json().users).toHaveLength(30);
    expect(firstPage.json().users[0].username).toBe('user-001');
    const never = await app.inject({ method: 'GET', url: '/api/admin/users?type=maintainer&login=never&limit=100', headers: { cookie: adminCookie } });
    expect(never.json().users.every((user: any) => user.isMaintainer && user.lastLoginAt === null)).toBe(true);

    const bulk = await app.inject({ method: 'PUT', url: '/api/admin/users/bulk-permissions', headers: { cookie: adminCookie }, payload: { userIds: ids.slice(0, 3), canAddSongs: false, isMaintainer: true } });
    expect(bulk.json()).toMatchObject({ ok: true, updated: 3 });
    const updated = database.db.prepare(`SELECT count(*) AS count FROM users WHERE id IN (?, ?, ?) AND can_add_songs = 0 AND is_maintainer = 1`).get(...ids.slice(0, 3)) as { count: number };
    expect(updated.count).toBe(3);
  });

  it('永久删除整批回滚受保护目标，并在成功后匿名保留全局歌曲', async () => {
    const adminCookie = await setup();
    const createUser = async (username: string) => {
      const created = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie }, payload: { username, password: 'password123', canAddSongs: true } });
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'password123' } });
      const header = login.headers['set-cookie'];
      return { id: created.json().userId as number, cookie: (Array.isArray(header) ? header[0] : header)!.split(';')[0]! };
    };
    const first = await createUser('delete-first');
    const second = await createUser('delete-second');
    const song = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: first.cookie }, payload: { title: '匿名保留歌曲', artist: '测试歌手', collectionType: 'repertoire' } });
    database.db.prepare('INSERT INTO plays(user_id, song_id, note) VALUES (?, ?, ?)').run(first.id, song.json().songId, '待删除记录');

    const preview = await app.inject({ method: 'POST', url: '/api/admin/users/deletion-preview', headers: { cookie: adminCookie }, payload: { userIds: [first.id, second.id] } });
    expect(preview.json().impact).toMatchObject({ userCount: 2, personalSongCount: 1, playCount: 1, contributedSongCount: 1 });
    const wrongPassword = await app.inject({ method: 'POST', url: '/api/admin/users/bulk-delete', headers: { cookie: adminCookie }, payload: { userIds: [first.id, second.id], adminPassword: 'wrong-pass', confirmed: true } });
    expect(wrongPassword.statusCode).toBe(403);
    expect((database.db.prepare('SELECT count(*) AS count FROM users WHERE id IN (?, ?)').get(first.id, second.id) as { count: number }).count).toBe(2);

    const adminId = (database.db.prepare("SELECT id FROM users WHERE username = 'singer'").get() as { id: number }).id;
    const protectedBatch = await app.inject({ method: 'POST', url: '/api/admin/users/bulk-delete', headers: { cookie: adminCookie }, payload: { userIds: [first.id, adminId], adminPassword: 'password123', confirmed: true } });
    expect(protectedBatch.statusCode).toBe(409);
    expect(database.db.prepare('SELECT id FROM users WHERE id = ?').get(first.id)).toBeTruthy();

    const removed = await app.inject({ method: 'POST', url: '/api/admin/users/bulk-delete', headers: { cookie: adminCookie }, payload: { userIds: [first.id, second.id], adminPassword: 'password123', confirmed: true } });
    expect(removed.json()).toMatchObject({ ok: true, deleted: 2 });
    expect((database.db.prepare('SELECT count(*) AS count FROM users WHERE id IN (?, ?)').get(first.id, second.id) as { count: number }).count).toBe(0);
    expect((database.db.prepare('SELECT count(*) AS count FROM users WHERE is_system = 1').get() as { count: number }).count).toBe(1);
    expect(database.db.prepare('SELECT id FROM songs WHERE id = ?').get(song.json().songId)).toBeTruthy();
    expect((database.db.prepare('SELECT count(*) AS count FROM plays WHERE user_id = ?').get(first.id) as { count: number }).count).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    const global = await app.inject({ method: 'GET', url: '/api/search?scope=global&q=匿名保留歌曲', headers: { cookie: adminCookie } });
    expect(global.json().songs[0]).toMatchObject({ title: '匿名保留歌曲' });
  });

  it('下一次 KTV 支持加入、逐首移除和清空', async () => {
    const cookie = await setup();
    const first = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: { title: '第一首', artist: '甲', collectionType: 'repertoire' } });
    const second = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: { title: '第二首', artist: '乙', collectionType: 'repertoire' } });
    await app.inject({ method: 'PUT', url: `/api/playlists/next-ktv/${first.json().songId}`, headers: { cookie }, payload: {} });
    await app.inject({ method: 'PUT', url: `/api/playlists/next-ktv/${second.json().songId}`, headers: { cookie }, payload: {} });
    expect((await app.inject({ method: 'GET', url: '/api/playlists/next-ktv', headers: { cookie } })).json().songs).toHaveLength(2);
    await app.inject({ method: 'DELETE', url: `/api/playlists/next-ktv/${first.json().songId}`, headers: { cookie } });
    expect((await app.inject({ method: 'GET', url: '/api/playlists/next-ktv', headers: { cookie } })).json().songs).toHaveLength(1);
    const cleared = await app.inject({ method: 'DELETE', url: '/api/playlists/next-ktv', headers: { cookie } });
    expect(cleared.json()).toMatchObject({ ok: true, removed: 1 });

    await app.inject({ method: 'PUT', url: `/api/playlists/next-ktv/${first.json().songId}`, headers: { cookie }, payload: {} });
    const picked = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie }, payload: { requestId: crypto.randomUUID() } });
    expect(picked.json()).toMatchObject({ source: 'ktv', song: { id: first.json().songId } });
    const ratingRequired = await app.inject({ method: 'POST', url: `/api/picks/${picked.json().eventId}/complete`, headers: { cookie }, payload: { requestId: crypto.randomUUID() } });
    expect(ratingRequired.statusCode).toBe(422);
    const completed = await app.inject({ method: 'POST', url: `/api/picks/${picked.json().eventId}/complete`, headers: { cookie }, payload: { requestId: crypto.randomUUID(), rating: 4 } });
    expect(completed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/playlists/next-ktv', headers: { cookie } })).json().songs).toHaveLength(0);
  });

  it('曲库按歌名拼音分组，并对完整数据执行个人筛选', async () => {
    const cookie = await setup();
    for (const song of [
      { title: '晴天', artist: '周杰伦', language: '国语', genre: '流行', difficulty: 'easy' },
      { title: '海阔天空', artist: 'Beyond', language: '粤语', genre: '摇滚', difficulty: 'hard' },
      { title: '123木头人', artist: '黑涩会美眉', language: '国语', genre: '流行', difficulty: 'medium' }
    ]) await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: { ...song, collectionType: 'repertoire' } });
    const full = await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=repertoire&limit=2', headers: { cookie } });
    expect(full.statusCode).toBe(200);
    expect(full.json()).toMatchObject({ total: 3, hasMore: true });
    expect(full.json().alphabetIndex).toEqual(expect.arrayContaining([
      expect.objectContaining({ initial: 'H', count: 1 }),
      expect.objectContaining({ initial: 'Q', count: 1 }),
      expect.objectContaining({ initial: '#', count: 1 })
    ]));
    const hard = await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=repertoire&difficulties=hard', headers: { cookie } });
    expect(hard.json().songs).toHaveLength(1);
    expect(hard.json().songs[0]).toMatchObject({ title: '海阔天空', titleInitial: 'H' });
    const songId = hard.json().songs[0].id;
    expect((await app.inject({ method: 'PATCH', url: `/api/user-songs/${songId}/meta`, headers: { cookie }, payload: { rating: 5, personalDifficulty: 'easy', keyShift: 0, note: '聚会开场', memoryCue: '海风画面' } })).statusCode).toBe(200);
    const strong = await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=repertoire&scene=strong', headers: { cookie } });
    expect(strong.json().songs[0]).toMatchObject({ id: songId, rating: 5, personalDifficulty: 'easy', keyShift: 0 });
    const compactPinyin = await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=repertoire&q=haikuotiankong', headers: { cookie } });
    expect(compactPinyin.json().songs[0]).toMatchObject({ id: songId });
    const memorySearch = await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=repertoire&q=海风画面', headers: { cookie } });
    expect(memorySearch.json().songs[0]).toMatchObject({ id: songId });
  });

  it('普通歌单协作者可以共同维护歌曲但不能管理歌单', async () => {
    const ownerCookie = await setup();
    const createdUser = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: ownerCookie }, payload: { username: 'collaborator', password: 'password123' } });
    const collaboratorId = createdUser.json().userId;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'collaborator', password: 'password123' } });
    const header = login.headers['set-cookie']; const collaboratorCookie = (Array.isArray(header) ? header[0] : header)!.split(';')[0]!;
    const song = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: ownerCookie }, payload: { title: '协作歌曲', artist: '歌手', collectionType: 'repertoire' } });
    const playlist = await app.inject({ method: 'POST', url: '/api/playlists', headers: { cookie: ownerCookie }, payload: { name: '生日局', collaboratorUserIds: [collaboratorId] } });
    const playlistId = playlist.json().playlistId;
    expect((await app.inject({ method: 'GET', url: '/api/playlists', headers: { cookie: collaboratorCookie } })).json().playlists[0]).toMatchObject({ id: playlistId, access: 'collaborator' });
    expect((await app.inject({ method: 'PUT', url: `/api/playlists/${playlistId}/songs/${song.json().songId}`, headers: { cookie: collaboratorCookie }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/playlists/${playlistId}`, headers: { cookie: collaboratorCookie }, payload: { name: '越权改名' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/playlists/${playlistId}`, headers: { cookie: collaboratorCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/playlists/${playlistId}`, headers: { cookie: ownerCookie } })).json().songs).toHaveLength(1);
  });

  it('精确重复必须复用或审核，审核合并不会创建第二首全局歌曲', async () => {
    const adminCookie = await setup();
    const original = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: adminCookie }, payload: { title: '光年之外', artist: 'G.E.M.', version: 'Live', collectionType: 'repertoire' } });
    const user = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie }, payload: { username: 'submitter', password: 'password123' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'submitter', password: 'password123' } });
    const header = login.headers['set-cookie']; const userCookie = (Array.isArray(header) ? header[0] : header)!.split(';')[0]!;
    const duplicatePayload = { title: ' 光年之外 ', artist: 'g.e.m', version: 'LIVE', collectionType: 'learning' };
    const duplicate = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: userCookie }, payload: duplicatePayload });
    expect(duplicate.statusCode).toBe(409); expect(duplicate.json().code).toBe('EXACT_DUPLICATE');
    const submitted = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: userCookie }, payload: { ...duplicatePayload, duplicateAction: 'submit_review', matchedSongId: original.json().songId } });
    expect(submitted.statusCode).toBe(202);
    expect((await app.inject({ method: 'GET', url: '/api/reviews', headers: { cookie: userCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/reviews/${submitted.json().submissionId}/merge`, headers: { cookie: adminCookie }, payload: {} })).statusCode).toBe(200);
    expect((database.db.prepare("SELECT count(*) AS count FROM songs WHERE status = 'active'").get() as any).count).toBe(1);
    const personal = await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=learning', headers: { cookie: userCookie } });
    expect(personal.json().songs[0]).toMatchObject({ id: original.json().songId });
    expect((await app.inject({ method: 'POST', url: `/api/reviews/${submitted.json().submissionId}/reject`, headers: { cookie: adminCookie }, payload: {} })).statusCode).toBe(409);
    expect(user.json().userId).toBeGreaterThan(0);
  });

  it('不收录的重复歌曲提交审核后不会建立个人曲库关系', async () => {
    const adminCookie = await setup();
    const original = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: adminCookie }, payload: { title: '审核全局歌曲', artist: '审核歌手', collectionType: 'repertoire' } });
    const user = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie }, payload: { username: 'global-maintainer', password: 'password123' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'global-maintainer', password: 'password123' } });
    const header = login.headers['set-cookie']; const userCookie = (Array.isArray(header) ? header[0] : header)!.split(';')[0]!;
    const submitted = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: userCookie }, payload: {
      title: '审核全局歌曲', artist: '审核歌手', collectionType: null,
      duplicateAction: 'submit_review', matchedSongId: original.json().songId
    } });
    expect(submitted.statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: `/api/reviews/${submitted.json().submissionId}/merge`, headers: { cookie: adminCookie }, payload: {} })).statusCode).toBe(200);
    expect((database.db.prepare('SELECT count(*) AS count FROM user_songs WHERE user_id = ? AND song_id = ?').get(user.json().userId, original.json().songId) as any).count).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=learning', headers: { cookie: userCookie } })).json().total).toBe(0);
  });

  it('别名搜索、个人字段隔离和个人曲库批量操作保持原子性', async () => {
    const cookie = await setup();
    const ownerId = (database.db.prepare("SELECT id FROM users WHERE username = 'singer'").get() as { id: number }).id;
    const first = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '海边的歌', artist: '测试歌手', aliases: ['海边版'], collectionType: 'repertoire'
    } });
    const second = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '月光下的歌', artist: '另一个歌手', collectionType: 'repertoire'
    } });
    const firstId = first.json().songId as number;
    const secondId = second.json().songId as number;

    expect((await app.inject({ method: 'GET', url: `/api/songs/${firstId}`, headers: { cookie } })).json()).toMatchObject({ aliases: ['海边版'] });
    expect((await app.inject({ method: 'PUT', url: `/api/songs/${firstId}`, headers: { cookie }, payload: {
      title: '海边的歌', artist: '测试歌手', performanceType: 'solo', aliases: ['新别名']
    } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/search?scope=global&q=新别名', headers: { cookie } })).json().songs[0]).toMatchObject({ id: firstId });

    await app.inject({ method: 'PATCH', url: `/api/user-songs/${firstId}/meta`, headers: { cookie }, payload: { note: '只属于甲用户的记忆词' } });
    const created = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie }, payload: { username: 'search-isolation', password: 'password123' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'search-isolation', password: 'password123' } });
    const header = login.headers['set-cookie'];
    const otherCookie = (Array.isArray(header) ? header[0] : header)!.split(';')[0]!;
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=repertoire&q=只属于甲用户', headers: { cookie: otherCookie } })).json().total).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/search?scope=personal&collection=repertoire&q=只属于甲用户', headers: { cookie } })).json().total).toBe(1);

    const picked = await app.inject({ method: 'POST', url: '/api/picks', headers: { cookie }, payload: { requestId: '2ecf53c6-4e12-4b9c-9c99-35a93f7bcd22' } });
    expect(picked.statusCode).toBe(200);
    const invalidBatch = await app.inject({ method: 'POST', url: '/api/user-songs/batch', headers: { cookie }, payload: { action: 'remove', songIds: [firstId, 999999] } });
    expect(invalidBatch.statusCode).toBe(404);
    expect((database.db.prepare('SELECT removed_at FROM user_songs WHERE user_id = ? AND song_id = ?').get(ownerId, firstId) as any).removed_at).toBeNull();

    const batch = await app.inject({ method: 'POST', url: '/api/user-songs/batch', headers: { cookie }, payload: { action: 'set_collection', collectionType: 'learning', songIds: [firstId, secondId] } });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({ ok: true, updated: 2 });
    expect(database.db.prepare('SELECT collection_type FROM user_songs WHERE user_id = ? AND song_id IN (?, ?) ORDER BY song_id').all(ownerId, firstId, secondId)).toEqual([
      { collection_type: 'learning' }, { collection_type: 'learning' }
    ]);
    expect((database.db.prepare("SELECT count(*) AS count FROM pick_queue_items WHERE status = 'pending'").get() as any).count).toBe(0);
  });
});
