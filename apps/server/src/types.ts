import type Database from 'better-sqlite3';

export interface UserPayload {
  id: number;
  username: string;
  nickname: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: 'admin' | 'user';
  isMaintainer: boolean;
  canAddSongs: boolean;
}

export interface AppContext {
  db: Database.Database;
  dataRoot?: string;
  webRoot?: string;
  devWebRoot?: string;
}
