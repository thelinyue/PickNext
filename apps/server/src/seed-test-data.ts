import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppDatabase } from './db.js';
import { hashPassword } from './auth.js';

const TEST_PASSWORD = 'PickNext123!';
const accountDefinitions = [
  ['admin_demo', 'admin'],
  ['new_demo', 'user'],
  ['learning_demo', 'user'],
  ['repertoire_demo', 'user'],
  ['ktv_demo', 'user'],
  ['recent_demo', 'user'],
  ['single_artist_demo', 'user'],
  ['filter_demo', 'user'],
  ['snooze_demo', 'user'],
  ['skip_demo', 'user']
] as const;

const songDefinitions = [
  ['晴天', '周杰伦', '国语', '流行', 'medium', 'solo', null],
  ['稻香', '周杰伦', '国语', '流行', 'easy', 'solo', null],
  ['搁浅', '周杰伦', '国语', '抒情', 'hard', 'solo', null],
  ['简单爱', '周杰伦', '国语', '流行', 'easy', 'solo', null],
  ['最长的电影', '周杰伦', '国语', '抒情', 'hard', 'solo', null],
  ['一路向北', '周杰伦', '国语', '摇滚', 'hard', 'solo', null],
  ['夜曲', '周杰伦', '国语', 'R&B', 'medium', 'solo', null],
  ['蒲公英的约定', '周杰伦', '国语', '抒情', 'medium', 'solo', null],
  ['富士山下', '陈奕迅', '粤语', '流行', 'medium', 'solo', null],
  ['十年', '陈奕迅', '国语', '抒情', 'easy', 'solo', null],
  ['浮夸', '陈奕迅', '粤语', '摇滚', 'hard', 'solo', null],
  ['红玫瑰', '陈奕迅', '国语', '流行', 'medium', 'solo', null],
  ['后来', '刘若英', '国语', '抒情', 'medium', 'solo', null],
  ['勇气', '梁静茹', '国语', '流行', 'easy', 'solo', null],
  ['可惜不是你', '梁静茹', '国语', '抒情', 'hard', 'solo', null],
  ['小幸运', '田馥甄', '国语', '流行', 'easy', 'solo', null],
  ['你最珍贵', '张学友 / 高慧君', '国语', '抒情', 'medium', 'duet', '对唱版'],
  ['珊瑚海', '周杰伦 / 梁心颐', '国语', '流行', 'hard', 'duet', '对唱版'],
  ['明天会更好', '群星', '国语', '公益', 'easy', 'chorus', '合唱版'],
  ['海阔天空', 'Beyond', '粤语', '摇滚', 'hard', 'chorus', null],
  ['喜欢你', 'Beyond', '粤语', '摇滚', 'medium', 'solo', null],
  ['光辉岁月', 'Beyond', '粤语', '摇滚', 'hard', 'chorus', null],
  ['Shape of You', 'Ed Sheeran', '英语', '流行', 'medium', 'solo', null],
  ['Someone Like You', 'Adele', '英语', '抒情', 'hard', 'solo', null],
  ['Perfect', 'Ed Sheeran', '英语', '流行', 'medium', 'duet', 'Duet Version'],
  ['Lemon', '米津玄师', '日语', '流行', 'hard', 'solo', null],
  ['First Love', '宇多田光', '日语', 'R&B', 'hard', 'solo', null],
  ['童话', '光良', '国语', '抒情', 'easy', 'solo', null],
  ['演员', '薛之谦', '国语', '流行', 'medium', 'solo', null],
  ['修炼爱情', '林俊杰', '国语', '抒情', 'hard', 'solo', null]
] as const;

/**
 * 只在显式设置 ALLOW_TEST_SEED=1 时执行，避免部署者误把演示账号写入正式数据库。
 * 脚本仅重置固定的 *_demo 账号数据，不删除真实用户或全局歌曲。
 */
async function main() {
  if (process.env.ALLOW_TEST_SEED !== '1') {
    throw new Error('拒绝写入测试数据：请显式设置 ALLOW_TEST_SEED=1。');
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(here, '../../..');
  const databasePath = process.env.DATABASE_PATH ?? resolve(projectRoot, 'data/picknext.db');
  const database = new AppDatabase(databasePath, resolve(projectRoot, 'migrations'));
  const passwordHashes = new Map<string, string>();
  for (const [username] of accountDefinitions) passwordHashes.set(username, await hashPassword(TEST_PASSWORD));

  database.db.transaction(() => {
    const upsertUser = database.db.prepare(`
      INSERT INTO users(username, password_hash, role) VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role
    `);
    const userIds = new Map<string, number>();
    for (const [username, role] of accountDefinitions) {
      upsertUser.run(username, passwordHashes.get(username), role);
      const user = database.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
      userIds.set(username, user.id);
    }

    // 重跑时只清理固定演示账号的个人数据，保持脚本幂等。
    for (const userId of userIds.values()) {
      database.db.prepare('DELETE FROM plays WHERE user_id = ?').run(userId);
      database.db.prepare('DELETE FROM pick_sessions WHERE user_id = ?').run(userId);
      database.db.prepare('DELETE FROM playlists WHERE owner_id = ?').run(userId);
      database.db.prepare('DELETE FROM song_user_meta WHERE user_id = ?').run(userId);
      database.db.prepare('DELETE FROM user_songs WHERE user_id = ?').run(userId);
    }

    const adminId = userIds.get('admin_demo')!;
    const upsertSong = database.db.prepare(`
      INSERT INTO songs(title, artist, language, genre, difficulty, performance_type, version, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const songIds: number[] = [];
    for (const [title, artist, language, genre, difficulty, performanceType, version] of songDefinitions) {
      let song = database.db.prepare(`
        SELECT id FROM songs WHERE title = ? COLLATE NOCASE AND artist = ? COLLATE NOCASE
          AND coalesce(version, '') = coalesce(?, '') AND status = 'active'
      `).get(title, artist, version) as { id: number } | undefined;
      if (!song) {
        const result = upsertSong.run(title, artist, language, genre, difficulty, performanceType, version, adminId);
        song = { id: Number(result.lastInsertRowid) };
      }
      songIds.push(song.id);
    }

    const collect = database.db.prepare(`
      INSERT INTO user_songs(user_id, song_id, collection_type) VALUES (?, ?, ?)
      ON CONFLICT(user_id, song_id) DO UPDATE SET collection_type = excluded.collection_type, removed_at = NULL
    `);
    const meta = database.db.prepare(`
      INSERT INTO song_user_meta(user_id, song_id, rating, override_diff, key_shift, note, memory_cue, pick_snoozed_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, song_id) DO UPDATE SET rating=excluded.rating, override_diff=excluded.override_diff,
        key_shift=excluded.key_shift, note=excluded.note, memory_cue=excluded.memory_cue,
        pick_snoozed_until=excluded.pick_snoozed_until, updated_at=datetime('now')
    `);
    const addCollection = (username: string, indexes: number[], type: 'repertoire' | 'learning') => {
      const userId = userIds.get(username)!;
      for (const index of indexes) collect.run(userId, songIds[index], type);
    };
    const addMeta = (username: string, indexes: number[], snoozed = false) => {
      const userId = userIds.get(username)!;
      indexes.forEach((index, position) => meta.run(
        userId,
        songIds[index],
        3 + (position % 3),
        position % 4 === 0 ? 'hard' : null,
        (position % 5) - 2,
        position % 3 === 0 ? '副歌容易想起来' : null,
        position % 4 === 0 ? `记忆词-${position + 1}` : null,
        snoozed ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null
      ));
    };

    addCollection('learning_demo', [8, 10, 14, 17, 22, 23, 25, 26], 'learning');
    addCollection('repertoire_demo', [...Array(18).keys()], 'repertoire');
    addCollection('repertoire_demo', [22, 23, 25, 26], 'learning');
    addMeta('repertoire_demo', [...Array(18).keys()]);
    addCollection('ktv_demo', [...Array(15).keys()], 'repertoire');
    addMeta('ktv_demo', [...Array(15).keys()]);
    addCollection('recent_demo', [...Array(10).keys()], 'repertoire');
    addMeta('recent_demo', [...Array(10).keys()]);
    addCollection('single_artist_demo', [...Array(8).keys()], 'repertoire');
    addMeta('single_artist_demo', [...Array(8).keys()]);
    addCollection('filter_demo', [...Array(30).keys()], 'repertoire');
    addMeta('filter_demo', [...Array(30).keys()]);
    addCollection('snooze_demo', [12, 13, 14, 15, 27, 28], 'repertoire');
    addMeta('snooze_demo', [12, 13, 14, 15, 27], true);
    addMeta('snooze_demo', [28]);
    addCollection('skip_demo', [27], 'repertoire');
    addMeta('skip_demo', [27]);
    addCollection('admin_demo', [...Array(30).keys()], 'repertoire');
    addMeta('admin_demo', [...Array(30).keys()]);

    const addPlay = database.db.prepare(`
      INSERT INTO plays(user_id, song_id, note, rating_snapshot, played_at) VALUES (?, ?, ?, ?, ?)
    `);
    const historyUser = userIds.get('repertoire_demo')!;
    for (let index = 0; index < 16; index += 1) {
      addPlay.run(historyUser, songIds[index % 12], index % 4 === 0 ? '演唱状态不错' : null, 3 + (index % 3), new Date(Date.now() - index * 6 * 86_400_000).toISOString());
    }
    const recentUser = userIds.get('recent_demo')!;
    for (let index = 0; index < 10; index += 1) {
      addPlay.run(recentUser, songIds[index], null, 4, new Date(Date.now() - index * 3_600_000).toISOString());
    }

    const createPlaylist = database.db.prepare('INSERT INTO playlists(owner_id, name, kind) VALUES (?, ?, ?)');
    const addPlaylistSong = database.db.prepare('INSERT INTO playlist_songs(playlist_id, song_id, position) VALUES (?, ?, ?)');
    for (const [username] of accountDefinitions) {
      const userId = userIds.get(username)!;
      createPlaylist.run(userId, '下一次 KTV', 'next_ktv');
    }
    const ktvUser = userIds.get('ktv_demo')!;
    const ktvPlaylist = database.db.prepare(`SELECT id FROM playlists WHERE owner_id = ? AND kind = 'next_ktv'`).get(ktvUser) as { id: number };
    [0, 2, 8, 16, 19].forEach((index, position) => addPlaylistSong.run(ktvPlaylist.id, songIds[index], position));
    const themePlaylist = Number(createPlaylist.run(historyUser, '深夜慢歌', 'normal').lastInsertRowid);
    [2, 8, 12, 14, 23].forEach((index, position) => addPlaylistSong.run(themePlaylist, songIds[index], position));
    const duetPlaylist = Number(createPlaylist.run(historyUser, '对唱备选', 'normal').lastInsertRowid);
    [16, 17, 24].forEach((index, position) => addPlaylistSong.run(duetPlaylist, songIds[index], position));

    const skipUser = userIds.get('skip_demo')!;
    for (let index = 0; index < 3; index += 1) {
      const sessionId = randomUUID();
      const eventId = randomUUID();
      database.db.prepare(`
        INSERT INTO pick_sessions(id, user_id, random_seed, algorithm_version, started_at, last_activity_at, ended_at)
        VALUES (?, ?, ?, 'v1', datetime('now', ?), datetime('now', ?), datetime('now', ?))
      `).run(sessionId, skipUser, 100 + index, `-${index + 3} days`, `-${index + 3} days`, `-${index + 3} days`);
      const queueId = Number(database.db.prepare(`
        INSERT INTO pick_queue_items(session_id, song_id, source, position, filter_hash, recency_weight,
          artist_factor, genre_factor, difficulty_factor, final_weight, status)
        VALUES (?, ?, 'repertoire', 0, 'seed', 3, 1, 1, 1, 3, 'skipped')
      `).run(sessionId, songIds[27]).lastInsertRowid);
      database.db.prepare(`
        INSERT INTO pick_events(id, session_id, queue_item_id, user_id, song_id, source, candidate_count,
          filter_snapshot, request_id, algorithm_version, status, response_json, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, 'repertoire', 1, '{}', ?, 'v1', 'skipped', '{}', datetime('now', ?), datetime('now', ?))
      `).run(eventId, sessionId, queueId, skipUser, songIds[27], randomUUID(), `-${index + 3} days`, `-${index + 3} days`);
    }
  })();

  database.close();
  console.log('测试数据已生成：10 个演示账号、30 首全局歌曲及多种 Pick 场景。');
  console.log(`所有演示账号密码：${TEST_PASSWORD}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '生成测试数据失败。');
  process.exit(1);
});
