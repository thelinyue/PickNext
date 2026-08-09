ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1));

CREATE INDEX users_admin_list_idx
  ON users(is_system, role, is_maintainer, created_at DESC, id DESC);

