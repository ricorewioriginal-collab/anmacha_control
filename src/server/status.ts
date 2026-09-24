// Stream-Status wie die Icecast-Statusseite – für jeden Sendeweg:
//  • AirDeck-Sender: alle verbundenen Ausgänge (Icecast/SHOUTcast/laut.fm) + interner Relay
//  • laut.fm-Sender: Icecast-Status nachgebaut aus der öffentlichen laut.fm-API
// Formate: JSON (Aufbau wie status-json.xsl), Icecast-XML, M3U, XSPF.

export interface IceSource {
  listenurl: string;
  server_name: string;
  server_description?: string;
  server_type: string;
  genre?: string;
  bitrate?: number | null;
  listeners: number | null;
  listener_peak?: number | null;
  title?: string;
  artist?: string;
  stream_start_iso8601?: string | null;
  /** Herkunft dieses Mounts */
  kind: 'icecast' | 'shoutcast' | 'laut.fm' | 'airdeck' | 'azuracast' | 'extern';
}

export interface NowPlayingInfo {
  artist: string;
  title: string;
  album?: string;
  started_at?: string | null;
  ends_at?: string | null;
}

export interface StreamStatus {
  kind: 'airdeck' | 'laut.fm';
  station: string;
  name: string;
  description?: string;
  icestats: { admin: string; host: string; location: string; server_id: string; server_start_iso8601: string; source: IceSource[] };
  now: NowPlayingInfo | null;
  last_songs: { started_at?: string; artist: string; title: string }[];
  onair?: { source: string; type: string; priority: number } | null;
  links: Record<string, string>;
  updated_at: string;
}

const xmlEsc = (s: unknown) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Icecast-kompatibles XML (wie /admin/stats bzw. status.xsl-Rohdaten). */
export function toIcecastXml(s: StreamStatus): string {
  const ic = s.icestats;
  const src = ic.source.map((x) => {
    const mount = (() => {
      try {
        return new URL(x.listenurl).pathname;
      } catch {
        return '/';
      }
    })();
    const f = (k: string, v: unknown) => (v === undefined || v === null || v === '' ? '' : `    <${k}>${xmlEsc(v)}</${k}>\n`);
    return `  <source mount="${xmlEsc(mount)}">\n${f('server_name', x.server_name)}${f('server_description', x.server_description)}${f('server_type', x.server_type)}${f('genre', x.genre)}${f('bitrate', x.bitrate)}${f('listeners', x.listeners ?? 0)}${f('listener_peak', x.listener_peak)}${f('title', x.title)}${f('artist', x.artist)}${f('stream_start_iso8601', x.stream_start_iso8601)}${f('listenurl', x.listenurl)}  </source>\n`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<icestats>\n  <admin>${xmlEsc(ic.admin)}</admin>\n  <host>${xmlEsc(ic.host)}</host>\n  <location>${xmlEsc(ic.location)}</location>\n  <server_id>${xmlEsc(ic.server_id)}</server_id>\n  <server_start_iso8601>${xmlEsc(ic.server_start_iso8601)}</server_start_iso8601>\n  <sources>${ic.source.length}</sources>\n${src}</icestats>\n`;
}

export function toM3u(s: StreamStatus): string {
  return ['#EXTM3U', ...s.icestats.source.flatMap((x) => [`#EXTINF:-1,${s.name}${s.icestats.source.length > 1 ? ` (${x.kind})` : ''}`, x.listenurl])].join('\n') + '\n';
}

export function toXspf(s: StreamStatus): string {
  const tracks = s.icestats.source.map((x) => `    <track>\n      <location>${xmlEsc(x.listenurl)}</location>\n      <title>${xmlEsc(s.name)}</title>\n      <annotation>${xmlEsc(x.title ?? '')}</annotation>\n    </track>\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/">\n  <title>${xmlEsc(s.name)}</title>\n  <trackList>\n${tracks}  </trackList>\n</playlist>\n`;
}

// ---------- laut.fm (öffentliche API) ----------

type Fetch = typeof fetch;

interface LautStation { name: string; display_name?: string; description?: string; genres?: string[]; stream_url?: string; page_url?: string; format?: string }
interface LautSong { title?: string; artist?: { name?: string }; album?: string; started_at?: string; ends_at?: string }

/** Laut.fm-Sender als Icecast-Mount: Sender, aktueller Titel (mit Start/Ende), Hörer, Verlauf. */
export async function lautfmStatus(name: string, api: string, fetchFn: Fetch = fetch): Promise<StreamStatus> {
  if (!/^[a-z0-9_-]{1,60}$/.test(name)) throw new Error('Ungültiger laut.fm-Sendername');
  const get = async <T>(path: string): Promise<T | null> => {
    const r = await fetchFn(`${api}/station/${name}${path}`, { headers: { 'User-Agent': 'AirDeck-Status' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r?.ok) return null;
    return (await r.json().catch(() => null)) as T | null;
  };
  const [info, song, listeners, last] = await Promise.all([get<LautStation>(''), get<LautSong>('/current_song'), get<number>('/listeners'), get<LautSong[]>('/last_songs')]);
  if (!info) throw new Error('laut.fm-Sender nicht gefunden');
  const display = info.display_name || info.name;
  const artist = song?.artist?.name ?? '';
  const listenurl = info.stream_url || `https://stream.laut.fm/${name}`;
  return {
    kind: 'laut.fm',
    station: name,
    name: display,
    description: info.description,
    icestats: {
      admin: '', host: 'stream.laut.fm', location: 'laut.fm', server_id: 'laut.fm (nachgebaut von AirDeck)', server_start_iso8601: '',
      source: [{
        kind: 'laut.fm', listenurl, server_name: display, server_description: info.description ?? info.format ?? '', server_type: 'audio/mpeg',
        genre: (info.genres ?? []).join(', '), bitrate: null, listeners: typeof listeners === 'number' ? listeners : null, listener_peak: null,
        title: song ? (artist ? `${artist} - ${song.title ?? ''}` : song.title ?? '') : '', artist, stream_start_iso8601: song?.started_at ?? null,
      }],
    },
    now: song ? { artist, title: song.title ?? '', album: song.album, started_at: song.started_at ?? null, ends_at: song.ends_at ?? null } : null,
    last_songs: (last ?? []).slice(0, 10).map((x) => ({ started_at: x.started_at, artist: x.artist?.name ?? '', title: x.title ?? '' })),
    links: { station_page: info.page_url || `https://laut.fm/${name}` },
    updated_at: new Date().toISOString(),
  };
}

/** Öffentliche Hör-Adresse eines Ausgangs. */
export function listenUrlOf(o: { type: string; host: string; port: number; mount: string; tls: boolean; streamId?: number }): string {
  const base = `${o.tls ? 'https' : 'http'}://${o.host}${(o.tls && o.port === 443) || (!o.tls && o.port === 80) ? '' : `:${o.port}`}`;
  if (o.type === 'shoutcast') return o.streamId ? `${base}/stream/${o.streamId}/` : `${base}/;`;
  // laut.fm: gesendet wird an den Live-Server, gehört wird über stream.laut.fm – das übernimmt der laut.fm-Status
  return `${base}${o.mount.startsWith('/') ? o.mount : `/${o.mount}`}`;
}
