import { randomUUID } from 'node:crypto';
import { type Op, type WorkbookDoc, applyOp, invertCellsOp, validateOp } from '@excelsior/doc';
import type { User } from './auth';
import { type Role, canEdit } from './db';
import type { ClientMessage, Peer, PresenceState, ServerMessage } from './protocol';
import { SNAPSHOT_EVERY, type WorkbookStore } from './workbooks';

const COLORS = ['#e4572e', '#2e6fe4', '#17a589', '#a14fd8', '#f1a208', '#d6336c', '#1098ad'];

export interface Connection {
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface Client {
  id: string;
  user: User;
  role: Role;
  color: string;
  conn: Connection;
  presence: PresenceState | null;
}

export type ShutdownReason = 'deleted' | 'server-shutdown';

/** WebSocket close codes: 4404 tells the browser not to reconnect, 1001 is a normal "going away". */
const CLOSE_CODE: Record<ShutdownReason, number> = { deleted: 4404, 'server-shutdown': 1001 };

/**
 * Returns a function that restores `doc` to its state before `op` is applied. Cheap for the common ops
 * (cell edits and iteration state), so atomic commits do not need to clone the whole document.
 */
function undoFor(doc: WorkbookDoc, op: Op): () => void {
  switch (op.t) {
    case 'cells': {
      const inverse = invertCellsOp(doc, op);
      return () => applyOp(doc, inverse);
    }
    case 'iterationState': {
      const prev = doc.iterationState;
      return () => {
        doc.iterationState = prev;
      };
    }
    case 'calc': {
      const prev = doc.calc;
      return () => {
        doc.calc = prev;
      };
    }
    case 'addSheet':
      return () => {
        doc.sheets = doc.sheets.filter((s) => s.id !== op.sheet);
      };
    default: {
      const sheet = doc.sheets.find((s) => s.id === op.sheet);
      if (!sheet) return () => {};
      const { name, condFormats, charts } = sheet;
      const widths = { ...sheet.colWidths };
      return () => {
        Object.assign(sheet, { name, condFormats, charts, colWidths: widths });
      };
    }
  }
}

/**
 * One live workbook. The server is the single sequencer: commits are validated against the current
 * document, applied, given the next version number, persisted and broadcast to every client
 * (including the sender, which treats it as the acknowledgement). Since every op is a last-writer-wins
 * overwrite of a cell, sheet or setting, clients converge by applying commits in version order.
 *
 * Invariant: the in-memory document always equals the persisted one. A commit that fails validation
 * or persistence is rolled back before anyone sees it, and a room that has been shut down (its
 * workbook deleted, or the server stopping) never writes again.
 */
export class Room {
  private readonly clients = new Map<string, Client>();
  private colorIndex = 0;
  private closed = false;

  constructor(
    readonly id: string,
    private doc: WorkbookDoc,
    private version: number,
    private readonly store: WorkbookStore,
  ) {}

  get size(): number {
    return this.clients.size;
  }

  /** The latest sequenced document. Callers must treat it as read-only. */
  get current(): WorkbookDoc {
    return this.doc;
  }

  /** `clientKey` is chosen by the browser tab and survives reconnects, which makes retried commits idempotent. */
  join(user: User, role: Role, conn: Connection, clientKey?: string): string | null {
    if (this.closed) return null;
    const id = clientKey && !this.clients.has(clientKey) ? clientKey : randomUUID();
    const client: Client = {
      id,
      user,
      role,
      color: COLORS[this.colorIndex++ % COLORS.length],
      conn,
      presence: null,
    };
    this.clients.set(id, client);
    conn.send({
      type: 'welcome',
      clientId: id,
      version: this.version,
      doc: this.doc,
      role,
      you: { name: user.name, color: client.color },
      peers: [...this.clients.values()].filter((c) => c.id !== id).map((c) => this.peer(c)),
    });
    return id;
  }

  leave(clientId: string): void {
    if (!this.clients.delete(clientId)) return;
    this.broadcast({ type: 'leave', clientId }, clientId);
    if (this.clients.size === 0) this.persistSnapshot();
  }

  /**
   * Stops the room: no further commits or snapshots. When the server is stopping, the latest state is
   * snapshotted first; when the workbook was deleted there is nothing left to write to.
   */
  shutdown(reason: ShutdownReason): void {
    if (this.closed) return;
    if (reason === 'server-shutdown') this.persistSnapshot();
    this.closed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const c of clients) {
      c.conn.send({ type: 'closed', reason });
      c.conn.close(CLOSE_CODE[reason], reason);
    }
  }

  handle(clientId: string, msg: ClientMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (msg.type === 'presence') {
      client.presence = msg.state;
      this.broadcast({ type: 'presence', peer: this.peer(client) }, clientId);
      return;
    }
    const result = this.commit(client, msg.clientOpId, msg.ops);
    if (result) client.conn.send({ type: 'reject', clientOpId: msg.clientOpId, error: result });
  }

  /** Applies a commit; returns an error message if it was rejected. Exposed for REST restores. */
  commit(client: Pick<Client, 'id' | 'user' | 'role'>, clientOpId: string, ops: Op[]): string | null {
    if (this.closed) return 'This workbook is no longer available';
    if (!canEdit(client.role)) return 'You have view-only access to this workbook';
    if (!Array.isArray(ops) || ops.length === 0) return 'Empty commit';
    if (this.store.hasCommit(this.id, client.id, clientOpId)) {
      // A retry of a commit we already sequenced (the ack was lost): acknowledge without reapplying.
      const ack: ServerMessage = {
        type: 'commit',
        version: this.version,
        clientId: client.id,
        clientOpId,
        userName: client.user.name,
        ops: [],
      };
      this.clients.get(client.id)?.conn.send(ack);
      return null;
    }
    // Commits are atomic: every op is validated against the document as left by the previous one, and
    // all of them are undone if any op is invalid or the write to the op log fails.
    const undo: (() => void)[] = [];
    const rollback = () => {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]();
    };
    const version = this.version + 1;
    try {
      for (const op of ops) {
        validateOp(this.doc, op);
        undo.push(undoFor(this.doc, op));
        applyOp(this.doc, op);
      }
    } catch (e) {
      rollback();
      return e instanceof Error ? e.message : String(e);
    }
    try {
      this.store.appendOps(this.id, version, client.user.id, client.id, clientOpId, ops);
    } catch (e) {
      rollback();
      console.error(`workbook ${this.id}: could not persist version ${version}`, e);
      return 'The change could not be saved; please retry';
    }
    this.version = version;
    if (version % SNAPSHOT_EVERY === 0) this.persistSnapshot();
    this.broadcast({
      type: 'commit',
      version,
      clientId: client.id,
      clientOpId,
      userName: client.user.name,
      ops,
    });
    return null;
  }

  /** Snapshots are an optimization (the op log is authoritative), so a failure is logged, not fatal. */
  private persistSnapshot(): void {
    if (this.closed) return;
    try {
      this.store.saveSnapshot(this.id, this.version, this.doc);
    } catch (e) {
      console.error(`workbook ${this.id}: could not save snapshot at version ${this.version}`, e);
    }
  }

  private peer(c: Client): Peer {
    return { clientId: c.id, name: c.user.name, color: c.color, presence: c.presence };
  }

  private broadcast(msg: ServerMessage, except?: string): void {
    for (const c of this.clients.values()) if (c.id !== except) c.conn.send(msg);
  }
}

/** Keeps one Room per open workbook and drops it when the last client leaves. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly store: WorkbookStore) {}

  get(id: string): Room | null {
    let room = this.rooms.get(id);
    if (room) return room;
    const state = this.store.docAt(id);
    if (!state) return null;
    room = new Room(id, state.doc, state.version, this.store);
    this.rooms.set(id, room);
    return room;
  }

  release(id: string): void {
    const room = this.rooms.get(id);
    if (room && room.size === 0) this.rooms.delete(id);
  }

  /** Shuts one room down (before its workbook is deleted) so nothing writes to it afterwards. */
  close(id: string, reason: ShutdownReason): void {
    this.rooms.get(id)?.shutdown(reason);
    this.rooms.delete(id);
  }

  /** Snapshots and disconnects every open room; used on server shutdown. */
  closeAll(): void {
    for (const room of this.rooms.values()) room.shutdown('server-shutdown');
    this.rooms.clear();
  }
}
