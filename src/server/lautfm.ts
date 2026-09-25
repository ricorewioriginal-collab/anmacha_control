// laut.fm-Anbindung (optionaler Adapter):
//  • Radioadmin-API (https://api.radioadmin.laut.fm, Bearer-Token des Nutzers) – Playlists, Titel,
//    Sendeplan, Statistik, Benutzer, Station, Live-Zugang. Nur dokumentierte Endpunkte (radioadmin-api-spec).
//  • Öffentliche API (https://api.laut.fm) – current_song, last_songs, listeners (ohne Login).
// AirDeck leitet Anfragen serverseitig weiter: der Token bleibt verschlüsselt lokal und erreicht nie den Browser.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

// Umgebungsvariablen nur für Tests/Staging (z. B. lokaler Mock); Standard sind die echten laut.fm-Server
export const RADIOADMIN = process.env.AIRDECK_RADIOADMIN_URL || 'https://api.radioadmin.laut.fm';
export const PUBLIC_API = process.env.AIRDECK_LAUTFM_API_URL || 'https://api.laut.fm';

/**
 * Radioadmin-Tokens gehören zu einer „callback_url“. Bei jeder Anfrage muss derselbe Wert als
 * Origin-Header mitgeschickt werden (Auskunft laut.fm). AirDeck nutzt standardmäßig „airdeck“.
 */
export const DEFAULT_ORIGIN = 'airdeck';
export const ORIGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;

export function loginUrl(origin = DEFAULT_ORIGIN): string {
  return `https://radioadmin.laut.fm/login?callback_url=${encodeURIComponent(origin)}`;
}

export interface LautfmConfig {
  /** callback_url, mit der das Token erzeugt wurde (= Origin-Header) */
  origin?: string;
  /** Numerische Station-ID im Radioadmin */
  stationId?: number;
  /** Stationsname (URL-Name, z. B. "80er-radio") für die öffentliche API */
  stationName?: string;
}

export const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,400}$/;

/** Token aus Kopieren/Einfügen säubern: „Bearer “, Anführungszeichen, Leerraum. */
export function cleanToken(v: unknown): string {
  return String(v ?? '').trim().replace(/^bearer\s+/i, '').replace(/^["']+|["']+$/g, '').trim();
}

export interface RaStation {
  id: number;
  name: string;
  displayName: string;
  role: string;
}

/** /stations liefert je nach Version ein Array oder { stations: [...] } – beides verstehen. */
export function normalizeStations(data: unknown): RaStation[] | null {
  const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { stations?: unknown }).stations) ? (data as { stations: unknown[] }).stations : null;
  if (!list) return null;
  const out: RaStation[] = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const id = Number(o.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const name = String(o.name ?? '').trim().toLowerCase();
    out.push({ id, name, displayName: String(o.display_name ?? o.name ?? ''), role: String(o.role ?? 'dj').toLowerCase() });
  }
  return out;
}

/**
 * Probiert Origin-Kandidaten gegen GET /stations. Der erste Kandidat bekommt bis zu drei Versuche
 * (frisch ausgestellte Tokens sind bei laut.fm nicht sofort überall gültig), die übrigen je einen.
 */
export async function detectOrigin(token: string, candidates: unknown[], waitMs = 400): Promise<{ origin: string; stations: RaStation[] | null; unreachable: boolean }> {
  const list = [...new Set(candidates.map((c) => String(c ?? '').trim()).filter((c) => c && ORIGIN_RE.test(c)))];
  let reached = false;
  for (let i = 0; i < list.length; i++) {
    for (let attempt = 1; attempt <= (i === 0 ? 3 : 1); attempt++) {
      try {
        const r = await fetch(`${RADIOADMIN}/stations`, { headers: { Authorization: `Bearer ${token}`, Origin: list[i]!, Accept: 'application/json', 'User-Agent': 'AirDeck' }, signal: AbortSignal.timeout(8000) });
        reached = true;
        if (r.ok) {
          const st = normalizeStations(await r.json().catch(() => null));
          if (st) return { origin: list[i]!, stations: st, unreachable: false };
        } else await r.body?.cancel();
      } catch {
        // Netzwerkfehler: nächster Versuch
      }
      if (i === 0 && attempt < 3) await new Promise((ok) => setTimeout(ok, waitMs));
    }
  }
  return { origin: list[0] ?? DEFAULT_ORIGIN, stations: null, unreachable: !reached };
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

/** Öffentliche laut.fm-API laut api-spec (ohne die Dauer-Streams song_change.*). */
export function allowedPublicPath(path: string): boolean {
  if (path.includes('..')) return false;
  return /^\/(server_status|time|letters|genres|station_names|listeners|stations(\/(live|numbers|letter\/[a-z0-9]|genre\/[A-Za-z0-9%._ -]{1,60}|[a-z0-9_,-]{1,400}))?|station\/[a-z0-9_-]+(\/(listeners|images\/[a-z_]{1,30}|schedule|playlists|current_song|last_songs|next_artists))?)$/.test(path);
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie']);

/** Leitet eine Anfrage an laut.fm weiter und streamt die Antwort zurück (inkl. Uploads). */
export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  token: string | undefined,
  timeoutMs = 60_000,
  origin?: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const headers: Record<string, string> = { Accept: String(req.headers.accept ?? 'application/json'), 'User-Agent': 'AirDeck/0.3' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
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
