// Broadcast Adapter: SHOUTcast-Source-Client (Legacy-Protokoll, von SHOUTcast v1 und v2 DNAS unterstützt).
// Ablauf: TCP auf Port+1 → "<passwort>\r\n" → "OK2" → icy-Header → Audiodaten.
// SHOUTcast v2: Passwort im Format "<passwort>:#<stream-id>".

import { connect, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import type { BroadcastOutput, OutputConfig, OutputState } from './icecast.ts';

const MAX_BUFFERED = 512 * 1024;

export function shoutcastPassword(cfg: Pick<OutputConfig, 'streamId'>, pass: string): string {
  return cfg.streamId ? `${pass}:#${cfg.streamId}` : pass;
}

export class ShoutcastOutput implements BroadcastOutput {
  readonly cfg: OutputConfig;
  readonly state: OutputState = { status: 'idle', bytesSent: 0, droppedChunks: 0 };
  private sock: Socket | null = null;
  private readonly password: () => string | undefined;
  private readonly onChange: (s: OutputState) => void;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 2000;
  private wanted: { contentType: string; init?: Buffer } | null = null;

  constructor(cfg: OutputConfig, password: () => string | undefined, onChange: (s: OutputState) => void = () => {}) {
    this.cfg = cfg;
    this.password = password;
    this.onChange = onChange;
  }

  start(contentType: string, init?: Buffer): void {
    if (!this.cfg.enabled) return;
    this.wanted = { contentType, init };
    this.retryDelay = 2000;
    this.open();
  }

  stop(): void {
    this.wanted = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.close();
    this.set({ status: 'idle', error: undefined, errorCategory: undefined });
  }

  write(chunk: Buffer): void {
    const s = this.sock;
    if (!s || this.state.status !== 'connected') return;
    if (s.writableLength > MAX_BUFFERED) {
      this.state.droppedChunks++;
      return;
    }
    s.write(chunk);
    this.state.bytesSent += chunk.length;
  }

  /** Titel über admin.cgi (v1: ohne sid, v2: mit sid). */
  updateMetadata(song: string): void {
    const pass = this.password();
    if (this.state.status !== 'connected' || !pass) return;
    const sid = this.cfg.streamId ? `sid=${this.cfg.streamId}&` : '';
    const req = httpRequest({
      host: this.cfg.host,
      port: this.cfg.port,
      path: `/admin.cgi?${sid}pass=${encodeURIComponent(pass)}&mode=updinfo&song=${encodeURIComponent(song)}`,
      headers: { 'User-Agent': 'Mozilla/5.0 (AirDeck)' },
      timeout: 5000,
    });
    req.on('response', (r) => r.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end();
  }

  private open(): void {
    this.close();
    const wanted = this.wanted;
    if (!wanted) return;
    const pass = this.password();
    if (!pass) return this.set({ status: 'error', error: 'Kein Passwort hinterlegt', errorCategory: 'auth' });
    if (!/mpeg|aac/i.test(wanted.contentType)) {
      return this.set({ status: 'error', error: `SHOUTcast unterstützt nur MP3/AAC (Quelle sendet ${wanted.contentType})`, errorCategory: 'unsupported' });
    }
    this.set({ status: 'connecting', error: undefined, errorCategory: undefined, contentType: wanted.contentType });
    const sock = connect({ host: this.cfg.host, port: this.cfg.port + 1 });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setTimeout(10_000);
    let reply = '';
    let ready = false;
    sock.on('connect', () => sock.write(`${shoutcastPassword(this.cfg, pass)}\r\n`));
    sock.on('data', (d: Buffer) => {
      if (ready) return;
      reply += d.toString('latin1');
      if (!reply.includes('\n')) return;
      if (!/^OK/i.test(reply.trim())) return this.fail(`Server: ${reply.trim().slice(0, 60)}`, 'auth', false);
      ready = true;
      sock.setTimeout(0);
      sock.write(
        [
          `content-type:${wanted.contentType}`, `icy-name:${this.cfg.name}`, 'icy-genre:', 'icy-pub:0', 'icy-url:', `icy-br:${this.cfg.bitrateKbps ?? 128}`,
        ].join('\r\n') + '\r\n\r\n',
      );
      this.retryDelay = 2000;
      this.set({ status: 'connected', connectedAt: Date.now() });
      if (wanted.init) this.write(wanted.init);
    });
    sock.on('timeout', () => this.fail('Zeitüberschreitung', 'network', true));
    sock.on('error', (e) => this.fail(e.message, 'network', true));
    sock.on('close', () => {
      if (this.sock === sock && this.state.status === 'connected') this.fail('Verbindung getrennt', 'network', true);
    });
  }

  private fail(message: string, category: OutputState['errorCategory'], retry: boolean): void {
    this.close();
    this.set({ status: 'error', error: message, errorCategory: category });
    if (retry && this.wanted && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.open();
      }, this.retryDelay);
      this.retryTimer.unref();
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    }
  }

  private close(): void {
    const s = this.sock;
    this.sock = null;
    if (s) {
      s.removeAllListeners('close');
      s.on('error', () => {});
      s.destroy();
    }
  }

  private set(patch: Partial<OutputState>): void {
    Object.assign(this.state, patch);
    this.onChange(this.state);
  }
}
