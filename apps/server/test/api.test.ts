import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db';
import type { ServerMessage } from '../src/protocol';

const ORIGIN = 'http://localhost:8093';
let base = '';
let server: Server;
let db: DatabaseSync;
let shutdown: () => void;

beforeAll(async () => {
  db = openDatabase(':memory:');
  const created = createApp({
    db,
    origins: [ORIGIN],
    secureCookies: false,
  });
  shutdown = created.shutdown;
  server = serve({ fetch: created.app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  created.attachWebSocket(server);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

// Same order as production: rooms and sockets first, then the HTTP server, then the database.
afterAll(async () => {
  shutdown();
  await new Promise((r) => server.close(r));
  db.close();
});

/** A cookie-jar client that behaves like a same-origin browser tab. */
class Client {
  cookie = '';

  async call(method: string, path: string, json?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: this.cookie, ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
  }

  socket(
    id: string,
  ): Promise<{ ws: WebSocket; messages: ServerMessage[]; next: (type: string) => Promise<ServerMessage> }> {
    const ws = new WebSocket(
      `${base.replace('http', 'ws')}/api/workbooks/${id}/live?client=test-${Math.random().toString(36).slice(2, 10)}`,
      {
        headers: { cookie: this.cookie, origin: ORIGIN },
      },
    );
    const messages: ServerMessage[] = [];
    const waiters: { type: string; resolve: (m: ServerMessage) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      const i = waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else messages.push(m);
    });
    const next = (type: string) =>
      new Promise<ServerMessage>((resolve) => {
        const idx = messages.findIndex((m) => m.type === type);
        if (idx >= 0) resolve(messages.splice(idx, 1)[0]);
        else waiters.push({ type, resolve });
      });
    return new Promise((resolve, reject) => {
      ws.on('open', () => resolve({ ws, messages, next }));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade failed: ${res.statusCode}`)));
    });
  }
}

describe('auth', () => {
  it('signs up, rejects duplicates and wrong passwords, and keeps the session HttpOnly', async () => {
    const a = new Client();
    const res = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', name: 'Ada', password: 'correct horse' }),
    });
    expect(res.status).toBe(201);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    a.cookie = cookie.split(';')[0];
    expect((await a.call('GET', '/api/auth/me')).body.user).toMatchObject({ email: 'ada@example.com' });
    expect(
      (
        await new Client().call('POST', '/api/auth/signup', {
          email: 'ada@example.com',
          name: 'X',
          password: 'whatever1',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await new Client().call('POST', '/api/auth/login', {
          email: 'ada@example.com',
          password: 'wrong-password',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await new Client().call('POST', '/api/auth/login', {
          email: 'ada@example.com',
          password: 'correct horse',
        })
      ).status,
    ).toBe(200);
    expect(
      (await new Client().call('POST', '/api/auth/signup', { email: 'bad', name: 'X', password: 'short' }))
        .status,
    ).toBe(400);
  });

  it('blocks cross-site and non-JSON state-changing requests', async () => {
    const a = new Client();
    await a.call('POST', '/api/auth/signup', {
      email: 'csrf@example.com',
      name: 'C',
      password: 'password123',
    });
    expect(
      (
        await a.call(
          'POST',
          '/api/workbooks',
          { title: 't', template: 'blank' },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await a.call(
          'POST',
          '/api/workbooks',
          { title: 't', template: 'blank' },
          { 'content-type': 'text/plain' },
        )
      ).status,
    ).toBe(415);
    expect((await new Client().call('GET', '/api/workbooks')).status).toBe(401);
  });
});

describe('workbooks, sharing and collaboration', () => {
  it('creates from templates, shares with roles, syncs edits live and restores versions', async () => {
    const owner = new Client();
    await owner.call('POST', '/api/auth/signup', {
      email: 'owner@example.com',
      name: 'Owner',
      password: 'password123',
    });
    const created = await owner.call('POST', '/api/workbooks', { title: 'Spirals', template: 'neural-net' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(((await owner.call('GET', '/api/workbooks')).body.workbooks as unknown[]).length).toBe(1);

    const editor = new Client();
    await editor.call('POST', '/api/auth/signup', {
      email: 'ed@example.com',
      name: 'Ed',
      password: 'password123',
    });
    const viewer = new Client();
    await viewer.call('POST', '/api/auth/signup', {
      email: 'vi@example.com',
      name: 'Vi',
      password: 'password123',
    });
    expect((await editor.call('GET', `/api/workbooks/${id}`)).status).toBe(404);
    const editToken = (await owner.call('POST', `/api/workbooks/${id}/shares`, { role: 'editor' })).body
      .token as string;
    const viewToken = (await owner.call('POST', `/api/workbooks/${id}/shares`, { role: 'viewer' })).body
      .token as string;
    expect((await editor.call('POST', `/api/shares/${editToken}/accept`, {})).body.workbookId).toBe(id);
    await viewer.call('POST', `/api/shares/${viewToken}/accept`, {});

    const a = await owner.socket(id);
    const welcomeA = (await a.next('welcome')) as Extract<ServerMessage, { type: 'welcome' }>;
    expect(welcomeA.doc.sheets.map((s) => s.name)).toEqual(['Train', 'Net']);
    const b = await editor.socket(id);
    await b.next('welcome');
    const v = await viewer.socket(id);
    await v.next('welcome');

    a.ws.send(
      JSON.stringify({
        type: 'commit',
        clientOpId: 'op-1',
        ops: [{ t: 'cells', sheet: 'train', cells: { B4: { v: '0.25' } } }],
      }),
    );
    const seenByB = (await b.next('commit')) as Extract<ServerMessage, { type: 'commit' }>;
    expect(seenByB.version).toBe(1);
    expect(seenByB.ops[0]).toMatchObject({ t: 'cells', cells: { B4: { v: '0.25' } } });
    expect(((await a.next('commit')) as { clientOpId: string }).clientOpId).toBe('op-1');

    a.ws.send(
      JSON.stringify({
        type: 'presence',
        state: { sheetId: 'train', selection: { r1: 3, c1: 1, r2: 3, c2: 1 }, editing: false },
      }),
    );
    expect(((await b.next('presence')) as Extract<ServerMessage, { type: 'presence' }>).peer.name).toBe(
      'Owner',
    );

    v.ws.send(
      JSON.stringify({
        type: 'commit',
        clientOpId: 'v-1',
        ops: [{ t: 'cells', sheet: 'train', cells: { A1: { v: 'x' } } }],
      }),
    );
    expect(((await v.next('reject')) as { error: string }).error).toMatch(/view-only/);

    b.ws.send(
      JSON.stringify({ type: 'commit', clientOpId: 'bad', ops: [{ t: 'cells', sheet: 'nope', cells: {} }] }),
    );
    expect(((await b.next('reject')) as { error: string }).error).toMatch(/Unknown sheet/);

    const history = await owner.call('GET', `/api/workbooks/${id}/versions`);
    expect(history.body.current).toBe(1);
    const at0 = await owner.call('GET', `/api/workbooks/${id}/versions/0`);
    expect(
      (at0.body.doc as { sheets: { cells: Record<string, { v?: string }> }[] }).sheets[0].cells.B4.v,
    ).toBe('1');
    expect((await owner.call('POST', `/api/workbooks/${id}/restore`, { version: 0 })).status).toBe(200);
    const restored = (await b.next('commit')) as Extract<ServerMessage, { type: 'commit' }>;
    expect(restored.version).toBe(2);
    for (const s of [a, b, v]) s.ws.close();
    expect((await viewer.call('DELETE', `/api/workbooks/${id}`)).status).toBe(403);
    expect((await owner.call('DELETE', `/api/workbooks/${id}`)).status).toBe(200);
  });

  it('rejects a whole multi-op commit when one op is invalid', async () => {
    const u = new Client();
    await u.call('POST', '/api/auth/signup', {
      email: 'atomic@example.com',
      name: 'At',
      password: 'password123',
    });
    const id = (await u.call('POST', '/api/workbooks', { title: 'a', template: 'blank' })).body.id as string;
    const s = await u.socket(id);
    await s.next('welcome');
    s.ws.send(
      JSON.stringify({
        type: 'commit',
        clientOpId: 'multi',
        ops: [
          { t: 'cells', sheet: 's1', cells: { A1: { v: '1' } } },
          { t: 'cells', sheet: 'missing', cells: { A1: { v: '2' } } },
        ],
      }),
    );
    expect(((await s.next('reject')) as { error: string }).error).toMatch(/Unknown sheet/);
    s.ws.send(
      JSON.stringify({
        type: 'commit',
        clientOpId: 'single',
        ops: [{ t: 'cells', sheet: 's1', cells: { B1: { v: '7' } } }],
      }),
    );
    expect(((await s.next('commit')) as { version: number }).version).toBe(1);
    const latest = await u.call('GET', `/api/workbooks/${id}/versions/1`);
    const cells = (latest.body.doc as { sheets: { cells: Record<string, { v?: string }> }[] }).sheets[0]
      .cells;
    expect(cells.A1).toBeUndefined();
    expect(cells.B1.v).toBe('7');
    s.ws.close();
  });

  it('deleting a workbook disconnects its live clients and stops all writes to it', async () => {
    const owner = new Client();
    await owner.call('POST', '/api/auth/signup', {
      email: 'del@example.com',
      name: 'Del',
      password: 'password123',
    });
    const id = (await owner.call('POST', '/api/workbooks', { title: 'd', template: 'blank' })).body
      .id as string;
    const s = await owner.socket(id);
    await s.next('welcome');
    const closed = new Promise<number>((resolve) => s.ws.on('close', (code) => resolve(code)));
    expect((await owner.call('DELETE', `/api/workbooks/${id}`)).status).toBe(200);
    expect(await s.next('closed')).toEqual({ type: 'closed', reason: 'deleted' });
    expect(await closed).toBe(4404);
    // Reconnecting to a deleted workbook is refused at the upgrade, and nothing is left in the database.
    await expect(owner.socket(id)).rejects.toThrow('404');
    for (const table of ['ops', 'snapshots', 'members', 'shares']) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workbook_id = ?`).get(id) as {
        n: number;
      };
      expect(row.n).toBe(0);
    }
  });

  it('refuses WebSocket upgrades from other origins or without a session', async () => {
    const u = new Client();
    await u.call('POST', '/api/auth/signup', { email: 'ws@example.com', name: 'W', password: 'password123' });
    const id = (await u.call('POST', '/api/workbooks', { title: 'b', template: 'blank' })).body.id as string;
    const evil = new WebSocket(`${base.replace('http', 'ws')}/api/workbooks/${id}/live`, {
      headers: { cookie: u.cookie, origin: 'https://evil.example' },
    });
    await expect(
      new Promise((res, rej) => {
        evil.on('open', res);
        evil.on('unexpected-response', (_q, r) => rej(new Error(String(r.statusCode))));
      }),
    ).rejects.toThrow('403');
    const anon = new WebSocket(`${base.replace('http', 'ws')}/api/workbooks/${id}/live`, {
      headers: { origin: ORIGIN },
    });
    await expect(
      new Promise((res, rej) => {
        anon.on('open', res);
        anon.on('unexpected-response', (_q, r) => rej(new Error(String(r.statusCode))));
      }),
    ).rejects.toThrow('401');
  });
});
