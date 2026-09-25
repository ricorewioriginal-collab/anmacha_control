// Öffentlicher Stream-Status (wie Icecast status-json) für alle Sendewege, mit kurzem Zwischenspeicher.

import type { AirDeckApp } from '../app.ts';
import { AppError } from '../model.ts';
import { PUBLIC_API } from '../lautfm.ts';
import { lautfmStatus, listenUrlOf, type StreamStatus } from '../status.ts';
import type { ExternalNow } from '../bridge.ts';

export class StatusService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  readonly statusCache = new Map<string, { at: number; data: Promise<StreamStatus> }>();

  readonly startedAt = new Date().toISOString();

  cached(key: string, ttlMs: number, fn: () => Promise<StreamStatus>): Promise<StreamStatus> {
    const hit = this.statusCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    const data = fn();
    this.statusCache.set(key, { at: Date.now(), data });
    data.catch(() => this.statusCache.delete(key));
    if (this.statusCache.size > 200) this.statusCache.delete(this.statusCache.keys().next().value!);
    return data;
  }

  /** Zwischenspeicher eines Senders verwerfen (z. B. nach gemeldetem Now Playing). */
  invalidate(stationId: string): void {
    for (const k of [...this.statusCache.keys()]) if (k.startsWith(`a:${stationId}:`)) this.statusCache.delete(k);
  }

  /** Öffentliche Senderliste für die Statusseite. */
  publicStations(): { id: string; name: string; lautfm?: string }[] {
    return [...this.app.stations.values()].filter((r) => r.station.publicStatus !== false).map((r) => ({ id: r.station.id, name: r.station.name, ...(r.data.lautfm?.stationName ? { lautfm: r.data.lautfm.stationName } : {}) }));
  }

  /** Status eines AirDeck-Senders: aktive Quelle, verbundene Ausgänge, laut.fm (falls verbunden), Now Playing, Verlauf. */
  streamStatus(stationId: string, host: string): Promise<StreamStatus> {
    const rt = this.app.stations.get(stationId);
    if (!rt || rt.station.publicStatus === false) return Promise.reject(new AppError(404, 'not_found', 'Sender nicht gefunden oder nicht öffentlich'));
    return this.cached(`a:${stationId}:${host}`, 5000, async () => {
      const lib = new Map(rt.data.library.map((m) => [m.id, m]));
      const m = rt.nowPlaying.mediaId ? lib.get(rt.nowPlaying.mediaId) : undefined;
      const active = this.app.engine.list(stationId).find((s) => s.state === 'active');
      const fmt = rt.data.playout?.format ?? 'mp3';
      const type = fmt === 'opus' ? 'application/ogg' : fmt === 'aac' ? 'audio/aac' : 'audio/mpeg';
      const title = m ? (m.artist ? `${m.artist} - ${m.title}` : m.title) : '';
      const sources: StreamStatus['icestats']['source'] = [];
      for (const o of this.app.outputs.values()) {
        if (o.cfg.stationId !== stationId || !o.cfg.enabled || o.state.status !== 'connected') continue;
        if (/(^|\.)laut\.fm$/i.test(o.cfg.host) && rt.data.lautfm?.stationName) continue; // kommt unten mit echten laut.fm-Daten
        sources.push({
          kind: o.cfg.type === 'shoutcast' ? 'shoutcast' : 'icecast', listenurl: listenUrlOf(o.cfg), server_name: rt.station.name, server_description: rt.station.slogan,
          server_type: o.state.contentType ?? type, genre: rt.station.genre, bitrate: o.cfg.bitrateKbps ?? rt.data.playout?.bitrateKbps ?? null,
          listeners: o.state.listeners ?? null, title, artist: m?.artist, stream_start_iso8601: o.state.connectedAt ? new Date(o.state.connectedAt).toISOString() : null,
        });
      }
      let laut: StreamStatus | null = null;
      if (rt.data.lautfm?.stationName) laut = await this.lautfmPublicStatus(rt.data.lautfm.stationName).catch(() => null);
      if (laut) sources.push(...laut.icestats.source);
      // Gespiegelte Systeme (AzuraCast/Icecast) und per Bridge-API gemeldete Streams
      let ext: ExternalNow | undefined;
      for (const b of rt.data.bridges ?? []) {
        const d = b.mirror ? this.app.svc.bridges.bridgeStatus.get(b.id)?.data : undefined;
        if (!d) continue;
        ext ??= d;
        for (const u of d.listenUrls.slice(0, 3)) {
          sources.push({ kind: b.kind === 'azuracast' ? 'azuracast' : 'icecast', listenurl: u, server_name: d.name, server_type: d.format ? (d.format.includes('/') ? d.format : `audio/${d.format}`) : 'audio/mpeg',
            bitrate: d.bitrate ?? null, listeners: d.listeners, title: d.now ? (d.now.artist ? `${d.now.artist} - ${d.now.title}` : d.now.title) : '', artist: d.now?.artist, stream_start_iso8601: d.now?.started_at ?? null, genre: rt.station.genre });
        }
      }
      const pushed = this.app.svc.bridges.externalNow.get(stationId);
      if (pushed && Date.now() - pushed.at < 6 * 3600_000) {
        ext = pushed;
        for (const u of pushed.listenUrls) sources.push({ kind: 'extern', listenurl: u, server_name: rt.station.name, server_type: 'audio/mpeg', listeners: pushed.listeners, title: pushed.now ? (pushed.now.artist ? `${pushed.now.artist} - ${pushed.now.title}` : pushed.now.title) : '', artist: pushed.now?.artist, stream_start_iso8601: pushed.now?.started_at ?? null });
      }
      const log = (rt.data.playLog ?? []).filter((e) => e.category === 'music').slice(0, 10);
      return {
        kind: 'airdeck', station: stationId, name: rt.station.name, description: rt.station.slogan,
        icestats: { admin: '', host, location: 'AirDeck', server_id: `AirDeck ${this.app.updater.current}`, server_start_iso8601: this.startedAt, source: sources },
        now: m ? { artist: m.artist, title: m.title, album: m.album, started_at: rt.nowPlaying.startedAt ? new Date(rt.nowPlaying.startedAt).toISOString() : null,
          ends_at: rt.nowPlaying.startedAt && m.durationMs ? new Date(rt.nowPlaying.startedAt + m.durationMs - (m.cueInMs ?? 0)).toISOString() : null } : ext?.now ?? laut?.now ?? null,
        last_songs: log.length ? log.map((e) => ({ started_at: new Date(e.at).toISOString(), artist: e.artist, title: e.title })) : ext?.history.length ? ext.history : laut?.last_songs ?? [],
        onair: active ? { source: active.name, type: active.type, priority: active.priority } : null,
        links: { ...(laut?.links ?? {}), ...(rt.station.logo ? { logo: `/api/v1/stations/${stationId}/logo` } : {}) },
        updated_at: new Date().toISOString(),
      };
    });
  }

  /** Beliebiger laut.fm-Sender (Name) – Icecast-Status nachgebaut aus der öffentlichen API, 10 s zwischengespeichert. */
  lautfmPublicStatus(name: string): Promise<StreamStatus> {
    return this.cached(`l:${name}`, 10_000, () => lautfmStatus(name, PUBLIC_API));
  }
}
