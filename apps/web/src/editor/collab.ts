import { type Op, type WorkbookDoc, applyOp, cloneDoc, validateOp } from '@excelsior/doc';

export interface Presence {
  sheetId: string;
  selection: { r1: number; c1: number; r2: number; c2: number };
  editing: boolean;
}

export interface Peer {
  clientId: string;
  name: string;
  color: string;
  presence: Presence | null;
}

type ServerMessage =
  | {
      type: 'welcome';
      clientId: string;
      version: number;
      doc: WorkbookDoc;
      role: 'owner' | 'editor' | 'viewer';
      you: { name: string; color: string };
      peers: Peer[];
    }
  | { type: 'commit'; version: number; clientId: string; clientOpId: string; userName: string; ops: Op[] }
  | { type: 'reject'; clientOpId: string; error: string }
  | { type: 'presence'; peer: Peer }
  | { type: 'leave'; clientId: string }
  | { type: 'closed'; reason: 'deleted' | 'server-shutdown' };

export interface CollabEvents {
  /** The visible document changed; `ops` are the ops whose effects should reach the engine. */
  onDoc(ops: Op[] | 'reset'): void;
  onPeers(peers: Peer[]): void;
  onStatus(status: 'connecting' | 'live' | 'offline', error?: string): void;
}

interface Pending {
  id: string;
  ops: Op[];
}

const CLIENT_KEY = `tab-${crypto.randomUUID()}`;

/**
 * Client side of server-sequenced collaboration. `confirmed` is the server's document at `version`;
 * the visible document is confirmed + pending local commits. Remote commits apply to `confirmed`, and
 * pending commits are replayed on top, so local edits stay visible until the server orders them.
 */
export class Collab {
  confirmed: WorkbookDoc | null = null;
  view: WorkbookDoc | null = null;
  version = 0;
  role: 'owner' | 'editor' | 'viewer' = 'viewer';
  me = { name: '', color: '#000' };
  private pending: Pending[] = [];
  private peers = new Map<string, Peer>();
  private ws: WebSocket | null = null;
  private closed = false;
  private seq = 0;
  private retry = 500;

  constructor(
    private readonly workbookId: string,
    private readonly events: CollabEvents,
  ) {
    this.connect();
  }

  private connect(): void {
    this.events.onStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/api/workbooks/${this.workbookId}/live?client=${CLIENT_KEY}`,
    );
    this.ws = ws;
    ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = () => {
      this.ws = null;
      if (this.closed) return;
      this.events.onStatus('offline');
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 8000);
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  get canEdit(): boolean {
    return this.role !== 'viewer';
  }

  /**
   * Applies ops locally right away and sends them to the server. `silent` skips the local change
   * notification, for state the local engine already has (the iteration state it just produced).
   */
  commit(ops: Op[], silent = false): void {
    if (!this.view || !this.canEdit || ops.length === 0) return;
    for (const op of ops) validateOp(this.view, op);
    const id = `c${++this.seq}`;
    for (const op of ops) applyOp(this.view, op);
    this.pending.push({ id, ops });
    this.send({ type: 'commit', clientOpId: id, ops });
    if (!silent) this.events.onDoc(ops);
  }

  presence(state: Presence): void {
    this.send({ type: 'presence', state });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private receive(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome': {
        this.retry = 500;
        this.confirmed = msg.doc;
        this.version = msg.version;
        this.role = msg.role;
        this.me = msg.you;
        this.peers = new Map(msg.peers.map((p) => [p.clientId, p]));
        // Resend anything the server may not have seen; it deduplicates by client op id.
        for (const p of this.pending) this.send({ type: 'commit', clientOpId: p.id, ops: p.ops });
        this.rebuild();
        this.events.onDoc('reset');
        this.events.onPeers([...this.peers.values()]);
        this.events.onStatus('live');
        return;
      }
      case 'commit': {
        if (!this.confirmed) return;
        for (const op of msg.ops) applyOp(this.confirmed, op);
        this.version = Math.max(this.version, msg.version);
        const mine = msg.clientId === CLIENT_KEY && this.pending[0]?.id === msg.clientOpId;
        if (mine) {
          this.pending.shift();
          // Our own op is already visible; only rebuild if others are still pending behind it.
          if (this.pending.length === 0) this.view = cloneDoc(this.confirmed);
          return;
        }
        this.rebuild();
        this.events.onDoc([...msg.ops, ...this.pending.flatMap((p) => p.ops)]);
        return;
      }
      case 'reject': {
        this.pending = this.pending.filter((p) => p.id !== msg.clientOpId);
        this.rebuild();
        this.events.onDoc('reset');
        this.events.onStatus('live', msg.error);
        return;
      }
      case 'presence':
        this.peers.set(msg.peer.clientId, msg.peer);
        this.events.onPeers([...this.peers.values()]);
        return;
      case 'leave':
        this.peers.delete(msg.clientId);
        this.events.onPeers([...this.peers.values()]);
        return;
      case 'closed':
        // A deleted workbook will never come back, so stop reconnecting; a server restart will.
        if (msg.reason === 'deleted') {
          this.closed = true;
          this.events.onStatus('offline', 'This workbook was deleted');
        }
        return;
    }
  }

  private rebuild(): void {
    if (!this.confirmed) return;
    const view = cloneDoc(this.confirmed);
    this.pending = this.pending.filter((p) => {
      try {
        for (const op of p.ops) {
          validateOp(view, op);
          applyOp(view, op);
        }
        return true;
      } catch {
        return false;
      }
    });
    this.view = view;
  }
}
