// Brücke zu bestehenden Systemen (AzuraCast, eigener Icecast, SAM/mAirList/RadioDJ über ihren Stream, reine Web-Relays):
//  • Pull-Relay: fremden Stream als AirDeck-Quelle mit eigener Priorität übernehmen (Automation dort läuft weiter)
//  • Status-Spiegel: Now Playing, Hörer, Verlauf aus AzuraCast- bzw. Icecast-Status übernehmen
//  • Zuordnung über externe Schlüssel: nichts wird doppelt angelegt, Sync ist wiederholbar (idempotent)

export interface ExternalNow {
  name: string;
  listeners: number | null;
  listenUrls: string[];
  now: { artist: string; title: string; album?: string; started_at?: string | null; ends_at?: string | null } | null;
  history: { started_at?: string; artist: string; title: string }[];
  live: { active: boolean; streamer?: string } | null;
  bitrate?: number | null;
  format?: string;
}

type Fetch = typeof fetch;

async function getJson<T>(fetchFn: Fetch, url: string, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetchFn(url, { headers: { 'User-Agent': 'AirDeck-Bridge', Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => {
    throw new Error(`nicht erreichbar: ${e.message}`);
  });
  if (r.status === 401 || r.status === 403) throw new Error('Zugriff verweigert (API-Key prüfen)');
  if (r.status === 404) throw new Error('nicht gefunden (Adresse/Sender prüfen)');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

interface AzSong { artist?: string; title?: string; album?: string; text?: string }
interface AzNowPlaying {
  station?: { name?: string; listen_url?: string; mounts?: { url?: string; bitrate?: number; format?: string; is_default?: boolean }[] };
  listeners?: { current?: number; total?: number };
  live?: { is_live?: boolean; streamer_name?: string };
  now_playing?: { played_at?: number; duration?: number; song?: AzSong } | null;
  song_history?: { played_at?: number; song?: AzSong }[];
}

const iso = (sec?: number) => (sec ? new Date(sec * 1000).toISOString() : null);

/** AzuraCast: /api/nowplaying/<station> (öffentlich; API-Key nur für nicht-öffentliche Sender). */
export async function fetchAzuracast(baseUrl: string, station: string, apiKey?: string, fetchFn: Fetch = fetch): Promise<ExternalNow> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/nowplaying/${encodeURIComponent(station)}`;
  const d = await getJson<AzNowPlaying>(fetchFn, url, apiKey ? { 'X-API-Key': apiKey } : {});
  const np = d.now_playing;
  const mounts = d.station?.mounts ?? [];
  const def = mounts.find((m) => m.is_default) ?? mounts[0];
  return {
    name: d.station?.name ?? station,
    listeners: d.listeners?.current ?? d.listeners?.total ?? null,
    listenUrls: [...new Set([d.station?.listen_url, ...mounts.map((m) => m.url)].filter((x): x is string => !!x))],
    now: np?.song ? { artist: np.song.artist ?? '', title: np.song.title ?? np.song.text ?? '', album: np.song.album || undefined, started_at: iso(np.played_at), ends_at: np.played_at && np.duration ? iso(np.played_at + np.duration) : null } : null,
    history: (d.song_history ?? []).slice(0, 10).map((h) => ({ started_at: iso(h.played_at) ?? undefined, artist: h.song?.artist ?? '', title: h.song?.title ?? h.song?.text ?? '' })),
    live: d.live ? { active: !!d.live.is_live, streamer: d.live.streamer_name || undefined } : null,
    bitrate: def?.bitrate ?? null,
    format: def?.format,
  };
}

/** Beliebiger Icecast: status-json.xsl, ein bestimmter Mount. */
export async function fetchIcecastMount(statusUrl: string, mount: string, fetchFn: Fetch = fetch): Promise<ExternalNow> {
  const url = /status-json\.xsl/.test(statusUrl) ? statusUrl : `${statusUrl.replace(/\/+$/, '')}/status-json.xsl`;
  const d = await getJson<{ icestats?: { source?: unknown } }>(fetchFn, url);
  const list = ((Array.isArray(d.icestats?.source) ? d.icestats!.source : d.icestats?.source ? [d.icestats.source] : []) as Array<Record<string, unknown>>);
  const want = mount.startsWith('/') ? mount : `/${mount}`;
  const src = list.find((s) => typeof s.listenurl === 'string' && new URL(s.listenurl, 'http://x').pathname === want);
  if (!src) throw new Error(`Mount ${want} ist gerade nicht aktiv`);
  const raw = String(src.title ?? '');
  const [artist, ...rest] = raw.includes(' - ') ? raw.split(' - ') : ['', raw];
  const base = new URL(url);
  return {
    name: String(src.server_name ?? want),
    listeners: typeof src.listeners === 'number' ? src.listeners : null,
    listenUrls: [`${base.protocol}//${base.host}${want}`],
    now: raw ? { artist: String(src.artist ?? artist ?? ''), title: rest.length ? rest.join(' - ') : raw, started_at: null, ends_at: null } : null,
    history: [],
    live: null,
    bitrate: typeof src.bitrate === 'number' ? src.bitrate : null,
    format: typeof src.server_type === 'string' ? src.server_type : undefined,
  };
}

// ---------- Pull-Relay ----------

export interface PullHooks {
  open(contentType: string): void;
  data(chunk: Buffer): void;
  close(): void;
  log(event: string, data: Record<string, unknown>): void;
}

/** Holt einen fremden Stream dauerhaft ab (mit Wiederverbindung) und reicht ihn als Quelle weiter. */
export class PullRelay {
  readonly url: string;
  private readonly hooks: PullHooks;
  private ctrl: AbortController | null = null;
  private stopped = true;
  private backoffMs = 2000;
  private timer: NodeJS.Timeout | null = null;
  state: 'stopped' | 'connecting' | 'streaming' | 'retrying' = 'stopped';
  lastError: string | null = null;
  bytes = 0;

  constructor(url: string, hooks: PullHooks) {
    this.url = url;
    this.hooks = hooks;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ctrl?.abort();
    this.state = 'stopped';
  }

  private retry(reason: string): void {
    if (this.stopped) return;
    this.lastError = reason;
    this.state = 'retrying';
    this.hooks.log('relay_pull_retry', { url: this.url, reason, inMs: this.backoffMs });
    this.timer = setTimeout(() => void this.connect(), this.backoffMs);
    this.timer.unref();
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.state = 'connecting';
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    let opened = false;
    try {
      const r = await fetch(this.url, { headers: { 'User-Agent': 'AirDeck-Relay', 'Icy-MetaData': '0' }, signal: ctrl.signal, redirect: 'follow' });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const type = (r.headers.get('content-type') ?? 'audio/mpeg').split(';')[0]!.trim();
      if (!/^(audio|application\/ogg|video\/mp2t)/.test(type)) throw new Error(`kein Audio-Stream (${type})`);
      this.hooks.open(type);
      opened = true;
      this.state = 'streaming';
      this.lastError = null;
      this.hooks.log('relay_pull_connected', { url: this.url, type });
      const reader = r.body.getReader();
      let good = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.bytes += value.byteLength;
        good += value.byteLength;
        if (good > 256 * 1024) this.backoffMs = 2000; // stabile Verbindung → Wartezeit zurücksetzen
        this.hooks.data(Buffer.from(value));
      }
      throw new Error('Stream beendet');
    } catch (err) {
      if (opened) this.hooks.close();
      if (!this.stopped) this.retry((err as Error).message);
    }
  }
}
