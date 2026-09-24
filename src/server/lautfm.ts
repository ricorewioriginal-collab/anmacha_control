// laut.fm-Anbindung (optionaler Adapter):
//  • Radioadmin-API (https://api.radioadmin.laut.fm, Bearer-Token des Nutzers) – Playlists, Titel,
//    Sendeplan, Statistik, Benutzer, Station, Live-Zugang. Nur dokumentierte Endpunkte (radioadmin-api-spec).
//  • Öffentliche API (https://api.laut.fm) – current_song, last_songs, listeners (ohne Login).
// AirDeck leitet Anfragen serverseitig weiter: der Token bleibt verschlüsselt lokal und erreicht nie den Browser.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export const RADIOADMIN = 'https://api.radioadmin.laut.fm';
export const PUBLIC_API = 'https://api.laut.fm';

export interface LautfmConfig {
  /** Numerische Station-ID im Radioadmin */
  stationId?: number;
  /** Stationsname (URL-Name, z. B. "80er-radio") für die öffentliche API */
  stationName?: string;
}

/**
 * Erlaubte Radioadmin-Pfade: nur die eigene Station bzw. Listen/Status.
 * `;incomplete` / `;queued` sind Teil der offiziellen Pfade.
 */
export function allowedRadioadminPath(path: string, stationId: number | undefined): boolean {
  if (!/^\/[A-Za-z0-9_\-/;,.]*$/.test(path) || path.includes('..')) return false;
  if (path === '/stations' || path === '/server_status') return true;
  if (/^\/automation_algorithms\/[A-Za-z0-9_-]+$/.test(path)) return true;
  if (stationId === undefined) return false;
  return path === `/stations/${stationId}` || path.startsWith(`/stations/${stationId}/`);
}

export function allowedPublicPath(path: string): boolean {
  return /^\/(station\/[a-z0-9_-]+(\/(current_song|last_songs|listeners|playlists|schedule|next_artists))?|listeners|stations(\/names)?)$/i.test(path);
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie']);

/** Leitet eine Anfrage an laut.fm weiter und streamt die Antwort zurück (inkl. Uploads). */
export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  token: string | undefined,
  timeoutMs = 60_000,
): Promise<void> {
  const method = req.method ?? 'GET';
  const headers: Record<string, string> = { Accept: String(req.headers.accept ?? 'application/json'), 'User-Agent': 'AirDeck/0.3' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type']);
  // DELETE kann laut Spezifikation einen Body haben (z. B. Tags entfernen)
  const hasBody = !['GET', 'HEAD'].includes(method) && (!!req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      duplex: hasBody ? 'half' : undefined,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const out: Record<string, string> = { 'Cache-Control': 'no-store' };
    r.headers.forEach((v, k) => {
      if (!HOP.has(k.toLowerCase())) out[k] = v;
    });
    res.writeHead(r.status, out);
    if (!r.body) return void res.end();
    await new Promise<void>((ok) => {
      Readable.fromWeb(r.body as never).on('error', () => ok()).pipe(res).on('finish', ok).on('close', ok);
    });
  } catch (err) {
    if (!res.headersSent) {
      const aborted = (err as Error).name === 'AbortError';
      res.writeHead(aborted ? 504 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: aborted ? 'timeout' : 'upstream_unreachable', message: aborted ? 'laut.fm antwortet nicht' : 'laut.fm nicht erreichbar' }));
    } else res.destroy();
  } finally {
    clearTimeout(timer);
  }
}
