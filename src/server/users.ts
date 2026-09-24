// Benutzerverwaltung für den Eigenbetrieb: Konten mit Rollen und Sender-Zuordnung, Login/Logout mit Sitzungen.
// Passwörter: scrypt mit Salz (nie im Klartext), Sitzungen nur als Hash gespeichert, Sperre nach Fehlversuchen.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readJson, writeFileAtomic } from './store.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const ROLES = ['admin', 'operator', 'editor', 'dj', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Rechte je Rolle (Scopes der REST-API). Mehrere Rollen addieren sich. */
export const ROLE_SCOPES: Record<Role, string[]> = {
  admin: ['*'],
  // Sendeleitung: alles im Sendebetrieb, aber keine Benutzer/Tokens
  operator: ['now_playing:read', 'schedule:read', 'stream:read', 'branding:read', 'queue:read', 'queue:write', 'cardwall:read', 'cardwall:trigger',
    'sources:read', 'sources:write', 'automation:read', 'automation:write', 'media:read', 'media:write', 'stations:write', 'outputs:read', 'outputs:write',
    'audit:read', 'lautfm:read', 'lautfm:write', 'ai:read', 'ai:write'],
  // Redaktion/Musikplanung: Bibliothek, Queue, Planung, KI-Werkzeuge, laut.fm-Playlists – keine Ausgänge/Quellen
  editor: ['now_playing:read', 'schedule:read', 'branding:read', 'queue:read', 'queue:write', 'cardwall:read', 'automation:read', 'media:read', 'media:write',
    'lautfm:read', 'lautfm:write', 'ai:read', 'ai:write', 'sources:read', 'outputs:read'],
  // Moderation: live gehen, Carts, Queue – keine Einstellungen
  dj: ['now_playing:read', 'schedule:read', 'branding:read', 'queue:read', 'queue:write', 'cardwall:read', 'cardwall:trigger', 'sources:read', 'sources:write',
    'automation:read', 'media:read', 'outputs:read'],
  viewer: ['now_playing:read', 'schedule:read', 'stream:read', 'branding:read', 'queue:read', 'cardwall:read', 'sources:read', 'automation:read', 'media:read', 'outputs:read'],
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator (alles)', operator: 'Sendeleitung', editor: 'Redaktion / Musikplanung', dj: 'Moderation / DJ', viewer: 'Nur ansehen',
};

export interface User {
  id: string;
  username: string;
  name: string;
  passwordHash: string;
  roles: Role[];
  /** Sender, die der Benutzer sieht ('*' = alle) */
  stationIds: string[];
  disabled?: boolean;
  mustChangePassword?: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

interface Session {
  hash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  ip?: string;
}

export type PublicUser = Omit<User, 'passwordHash'>;

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SESSION_MS = 12 * 3600_000;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 16384;
  const key = await scrypt(pw, salt, 64, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Mindestanforderung, bewusst einfach verständlich. */
export function checkPassword(pw: string): void {
  if (typeof pw !== 'string' || pw.length < 10) throw new AuthError(400, 'Passwort: mindestens 10 Zeichen');
  if (pw.length > 200) throw new AuthError(400, 'Passwort zu lang');
  if (!/[a-zA-ZäöüÄÖÜß]/.test(pw) || !/[0-9\W_]/.test(pw)) throw new AuthError(400, 'Passwort: Buchstaben und mindestens eine Ziffer oder ein Sonderzeichen');
}

export class UserStore {
  private readonly file: string;
  private readonly sessionsFile: string;
  private users: User[];
  private sessions: Session[];
  private readonly failures = new Map<string, { count: number; until: number }>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'users.json');
    this.sessionsFile = join(dataDir, 'sessions.json');
    this.users = readJson<User[]>(this.file, []);
    this.sessions = readJson<Session[]>(this.sessionsFile, []).filter((s) => s.expiresAt > Date.now());
  }

  private saveUsers(): void {
    writeFileAtomic(this.file, JSON.stringify(this.users, null, 1), 0o600);
  }

  private saveSessions(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.sessions = this.sessions.filter((s) => s.expiresAt > Date.now());
      writeFileAtomic(this.sessionsFile, JSON.stringify(this.sessions), 0o600);
    }, 1000);
    this.saveTimer.unref();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    writeFileAtomic(this.sessionsFile, JSON.stringify(this.sessions.filter((s) => s.expiresAt > Date.now())), 0o600);
  }

  get count(): number {
    return this.users.length;
  }

  list(): PublicUser[] {
    return this.users.map(({ passwordHash: _p, ...u }) => u);
  }

  get(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }

  private cleanRoles(roles: unknown): Role[] {
    const r = (Array.isArray(roles) ? roles : []).filter((x): x is Role => (ROLES as readonly string[]).includes(String(x)));
    return r.length ? [...new Set(r)] : ['viewer'];
  }

  private adminsLeft(except?: string): number {
    return this.users.filter((u) => u.id !== except && !u.disabled && u.roles.includes('admin')).length;
  }

  async create(input: { username: string; name?: string; password: string; roles?: unknown; stationIds?: unknown; mustChangePassword?: boolean }): Promise<PublicUser> {
    const username = String(input.username ?? '').trim().toLowerCase();
    if (!USERNAME.test(username)) throw new AuthError(400, 'Benutzername: 2–40 Zeichen, a–z, 0–9, Punkt, Minus, Unterstrich');
    if (this.users.some((u) => u.username === username)) throw new AuthError(409, 'Benutzername ist vergeben');
    checkPassword(input.password);
    const user: User = {
      id: `usr_${randomBytes(6).toString('hex')}`,
      username,
      name: String(input.name ?? username).trim().slice(0, 80) || username,
      passwordHash: await hashPassword(input.password),
      roles: this.cleanRoles(input.roles),
      stationIds: Array.isArray(input.stationIds) && input.stationIds.length ? input.stationIds.map(String).slice(0, 100) : ['*'],
      mustChangePassword: input.mustChangePassword ?? false,
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    this.saveUsers();
    const { passwordHash: _p, ...pub } = user;
    return pub;
  }

  async update(id: string, patch: { name?: unknown; roles?: unknown; stationIds?: unknown; disabled?: unknown; password?: unknown; mustChangePassword?: unknown }): Promise<PublicUser> {
    const u = this.get(id);
    if (!u) throw new AuthError(404, 'Benutzer nicht gefunden');
    const roles = patch.roles !== undefined ? this.cleanRoles(patch.roles) : u.roles;
    const disabled = typeof patch.disabled === 'boolean' ? patch.disabled : u.disabled;
    if (u.roles.includes('admin') && (!roles.includes('admin') || disabled) && this.adminsLeft(u.id) === 0) throw new AuthError(409, 'Der letzte Administrator kann nicht entzogen oder gesperrt werden');
    if (typeof patch.password === 'string' && patch.password) {
      checkPassword(patch.password);
      u.passwordHash = await hashPassword(patch.password);
      this.revokeUser(u.id);
    }
    if (typeof patch.name === 'string') u.name = patch.name.trim().slice(0, 80) || u.username;
    u.roles = roles;
    if (Array.isArray(patch.stationIds)) u.stationIds = patch.stationIds.length ? patch.stationIds.map(String).slice(0, 100) : ['*'];
    u.disabled = disabled || undefined;
    if (disabled) this.revokeUser(u.id);
    if (typeof patch.mustChangePassword === 'boolean') u.mustChangePassword = patch.mustChangePassword || undefined;
    this.saveUsers();
    const { passwordHash: _p, ...pub } = u;
    return pub;
  }

  remove(id: string): void {
    const u = this.get(id);
    if (!u) throw new AuthError(404, 'Benutzer nicht gefunden');
    if (u.roles.includes('admin') && this.adminsLeft(u.id) === 0) throw new AuthError(409, 'Der letzte Administrator kann nicht gelöscht werden');
    this.users = this.users.filter((x) => x !== u);
    this.revokeUser(id);
    this.saveUsers();
  }

  /** Anmeldung: Sperre nach 5 Fehlversuchen für 15 Minuten (pro Benutzername und IP). */
  async login(usernameRaw: string, password: string, ip = ''): Promise<{ token: string; user: PublicUser; expiresAt: number }> {
    const username = String(usernameRaw ?? '').trim().toLowerCase();
    const key = `${username}|${ip}`;
    const f = this.failures.get(key);
    if (f && f.until > Date.now()) throw new AuthError(429, `Zu viele Fehlversuche – bitte in ${Math.ceil((f.until - Date.now()) / 60_000)} Minuten erneut versuchen`);
    const u = this.users.find((x) => x.username === username);
    // Immer ein Hash-Vergleich, damit die Antwortzeit nichts über existierende Namen verrät
    const ok = await verifyPassword(String(password ?? ''), u?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    if (!u || !ok || u.disabled) {
      // nach Ablauf einer Sperre neu zählen, sonst weiterzählen
      const n = (f && f.until > 0 && f.until <= Date.now() ? 0 : f?.count ?? 0) + 1;
      this.failures.set(key, { count: n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 });
      if (this.failures.size > 5000) this.failures.delete(this.failures.keys().next().value!);
      throw new AuthError(401, u?.disabled && ok ? 'Konto ist gesperrt' : 'Benutzername oder Passwort falsch');
    }
    this.failures.delete(key);
    const token = `as_${randomBytes(32).toString('base64url')}`;
    const expiresAt = Date.now() + SESSION_MS;
    this.sessions.push({ hash: sha(token), userId: u.id, createdAt: Date.now(), expiresAt, ip: ip || undefined });
    u.lastLoginAt = new Date().toISOString();
    this.saveUsers();
    this.saveSessions();
    const { passwordHash: _p, ...pub } = u;
    return { token, user: pub, expiresAt };
  }

  logout(token: string): void {
    const h = sha(token);
    this.sessions = this.sessions.filter((s) => s.hash !== h);
    this.saveSessions();
  }

  revokeUser(userId: string): void {
    this.sessions = this.sessions.filter((s) => s.userId !== userId);
    this.saveSessions();
  }

  /** Sitzung prüfen (gleitend verlängert, solange genutzt). */
  session(token: string): User | null {
    if (!token.startsWith('as_')) return null;
    const h = sha(token);
    const s = this.sessions.find((x) => x.hash === h);
    if (!s || s.expiresAt < Date.now()) return null;
    const u = this.get(s.userId);
    if (!u || u.disabled) return null;
    // höchstens alle 5 Minuten verlängern, damit nicht jede Anfrage schreibt
    if (s.expiresAt - Date.now() < SESSION_MS - 5 * 60_000) {
      s.expiresAt = Date.now() + SESSION_MS;
      this.saveSessions();
    }
    return u;
  }

  static scopesFor(roles: Role[]): string[] {
    if (roles.includes('admin')) return ['*'];
    return [...new Set(roles.flatMap((r) => ROLE_SCOPES[r] ?? []))];
  }
}
