// ICY-Metadaten (StreamTitle) aus einem externen Audio-Stream lesen: Abschnitt 20/22 - Metadaten eines
// eingebundenen externen Streams (z. B. ein als Programminhalt geplanter Nachrichten-/Musik-Stream) sollen
// als echtes "Jetzt läuft" erkannt werden, nicht nur der beim Anlegen einmalig eingetragene Titel.
// Eigene, leichte Verbindung nur für Metadaten (die Audiodaten selbst laufen unabhängig über ffmpeg im
// Sendebus) - verwirft die Audiobytes, behält nur die eingebetteten Metadaten-Blöcke.

export interface IcyHooks {
  onTitle(title: { artist: string; title: string } | null): void;
  log?(event: string, data: Record<string, unknown>): void;
}

/** "Interpret - Titel" bzw. reiner Titel aus StreamTitle='...' auswerten. */
export function parseStreamTitle(raw: string): { artist: string; title: string } | null {
  const text = raw.trim();
  if (!text) return null;
  const i = text.indexOf(' - ');
  if (i > 0) return { artist: text.slice(0, i).trim(), title: text.slice(i + 3).trim() };
  return { artist: '', title: text };
}

/** Einen ICY-Metadaten-Block (StreamTitle='...';...) auswerten. */
export function parseIcyMetadataBlock(block: string): { artist: string; title: string } | null {
  const m = /StreamTitle=(['"])(.*?)\1;/.exec(block);
  return m ? parseStreamTitle(m[2]!) : null;
}

type Fetch = typeof fetch;

/** Verbindet sich nur für Metadaten mit einem Stream (Icy-MetaData: 1), meldet StreamTitle-Änderungen. */
export class IcyMetadataReader {
  readonly url: string;
  private readonly hooks: IcyHooks;
  private ctrl: AbortController | null = null;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private backoffMs = 3000;
  private lastTitle: string | null = null;
  private readonly fetchFn: Fetch;

  constructor(url: string, hooks: IcyHooks, fetchFn: Fetch = fetch) {
    this.url = url;
    this.hooks = hooks;
    this.fetchFn = fetchFn;
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
    this.hooks.onTitle(null);
  }

  private retry(reason: string): void {
    if (this.stopped) return;
    this.hooks.log?.('icy_retry', { url: this.url, reason, inMs: this.backoffMs });
    this.timer = setTimeout(() => void this.connect(), this.backoffMs);
    this.timer.unref?.();
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    try {
      const r = await this.fetchFn(this.url, { headers: { 'User-Agent': 'AirDeck-Icy', 'Icy-MetaData': '1' }, signal: ctrl.signal, redirect: 'follow' });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const metaint = Number(r.headers.get('icy-metaint') ?? '0');
      if (!metaint || !Number.isFinite(metaint)) {
        // Server liefert keine eingebetteten Metadaten (kein Icecast/SHOUTcast-Feature) - nichts zu lesen,
        // aber keine Wiederholung nötig: einfach beendet, der zuletzt eingetragene Titel bleibt bestehen.
        void r.body.cancel();
        return;
      }
      this.backoffMs = 3000;
      const reader = r.body.getReader();
      // ICY-Zyklus: <metaint> Bytes Audio, dann 1 Längen-Byte (x16 = Blocklänge), dann der Block selbst.
      type State = 'audio' | 'lenbyte' | 'meta';
      let state: State = 'audio';
      let inAudio = 0;
      let pendingLen = 0;
      let metaBuf = Buffer.alloc(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let buf = Buffer.from(value);
        while (buf.length > 0) {
          if (state === 'audio') {
            const take = Math.min(metaint - inAudio, buf.length);
            inAudio += take;
            buf = buf.subarray(take);
            if (inAudio >= metaint) { state = 'lenbyte'; inAudio = 0; }
            continue;
          }
          if (state === 'lenbyte') {
            pendingLen = buf[0]! * 16;
            buf = buf.subarray(1);
            state = pendingLen > 0 ? 'meta' : 'audio';
            continue;
          }
          // state === 'meta'
          const take = Math.min(pendingLen, buf.length);
          metaBuf = Buffer.concat([metaBuf, buf.subarray(0, take)]);
          buf = buf.subarray(take);
          pendingLen -= take;
          if (pendingLen === 0) {
            const block = metaBuf.toString('utf8').replace(/\0+$/, '');
            metaBuf = Buffer.alloc(0);
            const parsed = parseIcyMetadataBlock(block);
            const key = parsed ? `${parsed.artist} - ${parsed.title}` : null;
            if (key !== this.lastTitle) {
              this.lastTitle = key;
              this.hooks.onTitle(parsed);
            }
            state = 'audio';
          }
        }
      }
      throw new Error('Verbindung beendet');
    } catch (err) {
      if (!this.stopped) this.retry((err as Error).message);
    }
  }
}
