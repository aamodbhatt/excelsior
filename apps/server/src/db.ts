import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workbooks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (workbook_id, user_id)
);
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  user_id TEXT,
  client_id TEXT,
  client_op_id TEXT,
  summary TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workbook_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_dedupe ON ops (workbook_id, client_id, client_op_id);
CREATE TABLE IF NOT EXISTS snapshots (
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  doc_gz BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workbook_id, version)
);
`;

/** Opens (and migrates) the SQLite database. Use ":memory:" in tests. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export type Role = 'owner' | 'editor' | 'viewer';

export function canEdit(role: Role | null): boolean {
  return role === 'owner' || role === 'editor';
}
