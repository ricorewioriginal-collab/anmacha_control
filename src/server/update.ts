// Update-Funktion: prüft den Download-Bereich (neuestes GitHub-Release) oder eine eigene Update-Adresse,
// lädt das Windows-Setup, prüft die SHA-256-Prüfsumme und installiert still. Android lädt die neue APK.
// Private Repositories: Zugriffstoken (nur Lesen) wird verschlüsselt im Secret-Store gehalten.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface UpdateSource {
  /** GitHub "owner/repo" oder leer, wenn eine eigene Manifest-URL genutzt wird */
  repo: string;
  tag: string;
  /** Eigene Update-Adresse (JSON-Manifest), optional */
  manifestUrl?: string;
  tokenRef?: string;
}

export interface UpdateAsset {
  name: string;
  size: number;
  /** "sha256:<hex>" (von GitHub geliefert) oder null */
  digest: string | null;
  /** Download-URL (API-URL bei GitHub, damit auch private Repos funktionieren) */
  url: string;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  publishedAt: string | null;
  available: boolean;
  assets: { setup?: UpdateAsset; portable?: UpdateAsset; apk?: UpdateAsset };
  error?: string;
}

export const DEFAULT_SOURCE: UpdateSource = { repo: 'ricorewioriginal-collab/anmacha_control', tag: 'latest' };

/** Releases sind unveränderlich: jeder Build hat ein eigenes Release, „latest“ zeigt auf das neueste.
 *  Der frühere Kanal „nightly“ wird nicht mehr aktualisiert und gilt deshalb ebenfalls als „latest“. */
export function releasePath(tag: string): string {
  return !tag || tag === 'latest' || tag === 'nightly' ? 'releases/latest' : `releases/tags/${encodeURIComponent(tag)}`;
}

/** Build-Kennung aus dem Release-Text ("Automatisch gebaut aus <sha>"). */
export function buildFromBody(body: string | null | undefined): string | null {
  const m = /\b([0-9a-f]{40})\b/.exec(body ?? '');
  return m ? m[1]!.slice(0, 7) : null;
}

export function isNewer(current: string, latest: string | null): boolean {
  if (!latest) return false;
  if (current === 'dev') return false; // Entwicklungsstand wird nie überschrieben
  return !latest.startsWith(current) && !current.startsWith(latest);
}

type Fetch = typeof fetch;

export class Updater {
  readonly current: string;
  private readonly fetchFn: Fetch;
  private cache: { at: number; info: UpdateInfo } | null = null;

  constructor(current: string, fetchFn: Fetch = fetch) {
    this.current = current;
    this.fetchFn = fetchFn;
  }

  private headers(token?: string, accept = 'application/vnd.github+json'): Record<string, string> {
    return { Accept: accept, 'User-Agent': 'AirDeck-Updater', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  async check(src: UpdateSource, token?: string, force = false): Promise<UpdateInfo> {
    if (!force && this.cache && Date.now() - this.cache.at < 10 * 60_000) return this.cache.info;
    const info: UpdateInfo = { current: this.current, latest: null, publishedAt: null, available: false, assets: {} };
    try {
      if (src.manifestUrl) {
        // Eigenes Manifest: { build, publishedAt, assets: { setup: {url,size,sha256}, portable: {...}, apk: {...} } }
        const r = await this.fetchFn(src.manifestUrl, { headers: { 'User-Agent': 'AirDeck-Updater' }, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`Update-Adresse antwortete ${r.status}`);
        const m = (await r.json()) as { build?: string; publishedAt?: string; assets?: Record<string, { url: string; size?: number; sha256?: string }> };
        info.latest = m.build?.slice(0, 7) ?? null;
        info.publishedAt = m.publishedAt ?? null;
        for (const k of ['setup', 'portable', 'apk'] as const) {
          const a = m.assets?.[k];
          if (a?.url) info.assets[k] = { name: k, size: a.size ?? 0, digest: a.sha256 ? `sha256:${a.sha256}` : null, url: a.url };
        }
      } else {
        const r = await this.fetchFn(`https://api.github.com/repos/${src.repo}/${releasePath(src.tag)}`, {
          headers: this.headers(token), signal: AbortSignal.timeout(10_000),
        });
        if (r.status === 404 || r.status === 401) throw new Error('Release nicht erreichbar – bei privatem Repository ein Zugriffstoken unter „Updates“ hinterlegen');
        if (!r.ok) throw new Error(`GitHub antwortete ${r.status}`);
        const rel = (await r.json()) as { body?: string; published_at?: string; assets?: Array<{ name: string; size: number; digest?: string; url: string }> };
        info.latest = buildFromBody(rel.body);
        info.publishedAt = rel.published_at ?? null;
        for (const a of rel.assets ?? []) {
          const asset = { name: a.name, size: a.size, digest: a.digest ?? null, url: a.url };
          if (/Setup.*\.exe$/i.test(a.name)) info.assets.setup = asset;
          else if (/Portable.*\.zip$/i.test(a.name)) info.assets.portable = asset;
          else if (/\.apk$/i.test(a.name)) info.assets.apk = asset;
        }
      }
      info.available = isNewer(this.current, info.latest);
    } catch (err) {
      info.error = (err as Error).message;
    }
    this.cache = { at: Date.now(), info };
    return info;
  }

  /** Datei laden (GitHub-API-Asset oder direkte URL) als Stream. */
  async open(asset: UpdateAsset, token?: string): Promise<Response> {
    const isGithubApi = asset.url.startsWith('https://api.github.com/');
    const r = await this.fetchFn(asset.url, {
      headers: isGithubApi ? this.headers(token, 'application/octet-stream') : { 'User-Agent': 'AirDeck-Updater' },
      redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!r.ok || !r.body) throw new Error(`Download fehlgeschlagen (${r.status})`);
    return r;
  }

  /** Lädt eine Datei, prüft Größe und SHA-256 und gibt den lokalen Pfad zurück. */
  async download(asset: UpdateAsset, token?: string, dir = tmpdir()): Promise<string> {
    const file = join(dir, `airdeck-update-${Date.now()}-${asset.name.replace(/[^\w.-]/g, '_')}`);
    const r = await this.open(asset, token);
    const hash = createHash('sha256');
    let size = 0;
    const body = Readable.fromWeb(r.body as never);
    body.on('data', (d: Buffer) => {
      hash.update(d);
      size += d.length;
    });
    await pipeline(body, createWriteStream(file));
    const hex = hash.digest('hex');
    if (asset.size && size !== asset.size) {
      rmSync(file, { force: true });
      throw new Error('Download unvollständig');
    }
    if (asset.digest && asset.digest !== `sha256:${hex}`) {
      rmSync(file, { force: true });
      throw new Error('Prüfsumme stimmt nicht – Update verworfen');
    }
    return file;
  }

  /** Windows: Setup still starten; es beendet AirDeck, ersetzt die Dateien und startet AirDeck neu. */
  runWindowsSetup(file: string, headless: boolean): void {
    const args = ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/UPDATE=1', ...(headless ? ['/HEADLESSRUN=1'] : [])];
    const p = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    p.unref();
  }
}
