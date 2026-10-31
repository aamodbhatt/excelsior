import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { openDatabase } from './db';

/** Typed configuration from the environment, with defaults that work for local development. */
const config = {
  port: Number(process.env.PORT ?? 8093),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.EXCELSIOR_DB ?? 'apps/server/var/excelsior.sqlite',
  webDist: process.env.EXCELSIOR_WEB_DIST ?? 'apps/web/dist',
  origins: (
    process.env.EXCELSIOR_ORIGINS ??
    'http://localhost:8093,http://127.0.0.1:8093,http://localhost:5193,http://127.0.0.1:5193'
  )
    .split(',')
    .map((s) => s.trim()),
  secureCookies: process.env.EXCELSIOR_SECURE_COOKIES === '1',
};

if (!Number.isInteger(config.port) || config.port <= 0) throw new Error(`Invalid PORT '${process.env.PORT}'`);

const db = openDatabase(config.dbPath);
const { app, attachWebSocket, shutdown } = createApp({
  db,
  origins: config.origins,
  secureCookies: config.secureCookies,
});

const dist = resolve(config.webDist);
if (existsSync(join(dist, 'index.html'))) {
  const index = readFileSync(join(dist, 'index.html'), 'utf8');
  app.use('/assets/*', serveStatic({ root: config.webDist }));
  app.get('/favicon.svg', serveStatic({ root: config.webDist }));
  // Client-side routes (/, /w/:id, /s/:token, /login) all load the single-page app.
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.notFound() : c.html(index)));
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`excelsior listening on http://${config.host}:${info.port}`);
});
attachWebSocket(server as Server);

// Order matters: rooms snapshot and disconnect first, then the HTTP server stops, and only then does the
// database close, so no request or socket handler can run against a closed store.
let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  shutdown();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
