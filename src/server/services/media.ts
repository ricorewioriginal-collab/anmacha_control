// Medien: Bibliothek, Tags und Laufzeit, Lautheitsanalyse (EBU R128), URL-Streams, M3U, Cover.

import type { AirDeckApp } from '../app.ts';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_CATEGORIES, type MediaItem } from '../../core/automation.ts';
import { parseM3U, toM3U } from '../../core/scheduler.ts';
import { analyzeLoudness, probeMedia } from '../ffmpeg.ts';
import { AppError, newId } from '../model.ts';
import { writeFileAtomic } from '../store.ts';

export class MediaService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  library(stationId: string): MediaItem[] {
    return this.app.rt(stationId).data.library;
  }

  media(stationId: string, id: string): MediaItem {
    const m = this.app.rt(stationId).data.library.find((x) => x.id === id);
    if (!m) throw new AppError(404, 'not_found', 'Medium nicht gefunden');
    return m;
  }

  mediaPath(stationId: string, m: MediaItem): string {
    if (m.url) return m.url;
    return join(this.app.mediaDir, stationId, m.file);
  }

  addMedia(stationId: string, item: MediaItem): MediaItem {
    const rt = this.app.rt(stationId);
    rt.data.library.push(item);
    this.app.publish('library.changed', stationId, { added: item });
    this.app.changed();
    // Laufzeit und ID3-Tags serverseitig lesen (wichtig für Crossfade/Backtiming im Headless-Betrieb)
    const ffprobe = this.app.ffmpeg?.ffprobe;
    if (ffprobe && !item.url) {
      probeMedia(ffprobe, this.mediaPath(stationId, item)).then(({ durationMs, tags }) => {
        if (!rt.data.library.includes(item)) return;
        const patch: Record<string, unknown> = {};
        if (durationMs && item.durationMs == null) patch.durationMs = durationMs;
        if (tags.title) patch.title = tags.title;
        if (tags.artist) patch.artist = tags.artist;
        if (tags.bpm && item.bpm == null) patch.bpm = tags.bpm;
        if (tags.album) item.album = tags.album;
        if (tags.genre) item.genre = tags.genre;
        if (tags.year) item.year = tags.year;
        if (Object.keys(patch).length || tags.album || tags.genre || tags.year) this.updateMedia(stationId, item.id, patch);
      });
    }
    if (!item.url && item.lufs == null) this.queueLoudness(stationId, item.id);
    return item;
  }

  readonly loudQueue: { stationId: string; id: string }[] = [];

  loudBusy = false;

  queueLoudness(stationId: string, id: string): void {
    if (!this.app.ffmpeg || this.loudQueue.some((x) => x.stationId === stationId && x.id === id)) return;
    this.loudQueue.push({ stationId, id });
    void this.runLoudness();
  }

  /** Alle noch nicht gemessenen Titel eines Senders einreihen. */
  analyzeLibrary(stationId: string, force = false): { queued: number } {
    if (!this.app.ffmpeg) throw new AppError(501, 'unsupported', 'Lautheitsanalyse benötigt ffmpeg');
    let queued = 0;
    for (const m of this.app.rt(stationId).data.library) {
      if (m.url || (!force && m.lufs != null)) continue;
      this.queueLoudness(stationId, m.id);
      queued++;
    }
    return { queued };
  }

  loudnessStatus(stationId: string): unknown {
    const lib = this.app.rt(stationId).data.library.filter((m) => !m.url);
    return { total: lib.length, measured: lib.filter((m) => m.lufs != null).length, pending: this.loudQueue.filter((x) => x.stationId === stationId).length, running: this.loudBusy };
  }

  async runLoudness(): Promise<void> {
    if (this.loudBusy || !this.app.ffmpeg) return;
    this.loudBusy = true;
    try {
      for (let job = this.loudQueue.shift(); job; job = this.loudQueue.shift()) {
        const rt = this.app.stations.get(job.stationId);
        const m = rt?.data.library.find((x) => x.id === job!.id);
        if (!m || m.url) continue;
        const r = await analyzeLoudness(this.app.ffmpeg.ffmpeg, this.mediaPath(job.stationId, m));
        if (!r || !rt!.data.library.includes(m)) continue;
        m.lufs = r.lufs;
        m.truePeakDb = r.truePeakDb;
        this.app.publish('library.changed', job.stationId, { updated: m });
        this.app.changed();
      }
    } finally {
      this.loudBusy = false;
    }
  }

  updateMedia(stationId: string, id: string, patch: Record<string, unknown>): MediaItem {
    const m = this.media(stationId, id);
    if (typeof patch.title === 'string') m.title = patch.title.slice(0, 200);
    if (typeof patch.artist === 'string') m.artist = patch.artist.slice(0, 200);
    if (typeof patch.category === 'string' && (MEDIA_CATEGORIES as readonly string[]).includes(patch.category)) m.category = patch.category as MediaItem['category'];
    if (typeof patch.folder === 'string') m.folder = patch.folder.trim().slice(0, 80) || undefined;
    for (const k of ['durationMs', 'cueInMs', 'cueOutMs', 'segueMs', 'introMs', 'bpm', 'gainDb'] as const) {
      const v = patch[k];
      if (v === null && k !== 'durationMs') delete m[k];
      else if (typeof v === 'number' && Number.isFinite(v) && (k === 'gainDb' || v >= 0)) m[k] = v;
    }
    this.app.publish('library.changed', stationId, { updated: m });
    this.app.changed();
    return m;
  }

  removeMedia(stationId: string, id: string): void {
    const rt = this.app.rt(stationId);
    const m = this.media(stationId, id);
    rt.data.library = rt.data.library.filter((x) => x.id !== id);
    rt.queue.prune((mid) => mid !== id);
    for (const c of rt.data.cardwall) if (c.mediaId === id) c.mediaId = null;
    for (const pl of rt.data.playlists ?? []) pl.items = pl.items.filter((x) => x !== id);
    if (!m.url) rmSync(this.mediaPath(stationId, m), { force: true });
    this.app.publish('library.changed', stationId, { removed: id });
    this.app.publishQueue(stationId);
    this.app.changed();
  }

  /** Cover-Bild aus der Audiodatei (eingebettetes Bild), zwischengespeichert. */
  async cover(stationId: string, mediaId: string): Promise<string | null> {
    const m = this.media(stationId, mediaId);
    if (m.url || !this.app.ffmpeg) return null;
    const dir = join(this.app.dataDir, 'covers', stationId);
    const file = join(dir, `${m.id}.jpg`);
    const none = `${file}.none`;
    if (existsSync(file)) return file;
    if (existsSync(none)) return null;
    mkdirSync(dir, { recursive: true });
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(this.app.ffmpeg!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', this.mediaPath(stationId, m), '-an', '-frames:v', '1', '-vf', 'scale=300:300:force_original_aspect_ratio=increase,crop=300:300', file], { windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0 && existsSync(file)));
      setTimeout(() => p.kill(), 15_000).unref();
    });
    if (!ok) {
      rmSync(file, { force: true });
      writeFileAtomic(none, '');
      return null;
    }
    return file;
  }

  folders(stationId: string): string[] {
    return [...new Set(this.app.rt(stationId).data.library.map((m) => m.folder ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  }

  addUrlMedia(stationId: string, input: { url: string; title?: string; artist?: string; durationMs?: number; folder?: string }): MediaItem {
    const url = String(input.url ?? '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new AppError(400, 'invalid_url', 'Nur http(s)-URLs sind erlaubt');
    const existing = this.app.rt(stationId).data.library.find((m) => m.url === url);
    if (existing) return existing;
    const dur = typeof input.durationMs === 'number' && input.durationMs > 0 ? Math.round(input.durationMs) : null;
    return this.addMedia(stationId, {
      id: newId('m'), title: String(input.title || url).slice(0, 200), artist: String(input.artist ?? '').slice(0, 200),
      category: 'stream', file: '', url, durationMs: dur, cueOutMs: dur ?? undefined, addedAt: Date.now(), folder: input.folder,
    });
  }

  exportQueueM3U(stationId: string): string {
    const rt = this.app.rt(stationId);
    const lib = new Map(rt.data.library.map((m) => [m.id, m]));
    return toM3U(rt.queue.list().map((q) => lib.get(q.mediaId)).filter((m): m is MediaItem => !!m).map((m) => ({
      title: m.title, artist: m.artist, durationMs: m.durationMs, path: m.url ?? m.originalName ?? m.file,
    })));
  }

  /** M3U importieren: Einträge werden über Dateiname, "Interpret - Titel" oder URL der Bibliothek zugeordnet. */
  importM3U(stationId: string, text: string, target: { playlistName?: string }): { matched: number; missing: string[]; playlistId?: string } {
    const rt = this.app.rt(stationId);
    const norm = (x: string) => x.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/\s+/g, ' ').trim();
    const byName = new Map<string, MediaItem>();
    for (const m of rt.data.library) {
      if (m.originalName) byName.set(norm(m.originalName), m);
      byName.set(norm(m.artist ? `${m.artist} - ${m.title}` : m.title), m);
      if (m.url) byName.set(m.url.toLowerCase(), m);
    }
    const ids: string[] = [];
    const missing: string[] = [];
    for (const e of parseM3U(text).slice(0, 5000)) {
      const base = e.path.replace(/^.*[\\/]/, '');
      let m = byName.get(e.path.toLowerCase()) ?? byName.get(norm(base)) ?? (e.title ? byName.get(norm(e.title)) : undefined);
      if (!m && /^https?:\/\//i.test(e.path)) m = this.addUrlMedia(stationId, { url: e.path, title: e.title, durationMs: e.durationMs });
      if (m) ids.push(m.id);
      else missing.push(e.title ?? base);
    }
    if (target.playlistName) {
      const pl = this.app.svc.planning.savePlaylist(stationId, null, { name: target.playlistName, items: ids });
      return { matched: ids.length, missing, playlistId: pl.id };
    }
    for (const id of ids) rt.queue.add(id, 'manual');
    this.app.publishQueue(stationId);
    return { matched: ids.length, missing };
  }
}
