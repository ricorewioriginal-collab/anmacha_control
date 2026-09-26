// Sender verwalten: anlegen (mit Grundausstattung), bearbeiten, Logo, löschen.

import type { AirDeckApp } from '../app.ts';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceConfig } from '../../core/source-priority.ts';
import { AppError, SLUG, canSee, newId, safeColor, type Principal, type Station } from '../model.ts';

export class StationService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  createStation(input: Partial<Station> & { id: string; name: string }, withDefaults = false): Station {
    if (!SLUG.test(input.id)) throw new AppError(400, 'invalid_id', 'Sender-ID: a-z, 0-9, Bindestrich, max. 40 Zeichen');
    if (this.app.stations.has(input.id)) throw new AppError(409, 'exists', 'Sender existiert bereits');
    const station: Station = {
      id: input.id,
      name: input.name.slice(0, 80),
      slogan: (input.slogan ?? '').slice(0, 120),
      primaryColor: safeColor(input.primaryColor, '#19c3e6'),
      accentColor: safeColor(input.accentColor, '#8b5cf6'),
    };
    this.app.mountStation(station);
    if (withDefaults) {
      // Sinnvolle Grundausstattung laut Spezifikation.
      const defaults: Array<[string, SourceConfig['type'], number, SourceConfig['takeoverPolicy']]> = [
        ['Live Studio', 'live_studio', 1, 'auto'],
        ['Remote Studio', 'remote_studio', 2, 'auto'],
        ['Android Live', 'mobile', 3, 'auto'],
        ['AirDeck Automation', 'automation', 10, 'auto'],
      ];
      for (const [name, type, priority, takeoverPolicy] of defaults) {
        this.app.engine.addSource({
          id: newId('src'), stationId: station.id, name, type, target: '/live', priority, takeoverPolicy,
          allowedRoles: ['operator', 'dj'],
        });
      }
    }
    this.app.audit.write({ kind: 'station', event: 'created', stationId: station.id });
    this.app.changed();
    return station;
  }

  updateStation(id: string, patch: Partial<Station>): Station {
    const rt = this.app.rt(id);
    const s = rt.station;
    if (patch.name !== undefined) s.name = String(patch.name).slice(0, 80);
    if (patch.slogan !== undefined) s.slogan = String(patch.slogan).slice(0, 120);
    if (patch.primaryColor !== undefined) s.primaryColor = safeColor(patch.primaryColor, s.primaryColor);
    if (patch.accentColor !== undefined) s.accentColor = safeColor(patch.accentColor, s.accentColor);
    if (typeof patch.publicStatus === 'boolean') s.publicStatus = patch.publicStatus;
    if (typeof patch.genre === 'string') s.genre = patch.genre.slice(0, 80) || undefined;
    this.app.publish('station.changed', id, s);
    this.app.changed();
    return s;
  }

  static readonly LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

  /** Eigenes Senderlogo speichern (PNG/JPG/WebP/GIF, max. 2 MB; SVG bewusst nicht wegen Skripten). */
  setStationLogo(id: string, contentType: string, data: Buffer): Station {
    const s = this.app.rt(id).station;
    const ext = StationService.LOGO_TYPES[contentType.split(';')[0]!.trim().toLowerCase()];
    if (!ext) throw new AppError(415, 'unsupported_media', 'Logo als PNG, JPG, WebP oder GIF hochladen');
    if (data.length > 2 * 1024 * 1024) throw new AppError(413, 'too_large', 'Logo höchstens 2 MB');
    // Signatur prüfen statt dem angegebenen Typ blind zu vertrauen
    const sig = data.subarray(0, 12);
    const ok = { png: sig[0] === 0x89 && sig[1] === 0x50, jpg: sig[0] === 0xff && sig[1] === 0xd8, gif: sig.toString('latin1', 0, 3) === 'GIF', webp: sig.toString('latin1', 8, 12) === 'WEBP' }[ext];
    if (!ok) throw new AppError(415, 'unsupported_media', 'Datei ist kein gültiges Bild');
    const dir = join(this.app.dataDir, 'logos');
    mkdirSync(dir, { recursive: true });
    this.removeLogoFile(id);
    writeFileSync(join(dir, `${id}.${ext}`), data);
    s.logo = `${ext}:${Date.now().toString(36)}`;
    this.app.publish('station.changed', id, s);
    this.app.changed();
    return s;
  }

  removeStationLogo(id: string): Station {
    const s = this.app.rt(id).station;
    this.removeLogoFile(id);
    delete s.logo;
    this.app.publish('station.changed', id, s);
    this.app.changed();
    return s;
  }

  removeLogoFile(id: string): void {
    for (const ext of Object.values(StationService.LOGO_TYPES)) rmSync(join(this.app.dataDir, 'logos', `${id}.${ext}`), { force: true });
  }

  stationLogo(id: string): { path: string; type: string } | null {
    const s = this.app.stations.get(id)?.station;
    if (!s?.logo) return null;
    const ext = s.logo.split(':')[0]!;
    const type = Object.entries(StationService.LOGO_TYPES).find(([, e]) => e === ext)?.[0];
    const path = join(this.app.dataDir, 'logos', `${id}.${ext}`);
    return type && existsSync(path) ? { path, type } : null;
  }

  /** Sender vollständig entfernen (Playout, Aufnahmen, Quellen, Ausgänge, Medien). Der letzte Sender bleibt. */
  deleteStation(p: Principal, id: string): void {
    this.app.rt(id);
    if (this.app.stations.size <= 1) throw new AppError(409, 'last_station', 'Der letzte Sender kann nicht gelöscht werden');
    const pl = this.app.playouts.get(id);
    if (pl) {
      pl.playout.stop();
      this.app.playouts.delete(id);
    }
    if (this.app.svc.recorder.recorders.has(id)) this.app.svc.recorder.stopRecording(id);
    for (const s of this.app.engine.list(id)) this.app.removeSource(p, id, s.id);
    for (const o of [...this.app.outputs.values()]) if (o.cfg.stationId === id) this.app.removeOutput(p, id, o.cfg.id);
    for (const key of [...this.app.relays.keys()]) if (key.startsWith(`${id}/`)) this.app.relays.delete(key);
    this.app.secrets.delete(`lautfm:${id}`);
    this.removeLogoFile(id);
    rmSync(join(this.app.mediaDir, id), { recursive: true, force: true });
    this.app.stations.delete(id);
    this.app.audit.write({ kind: 'station', event: 'deleted', actor: p.id, stationId: id });
    this.app.changed();
  }

  listStations(p: Principal): (Station & { lautfmConnected: boolean })[] {
    return [...this.app.stations.values()].filter((r) => canSee(p, r.station.id)).map((r) => this.withLautfmFlag(r));
  }

  station(id: string): Station & { lautfmConnected: boolean } {
    return this.withLautfmFlag(this.app.rt(id));
  }

  /** Ob der Sender selbst eine laut.fm-Identität hat (Radioadmin verbunden) - steuert z. B. die laut.fm-Navigation im Studio. */
  private withLautfmFlag(r: { station: Station; data: { lautfm?: { stationName?: string } } }): Station & { lautfmConnected: boolean } {
    return { ...r.station, lautfmConnected: !!r.data.lautfm?.stationName };
  }
}
