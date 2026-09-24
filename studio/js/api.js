// @ts-check
// Schlanker API-Client für AirDeck REST v1 + Server-Sent Events.

const TOKEN_KEY = 'airdeck.token';

export function readToken() {
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
  }

  /** @param {string} method @param {string} path @param {any} [body] @param {Record<string,string>} [headers] */
  async req(method, path, body, headers = {}) {
    const isRaw = body instanceof Blob || body instanceof ArrayBuffer;
    const r = await fetch(`/api/v1${path}`, {
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

  get = (/** @type {string} */ p) => this.req('GET', p);
  post = (/** @type {string} */ p, /** @type {any} */ b = {}) => this.req('POST', p, b);
  patch = (/** @type {string} */ p, /** @type {any} */ b) => this.req('PATCH', p, b);
  put = (/** @type {string} */ p, /** @type {any} */ b) => this.req('PUT', p, b);
  del = (/** @type {string} */ p) => this.req('DELETE', p);

  /** @param {string} stationId @param {string} mediaId */
  mediaUrl(stationId, mediaId) {
    return `/api/v1/stations/${encodeURIComponent(stationId)}/media/${encodeURIComponent(mediaId)}/file?token=${encodeURIComponent(this.token)}`;
  }

  /** @param {string} stationId @param {(type: string, data: any) => void} onEvent @param {(ok: boolean) => void} onState */
  events(stationId, onEvent, onState) {
    const es = new EventSource(`/api/v1/events?station=${encodeURIComponent(stationId)}&token=${encodeURIComponent(this.token)}`);
    const types = [
      'sources.changed', 'queue.changed', 'now_playing.changed', 'deck.state_changed', 'library.changed',
      'cardwall.changed', 'cardwall.triggered', 'stream.state_changed', 'station.changed', 'automation.state_changed',
      'source.takeover_completed', 'source.takeover_rejected', 'source.off_air', 'source.fallback_completed', 'source.source_failed',
    ];
    for (const t of types) es.addEventListener(t, (e) => onEvent(t, JSON.parse(/** @type {MessageEvent} */ (e).data)));
    es.onopen = () => onState(true);
    es.onerror = () => onState(false);
    return es;
  }
}
