import type { Op, WorkbookDoc } from '@excelsior/doc';
import type { Role } from './db';

/** Ephemeral per-connection state shown to collaborators (cursor, selection, what is being edited). */
export interface PresenceState {
  sheetId: string;
  selection: { r1: number; c1: number; r2: number; c2: number };
  editing: boolean;
}

export interface Peer {
  clientId: string;
  name: string;
  color: string;
  presence: PresenceState | null;
}

export type ClientMessage =
  | { type: 'commit'; clientOpId: string; ops: Op[] }
  | { type: 'presence'; state: PresenceState };

export type ServerMessage =
  | {
      type: 'welcome';
      clientId: string;
      version: number;
      doc: WorkbookDoc;
      role: Role;
      you: { name: string; color: string };
      peers: Peer[];
    }
  | { type: 'commit'; version: number; clientId: string; clientOpId: string; userName: string; ops: Op[] }
  | { type: 'reject'; clientOpId: string; error: string }
  | { type: 'presence'; peer: Peer }
  | { type: 'leave'; clientId: string }
  /** The room was shut down: the workbook was deleted, or the server is stopping. */
  | { type: 'closed'; reason: 'deleted' | 'server-shutdown' };
