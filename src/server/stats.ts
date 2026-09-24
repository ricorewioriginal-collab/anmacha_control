// Hörerzahlen von Icecast (status-json.xsl) und SHOUTcast (v1: /7.html, v2: /stats?sid=&json=1).
// Nur öffentliche Statusseiten, keine Admin-Zugänge.

import type { OutputConfig } from './icecast.ts';

/** Liest die Hörerzahl aus den öffentlichen Statusseiten; null = unbekannt. */
export async function fetchListeners(cfg: OutputConfig, timeoutMs = 5000): Promise<number | null> {
  const base = `${cfg.tls ? 'https' : 'http'}://${cfg.host}:${cfg.port}`;
  const get = async (path: string) => {
    const r = await fetch(base + path, { headers: { 'User-Agent': 'Mozilla/5.0 (AirDeck)' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
  };
  try {
    if (cfg.type === 'icecast') return parseIcecastStatus(await get('/status-json.xsl'), cfg.mount);
    if (cfg.streamId) return parseShoutcastV2(await get(`/stats?sid=${cfg.streamId}&json=1`));
    return parseShoutcastV1(await get('/7.html'));
  } catch {
    return null;
  }
}

export function parseIcecastStatus(text: string, mount: string): number | null {
  const m = mount.startsWith('/') ? mount : `/${mount}`;
  const data = JSON.parse(text) as { icestats?: { source?: unknown } };
  const src = data.icestats?.source;
  const list = (Array.isArray(src) ? src : src ? [src] : []) as Array<{ listenurl?: string; listeners?: number }>;
  const hit = list.find((s) => typeof s.listenurl === 'string' && new URL(s.listenurl, 'http://x').pathname === m);
  return typeof hit?.listeners === 'number' ? hit.listeners : null;
}

export function parseShoutcastV1(html: string): number | null {
  const body = /<body[^>]*>([^<]*)<\/body>/i.exec(html)?.[1] ?? html;
  const n = Number.parseInt(body.split(',')[0] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

export function parseShoutcastV2(text: string): number | null {
  const d = JSON.parse(text) as { currentlisteners?: number };
  return typeof d.currentlisteners === 'number' ? d.currentlisteners : null;
}
