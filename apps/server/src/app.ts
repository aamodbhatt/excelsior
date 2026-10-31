import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { type CellPatch, type Op, type WorkbookDoc, emptyWorkbook } from '@excelsior/doc';
import { neuralNetTemplate, transformerTemplate } from '@excelsior/nn2sheet/templates';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { AuthStore, RateLimiter, SESSION_COOKIE, SESSION_TTL_MS, type User } from './auth';
import { canEdit } from './db';
import type { ClientMessage } from './protocol';
import { RoomRegistry } from './rooms';
import { WorkbookStore } from './workbooks';

export interface AppConfig {
  db: DatabaseSync;
  /** Browser origins allowed to make state-changing requests and open WebSockets. */
  origins: string[];
  /** Set the Secure flag on cookies (when served over HTTPS). */
  secureCookies: boolean;
}

type Env = { Variables: { user: User } };

const TEMPLATES: Record<string, () => WorkbookDoc> = {
  blank: emptyWorkbook,
  'neural-net': neuralNetTemplate,
  transformer: transformerTemplate,
};

const credentials = z.object({
  email: z.email().max(200).toLowerCase(),
  password: z.string().min(8).max(200),
});
const signup = credentials.extend({ name: z.string().trim().min(1).max(60) });
const createBody = z.object({
  title: z.string().trim().min(1).max(120),
  template: z.enum(['blank', 'neural-net', 'transformer']),
});
const clientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('commit'),
    clientOpId: z.string().min(1).max(80),
    ops: z
      .array(z.looseObject({ t: z.string() }))
      .min(1)
      .max(100),
  }),
  z.object({
    type: z.literal('presence'),
    state: z.object({
      sheetId: z.string().max(80),
      selection: z.object({
        r1: z.number().int(),
        c1: z.number().int(),
        r2: z.number().int(),
        c2: z.number().int(),
      }),
      editing: z.boolean(),
    }),
  }),
]);

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: 'Expected a JSON body' });
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new HTTPException(400, {
      message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    });
  return parsed.data;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Ops that turn the current document back into `old` (cells, settings, formats and iteration state). */
function restoreOps(current: WorkbookDoc, old: WorkbookDoc): Op[] {
  const ops: Op[] = [];
  for (const sheet of old.sheets) {
    const now = current.sheets.find((s) => s.id === sheet.id);
    if (!now) continue;
    const cells: Record<string, CellPatch> = {};
    for (const addr of new Set([...Object.keys(now.cells), ...Object.keys(sheet.cells)])) {
      const a = now.cells[addr];
      const b = sheet.cells[addr];
      if (a?.v !== b?.v || JSON.stringify(a?.s) !== JSON.stringify(b?.s))
        cells[addr] = { v: b?.v ?? null, s: b?.s ?? null };
    }
    if (Object.keys(cells).length) ops.push({ t: 'cells', sheet: sheet.id, cells });
    ops.push(
      { t: 'condFormats', sheet: sheet.id, rules: sheet.condFormats },
      { t: 'charts', sheet: sheet.id, charts: sheet.charts },
    );
  }
  ops.push({ t: 'calc', calc: old.calc }, { t: 'iterationState', state: old.iterationState });
  return ops;
}

/** Builds the HTTP API plus a function that attaches the collaboration WebSocket to a Node server. */
export function createApp(config: AppConfig) {
  const auth = new AuthStore(config.db);
  const store = new WorkbookStore(config.db);
  const rooms = new RoomRegistry(store);
  const loginLimiter = new RateLimiter(10, 60_000);
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // CSRF defence in depth: SameSite=Lax cookies, plus every state-changing request must come from an
  // allowed origin (browsers always send Origin on cross-site POSTs) and carry a JSON body.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      if (origin ? !config.origins.includes(origin) : site !== undefined && site !== 'same-origin') {
        throw new HTTPException(403, { message: 'Cross-site request blocked' });
      }
      const type = c.req.header('content-type') ?? '';
      if (c.req.method !== 'DELETE' && !type.startsWith('application/json')) {
        throw new HTTPException(415, { message: 'Requests must be application/json' });
      }
    }
    await next();
  });

  const startSession = (c: Context, user: User) => {
    setCookie(c, SESSION_COOKIE, auth.createSession(user.id), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.secureCookies,
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
  };

  app.post('/api/auth/signup', async (c) => {
    const { email, name, password } = await body(c, signup);
    const user = await auth.createUser(email, name, password);
    if (!user) throw new HTTPException(409, { message: 'An account with that email already exists' });
    startSession(c, user);
    return c.json({ user }, 201);
  });

  app.post('/api/auth/login', async (c) => {
    const { email, password } = await body(c, credentials);
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    if (!loginLimiter.allow(`${email}|${ip}`))
      throw new HTTPException(429, { message: 'Too many attempts; try again in a minute' });
    const user = await auth.authenticate(email, password);
    if (!user) throw new HTTPException(401, { message: 'Wrong email or password' });
    startSession(c, user);
    return c.json({ user });
  });

  app.post('/api/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) auth.deleteSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Everything below requires a session.
  app.use('/api/*', async (c, next) => {
    const user = auth.userForSession(getCookie(c, SESSION_COOKIE));
    if (!user) throw new HTTPException(401, { message: 'Sign in required' });
    c.set('user', user);
    await next();
  });

  const requireRole = (c: Context<Env>, write: boolean) => {
    const meta = store.meta(c.req.param('id')!, c.get('user').id);
    if (!meta) throw new HTTPException(404, { message: 'Workbook not found' });
    if (write && !canEdit(meta.role)) throw new HTTPException(403, { message: 'You have view-only access' });
    return meta;
  };

  app.get('/api/auth/me', (c) => c.json({ user: c.get('user') }));

  app.get('/api/workbooks', (c) => c.json({ workbooks: store.list(c.get('user').id) }));

  app.post('/api/workbooks', async (c) => {
    const { title, template } = await body(c, createBody);
    const id = store.create(c.get('user').id, title, TEMPLATES[template]());
    return c.json({ id }, 201);
  });

  app.get('/api/workbooks/:id', (c) => c.json({ workbook: requireRole(c, false) }));

  app.patch('/api/workbooks/:id', async (c) => {
    requireRole(c, true);
    const { title } = await body(c, z.object({ title: z.string().trim().min(1).max(120) }));
    store.rename(c.req.param('id'), title);
    return c.json({ ok: true });
  });

  app.delete('/api/workbooks/:id', (c) => {
    const meta = requireRole(c, true);
    if (meta.role !== 'owner')
      throw new HTTPException(403, { message: 'Only the owner can delete a workbook' });
    // Stop the live room first so no commit or snapshot can target the rows we are about to delete.
    rooms.close(meta.id, 'deleted');
    store.delete(meta.id);
    return c.json({ ok: true });
  });

  app.post('/api/workbooks/:id/shares', async (c) => {
    const meta = requireRole(c, true);
    const { role } = await body(c, z.object({ role: z.enum(['editor', 'viewer']) }));
    return c.json({ token: store.createShare(meta.id, role) }, 201);
  });

  app.post('/api/shares/:token/accept', (c) => {
    const id = store.acceptShare(c.req.param('token'), c.get('user').id);
    if (!id) throw new HTTPException(404, { message: 'This share link is invalid' });
    return c.json({ workbookId: id });
  });

  app.get('/api/workbooks/:id/versions', (c) => {
    const meta = requireRole(c, false);
    return c.json({ current: meta.version, versions: store.versions(meta.id) });
  });

  app.get('/api/workbooks/:id/versions/:version', (c) => {
    const meta = requireRole(c, false);
    const v = Number(c.req.param('version'));
    if (!Number.isInteger(v) || v < 0 || v > meta.version)
      throw new HTTPException(400, { message: 'Unknown version' });
    return c.json(store.docAt(meta.id, v));
  });

  app.post('/api/workbooks/:id/restore', async (c) => {
    const meta = requireRole(c, true);
    const { version } = await body(c, z.object({ version: z.number().int().min(0) }));
    const old = store.docAt(meta.id, version);
    const room = rooms.get(meta.id);
    if (!old || !room) throw new HTTPException(404, { message: 'Unknown version' });
    // Diff against the room's in-memory document: it is the latest sequenced state, including commits
    // that arrived after this request started.
    const error = room.commit(
      { id: `restore-${crypto.randomUUID()}`, user: c.get('user'), role: meta.role },
      crypto.randomUUID(),
      restoreOps(room.current, old.doc),
    );
    rooms.release(meta.id);
    if (error) throw new HTTPException(400, { message: error });
    return c.json({ ok: true });
  });

  let wss: WebSocketServer | null = null;

  /** Upgrades /api/workbooks/:id/live?client=<key> to the collaboration socket. */
  const attachWebSocket = (server: Server) => {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    wss = sockets;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = /^\/api\/workbooks\/([\w-]+)\/live$/.exec(url.pathname);
      const reject = (code: number, text: string) => {
        socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      if (!match) return reject(404, 'Not Found');
      // Cross-site WebSocket hijacking: browsers send Origin on upgrades and cookies ride along.
      if (req.headers.origin && !config.origins.includes(req.headers.origin)) return reject(403, 'Forbidden');
      const user = auth.userForSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (!user) return reject(401, 'Unauthorized');
      const meta = store.meta(match[1], user.id);
      const room = meta && rooms.get(meta.id);
      if (!meta || !room) return reject(404, 'Not Found');
      const key = url.searchParams.get('client') ?? undefined;
      sockets.handleUpgrade(req, socket, head, (ws) => {
        const clientId = room.join(
          user,
          meta.role,
          { send: (m) => ws.send(JSON.stringify(m)), close: (code, reason) => ws.close(code, reason) },
          key && /^[\w-]{8,64}$/.test(key) ? key : undefined,
        );
        if (clientId === null) {
          // The room shut down between the lookup and the upgrade (e.g. the workbook was just deleted).
          ws.close(4404, 'deleted');
          return;
        }
        ws.on('message', (data) => {
          let msg: ClientMessage;
          try {
            const parsed = clientMessage.safeParse(JSON.parse(String(data)));
            if (!parsed.success) return;
            msg = parsed.data as ClientMessage;
          } catch {
            return;
          }
          try {
            room.handle(clientId, msg);
          } catch (e) {
            // One bad message must not take down the process (and every other open workbook).
            console.error(`workbook ${meta.id}: failed to handle a message`, e);
            ws.close(1011, 'internal error');
          }
        });
        ws.on('close', () => {
          room.leave(clientId);
          rooms.release(meta.id);
        });
      });
    });
    return sockets;
  };

  /**
   * Graceful stop: snapshot and disconnect every live room, then stop accepting sockets. Call it before
   * closing the HTTP server and the database so that no handler runs against a closed store.
   */
  const shutdown = () => {
    rooms.closeAll();
    for (const ws of wss?.clients ?? []) ws.terminate();
    wss?.close();
  };

  return { app, attachWebSocket, shutdown };
}
