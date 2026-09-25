// Brücke zu bestehenden Systemen (AzuraCast, Icecast, Streams) und Bridge-API für Entwickler (externe Schlüssel → Sender).

import type { AirDeckApp } from '../app.ts';
import { AppError, newId, type BridgeConfig, type Principal, type Station } from '../model.ts';
import { PullRelay, fetchAzuracast, fetchIcecastMount, type ExternalNow } from '../bridge.ts';

export class BridgeService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  readonly bridgeStatus = new Map<string, { at: number; data?: ExternalNow; error?: string; busy?: boolean }>();

  readonly pulls = new Map<string, PullRelay>();

  /** Von außen gemeldetes Now Playing (Bridge-API), pro Sender */
  readonly externalNow = new Map<string, ExternalNow & { at: number }>();

  bridges(stationId: string): unknown[] {
    return (this.app.rt(stationId).data.bridges ?? []).map((b) => ({
      ...b, hasKey: this.app.secrets.has(`bridge:${b.id}`),
      status: this.bridgeStatus.get(b.id) ?? null,
      relay: this.pulls.has(b.id) ? { state: this.pulls.get(b.id)!.state, error: this.pulls.get(b.id)!.lastError, bytes: this.pulls.get(b.id)!.bytes } : null,
    }));
  }

  saveBridge(p: Principal, stationId: string, id: string | null, input: Record<string, any>): unknown {
    const rt = this.app.rt(stationId);
    const list = (rt.data.bridges ??= []);
    const cur = id ? list.find((b) => b.id === id) : undefined;
    if (id && !cur) throw new AppError(404, 'not_found', 'Anbindung nicht gefunden');
    if (input.remove === true && cur) {
      this.stopPull(cur.id);
      if (cur.sourceId && this.app.engine.get(cur.sourceId)) this.app.removeSource(p, stationId, cur.sourceId);
      rt.data.bridges = list.filter((b) => b !== cur);
      this.app.secrets.delete(`bridge:${cur.id}`);
      this.bridgeStatus.delete(cur.id);
      this.app.changed();
      return { removed: true };
    }
    const kind = ['azuracast', 'icecast', 'stream'].includes(input.kind) ? input.kind : cur?.kind ?? 'stream';
    const url = String(input.url ?? cur?.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new AppError(400, 'invalid_url', 'Adresse mit http(s):// angeben');
    const pullUrl = typeof input.pullUrl === 'string' ? input.pullUrl.trim() : cur?.pullUrl ?? '';
    if (pullUrl && !/^https?:\/\/[^\s]+$/.test(pullUrl)) throw new AppError(400, 'invalid_url', 'Stream-Adresse mit http(s):// angeben');
    const b: BridgeConfig = {
      id: cur?.id ?? newId('br'),
      name: String(input.name ?? cur?.name ?? kind).trim().slice(0, 60) || kind,
      kind, url,
      station: typeof input.station === 'string' ? input.station.trim().slice(0, 80) || undefined : cur?.station,
      mirror: typeof input.mirror === 'boolean' ? input.mirror : cur?.mirror ?? kind !== 'stream',
      pull: typeof input.pull === 'boolean' ? input.pull : cur?.pull ?? kind === 'stream',
      pullUrl: pullUrl || undefined,
      sourceId: cur?.sourceId,
      priority: Number.isInteger(input.priority) && input.priority > 0 && input.priority < 1000 ? input.priority : cur?.priority ?? 20,
    };
    if (kind === 'azuracast' && !b.station) throw new AppError(400, 'invalid_station', 'AzuraCast: Kurzname oder ID des Senders angeben');
    if (kind === 'icecast' && !b.station) b.station = '/stream';
    if (typeof input.apiKey === 'string') {
      if (input.apiKey) this.app.secrets.set(`bridge:${b.id}`, input.apiKey.trim());
      else this.app.secrets.delete(`bridge:${b.id}`);
    }
    // Relay-Quelle anlegen/aktualisieren (Typ url_stream, eigene Priorität)
    if (b.pull) {
      const existing = b.sourceId ? this.app.engine.get(b.sourceId) : undefined;
      if (!existing) {
        const src = this.app.addSource(p, stationId, { name: `Relay: ${b.name}`, type: 'url_stream', target: '/live', priority: b.priority, takeoverPolicy: 'auto', allowedRoles: ['operator'] }) as { id: string };
        b.sourceId = src.id;
      } else if (existing.priority !== b.priority || existing.name !== `Relay: ${b.name}`) {
        this.app.updateSource(p, stationId, existing.id, { priority: b.priority, name: `Relay: ${b.name}` });
      }
    }
    if (cur) Object.assign(cur, b);
    else list.push(b);
    this.app.audit.write({ kind: 'bridge', event: cur ? 'updated' : 'created', actor: p.id, stationId, bridge: b.id, bridgeKind: b.kind, pull: b.pull, mirror: b.mirror });
    this.app.changed();
    this.stopPull(b.id);
    if (b.pull) void this.startPull(stationId, b);
    if (b.mirror) void this.pollBridge(stationId, b, true);
    return this.bridges(stationId).find((x) => (x as { id: string }).id === b.id);
  }

  stopPull(id: string): void {
    this.pulls.get(id)?.stop();
    this.pulls.delete(id);
  }

  /** Relay starten: Stream-URL explizit, sonst aus dem gespiegelten Status (AzuraCast-Mount/Icecast-Mount). */
  async startPull(stationId: string, b: BridgeConfig): Promise<void> {
    let url = b.kind === 'stream' ? b.url : b.pullUrl;
    if (!url) {
      const s = await this.pollBridge(stationId, b, true);
      url = s?.listenUrls[0];
    }
    const src = b.sourceId ? this.app.engine.list(stationId).find((x) => x.id === b.sourceId) : undefined;
    if (!url || !src || !(this.app.rt(stationId).data.bridges ?? []).includes(b)) {
      if (!url) this.app.audit.write({ kind: 'bridge', event: 'relay_no_url', stationId, bridge: b.id });
      return;
    }
    const relay = new PullRelay(url, {
      open: (type) => {
        try {
          this.app.ingestOpen(src, type);
        } catch (err) {
          this.app.audit.write({ kind: 'bridge', event: 'relay_rejected', stationId, bridge: b.id, message: (err as Error).message });
        }
      },
      data: (chunk) => this.app.ingestData(src, chunk),
      close: () => this.app.ingestClose(src),
      log: (event, data) => this.app.audit.write({ kind: 'bridge', event, stationId, bridge: b.id, ...data }),
    });
    this.pulls.set(b.id, relay);
    relay.start();
  }

  /** Status einer Anbindung abfragen (mit Zwischenspeicher, nie parallel). */
  async pollBridge(stationId: string, b: BridgeConfig, force = false): Promise<ExternalNow | undefined> {
    const st = this.bridgeStatus.get(b.id) ?? { at: 0 };
    if (st.busy || (!force && Date.now() - st.at < 15_000)) return st.data;
    st.busy = true;
    this.bridgeStatus.set(b.id, st);
    try {
      const key = this.app.secrets.get(`bridge:${b.id}`);
      if (b.kind === 'azuracast') st.data = await fetchAzuracast(b.url, b.station!, key);
      else if (b.kind === 'icecast') st.data = await fetchIcecastMount(b.url, b.station ?? '/stream');
      else return undefined;
      st.error = undefined;
      this.app.publish('bridge.status', stationId, { id: b.id, ...st.data });
    } catch (err) {
      st.error = (err as Error).message;
    } finally {
      st.at = Date.now();
      st.busy = false;
    }
    return st.data;
  }

  startBridges(): void {
    for (const [id, rt] of this.app.stations) for (const b of rt.data.bridges ?? []) if (b.pull) void this.startPull(id, b);
  }

  tickBridges(): void {
    for (const [id, rt] of this.app.stations) for (const b of rt.data.bridges ?? []) if (b.mirror && b.kind !== 'stream') void this.pollBridge(id, b);
  }

  bridgeMap(): Record<string, string> {
    return { ...this.app.docs.get<Record<string, string>>('bridge-keys', {}) };
  }

  /** Sender über einen externen Schlüssel anlegen oder aktualisieren – derselbe Schlüssel ergibt immer denselben Sender. */
  bridgeUpsertStation(key: string, input: Record<string, unknown>): { station: Station; created: boolean } {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/.test(key)) throw new AppError(400, 'invalid_key', 'Schlüssel: Buchstaben, Ziffern und : . _ - (max. 120)');
    const map = this.bridgeMap();
    const known = map[key];
    if (known && this.app.stations.has(known)) return { station: this.app.updateStation(known, input as Partial<Station>), created: false };
    const base = (typeof input.id === 'string' && input.id ? input.id : key).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'sender';
    let sid = base;
    for (let i = 2; this.app.stations.has(sid); i++) sid = `${base}-${i}`;
    const station = this.app.createStation({ id: sid, name: String(input.name ?? key).slice(0, 80), slogan: typeof input.slogan === 'string' ? input.slogan : undefined, primaryColor: input.primaryColor as string, accentColor: input.accentColor as string }, input.withDefaultSources !== false);
    if (typeof input.genre === 'string') this.app.updateStation(sid, { genre: input.genre });
    map[key] = sid;
    this.app.docs.set('bridge-keys', map);
    this.app.audit.write({ kind: 'bridge', event: 'station_created', key, stationId: sid });
    return { station, created: true };
  }

  bridgeStation(key: string): string {
    const sid = this.bridgeMap()[key];
    if (!sid || !this.app.stations.has(sid)) throw new AppError(404, 'not_found', 'Kein Sender zu diesem Schlüssel');
    return sid;
  }

  bridgeMappings(): Record<string, string> {
    return this.bridgeMap();
  }

  /** Now Playing von einem fremden System melden (z. B. eigene Automation, SAM, mAirList, RadioDJ per Skript). */
  bridgeNowPlaying(key: string, input: Record<string, unknown>): unknown {
    const sid = this.bridgeStation(key);
    const artist = String(input.artist ?? '').slice(0, 200);
    const title = String(input.title ?? '').slice(0, 200);
    if (!title) throw new AppError(400, 'invalid', 'Titel fehlt');
    const started = typeof input.startedAt === 'string' && !Number.isNaN(Date.parse(input.startedAt)) ? new Date(input.startedAt).toISOString() : new Date().toISOString();
    const dur = typeof input.durationMs === 'number' && input.durationMs > 0 ? input.durationMs : null;
    const prev = this.externalNow.get(sid);
    const history = prev?.now ? [{ started_at: prev.now.started_at ?? undefined, artist: prev.now.artist, title: prev.now.title }, ...prev.history].slice(0, 10) : prev?.history ?? [];
    const ext: ExternalNow & { at: number } = {
      at: Date.now(), name: this.app.rt(sid).station.name, listeners: typeof input.listeners === 'number' ? input.listeners : prev?.listeners ?? null,
      listenUrls: Array.isArray(input.listenUrls) ? input.listenUrls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 5) : prev?.listenUrls ?? [],
      now: { artist, title, album: typeof input.album === 'string' ? input.album : undefined, started_at: started, ends_at: dur ? new Date(Date.parse(started) + dur).toISOString() : null },
      history, live: null,
    };
    this.externalNow.set(sid, ext);
    this.app.svc.status.invalidate(sid);
    // Titelanzeige an die eigenen Ausgänge, Ereignis für Studio/Webhooks
    const song = artist ? `${artist} - ${title}` : title;
    for (const o of this.app.outputs.values()) if (o.cfg.stationId === sid) o.updateMetadata(song);
    this.app.publish('now_playing.external', sid, ext);
    return { stationId: sid, now: ext.now };
  }
}
