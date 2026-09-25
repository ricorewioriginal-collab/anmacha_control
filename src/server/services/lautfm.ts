// laut.fm: Zugang (Radioadmin-Token, Origin), Radioadmin-Anfragen, Live-Zugang als Ausgang übernehmen.

import type { AirDeckApp } from '../app.ts';
import { AppError, type Principal } from '../model.ts';
import { DEFAULT_ORIGIN, ORIGIN_RE, RADIOADMIN, loginUrl, type LautfmConfig } from '../lautfm.ts';

export class LautfmService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  lautfmConfig(stationId: string): LautfmConfig & { origin: string; hasToken: boolean; loginUrl: string } {
    const cfg = this.app.rt(stationId).data.lautfm ?? {};
    const origin = cfg.origin ?? DEFAULT_ORIGIN;
    return { ...cfg, origin, hasToken: this.app.secrets.has(`lautfm:${stationId}`), loginUrl: loginUrl(origin) };
  }

  lautfmToken(stationId: string): string | undefined {
    return this.app.secrets.get(`lautfm:${stationId}`);
  }

  setLautfmConfig(p: Principal, stationId: string, input: Record<string, unknown>): unknown {
    const rt = this.app.rt(stationId);
    const cfg: LautfmConfig = { ...rt.data.lautfm };
    if (input.stationId !== undefined) {
      const n = Number(input.stationId);
      cfg.stationId = input.stationId === null || input.stationId === '' ? undefined : Number.isSafeInteger(n) && n > 0 ? n : cfg.stationId;
    }
    if (typeof input.origin === 'string') {
      const o = input.origin.trim();
      if (o && !ORIGIN_RE.test(o)) throw new AppError(400, 'invalid_origin', 'Callback/Origin: nur Buchstaben, Ziffern und . _ : / -');
      cfg.origin = o && o !== DEFAULT_ORIGIN ? o : undefined;
    }
    if (typeof input.stationName === 'string') cfg.stationName = input.stationName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || undefined;
    if (typeof input.token === 'string') {
      if (input.token) this.app.secrets.set(`lautfm:${stationId}`, input.token.trim());
      else this.app.secrets.delete(`lautfm:${stationId}`);
    }
    rt.data.lautfm = cfg;
    this.app.audit.write({ kind: 'lautfm', event: 'config', actor: p.id, stationId, token: typeof input.token === 'string' ? (input.token ? 'set' : 'removed') : 'unchanged' });
    this.app.changed();
    return this.lautfmConfig(stationId);
  }

  /** Radioadmin-Anfrage mit gespeichertem Token (serverseitig). */
  async radioadmin(stationId: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const token = this.lautfmToken(stationId);
    if (!token) throw new AppError(409, 'no_token', 'Kein laut.fm-Radioadmin-Token hinterlegt');
    const r = await fetch(RADIOADMIN + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Origin: this.lautfmConfig(stationId).origin, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw new AppError(502, 'upstream_unreachable', 'laut.fm nicht erreichbar');
    });
    const text = await r.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Text-Antwort (z. B. Passwort)
    }
    return { status: r.status, data };
  }

  /**
   * Live-Zugang der laut.fm-Station als AirDeck-Ausgang übernehmen (Icecast-Source mit optionalem ?prio=).
   * Nutzt GET /stations/{id}/live und ggf. /live/password aus der Radioadmin-API.
   */
  async lautfmCreateOutput(p: Principal, stationId: string, priority?: number): Promise<unknown> {
    const cfg = this.lautfmConfig(stationId);
    if (!cfg.stationId) throw new AppError(409, 'no_station', 'Zuerst die laut.fm-Station wählen');
    const live = await this.radioadmin(stationId, 'GET', `/stations/${cfg.stationId}/live`);
    if (live.status !== 200 || typeof live.data !== 'object' || !live.data) throw new AppError(live.status === 403 ? 403 : 502, 'lautfm_error', `laut.fm antwortete ${live.status}`);
    const d = live.data as { protocol?: string; server?: string; port?: number; mountpoint?: string; user?: string; password?: string; bitrate?: number };
    let password = d.password;
    if (!password) {
      const pw = await this.radioadmin(stationId, 'GET', `/stations/${cfg.stationId}/live/password`);
      if (pw.status === 200 && typeof pw.data === 'string') password = pw.data;
    }
    if (!d.server || !d.mountpoint || !password) throw new AppError(502, 'lautfm_incomplete', 'laut.fm lieferte keine vollständigen Live-Zugangsdaten');
    return this.app.saveOutput(p, stationId, null, {
      name: `laut.fm ${cfg.stationName ?? cfg.stationId}`, type: 'icecast', host: d.server, port: d.port ?? (d.protocol === 'https' ? 443 : 80),
      tls: d.protocol === 'https', mount: d.mountpoint, username: d.user ?? 'source', password, priority, sourceTarget: '/live',
    });
  }
}
