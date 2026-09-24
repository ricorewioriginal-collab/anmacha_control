// Nextcloud-Brücke (WebDAV): Medien in der Cloud durchsuchen, in die Bibliothek übernehmen,
// Mitschnitte in die Cloud hochladen. App-Passwort liegt verschlüsselt im Secret-Store.

import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface NextcloudConfig {
  /** Basis-URL, z. B. https://cloud.example.com */
  url: string;
  user: string;
  /** Startordner innerhalb der Dateien, z. B. /Radio */
  root: string;
}

export interface DavEntry {
  name: string;
  /** Pfad relativ zum Benutzer-Dateibaum, beginnt mit / */
  path: string;
  dir: boolean;
  size: number;
  type: string;
  modified: string | null;
}

export class NextcloudError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Pfad normalisieren und gegen Ausbruch (..) sichern. */
export function cleanPath(p: string): string {
  const parts = String(p ?? '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (parts.includes('..')) throw new NextcloudError(400, 'Ungültiger Pfad');
  return '/' + parts.join('/');
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** PROPFIND-Antwort (Multistatus) ohne XML-Bibliothek lesen; Namespace-Präfixe beliebig. */
export function parseMultistatus(xml: string, davBase: string): DavEntry[] {
  const out: DavEntry[] = [];
  const tag = (block: string, name: string) => new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'i').exec(block)?.[1]?.trim() ?? '';
  const baseDecoded = decodeURIComponent(new URL(davBase, 'http://x').pathname).replace(/\/+$/, '');
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const block = m[1]!;
    const href = decodeURIComponent(tag(block, 'href').replace(/&amp;/g, '&'));
    const hrefPath = href.startsWith('http') ? new URL(href).pathname : href;
    if (!hrefPath.startsWith(baseDecoded)) continue;
    const rel = cleanPath(hrefPath.slice(baseDecoded.length));
    const rt = /<(?:[\w-]+:)?resourcetype\b[^>]*\/>|<(?:[\w-]+:)?resourcetype\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?resourcetype>/i.exec(block)?.[0] ?? '';
    const dir = /collection/i.test(rt);
    out.push({
      name: rel.split('/').pop() || '/',
      path: rel,
      dir,
      size: Number(tag(block, 'getcontentlength')) || 0,
      type: tag(block, 'getcontenttype'),
      modified: tag(block, 'getlastmodified') || null,
    });
  }
  return out;
}

type Fetch = typeof fetch;

export class Nextcloud {
  private readonly cfg: NextcloudConfig;
  private readonly password: string;
  private readonly fetchFn: Fetch;

  constructor(cfg: NextcloudConfig, password: string, fetchFn: Fetch = fetch) {
    this.cfg = cfg;
    this.password = password;
    this.fetchFn = fetchFn;
  }

  /** WebDAV-Basis des Benutzers (Nextcloud: /remote.php/dav/files/<user>) */
  get davBase(): string {
    return `${this.cfg.url.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(this.cfg.user)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: 'Basic ' + Buffer.from(`${this.cfg.user}:${this.password}`).toString('base64'), 'User-Agent': 'AirDeck-Nextcloud', ...extra };
  }

  private async req(method: string, path: string, init: { headers?: Record<string, string>; body?: RequestInit['body']; timeoutMs?: number; duplex?: 'half' } = {}): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetchFn(this.davBase + enc(cleanPath(path)), {
        method, headers: this.headers(init.headers), body: init.body ?? undefined, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
        ...(init.duplex ? { duplex: init.duplex } : {}),
      } as RequestInit);
    } catch (err) {
      throw new NextcloudError(502, `Nextcloud nicht erreichbar: ${(err as Error).message}`);
    }
    if (r.status === 401) throw new NextcloudError(401, 'Nextcloud-Anmeldung fehlgeschlagen (Benutzer/App-Passwort prüfen)');
    if (r.status === 404) throw new NextcloudError(404, 'Pfad in der Nextcloud nicht gefunden');
    if (!r.ok && r.status !== 207) throw new NextcloudError(502, `Nextcloud antwortete ${r.status}`);
    return r;
  }

  /** Ordnerinhalt (Depth 1), Ordner zuerst, alphabetisch. */
  async list(path: string): Promise<DavEntry[]> {
    const p = cleanPath(path);
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/></d:prop></d:propfind>';
    const r = await this.req('PROPFIND', p, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body });
    const all = parseMultistatus(await r.text(), this.davBase);
    return all.filter((e) => e.path !== p).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'de'));
  }

  /** Datei herunterladen (Größenlimit), gibt Bytes zurück. */
  async download(path: string, target: string, maxBytes: number): Promise<number> {
    const r = await this.req('GET', path, { timeoutMs: 15 * 60_000 });
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new NextcloudError(413, 'Datei zu groß');
    let size = 0;
    const body = Readable.fromWeb(r.body as never);
    body.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) body.destroy(new NextcloudError(413, 'Datei zu groß'));
    });
    try {
      await pipeline(body, createWriteStream(target));
    } catch (err) {
      rmSync(target, { force: true });
      throw err instanceof NextcloudError ? err : new NextcloudError(502, `Download abgebrochen: ${(err as Error).message}`);
    }
    return size;
  }

  /** Datei hochladen (z. B. Mitschnitt), legt fehlende Ordner an. */
  async upload(localFile: string, path: string, contentType: string): Promise<void> {
    const p = cleanPath(path);
    const dirs = p.split('/').slice(1, -1);
    for (let i = 1; i <= dirs.length; i++) {
      const d = '/' + dirs.slice(0, i).join('/');
      await this.req('MKCOL', d).catch((e: NextcloudError) => {
        // 405 = existiert bereits
        if (!/405/.test(e.message)) throw e;
      });
    }
    await this.req('PUT', p, {
      headers: { 'Content-Type': contentType, 'Content-Length': String(statSync(localFile).size) },
      body: Readable.toWeb(createReadStream(localFile)) as unknown as RequestInit['body'], duplex: 'half', timeoutMs: 30 * 60_000,
    });
  }
}
