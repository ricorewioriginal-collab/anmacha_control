// Geräte koppeln (docs/architecture/NETWORK.md „Server hinzufügen“):
// Am PC/Server wird ein Kopplungscode erzeugt (6 Ziffern, 5 Minuten, einmalig). Das Handy bzw. ein weiterer PC
// löst ihn ein und bekommt ein eigenes Geräte-Token mit festen Rechten, das sich einzeln widerrufen lässt.
// So braucht eine Desktop-Installation kein Benutzerkonto, damit sich die App verbinden kann (behebt AUDIT 5.1).

import { randomInt } from 'node:crypto';
import type { AirDeckApp } from '../app.ts';
import { AppError, type ApiToken, type Principal } from '../model.ts';
import { ROLE_SCOPES, type Role } from '../users.ts';
import { API_VERSION } from '../config.ts';

export const PAIR_TTL_MS = 5 * 60_000;
/** Fehlversuche je Adresse, danach Sperre */
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60_000;
const PAIR_ROLES: readonly Role[] = ['operator', 'dj', 'editor', 'viewer'];

interface Pairing {
  code: string;
  expiresAt: number;
  role: Role;
  stationIds: string[];
  createdBy: string;
}

export interface PairResult {
  token: string;
  device: { id: string; name: string; role: Role; stationIds: string[] };
  server: { name: string; version: string; api: string };
}

export class DeviceService {
  private readonly app: AirDeckApp;
  private readonly pending = new Map<string, Pairing>();
  private readonly fails = new Map<string, { count: number; until: number; first: number }>();

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  /** Kopplungscode erzeugen (nur mit Recht zur Token-Verwaltung). */
  createPairing(p: Principal, input: { role?: string; stationIds?: unknown }): { code: string; expiresAt: string; role: Role; stationIds: string[] } {
    this.cleanup();
    const role = (PAIR_ROLES as readonly string[]).includes(String(input.role)) ? (input.role as Role) : 'operator';
    const wanted = Array.isArray(input.stationIds) ? input.stationIds.map(String).filter((s) => s === '*' || this.app.stations.has(s)) : [];
    // nie mehr Sender freigeben, als die erzeugende Person selbst sehen darf
    const allowed = p.stationIds.includes('*') ? wanted : wanted.filter((s) => p.stationIds.includes(s));
    const stationIds = allowed.length ? allowed : p.stationIds.includes('*') ? ['*'] : p.stationIds;
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    while (this.pending.has(code));
    const pairing: Pairing = { code, expiresAt: Date.now() + PAIR_TTL_MS, role, stationIds, createdBy: p.id };
    this.pending.set(code, pairing);
    this.app.audit.write({ kind: 'device', event: 'pairing_created', actor: p.id, role, stationIds });
    return { code, expiresAt: new Date(pairing.expiresAt).toISOString(), role, stationIds };
  }

  /** Code einlösen (öffentlich, mit Sperre nach wiederholten Fehlversuchen je Adresse). */
  redeem(code: string, input: { name?: unknown; platform?: unknown }, ip: string): PairResult {
    this.cleanup();
    const now = Date.now();
    const f = this.fails.get(ip);
    if (f && f.until > now) throw new AppError(429, 'locked', 'Zu viele falsche Codes – bitte in ein paar Minuten erneut versuchen');
    const clean = String(code ?? '').replace(/\D/g, '');
    const pairing = this.pending.get(clean);
    if (!pairing || pairing.expiresAt < Date.now()) {
      // Fehlversuche zählen innerhalb von 10 Minuten; nach Ablauf einer Sperre beginnt die Zählung neu
      const fresh = !f || f.until > 0 || now - f.first > LOCK_MS;
      const count = (fresh ? 0 : f.count) + 1;
      this.fails.set(ip, { count, until: count >= MAX_FAILS ? now + LOCK_MS : 0, first: fresh ? now : f.first });
      this.app.audit.write({ kind: 'device', event: 'pairing_failed', ip });
      throw new AppError(403, 'invalid_code', 'Kopplungscode ungültig oder abgelaufen – am PC einen neuen Code erzeugen');
    }
    // einmalig
    this.pending.delete(clean);
    this.fails.delete(ip);
    const name = String(input.name ?? '').trim().slice(0, 60) || 'Gerät';
    const platform = ['android', 'windows', 'linux', 'macos', 'web', 'ios'].includes(String(input.platform)) ? String(input.platform) : 'web';
    const { token, info } = this.app.svc.auth.createToken({ name, scopes: ROLE_SCOPES[pairing.role], roles: [pairing.role], stationIds: pairing.stationIds });
    const rec = this.app.svc.auth.tokens.find((t) => t.id === info.id)!;
    rec.device = { platform, pairedAt: new Date().toISOString(), ip };
    this.app.docs.set('tokens', this.app.svc.auth.tokens);
    this.app.audit.write({ kind: 'device', event: 'paired', device: info.id, name, platform, role: pairing.role, by: pairing.createdBy, ip });
    this.app.publish('devices.changed', undefined, { paired: info.id });
    return {
      token,
      device: { id: info.id, name, role: pairing.role, stationIds: pairing.stationIds },
      server: { name: 'AirDeck', version: this.app.version, api: API_VERSION },
    };
  }

  list(): (Omit<ApiToken, 'hash'> & { device: NonNullable<ApiToken['device']> })[] {
    return this.app.svc.auth.listTokens().filter((t): t is Omit<ApiToken, 'hash'> & { device: NonNullable<ApiToken['device']> } => !!t.device);
  }

  revoke(p: Principal, id: string): void {
    if (!this.list().some((d) => d.id === id)) throw new AppError(404, 'not_found', 'Gerät nicht gefunden');
    this.app.svc.auth.revokeToken(id);
    this.app.audit.write({ kind: 'device', event: 'revoked', actor: p.id, device: id });
    this.app.publish('devices.changed', undefined, { revoked: id });
  }

  /** Zuletzt gesehen – höchstens alle 5 Minuten gespeichert, damit nicht jede Anfrage schreibt. */
  seen(t: ApiToken): void {
    if (!t.device) return;
    const now = Date.now();
    if (t.device.lastSeenAt && now - Date.parse(t.device.lastSeenAt) < 5 * 60_000) return;
    t.device.lastSeenAt = new Date(now).toISOString();
    this.app.docs.set('tokens', this.app.svc.auth.tokens);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [c, p] of this.pending) if (p.expiresAt < now) this.pending.delete(c);
    for (const [ip, f] of this.fails) if ((f.until > 0 && f.until < now) || (f.until === 0 && now - f.first > LOCK_MS)) this.fails.delete(ip);
    if (this.fails.size > 5000) this.fails.clear();
  }
}
