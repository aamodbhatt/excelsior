import { type Op, type WorkbookDoc, emptyWorkbook } from '@excelsior/doc';
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/protocol';
import { Room } from '../src/rooms';
import type { WorkbookStore } from '../src/workbooks';

/** An in-memory stand-in for WorkbookStore whose writes can be made to fail. */
class FakeStore {
  failAppend = false;
  failSnapshot = false;
  appended: number[] = [];
  snapshots: number[] = [];

  hasCommit(): boolean {
    return false;
  }

  appendOps(_id: string, version: number): void {
    if (this.failAppend) throw new Error('FOREIGN KEY constraint failed');
    this.appended.push(version);
  }

  saveSnapshot(_id: string, version: number): void {
    if (this.failSnapshot) throw new Error('FOREIGN KEY constraint failed');
    this.snapshots.push(version);
  }
}

const user = { id: 'u1', email: 'u@example.com', name: 'U' };

function setup() {
  const store = new FakeStore();
  const doc: WorkbookDoc = emptyWorkbook();
  const room = new Room('w1', doc, 0, store as unknown as WorkbookStore);
  const sent: ServerMessage[] = [];
  const closes: number[] = [];
  const clientId = room.join(user, 'owner', {
    send: (m) => sent.push(m),
    close: (code) => closes.push(code),
  })!;
  return { store, doc, room, sent, closes, clientId };
}

const edit = (cells: Record<string, string>): Op => ({
  t: 'cells',
  sheet: 's1',
  cells: Object.fromEntries(Object.entries(cells).map(([a, v]) => [a, { v }])),
});

describe('Room', () => {
  it('rolls the document back when persisting a commit fails', () => {
    const { store, doc, room } = setup();
    expect(room.commit({ id: 'c', user, role: 'owner' }, 'ok', [edit({ A1: '1' })])).toBeNull();
    store.failAppend = true;
    const error = room.commit({ id: 'c', user, role: 'owner' }, 'bad', [
      edit({ A1: '2', B1: '3' }),
      { t: 'calc', calc: { ...doc.calc, iterative: true } },
      { t: 'iterationState', state: { cells: [] } },
    ]);
    expect(error).toMatch(/could not be saved/);
    expect(doc.sheets[0].cells).toEqual({ A1: { v: '1' } });
    expect(doc.calc.iterative).toBe(false);
    expect(doc.iterationState).toBeNull();
    expect(store.appended).toEqual([1]);
  });

  it('never throws when the last client leaves and the snapshot write fails', () => {
    const { store, room, clientId } = setup();
    store.failSnapshot = true;
    expect(() => room.leave(clientId)).not.toThrow();
  });

  it('after shutdown for deletion it notifies clients and performs no further writes', () => {
    const { store, room, sent, closes, clientId } = setup();
    room.shutdown('deleted');
    expect(sent.at(-1)).toEqual({ type: 'closed', reason: 'deleted' });
    expect(closes).toEqual([4404]);
    expect(room.commit({ id: 'c', user, role: 'owner' }, 'late', [edit({ A1: '9' })])).toMatch(
      /no longer available/,
    );
    room.leave(clientId);
    expect(store.appended).toEqual([]);
    expect(store.snapshots).toEqual([]);
    expect(room.join(user, 'owner', { send: () => {}, close: () => {} })).toBeNull();
  });

  it('snapshots the latest state when the server shuts down', () => {
    const { store, room } = setup();
    room.commit({ id: 'c', user, role: 'owner' }, 'x', [edit({ A1: '1' })]);
    room.shutdown('server-shutdown');
    expect(store.snapshots).toEqual([1]);
  });
});
