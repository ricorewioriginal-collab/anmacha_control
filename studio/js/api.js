// @ts-check
// Schlanker API-Client für AirDeck REST v1 + Server-Sent Events.

const TOKEN_KEY = 'airdeck.token';
const SERVER_KEY = 'airdeck.server';

/** Läuft das Studio in der Android-/Desktop-Hülle (Capacitor) statt vom AirDeck-Server geladen? */
export const isNativeApp = () => !!(/** @type {any} */ (window).Capacitor?.isNativePlatform?.());

/** Basis-URL des AirDeck-Servers ('' = gleicher Ursprung). */
export function serverBase() {
  try {
    return (localStorage.getItem(SERVER_KEY) ?? '').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function saveServer(/** @type {string} */ url) {
  const clean = url.trim().replace(/\/+$/, '');
  try {
    if (clean) localStorage.setItem(SERVER_KEY, clean);
    else localStorage.removeItem(SERVER_KEY);
  } catch {}
}

export function readToken() {
  const srv = /[#&]server=([^&]+)/.exec(location.hash);
  if (srv) saveServer(decodeURIComponent(srv[1]));
  const m = /[#&]token=([^&]+)/.exec(location.hash);
  if (m) {
    const t = decodeURIComponent(m[1]);
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return t;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(/** @type {string|null} */ t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Api {
  /** @param {string} token */
  constructor(token) {
    this.token = token;
    this.base = serverBase();
  }

  /** @param {string} method @param {string} path @param {any} [body] @param {Record<string,string>} [headers] */
  async req(method, path, body, headers = {}) {
    const isRaw = body instanceof Blob || body instanceof ArrayBuffer || body instanceof FormData;
    const r = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
    });
    if (r.status === 204) return null;
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, data?.error ?? 'error', data?.message ?? `HTTP ${r.status}`);
    return data;
  }

  /** Binärdaten (z. B. Vorhören, Downloads) mit Auth laden. @param {string} path */
  async blob(path) {
    const r = await fetch(`${this.base}/api/v1${path}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new ApiError(r.status, 'error', `HTTP ${r.status}`);
    return r.blob();
  }

  get = (/** @type {string} */ p) => this.req('GET', p);
  post = (/** @type {string} */ p, /** @type {any} */ b = {}) => this.req('POST', p, b);
  patch = (/** @type {string} */ p, /** @type {any} */ b) => this.req('PATCH', p, b);
  put = (/** @type {string} */ p, /** @type {any} */ b) => this.req('PUT', p, b);
  del = (/** @type {string} */ p) => this.req('DELETE', p);

  /** @param {string} stationId @param {string} mediaId */
  mediaUrl(stationId, mediaId) {
    return `${this.base}/api/v1/stations/${encodeURIComponent(stationId)}/media/${encodeURIComponent(mediaId)}/file?token=${encodeURIComponent(this.token)}`;
  }

  /** Mithör-URL der aktiven Quelle eines Targets. @param {string} stationId @param {string} target */
  listenUrl(stationId, target) {
    return `${this.base}/listen/${encodeURIComponent(stationId)}${target}?token=${encodeURIComponent(this.token)}`;
  }

  /** @param {string} stationId @param {(type: string, data: any) => void} onEvent @param {(ok: boolean) => void} onState */
  events(stationId, onEvent, onState) {
    const es = new EventSource(`${this.base}/api/v1/events?station=${encodeURIComponent(stationId)}&token=${encodeURIComponent(this.token)}`);
    const types = [
      'sources.changed', 'queue.changed', 'now_playing.changed', 'deck.state_changed', 'library.changed',
      'cardwall.changed', 'cardwall.triggered', 'stream.state_changed', 'station.changed', 'automation.state_changed',
      'playout.state', 'playout.level', 'playout.log', 'planning.changed', 'playlists.changed', 'recorder.changed', 'schedule.fired',
      'automation.command', 'metadata.sent', 'ai.decision', 'ai.pending', 'source.takeover_completed', 'source.takeover_rejected', 'source.off_air', 'source.fallback_completed', 'source.source_failed',
    ];
    for (const t of types) es.addEventListener(t, (e) => onEvent(t, JSON.parse(/** @type {MessageEvent} */ (e).data)));
    es.onopen = () => onState(true);
    es.onerror = () => onState(false);
    return es;
  }
}
