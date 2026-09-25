// Benachrichtigungen: interne Ereignisse → Webhooks, Telegram, Now-Playing-Datei.

import type { AirDeckApp } from '../app.ts';
import { AppError, newId, type Principal } from '../model.ts';
import { NOTIFY_EVENTS, validateExportPath, validateWebhookUrl, type IntegrationsConfig, type NotifyEvent } from '../notify.ts';

export class NotificationService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  readonly lastOutStatus = new Map<string, string>();

  /** Übersetzt interne Ereignisse in externe Meldungen (Webhook/Telegram/Datei). */
  notifyFrom(type: string, stationId: string, payload: unknown): void {
    const cfg = this.app.stations.get(stationId)?.data.integrations;
    if (!cfg) return;
    const p = (payload ?? {}) as Record<string, any>;
    let event: NotifyEvent | null = null;
    let data: Record<string, unknown> = {};
    switch (type) {
      case 'now_playing.changed':
        event = 'now_playing';
        data = { mediaId: p.mediaId, title: p.media?.title, artist: p.media?.artist, album: p.media?.album, category: p.media?.category, durationMs: p.media?.durationMs };
        break;
      case 'source.takeover_completed':
        event = 'on_air_changed';
        data = { source: this.app.engine.get(p.sourceId)?.name ?? p.sourceId, priority: p.data?.priority, target: p.target };
        break;
      case 'source.off_air':
        event = 'off_air';
        data = { target: p.target };
        break;
      case 'source.source_failed':
        event = 'source_failed';
        data = { source: this.app.engine.get(p.sourceId)?.name ?? p.sourceId, reason: p.data?.reason };
        break;
      case 'playout.log':
        if (p.event === 'silence_detected') event = 'silence';
        else if (p.event === 'silence_recovered') event = 'silence_recovered';
        else if (p.event === 'encoder_crashed') event = 'encoder_crashed';
        data = { detail: p.stderr };
        break;
      case 'stream.state_changed': {
        const prev = this.lastOutStatus.get(p.id);
        this.lastOutStatus.set(p.id, p.status);
        if (prev === p.status) break;
        const name = this.app.outputs.get(p.id)?.cfg.name ?? p.id;
        if (p.status === 'error') event = 'stream_error';
        else if (p.status === 'connected') event = 'stream_connected';
        data = { output: name, error: p.error };
        break;
      }
      case 'schedule.fired':
        event = 'schedule_fired';
        data = { label: p.label, kind: p.kind, mode: p.mode };
        break;
    }
    if (event) this.app.notifier.emit(cfg, { event, station: stationId, at: new Date().toISOString(), data });
  }

  integrations(stationId: string): unknown {
    const cfg = this.app.rt(stationId).data.integrations ?? { webhooks: [] };
    return {
      events: NOTIFY_EVENTS,
      webhooks: cfg.webhooks.map(({ secretRef, ...w }) => ({ ...w, hasSecret: !!secretRef && this.app.secrets.has(secretRef) })),
      telegram: cfg.telegram ? { chatId: cfg.telegram.chatId, enabled: cfg.telegram.enabled, hasToken: this.app.secrets.has(cfg.telegram.botTokenRef) } : null,
      nowPlayingFile: cfg.nowPlayingFile ?? null,
    };
  }

  setIntegrations(p: Principal, stationId: string, input: Record<string, any>): unknown {
    const rt = this.app.rt(stationId);
    const cur: IntegrationsConfig = rt.data.integrations ?? { webhooks: [] };
    try {
      if (Array.isArray(input.webhooks)) {
        cur.webhooks = input.webhooks.slice(0, 10).map((w: Record<string, any>) => {
          const prev = cur.webhooks.find((x) => x.id === w.id);
          const id = prev?.id ?? newId('wh');
          const secretRef = prev?.secretRef ?? `webhook:${stationId}:${id}`;
          if (typeof w.secret === 'string' && w.secret) this.app.secrets.set(secretRef, w.secret);
          const events = (Array.isArray(w.events) ? w.events : []).filter((e: string) => (NOTIFY_EVENTS as readonly string[]).includes(e));
          return { id, url: validateWebhookUrl(String(w.url ?? '')), events, secretRef, enabled: w.enabled !== false };
        });
      }
      if (input.telegram === null) cur.telegram = undefined;
      else if (input.telegram && typeof input.telegram === 'object') {
        const botTokenRef = cur.telegram?.botTokenRef ?? `telegram:${stationId}`;
        if (typeof input.telegram.botToken === 'string' && input.telegram.botToken) this.app.secrets.set(botTokenRef, input.telegram.botToken.trim());
        cur.telegram = { chatId: String(input.telegram.chatId ?? '').slice(0, 64), botTokenRef, enabled: input.telegram.enabled !== false };
      }
      if (input.nowPlayingFile === null || input.nowPlayingFile === '') cur.nowPlayingFile = undefined;
      else if (typeof input.nowPlayingFile === 'string') cur.nowPlayingFile = validateExportPath(input.nowPlayingFile);
    } catch (err) {
      throw new AppError(400, 'invalid_integration', (err as Error).message);
    }
    rt.data.integrations = cur;
    this.app.audit.write({ kind: 'notify', event: 'config', actor: p.id, stationId });
    this.app.changed();
    return this.integrations(stationId);
  }

  /** Testmeldung an alle Webhooks/Telegram senden und Ergebnisse zurückgeben. */
  async testIntegrations(stationId: string): Promise<unknown> {
    const cfg = this.app.rt(stationId).data.integrations;
    if (!cfg) return { webhooks: [], telegram: null };
    const payload = { event: 'schedule_fired' as const, station: stationId, at: new Date().toISOString(), data: { test: true, label: 'AirDeck Testmeldung' } };
    const webhooks = await Promise.all(cfg.webhooks.map(async (w) => ({ id: w.id, ok: await this.app.notifier.deliverWebhook(w, payload) })));
    const telegram = cfg.telegram ? await this.app.notifier.deliverTelegram(cfg.telegram.chatId, cfg.telegram.botTokenRef, `✅ AirDeck ${stationId}: Testmeldung`) : null;
    return { webhooks, telegram };
  }
}
