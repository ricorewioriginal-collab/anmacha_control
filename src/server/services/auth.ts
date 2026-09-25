// Anmeldung: API-Tokens (nur als Hash gespeichert), Desktop-Token, Prüfung von Token und Benutzersitzungen.

import type { AirDeckApp } from '../app.ts';
import { randomBytes } from 'node:crypto';
import { ALL_SCOPES, AppError, hashToken, newId, type ApiToken, type Principal } from '../model.ts';
import { UserStore } from '../users.ts';

export class AuthService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  private loaded: ApiToken[] | null = null;

  /** erst beim ersten Zugriff laden – die Datenhaltung steht beim Anlegen der Dienste noch nicht bereit */
  get tokens(): ApiToken[] {
    return (this.loaded ??= this.app.docs.get<ApiToken[]>('tokens', []));
  }

  set tokens(v: ApiToken[]) {
    this.loaded = v;
  }

  hasTokens(): boolean {
    return this.tokens.length > 0;
  }

  createToken(input: { name: string; scopes: string[]; roles: string[]; stationIds: string[] }): { token: string; info: Omit<ApiToken, 'hash'> } {
    const scopes = input.scopes.includes('*') ? ['*'] : input.scopes.filter((s) => (ALL_SCOPES as readonly string[]).includes(s));
    const token = `ad_${randomBytes(24).toString('base64url')}`;
    const rec: ApiToken = {
      id: newId('tok'),
      name: input.name.slice(0, 80) || 'token',
      hash: hashToken(token),
      scopes,
      roles: input.roles.slice(0, 10),
      stationIds: input.stationIds.length ? input.stationIds : ['*'],
      createdAt: new Date().toISOString(),
    };
    this.tokens.push(rec);
    this.app.docs.set('tokens', this.tokens);
    const { hash: _hash, ...info } = rec;
    return { token, info };
  }

  /**
   * Token für das lokale Desktop-Programm (Windows): verschlüsselt im Secret Store,
   * damit das Studio-Fenster ohne Eingabe startet. Wird bei Widerruf neu erzeugt.
   */
  desktopToken(): string {
    const saved = this.app.secrets.get('desktop:token');
    if (saved && this.authenticate(saved)) return saved;
    const { token } = this.createToken({ name: 'desktop', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
    this.app.secrets.set('desktop:token', token);
    return token;
  }

  listTokens(): Omit<ApiToken, 'hash'>[] {
    return this.tokens.map(({ hash: _hash, ...t }) => t);
  }

  revokeToken(id: string): void {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length === before) throw new AppError(404, 'not_found', 'Token nicht gefunden');
    this.app.docs.set('tokens', this.tokens);
  }

  authenticate(token: string | undefined): Principal | null {
    if (!token) return null;
    const h = hashToken(token);
    const t = this.tokens.find((x) => x.hash === h);
    if (t) {
      this.app.svc.devices.seen(t);
      return { id: t.id, tokenId: t.id, roles: t.roles, stationIds: t.stationIds, scopes: t.scopes };
    }
    const u = this.app.users.session(token);
    if (!u) return null;
    return {
      id: u.id, tokenId: `session:${u.id}`, roles: u.roles, stationIds: u.stationIds, scopes: UserStore.scopesFor(u.roles),
      user: { id: u.id, username: u.username, name: u.name, ...(u.mustChangePassword ? { mustChangePassword: true } : {}) },
    };
  }
}
