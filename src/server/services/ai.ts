// KI je Sender: Einstellungen der Automation, Redaktionsassistent (Text) und Voice Studio (Sprache).

import type { AirDeckApp } from '../app.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_CATEGORIES, type MediaItem } from '../../core/automation.ts';
import { AppError, newId, type Principal } from '../model.ts';
import { DEFAULT_AI, type AiSource, type AiStationConfig } from '../ai/director.ts';
import { AiError } from '../ai/providers.ts';

export class AiToolsService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  aiConfig(stationId: string): AiStationConfig {
    const c = this.app.rt(stationId).data.ai;
    return { ...DEFAULT_AI, ...c, text: { ...DEFAULT_AI.text, ...c?.text }, voice: { ...DEFAULT_AI.voice, ...c?.voice }, music: { ...DEFAULT_AI.music, ...c?.music } };
  }

  setAiConfig(p: Principal, stationId: string, input: Record<string, any>): AiStationConfig {
    const cur = this.aiConfig(stationId);
    const str = (v: unknown, max: number, d: string) => (typeof v === 'string' ? v.trim().slice(0, max) : d);
    const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    const target = (t: any, d: any) => (t && typeof t === 'object' ? {
      providerId: str(t.providerId, 40, d?.providerId ?? ''), model: str(t.model, 120, d?.model ?? ''),
      ...(typeof t.temperature === 'number' ? { temperature: Math.max(0, Math.min(2, t.temperature)) } : {}),
      ...(typeof t.maxTokens === 'number' ? { maxTokens: int(t.maxTokens, 50, 8000, 600) } : d?.maxTokens ? { maxTokens: d.maxTokens } : {}),
    } : d);
    const voice = (t: any, d: any) => (t && typeof t === 'object' ? {
      providerId: str(t.providerId, 40, d?.providerId ?? ''), voice: str(t.voice, 300, d?.voice ?? ''), model: str(t.model, 120, d?.model ?? '') || undefined,
      ...(typeof t.speed === 'number' ? { speed: Math.max(0.5, Math.min(2, t.speed)) } : {}),
    } : d);
    const sources: AiSource[] = Array.isArray(input.sources) ? input.sources.slice(0, 12).map((s: any, i: number) => {
      const url = String(s.url ?? '').trim();
      if (!/^https?:\/\//.test(url)) throw new AppError(400, 'invalid_url', `Quelle ${i + 1}: URL muss mit http(s):// beginnen`);
      return { id: str(s.id, 40, '') || newId('ais'), name: str(s.name, 60, `Quelle ${i + 1}`), url, kind: ['rss', 'json', 'text'].includes(s.kind) ? s.kind : 'rss', use: ['news', 'weather', 'info'].includes(s.use) ? s.use : 'info' };
    }) : cur.sources;
    const next: AiStationConfig = {
      enabled: bool(input.enabled, cur.enabled),
      approval: bool(input.approval, cur.approval),
      everySongs: int(input.everySongs, 0, 20, cur.everySongs),
      topOfHourNews: bool(input.topOfHourNews, cur.topOfHourNews),
      language: str(input.language, 40, cur.language) || 'Deutsch',
      persona: str(input.persona, 400, cur.persona),
      style: str(input.style, 600, cur.style),
      maxWords: int(input.maxWords, 10, 300, cur.maxWords),
      sources,
      text: { ...target(input.text, cur.text), fallback: input.text && 'fallback' in input.text ? (input.text.fallback?.providerId ? target(input.text.fallback, undefined) : undefined) : cur.text.fallback },
      voice: { ...voice(input.voice, cur.voice), fallback: input.voice && 'fallback' in input.voice ? (input.voice.fallback?.providerId ? voice(input.voice.fallback, undefined) : undefined) : cur.voice.fallback },
      music: input.music && typeof input.music === 'object' ? {
        enabled: bool(input.music.enabled, cur.music.enabled), lookahead: int(input.music.lookahead, 1, 10, cur.music.lookahead),
        instructions: str(input.music.instructions, 600, cur.music.instructions), jingleEvery: int(input.music.jingleEvery, 0, 20, cur.music.jingleEvery),
      } : cur.music,
      keepGenerated: int(input.keepGenerated, 5, 500, cur.keepGenerated),
    };
    if (next.enabled && !next.text.providerId) throw new AppError(400, 'no_provider', 'Für die KI-Automation zuerst einen Text-Provider und ein Modell wählen');
    if (next.enabled && next.everySongs > 0 && !next.voice.providerId) throw new AppError(400, 'no_voice', 'Für Moderationen einen Sprach-Provider und eine Stimme wählen');
    this.app.rt(stationId).data.ai = next;
    this.app.audit.write({ kind: 'ai', event: 'config', actor: p.id, stationId, enabled: next.enabled, music: next.music.enabled, approval: next.approval });
    this.app.changed();
    return next;
  }

  /** KI-Sprachdatei als Medium ablegen (wird automatisch aufgeräumt). */
  addGeneratedMedia(stationId: string, audio: Buffer, ext: string, title: string, category: MediaItem['category'], generated = true): MediaItem {
    const id = newId('m');
    const file = `${id}.${ext === 'wav' ? 'wav' : 'mp3'}`;
    writeFileSync(join(this.app.mediaDir, stationId, file), audio);
    return this.app.addMedia(stationId, {
      id, title: title.slice(0, 200), artist: this.app.rt(stationId).station.name, category, file, durationMs: null, addedAt: Date.now(),
      folder: generated ? 'KI' : 'KI-Studio', ...(generated ? { generatedBy: 'ai' as const } : {}),
    });
  }

  /** KI-Werkzeug: Text erzeugen (Assistent, Spot-Texte, Sendungsplanung). */
  async aiText(stationId: string, prompt: string, system?: string): Promise<unknown> {
    const c = this.aiConfig(stationId);
    if (!prompt.trim()) throw new AppError(400, 'empty', 'Bitte eine Anweisung eingeben');
    try {
      const r = await this.app.ai.text(stationId, 'assistant', [c.text, c.text.fallback], system?.trim() || `Du bist der Redaktionsassistent des Radiosenders „${this.app.rt(stationId).station.name}“. Antworte auf ${c.language}.`, prompt.slice(0, 20_000), 90_000);
      return { text: r.text, providerId: r.providerId, model: r.model, cost: r.cost };
    } catch (err) {
      throw new AppError(502, 'ai_failed', (err as Error).message);
    }
  }

  /** KI-Werkzeug: Text vertonen und in die Bibliothek legen (Voice Studio, Spots, Jingles). */
  async aiSpeech(stationId: string, input: { text?: string; title?: string; category?: string; voice?: string; providerId?: string; model?: string }): Promise<MediaItem> {
    const c = this.aiConfig(stationId);
    const text = String(input.text ?? '').trim();
    if (!text) throw new AppError(400, 'empty', 'Kein Text');
    if (text.length > 5000) throw new AppError(413, 'too_long', 'Höchstens 5000 Zeichen');
    const target = input.providerId ? { providerId: input.providerId, voice: input.voice ?? '', model: input.model } : { ...c.voice, ...(input.voice ? { voice: input.voice } : {}) };
    try {
      const r = await this.app.ai.voice(stationId, 'voice_studio', [target, input.providerId ? undefined : c.voice.fallback], text, 120_000);
      const category = (MEDIA_CATEGORIES as readonly string[]).includes(String(input.category)) ? (input.category as MediaItem['category']) : 'tts';
      return this.addGeneratedMedia(stationId, r.audio, r.ext, input.title?.trim() || text.slice(0, 60), category, false);
    } catch (err) {
      throw new AppError(err instanceof AiError && err.code === 'no_voice' ? 400 : 502, 'ai_failed', (err as Error).message);
    }
  }
}
