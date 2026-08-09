ALTER TABLE users ADD COLUMN is_maintainer INTEGER NOT NULL DEFAULT 0 CHECK (is_maintainer IN (0, 1));
ALTER TABLE users ADD COLUMN can_add_songs INTEGER NOT NULL DEFAULT 1 CHECK (can_add_songs IN (0, 1));
