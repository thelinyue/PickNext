-- v0.2.0 搜索索引：公共歌曲资料与个人歌曲记忆分开索引，避免个人字段泄露到全局搜索。
CREATE VIRTUAL TABLE song_search USING fts5(
  song_id UNINDEXED,
  title,
  artist,
  version,
  pinyin,
  pinyin_compact,
  aliases,
  lyrics,
  lyrics_translit,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE user_song_search USING fts5(
  user_id UNINDEXED,
  song_id UNINDEXED,
  note,
  memory_cue,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO song_search(song_id, title, artist, version, pinyin, pinyin_compact, aliases, lyrics, lyrics_translit)
SELECT s.id, s.title, s.artist, coalesce(s.version, ''), coalesce(s.pinyin, ''), replace(coalesce(s.pinyin, ''), ' ', ''),
       coalesce(group_concat(a.alias, ' '), ''), coalesce(s.lyrics, ''), coalesce(s.lyrics_translit, '')
FROM songs s
LEFT JOIN song_aliases a ON a.song_id = s.id
WHERE s.status = 'active'
GROUP BY s.id;

INSERT INTO user_song_search(user_id, song_id, note, memory_cue)
SELECT us.user_id, us.song_id, coalesce(m.note, ''), coalesce(m.memory_cue, '')
FROM user_songs us
JOIN songs s ON s.id = us.song_id AND s.status = 'active'
LEFT JOIN song_user_meta m ON m.user_id = us.user_id AND m.song_id = us.song_id
WHERE us.removed_at IS NULL;
