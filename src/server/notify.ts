// Metadaten- & Benachrichtigungs-Engine: signierte Webhooks, Telegram-Alarme und Now-Playing-Export.
// Zustellung asynchron mit Timeout und begrenzten Wiederholungen – blockiert nie Audio oder Automation.

import { createHmac } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/** Ereignisse, die nach außen gemeldet werden können. */
export const NOTIFY_EVENTS = [
  'now_playing', 'on_air_changed', 'off_air', 'source_failed', 'silence', 'silence_recovered',
  'encoder_crashed', 'stream_error', 'stream_connected', 'schedule_fired',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Diese Ereignisse gelten als Alarm (z. B. für Telegram). */
export const ALERT_EVENTS: ReadonlySet<NotifyEvent> = new Set(['off_air', 'source_failed', 'silence', 'encoder_crashed', 'stream_error']);

export interface WebhookConfig {
  id: string;
  url: string;
  events: NotifyEvent[];
  /** Verweis auf das HMAC-Secret im Secret Store */
  secretRef?: string;
  enabled: boolean;
}

export interface IntegrationsConfig {
  webhooks: WebhookConfig[];
  telegram?: { chatId: string; botTokenRef: string; enabled: boolean };
  /** Absoluter Pfad für "Interpret - Titel" (Text) – daneben wird <pfad>.json geschrieben */
  nowPlayingFile?: string;
}

export interface NotifyPayload {
  event: NotifyEvent;
  station: string;
  at: string;
  data: Record<string, unknown>;
}

export function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function validateWebhookUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Ungültige URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Nur http(s)-URLs');
  return u.toString();
}

export function validateExportPath(p: string): string {
  if (!isAbsolute(p) || p.includes('\0')) throw new Error('Bitte einen absoluten Dateipfad angeben');
  return p;
}

/** Text für Alarme (deutsch, kurz). */
export function alertText(p: NotifyPayload): string {
  const d = p.data;
  const what: Record<string, string> = {
    off_air: 'OFF AIR – keine Quelle sendet',
    source_failed: `Quelle ausgefallen: ${d.source ?? ''} (${d.reason ?? ''})`,
    silence: 'Stille erkannt – Fallback aktiv',
    encoder_crashed: 'Encoder abgestürzt – Neustart läuft',
    stream_error: `Stream-Fehler: ${d.output ?? ''} – ${d.error ?? ''}`,
  };
  return `⚠️ AirDeck ${p.station}: ${what[p.event] ?? p.event}`;
}

type Fetch = typeof fetch;

export class Notifier {
  private readonly getSecret: (ref: string) => string | undefined;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private readonly fetchFn: Fetch;
  private inflight = 0;

  constructor(getSecret: (ref: string) => string | undefined, log: (event: string, data: Record<string, unknown>) => void, fetchFn: Fetch = fetch) {
    this.getSecret = getSecret;
    this.log = log;
    this.fetchFn = fetchFn;
  }

  /** Meldet ein Ereignis an alle passenden Ziele. Kehrt sofort zurück. */
  emit(cfg: IntegrationsConfig | undefined, payload: NotifyPayload): void {
    if (!cfg) return;
    if (payload.event === 'now_playing' && cfg.nowPlayingFile) this.writeNowPlaying(cfg.nowPlayingFile, payload);
    for (const w of cfg.webhooks) {
      if (w.enabled && w.events.includes(payload.event)) void this.deliverWebhook(w, payload);
    }
    const tg = cfg.telegram;
    if (tg?.enabled && ALERT_EVENTS.has(payload.event)) void this.deliverTelegram(tg.chatId, tg.botTokenRef, alertText(payload));
  }

  /** Zustellung mit bis zu 3 Versuchen (1 s, 4 s Pause), Timeout 5 s. */
  async deliverWebhook(w: WebhookConfig, payload: NotifyPayload): Promise<boolean> {
    if (this.inflight > 50) {
      this.log('webhook_dropped', { id: w.id, reason: 'queue_full' });
      return false;
    }
    this.inflight++;
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'AirDeck-Webhook/1', 'X-AirDeck-Event': payload.event };
    const secret = w.secretRef ? this.getSecret(w.secretRef) : undefined;
    if (secret) headers['X-AirDeck-Signature'] = sign(secret, body);
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await this.fetchFn(w.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
          if (r.ok) return true;
          if (r.status >= 400 && r.status < 500 && r.status !== 429) {
            this.log('webhook_rejected', { id: w.id, status: r.status });
            return false;
          }
        } catch {
          // Netzwerkfehler → nächster Versuch
        }
        if (attempt < 3) await new Promise((res) => setTimeout(res, attempt === 1 ? 1000 : 4000));
      }
      this.log('webhook_failed', { id: w.id, event: payload.event });
      return false;
    } finally {
      this.inflight--;
    }
  }

  async deliverTelegram(chatId: string, tokenRef: string, text: string): Promise<boolean> {
    const token = this.getSecret(tokenRef);
    if (!token) return false;
    try {
      const r = await this.fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) this.log('telegram_failed', { status: r.status });
      return r.ok;
    } catch {
      this.log('telegram_failed', { status: 0 });
      return false;
    }
  }

  private writeNowPlaying(file: string, p: NotifyPayload): void {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const d = p.data;
      const text = `${d.artist ? `${d.artist} - ` : ''}${d.title ?? ''}`;
      for (const [path, content] of [[file, text], [`${file}.json`, JSON.stringify({ ...d, station: p.station, at: p.at })]] as const) {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, content);
        renameSync(tmp, path);
      }
    } catch (err) {
      this.log('nowplaying_file_failed', { message: (err as Error).message });
    }
  }
}
