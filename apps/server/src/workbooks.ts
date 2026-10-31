import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { type Op, type WorkbookDoc, applyOp } from '@excelsior/doc';
import type { Role } from './db';

export interface WorkbookMeta {
  id: string;
  title: string;
  ownerId: string;
  version: number;
  updatedAt: number;
  role: Role;
}

export interface VersionEntry {
  version: number;
  userName: string | null;
  summary: string;
  createdAt: number;
}

/** Snapshots are taken every this many versions so any version rebuilds from a short replay. */
export const SNAPSHOT_EVERY = 50;

/** Describes a commit in a few words for the version timeline. */
export function summarize(ops: Op[]): string {
  const parts = ops.map((op) => {
    switch (op.t) {
      case 'cells': {
        const keys = Object.keys(op.cells);
        return keys.length === 1 ? `edited ${keys[0]}` : `edited ${keys.length} cells`;
      }
      case 'iterationState':
        return 'iteration state';
      case 'addSheet':
        return `added sheet ${op.name}`;
      case 'renameSheet':
        return `renamed sheet to ${op.name}`;
      default:
        return op.t;
    }
  });
  return [...new Set(parts)].join(', ');
}

/** Persistence for workbooks, membership, share links, the op log and snapshots. */
export class WorkbookStore {
  constructor(private readonly db: DatabaseSync) {}

  create(ownerId: string, title: string, doc: WorkbookDoc): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO workbooks (id, owner_id, title, version, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
      )
      .run(id, ownerId, title, now, now);
    this.db
      .prepare("INSERT INTO members (workbook_id, user_id, role) VALUES (?, ?, 'owner')")
      .run(id, ownerId);
    this.saveSnapshot(id, 0, doc);
    return id;
  }

  list(userId: string): WorkbookMeta[] {
    return (
      this.db
        .prepare(
          `SELECT w.id, w.title, w.owner_id, w.version, w.updated_at, m.role FROM workbooks w
           JOIN members m ON m.workbook_id = w.id WHERE m.user_id = ? ORDER BY w.updated_at DESC`,
        )
        .all(userId) as {
        id: string;
        title: string;
        owner_id: string;
        version: number;
        updated_at: number;
        role: Role;
      }[]
    ).map((r) => ({
      id: r.id,
      title: r.title,
      ownerId: r.owner_id,
      version: r.version,
      updatedAt: r.updated_at,
      role: r.role,
    }));
  }

  meta(id: string, userId: string): WorkbookMeta | null {
    const r = this.db
      .prepare(
        `SELECT w.id, w.title, w.owner_id, w.version, w.updated_at, m.role FROM workbooks w
         JOIN members m ON m.workbook_id = w.id WHERE w.id = ? AND m.user_id = ?`,
      )
      .get(id, userId) as
      | { id: string; title: string; owner_id: string; version: number; updated_at: number; role: Role }
      | undefined;
    return r
      ? {
          id: r.id,
          title: r.title,
          ownerId: r.owner_id,
          version: r.version,
          updatedAt: r.updated_at,
          role: r.role,
        }
      : null;
  }

  rename(id: string, title: string): void {
    this.db.prepare('UPDATE workbooks SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workbooks WHERE id = ?').run(id);
  }

  createShare(workbookId: string, role: 'editor' | 'viewer'): string {
    const token = randomBytes(18).toString('base64url');
    this.db
      .prepare('INSERT INTO shares (token, workbook_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(token, workbookId, role, Date.now());
    return token;
  }

  /** Grants the share's role (never downgrading an existing membership). Returns the workbook id. */
  acceptShare(token: string, userId: string): string | null {
    const share = this.db.prepare('SELECT workbook_id, role FROM shares WHERE token = ?').get(token) as
      | { workbook_id: string; role: 'editor' | 'viewer' }
      | undefined;
    if (!share) return null;
    const existing = this.db
      .prepare('SELECT role FROM members WHERE workbook_id = ? AND user_id = ?')
      .get(share.workbook_id, userId) as { role: Role } | undefined;
    if (!existing) {
      this.db
        .prepare('INSERT INTO members (workbook_id, user_id, role) VALUES (?, ?, ?)')
        .run(share.workbook_id, userId, share.role);
    } else if (existing.role === 'viewer' && share.role === 'editor') {
      this.db
        .prepare("UPDATE members SET role = 'editor' WHERE workbook_id = ? AND user_id = ?")
        .run(share.workbook_id, userId);
    }
    return share.workbook_id;
  }

  hasCommit(id: string, clientId: string, clientOpId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM ops WHERE workbook_id = ? AND client_id = ? AND client_op_id = ?')
      .get(id, clientId, clientOpId);
  }

  appendOps(
    id: string,
    version: number,
    userId: string,
    clientId: string,
    clientOpId: string,
    ops: Op[],
  ): void {
    this.db
      .prepare(
        'INSERT INTO ops (workbook_id, version, user_id, client_id, client_op_id, summary, ops_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, version, userId, clientId, clientOpId, summarize(ops), JSON.stringify(ops), Date.now());
    this.db
      .prepare('UPDATE workbooks SET version = ?, updated_at = ? WHERE id = ?')
      .run(version, Date.now(), id);
  }

  saveSnapshot(id: string, version: number, doc: WorkbookDoc): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO snapshots (workbook_id, version, doc_gz, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, version, gzipSync(JSON.stringify(doc)), Date.now());
  }

  /** Rebuilds the document at `version` (default: latest) from the nearest snapshot plus the op log. */
  docAt(id: string, version?: number): { doc: WorkbookDoc; version: number } | null {
    const target =
      version ??
      (
        this.db.prepare('SELECT version FROM workbooks WHERE id = ?').get(id) as
          | { version: number }
          | undefined
      )?.version;
    if (target === undefined) return null;
    const snap = this.db
      .prepare(
        'SELECT version, doc_gz FROM snapshots WHERE workbook_id = ? AND version <= ? ORDER BY version DESC LIMIT 1',
      )
      .get(id, target) as { version: number; doc_gz: Uint8Array } | undefined;
    if (!snap) return null;
    const doc = JSON.parse(gunzipSync(snap.doc_gz).toString('utf8')) as WorkbookDoc;
    const rows = this.db
      .prepare(
        'SELECT ops_json FROM ops WHERE workbook_id = ? AND version > ? AND version <= ? ORDER BY version',
      )
      .all(id, snap.version, target) as { ops_json: string }[];
    for (const row of rows) for (const op of JSON.parse(row.ops_json) as Op[]) applyOp(doc, op);
    return { doc, version: target };
  }

  versions(id: string, limit = 2000): VersionEntry[] {
    return (
      this.db
        .prepare(
          `SELECT o.version, u.name, o.summary, o.created_at FROM ops o LEFT JOIN users u ON u.id = o.user_id
           WHERE o.workbook_id = ? ORDER BY o.version DESC LIMIT ?`,
        )
        .all(id, limit) as { version: number; name: string | null; summary: string; created_at: number }[]
    )
      .reverse()
      .map((r) => ({ version: r.version, userName: r.name, summary: r.summary, createdAt: r.created_at }));
  }
}
