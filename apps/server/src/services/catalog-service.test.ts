import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CatalogService } from './catalog-service.js';

describe('曲库领域服务', () => {
  it('精确查重使用规范化身份且版本不同可并存', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, artist TEXT, version TEXT, normalized_title TEXT, normalized_artist TEXT, normalized_version TEXT, language TEXT, genre TEXT, difficulty TEXT, performance_type TEXT, lyrics TEXT, lyrics_translit TEXT, pinyin TEXT, title_initial TEXT, added_by INTEGER, status TEXT DEFAULT 'active')`);
    db.exec('CREATE TABLE user_songs (user_id INTEGER, song_id INTEGER, collection_type TEXT, removed_at TEXT, PRIMARY KEY (user_id, song_id))');
    db.exec('CREATE TABLE song_user_meta (user_id INTEGER, song_id INTEGER, override_diff TEXT, note TEXT, memory_cue TEXT, key_shift INTEGER, updated_at TEXT, PRIMARY KEY (user_id, song_id))');
    const service = new CatalogService(db);
    const first = service.createSong({ title: '晴天', artist: '周杰伦', version: null, performanceType: 'solo', addedBy: 1 });
    const second = service.createSong({ title: '晴天', artist: '周杰伦', version: 'Live', performanceType: 'solo', addedBy: 1 });
    expect(service.findCandidates({ title: ' 晴天 ', artist: '周杰伦', version: null }).exact?.id).toBe(first);
    expect(service.findCandidates({ title: '晴天', artist: '周杰伦', version: 'Live' }).exact?.id).toBe(second);
    expect(service.collectUserSong(2, first, { collectionType: 'repertoire' })).toBe(true);
    expect(db.prepare('SELECT collection_type FROM user_songs WHERE user_id = 2 AND song_id = ?').get(first)).toMatchObject({ collection_type: 'repertoire' });
    db.close();
  });
});
