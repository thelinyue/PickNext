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
  process.env.JWT_SECRET = 'test-secret-with-more-than-thirty-two-characters';
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

describe('核心 API 纵向闭环', () => {
  it('未登录不能访问个人曲库', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/songs' });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toContain('重新登录');
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

  it('曲库搜索按数据范围隔离，并只在三人评分后返回匿名聚合', async () => {
    const cookie = await setup();
    const repertoire = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '会唱的歌', artist: '歌手甲', language: '国语', genre: '流行', difficulty: 'easy', collectionType: 'repertoire'
    } });
    await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie }, payload: {
      title: '待学的歌', artist: '歌手乙', language: '粤语', genre: '摇滚', difficulty: 'hard', collectionType: 'learning'
    } });
    const ownerId = (database.db.prepare(`SELECT id FROM users WHERE username = 'singer'`).get() as { id: number }).id;
    const globalSongId = Number(database.db.prepare(`
      INSERT INTO songs(title, artist, language, genre, difficulty, performance_type, status, added_by)
      VALUES ('全站歌曲', '歌手丙', '英语', '民谣', 'medium', 'duet', 'active', ?)
    `).run(ownerId).lastInsertRowid);
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

    await app.inject({ method: 'PUT', url: `/api/admin/users/${userId}`, headers: { cookie: adminCookie }, payload: { canAddSongs: false } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'new-singer', password: 'password123' } });
    const header = login.headers['set-cookie'];
    const userCookie = (Array.isArray(header) ? header[0] : header)!.split(';')[0]!;
    const forbiddenAdd = await app.inject({ method: 'POST', url: '/api/songs', headers: { cookie: userCookie }, payload: {
      title: '不能添加', artist: '测试', collectionType: 'learning'
    } });
    expect(forbiddenAdd.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: userCookie } })).statusCode).toBe(403);

    expect((await app.inject({ method: 'PUT', url: `/api/admin/users/${userId}/password`, headers: { cookie: adminCookie }, payload: { password: 'changed123' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'new-singer', password: 'changed123' } })).statusCode).toBe(200);
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
  });
});
