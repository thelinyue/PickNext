-- v0.2.1 曲库歌曲优先加载：补齐列表、评分和个人演唱记录的连接索引。
CREATE INDEX IF NOT EXISTS songs_active_sort_idx
  ON songs(title_initial, pinyin COLLATE NOCASE, title COLLATE NOCASE)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS plays_user_song_played_idx
  ON plays(user_id, song_id, played_at DESC);

CREATE INDEX IF NOT EXISTS song_user_meta_song_rating_idx
  ON song_user_meta(song_id, rating);
