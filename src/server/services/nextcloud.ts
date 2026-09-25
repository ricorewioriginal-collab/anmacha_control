// Nextcloud-Brücke: Medien per WebDAV durchsuchen und übernehmen, Mitschnitte hochladen.

import type { AirDeckApp } from '../app.ts';
import { extname, join } from 'node:path';
import { MEDIA_CATEGORIES, parseFileName, type MediaItem } from '../../core/automation.ts';
import { AUDIO_FILE_RE, AppError, newId } from '../model.ts';
import { Nextcloud, NextcloudError, cleanPath, type NextcloudConfig } from '../nextcloud.ts';

export class NextcloudService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  nextcloudConfig(): (NextcloudConfig & { hasPassword: boolean }) | { configured: false } {
    const c = this.app.docs.get<NextcloudConfig | null>('nextcloud', null);
    return c ? { ...c, hasPassword: this.app.secrets.has('nextcloud:password') } : { configured: false };
  }

  setNextcloud(input: Record<string, unknown>): unknown {
    if (input.remove === true) {
      // Einstellung liegt in der Datenbank (vorher nextcloud.json – das Löschen der Datei wirkte nicht mehr)
      this.app.docs.set('nextcloud', null);
      this.app.secrets.delete('nextcloud:password');
      return { configured: false };
    }
    const url = String(input.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(url)) throw new AppError(400, 'invalid_url', 'Nextcloud-Adresse mit https:// angeben');
    const user = String(input.user ?? '').trim();
    if (!user) throw new AppError(400, 'invalid_user', 'Benutzername fehlt');
    let root: string;
    try {
      root = cleanPath(String(input.root ?? '/'));
    } catch {
      throw new AppError(400, 'invalid_path', 'Ungültiger Startordner');
    }
    if (typeof input.password === 'string' && input.password) this.app.secrets.set('nextcloud:password', input.password.trim());
    if (!this.app.secrets.has('nextcloud:password')) throw new AppError(400, 'no_password', 'App-Passwort fehlt (Nextcloud → Einstellungen → Sicherheit → App-Passwort)');
    this.app.docs.set('nextcloud', { url, user, root });
    this.app.audit.write({ kind: 'nextcloud', event: 'config', url, user });
    return this.nextcloudConfig();
  }

  nc(): { client: Nextcloud; root: string } {
    const c = this.app.docs.get<NextcloudConfig | null>('nextcloud', null);
    const pw = this.app.secrets.get('nextcloud:password');
    if (!c || !pw) throw new AppError(409, 'not_configured', 'Nextcloud ist noch nicht eingerichtet');
    return { client: new Nextcloud(c, pw), root: c.root };
  }

  ncCall<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err) => {
      if (err instanceof NextcloudError) throw new AppError(err.status === 401 ? 502 : err.status, 'nextcloud', err.message);
      throw err;
    });
  }

  /** Ordner in der Nextcloud (relativ zum Startordner). */
  async nextcloudList(path: string): Promise<unknown> {
    const { client, root } = this.nc();
    const rel = cleanPath(path);
    const entries = await this.ncCall(() => client.list(cleanPath(`${root}/${rel}`)));
    return {
      path: rel,
      entries: entries.map((e) => ({ ...e, path: cleanPath(e.path.slice(root === '/' ? 0 : root.length)), audio: !e.dir && AUDIO_FILE_RE.test(e.name) })),
    };
  }

  /** Dateien/Ordner (rekursiv, max. 500 Dateien) in die Bibliothek übernehmen. */
  async nextcloudImport(stationId: string, paths: string[], opts: { category?: string; folder?: string }): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const { client, root } = this.nc();
    const rt = this.app.rt(stationId);
    const category = (MEDIA_CATEGORIES as readonly string[]).includes(String(opts.category)) ? (opts.category as MediaItem['category']) : 'music';
    const files: { path: string; name: string; folder: string }[] = [];
    const walk = async (rel: string, folder: string, depth: number): Promise<void> => {
      const list = await this.ncCall(() => client.list(cleanPath(`${root}/${rel}`)));
      for (const e of list) {
        if (files.length >= 500) return;
        const r = cleanPath(`${rel}/${e.name}`);
        if (e.dir && depth < 4) await walk(r, folder ? `${folder} / ${e.name}` : e.name, depth + 1);
        else if (!e.dir && AUDIO_FILE_RE.test(e.name)) files.push({ path: r, name: e.name, folder });
      }
    };
    for (const p of paths.slice(0, 200)) {
      const rel = cleanPath(p);
      const name = rel.split('/').pop() ?? '';
      if (AUDIO_FILE_RE.test(name)) files.push({ path: rel, name, folder: opts.folder ?? '' });
      else await walk(rel, opts.folder || name, 0);
    }
    const errors: string[] = [];
    let imported = 0;
    let skipped = 0;
    for (const f of files) {
      // bereits übernommene Datei (gleicher Nextcloud-Pfad) nicht doppelt laden
      if (rt.data.library.some((m) => m.source === `nextcloud:${f.path}`)) {
        skipped++;
        continue;
      }
      const id = newId('m');
      const ext = extname(f.name).toLowerCase();
      const file = `${id}${ext}`;
      try {
        await this.ncCall(() => client.download(cleanPath(`${root}/${f.path}`), join(this.app.mediaDir, stationId, file), 500 * 1024 * 1024));
        const meta = parseFileName(f.name);
        this.app.addMedia(stationId, { id, title: meta.title || f.name, artist: meta.artist, category, file, durationMs: null, addedAt: Date.now(), folder: f.folder.slice(0, 80) || undefined, originalName: f.name, source: `nextcloud:${f.path}` });
        imported++;
      } catch (err) {
        errors.push(`${f.name}: ${(err as Error).message}`);
      }
    }
    this.app.audit.write({ kind: 'nextcloud', event: 'import', stationId, imported, skipped, errors: errors.length });
    return { imported, skipped, errors: errors.slice(0, 20) };
  }

  /** Mitschnitt in die Nextcloud hochladen. */
  async nextcloudUploadRecording(stationId: string, recId: string, targetDir: string): Promise<unknown> {
    const { client, root } = this.nc();
    const { path, rec } = this.app.svc.recorder.recordingFile(stationId, recId);
    const ext = rec.contentType.includes('ogg') ? 'ogg' : rec.contentType.includes('aac') ? 'aac' : rec.contentType.includes('webm') ? 'webm' : 'mp3';
    const name = `${new Date(rec.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')} ${rec.label}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    const target = cleanPath(`${root}/${targetDir || 'AirDeck-Mitschnitte'}/${name}.${ext}`);
    await this.ncCall(() => client.upload(path, target, rec.contentType));
    this.app.audit.write({ kind: 'nextcloud', event: 'upload', stationId, recId });
    return { uploaded: target };
  }
}
