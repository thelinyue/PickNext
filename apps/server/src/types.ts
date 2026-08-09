import type Database from 'better-sqlite3';

export interface UserPayload {
  id: number;
  username: string;
  role: 'admin' | 'user';
  isMaintainer: boolean;
  canAddSongs: boolean;
}

export interface AppContext {
  db: Database.Database;
  webRoot?: string;
  devWebRoot?: string;
}
