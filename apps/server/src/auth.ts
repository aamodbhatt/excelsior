import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LEN = 64;
export const SESSION_COOKIE = 'excelsior_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Hashes a password as `scrypt$N$r$p$salt$hash` (base64url), so parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join(
    '$',
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, , , , saltText, keyText] = stored.split('$');
  if (algo !== 'scrypt' || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(saltText, 'base64url'));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface User {
  id: string;
  email: string;
  name: string;
}

/** User and session storage. Only SHA-256 hashes of session tokens are stored. */
export class AuthStore {
  constructor(private readonly db: DatabaseSync) {}

  async createUser(email: string, name: string, password: string): Promise<User | null> {
    const exists = this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    if (exists) return null;
    const user: User = { id: randomUUID(), email, name };
    const hash = await hashPassword(password);
    this.db
      .prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, email, name, hash, Date.now());
    return user;
  }

  async authenticate(email: string, password: string): Promise<User | null> {
    const row = this.db
      .prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
      .get(email) as { id: string; email: string; name: string; password_hash: string } | undefined;
    // Hash even when the user is missing so response time does not reveal which emails exist.
    const ok = await verifyPassword(password, row?.password_hash ?? 'scrypt$0$0$0$AAAA$AAAA');
    return row && ok ? { id: row.id, email: row.email, name: row.name } : null;
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, Date.now() + SESSION_TTL_MS);
    return token;
  }

  userForSession(token: string | undefined): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        'SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      )
      .get(hashToken(token)) as { id: string; email: string; name: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, email: row.email, name: row.name };
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
}

/** Fixed-window limiter for login attempts, keyed by email and client address. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }
}
