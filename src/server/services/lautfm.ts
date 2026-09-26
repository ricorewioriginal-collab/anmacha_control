// laut.fm: Zugang (Radioadmin-Token, Origin), Radioadmin-Anfragen, Live-Zugang als Ausgang übernehmen.

import type { AirDeckApp } from '../app.ts';
import { AppError, SLUG, type Principal } from '../model.ts';
import { DEFAULT_ORIGIN, ORIGIN_RE, RADIOADMIN, TOKEN_RE, cleanToken, detectOrigin, loginUrl, type LautfmConfig, type RaStation } from '../lautfm.ts';

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

  /**
   * Verbinden: Token prüfen und dabei den passenden Origin selbst ermitteln.
   * laut.fm akzeptiert ein Token nur mit dem Origin, für den es ausgestellt wurde – beim Login über
   * die Webseite ist das die Adresse des Studios, bei einem Skript-Token der Name aus „callback_url=“.
   * Wer das nicht genau weiß, soll trotzdem verbinden können: AirDeck probiert die Kandidaten durch.
   */
  async connect(p: Principal, stationId: string, input: { token?: unknown; origin?: unknown; pageOrigin?: unknown }): Promise<unknown> {
    const token = input.token === undefined ? this.lautfmToken(stationId) : cleanToken(input.token);
    if (!token) throw new AppError(400, 'no_token', 'Bitte ein laut.fm-Token eingeben');
    if (!TOKEN_RE.test(token)) throw new AppError(400, 'invalid_token', 'Das sieht nicht wie ein laut.fm-Token aus (lange Zeichenfolge ohne Leerzeichen)');
    const cfg = this.app.rt(stationId).data.lautfm ?? {};
    const found = await detectOrigin(token, [input.origin, input.pageOrigin, cfg.origin, DEFAULT_ORIGIN, 'anmacha_dashboard']);
    if (!found.stations) {
      const why = found.unreachable ? 'laut.fm ist gerade nicht erreichbar – bitte später erneut versuchen.' : 'laut.fm hat das Token abgelehnt. Prüfe es unter radioadmin.laut.fm/tokens (gültig, nicht widerrufen) und gib ggf. den Namen aus „callback_url=“ als Origin an.';
      throw new AppError(found.unreachable ? 502 : 400, found.unreachable ? 'upstream_unreachable' : 'token_rejected', why);
    }
    const stations = found.stations;
    const keep = stations.find((s) => s.id === cfg.stationId);
    const pick = keep ?? (stations.length === 1 ? stations[0] : stations.find((s) => s.role === 'owner'));
    this.app.secrets.set(`lautfm:${stationId}`, token);
    const origin = found.origin === DEFAULT_ORIGIN ? undefined : found.origin;
    const next: LautfmConfig = { ...cfg, origin, stationId: pick?.id, stationName: pick?.name ?? cfg.stationName };
    this.app.rt(stationId).data.lautfm = next;
    this.app.audit.write({ kind: 'lautfm', event: 'connect', actor: p.id, stationId, origin: found.origin, stations: stations.length });
    // Weitere Sender desselben laut.fm-Kontos, die noch keinem AirDeck-Sender zugeordnet sind, automatisch
    // als eigene AirDeck-Sender anlegen ("Meine Sender" oben zeigt sie dann direkt mit an) - nur für globale
    // Admins, sonst könnte die anlegende Person die neuen Sender hinterher gar nicht sehen/verwalten.
    if (p.stationIds.includes('*')) this.autoCreateStations(p, stations, token, origin, pick?.id);
    this.app.changed();
    return { ...this.lautfmConfig(stationId), stations };
  }

  /** Eindeutige Sender-ID aus einem laut.fm-Namen ableiten (a-z0-9-, ggf. -2/-3 … bei Kollision). */
  private uniqueStationId(name: string): string {
    const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'lautfm';
    let id = base;
    let n = 2;
    while (!SLUG.test(id) || this.app.stations.has(id)) id = `${base}-${n++}`.slice(0, 40);
    return id;
  }

  /** Sender des verbundenen laut.fm-Kontos, die noch an keinem AirDeck-Sender hängen, neu anlegen und verknüpfen. */
  private autoCreateStations(p: Principal, stations: RaStation[], token: string, origin: string | undefined, skipId: number | undefined): void {
    const linked = new Set([...this.app.stations.values()].map((r) => r.data.lautfm?.stationId).filter((x): x is number => x !== undefined));
    for (const s of stations) {
      if (s.id === skipId || linked.has(s.id)) continue;
      const id = this.uniqueStationId(s.displayName || s.name);
      this.app.svc.stations.createStation({ id, name: s.displayName || s.name || `laut.fm ${s.id}` }, true);
      this.app.secrets.set(`lautfm:${id}`, token);
      this.app.rt(id).data.lautfm = { origin, stationId: s.id, stationName: s.name };
      this.app.audit.write({ kind: 'lautfm', event: 'auto_created', actor: p.id, stationId: id, lautfmStationId: s.id });
      linked.add(s.id);
    }
  }

  /** Verbindung prüfen; stimmt der gespeicherte Origin nicht mehr, wird er neu ermittelt. */
  async check(stationId: string): Promise<{ ok: boolean; origin?: string; stations?: RaStation[]; message?: string }> {
    const token = this.lautfmToken(stationId);
    if (!token) return { ok: false, message: 'Kein Token hinterlegt' };
    const cfg = this.app.rt(stationId).data.lautfm ?? {};
    const found = await detectOrigin(token, [cfg.origin ?? DEFAULT_ORIGIN, DEFAULT_ORIGIN, 'anmacha_dashboard']);
    if (!found.stations) return { ok: false, message: found.unreachable ? 'laut.fm nicht erreichbar' : 'Token abgelehnt – bitte neu verbinden' };
    if ((cfg.origin ?? DEFAULT_ORIGIN) !== found.origin) {
      this.app.rt(stationId).data.lautfm = { ...cfg, origin: found.origin === DEFAULT_ORIGIN ? undefined : found.origin };
      this.app.changed();
    }
    return { ok: true, origin: found.origin, stations: found.stations };
  }

  /** Radioadmin-Anfrage mit gespeichertem Token (serverseitig). */
  async radioadmin(stationId: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const token = this.lautfmToken(stationId);
    if (!token) throw new AppError(409, 'no_token', 'Kein laut.fm-Radioadmin-Token hinterlegt');
    const send = async (origin: string) => {
      const r = await fetch(RADIOADMIN + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, Origin: origin, Accept: 'application/json', 'User-Agent': 'AirDeck', ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
    };
    const res = await send(this.lautfmConfig(stationId).origin);
    // Abgelehnt? Einmal den Origin neu ermitteln (z. B. Token über anderen Weg erzeugt) und wiederholen
    if (res.status === 401 || res.status === 403) {
      const c = await this.check(stationId);
      if (c.ok && c.origin !== undefined) return send(c.origin);
    }
    return res;
  }

  /** GET /stations/{id}/live (+ ggf. /live/password) mit einem beliebigen Token/Origin abfragen. */
  private async fetchLive(token: string, origin: string, lautfmStationId: number): Promise<{ server: string; port?: number; mountpoint: string; user?: string; password: string; protocol?: string }> {
    const send = async (path: string) => {
      const r = await fetch(RADIOADMIN + path, {
        headers: { Authorization: `Bearer ${token}`, Origin: origin, Accept: 'application/json', 'User-Agent': 'AirDeck' },
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
    };
    const live = await send(`/stations/${lautfmStationId}/live`);
    if (live.status !== 200 || typeof live.data !== 'object' || !live.data) throw new AppError(live.status === 403 ? 403 : 502, 'lautfm_error', `laut.fm antwortete ${live.status}`);
    const d = live.data as { protocol?: string; server?: string; port?: number; mountpoint?: string; user?: string; password?: string };
    let password = d.password;
    if (!password) {
      const pw = await send(`/stations/${lautfmStationId}/live/password`);
      if (pw.status === 200 && typeof pw.data === 'string') password = pw.data;
    }
    if (!d.server || !d.mountpoint || !password) throw new AppError(502, 'lautfm_incomplete', 'laut.fm lieferte keine vollständigen Live-Zugangsdaten');
    return { server: d.server, port: d.port, mountpoint: d.mountpoint, user: d.user, password, protocol: d.protocol };
  }

  /**
   * Live-Zugang der laut.fm-Station als AirDeck-Ausgang übernehmen (Icecast-Source mit optionalem ?prio=).
   * Nur wenn dieser AirDeck-Sender selbst die laut.fm-Station ist (unter „laut.fm“ verbunden).
   */
  async lautfmCreateOutput(p: Principal, stationId: string, priority?: number): Promise<unknown> {
    const cfg = this.lautfmConfig(stationId);
    const token = this.lautfmToken(stationId);
    if (!cfg.stationId || !token) throw new AppError(409, 'no_station', 'Zuerst die laut.fm-Station wählen');
    const d = await this.fetchLive(token, cfg.origin, cfg.stationId);
    return this.app.saveOutput(p, stationId, null, {
      name: `laut.fm ${cfg.stationName ?? cfg.stationId}`, type: 'icecast', host: d.server, port: d.port ?? (d.protocol === 'https' ? 443 : 80),
      tls: d.protocol === 'https', mount: d.mountpoint, username: d.user ?? 'source', password: d.password, priority, sourceTarget: '/live',
    });
  }

  /**
   * Eigener Sender (keine laut.fm-Identität) soll zusätzlich live auf laut.fm zu hören sein: eigenes
   * Token, unabhängig von einer eventuellen „laut.fm“-Verbindung dieses Senders. Ohne lautfmStationId
   * und bei mehreren Sendern im Konto liefert das die Liste zur Auswahl zurück, statt zu raten.
   */
  async connectRelayOutput(p: Principal, stationId: string, input: { token?: unknown; origin?: unknown; pageOrigin?: unknown; lautfmStationId?: unknown; priority?: unknown }): Promise<unknown> {
    const token = cleanToken(input.token);
    if (!token) throw new AppError(400, 'no_token', 'Bitte ein laut.fm-Token eingeben');
    if (!TOKEN_RE.test(token)) throw new AppError(400, 'invalid_token', 'Das sieht nicht wie ein laut.fm-Token aus (lange Zeichenfolge ohne Leerzeichen)');
    const found = await detectOrigin(token, [input.origin, input.pageOrigin, DEFAULT_ORIGIN, 'anmacha_dashboard']);
    if (!found.stations) {
      const why = found.unreachable ? 'laut.fm ist gerade nicht erreichbar – bitte später erneut versuchen.' : 'laut.fm hat das Token abgelehnt. Prüfe es unter radioadmin.laut.fm/tokens.';
      throw new AppError(found.unreachable ? 502 : 400, found.unreachable ? 'upstream_unreachable' : 'token_rejected', why);
    }
    const lautfmStationId = input.lautfmStationId === undefined || input.lautfmStationId === '' ? undefined : Number(input.lautfmStationId);
    const pick = lautfmStationId !== undefined ? found.stations.find((s) => s.id === lautfmStationId) : found.stations.length === 1 ? found.stations[0] : undefined;
    if (!pick) return { stations: found.stations }; // Client soll eine Station wählen lassen
    const priority = input.priority === null || input.priority === '' || input.priority === undefined ? undefined : Number(input.priority);
    const d = await this.fetchLive(token, found.origin, pick.id);
    const out = this.app.saveOutput(p, stationId, null, {
      name: `laut.fm ${pick.displayName || pick.name}`, type: 'icecast', host: d.server, port: d.port ?? (d.protocol === 'https' ? 443 : 80),
      tls: d.protocol === 'https', mount: d.mountpoint, username: d.user ?? 'source', password: d.password, priority, sourceTarget: '/live',
    });
    this.app.audit.write({ kind: 'lautfm', event: 'relay_output_created', actor: p.id, stationId, lautfmStationId: pick.id });
    return out;
  }
}
