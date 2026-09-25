// Hörer-Interaktion: Musikwunsch, Grüße/Wunschbox, Song-Voting und Sprachnachricht ans Studio.
// (Idee aus dem AnMaCha-Hörerbereich, hier eigenständig und ohne Abhängigkeiten.)
//
// Sicherheit: Alles ist je Sender ausgeschaltet, bis es im Studio eingeschaltet wird. Öffentliche Aufrufe sind
// begrenzt (je Absender und Zeitraum), Texte werden als reiner Text gespeichert, IP-Adressen nur als flüchtiger
// Hash im Speicher geführt und nie abgelegt. Eingänge landen im Studio im Hörer-Posteingang.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AirDeckApp } from '../app.ts';
import { AppError, newId, type Principal } from '../model.ts';

export interface ListenerConfig {
  requests: boolean;
  messages: boolean;
  voting: boolean;
  voice: boolean;
  /** Begrüßungstext auf der Hörerseite */
  welcome?: string;
}

export interface InboxItem {
  id: string;
  kind: 'request' | 'message' | 'voice';
  at: number;
  status: 'new' | 'done';
  name?: string;
  text?: string;
  mediaId?: string;
  title?: string;
  /** Sprachnachricht: Dateiname im Hörer-Ordner */
  file?: string;
  contentType?: string;
  bytes?: number;
}

export const DEFAULT_LISTENER: ListenerConfig = { requests: false, messages: false, voting: false, voice: false };

const MAX_INBOX = 300;
const MAX_VOICE_FILES = 100;
export const MAX_VOICE_BYTES = 3 * 1024 * 1024;
const VOICE_TYPES: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
/** Grenzen je Absender: [Anzahl, Zeitraum ms] */
const LIMITS: Record<string, [number, number]> = { request: [3, 10 * 60_000], message: [3, 10 * 60_000], voice: [2, 60 * 60_000], search: [60, 60_000] };
const VOTE_WINDOW_MS = 12 * 3600_000;

/** Nur reiner Text, ohne Steuerzeichen, begrenzt */
function clean(v: unknown, max: number): string {
  return String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class ListenerService {
  private readonly app: AirDeckApp;
  /** Salz nur für diesen Prozess – Hashes sind nach einem Neustart nicht mehr zuordenbar */
  private readonly salt = randomBytes(16);
  private readonly hits = new Map<string, number[]>();
  private readonly votes = new Map<string, number>();

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  private who(ip: string): string {
    return createHash('sha256').update(this.salt).update(ip).digest('base64url').slice(0, 16);
  }

  private limit(sid: string, kind: string, ip: string): void {
    const [n, win] = LIMITS[kind]!;
    const key = `${sid}:${kind}:${this.who(ip)}`;
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < win);
    if (list.length >= n) throw new AppError(429, 'rate_limited', 'Zu viele Anfragen – bitte später noch einmal');
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 20_000) this.hits.clear();
  }

  config(sid: string): ListenerConfig {
    return { ...DEFAULT_LISTENER, ...this.app.rt(sid).data.listener };
  }

  setConfig(p: Principal, sid: string, input: Record<string, unknown>): ListenerConfig {
    const cur = this.config(sid);
    const b = (k: keyof ListenerConfig) => (typeof input[k] === 'boolean' ? (input[k] as boolean) : (cur[k] as boolean));
    const next: ListenerConfig = { requests: b('requests'), messages: b('messages'), voting: b('voting'), voice: b('voice'), welcome: typeof input.welcome === 'string' ? clean(input.welcome, 300) || undefined : cur.welcome };
    this.app.rt(sid).data.listener = next;
    this.app.audit.write({ kind: 'listener', event: 'config', actor: p.id, stationId: sid, ...next });
    this.app.changed();
    return next;
  }

  /** Öffentliche Sicht: nur, wenn der Sender öffentlich ist und mindestens eine Funktion an ist. */
  private publicStation(sid: string): { cfg: ListenerConfig; name: string } {
    const rt = this.app.stations.get(sid);
    const cfg = rt ? this.config(sid) : DEFAULT_LISTENER;
    if (!rt || rt.station.publicStatus === false || !(cfg.requests || cfg.messages || cfg.voting || cfg.voice)) {
      throw new AppError(404, 'not_found', 'Für diesen Sender ist der Hörerbereich nicht freigeschaltet');
    }
    return { cfg, name: rt.station.name };
  }

  private need(sid: string, feature: keyof Omit<ListenerConfig, 'welcome'>): ListenerConfig {
    const { cfg } = this.publicStation(sid);
    if (!cfg[feature]) throw new AppError(403, 'disabled', 'Diese Funktion ist für den Sender ausgeschaltet');
    return cfg;
  }

  publicInfo(sid: string): unknown {
    const { cfg, name } = this.publicStation(sid);
    const s = this.app.rt(sid).station;
    return { station: { id: sid, name, slogan: s.slogan, logo: s.logo ? `/api/v1/stations/${sid}/logo` : null, color: s.primaryColor }, requests: cfg.requests, messages: cfg.messages, voting: cfg.voting, voice: cfg.voice, welcome: cfg.welcome ?? '' };
  }

  /** Musiktitel suchen (nur Titel/Interpret, höchstens 30) */
  search(sid: string, q: string, ip: string): { id: string; title: string; artist: string }[] {
    const cfg = this.publicStation(sid).cfg;
    if (!cfg.requests && !cfg.voting) throw new AppError(403, 'disabled', 'Suche ist für den Sender ausgeschaltet');
    this.limit(sid, 'search', ip);
    const needle = clean(q, 80).toLowerCase();
    if (needle.length < 2) return [];
    return this.app.rt(sid).data.library
      .filter((m) => m.category === 'music' && `${m.artist} ${m.title}`.toLowerCase().includes(needle))
      .slice(0, 30)
      .map((m) => ({ id: m.id, title: m.title, artist: m.artist }));
  }

  private add(sid: string, item: Omit<InboxItem, 'id' | 'at' | 'status'>): InboxItem {
    const rt = this.app.rt(sid);
    const inbox = (rt.data.inbox ??= []);
    const full: InboxItem = { id: newId('in'), at: Date.now(), status: 'new', ...item };
    inbox.unshift(full);
    // Platz schaffen: erst erledigte, dann die ältesten Einträge
    while (inbox.length > MAX_INBOX) {
      const i = inbox.findLastIndex((x) => x.status === 'done');
      this.dropItem(sid, inbox.splice(i >= 0 ? i : inbox.length - 1, 1)[0]!);
    }
    this.app.changed();
    this.app.publish('inbox.new', sid, full);
    return full;
  }

  request(sid: string, ip: string, input: Record<string, unknown>): { ok: true } {
    this.need(sid, 'requests');
    const m = this.app.rt(sid).data.library.find((x) => x.id === String(input.mediaId ?? '') && x.category === 'music');
    if (!m) throw new AppError(404, 'not_found', 'Titel nicht gefunden');
    this.limit(sid, 'request', ip);
    this.add(sid, { kind: 'request', mediaId: m.id, title: m.artist ? `${m.artist} – ${m.title}` : m.title, name: clean(input.name, 40) || undefined, text: clean(input.text, 300) || undefined });
    return { ok: true };
  }

  message(sid: string, ip: string, input: Record<string, unknown>): { ok: true } {
    this.need(sid, 'messages');
    const text = clean(input.text, 500);
    if (text.length < 2) throw new AppError(400, 'empty', 'Bitte eine Nachricht eingeben');
    this.limit(sid, 'message', ip);
    this.add(sid, { kind: 'message', name: clean(input.name, 40) || undefined, text });
    return { ok: true };
  }

  vote(sid: string, ip: string, input: Record<string, unknown>): { ok: true; score: number } {
    this.need(sid, 'voting');
    const rt = this.app.rt(sid);
    const m = rt.data.library.find((x) => x.id === String(input.mediaId ?? '') && x.category === 'music');
    if (!m) throw new AppError(404, 'not_found', 'Titel nicht gefunden');
    const key = `${sid}:${m.id}:${this.who(ip)}`;
    const now = Date.now();
    if (now - (this.votes.get(key) ?? 0) < VOTE_WINDOW_MS) throw new AppError(429, 'already_voted', 'Für diesen Titel hast du schon abgestimmt');
    this.votes.set(key, now);
    if (this.votes.size > 50_000) for (const [k, t] of this.votes) if (now - t > VOTE_WINDOW_MS) this.votes.delete(k);
    const v = ((rt.data.votes ??= {})[m.id] ??= { up: 0, down: 0 });
    if (input.up === false) v.down++;
    else v.up++;
    this.app.changed();
    return { ok: true, score: v.up - v.down };
  }

  charts(sid: string, limit = 20): { id: string; title: string; artist: string; up: number; down: number; score: number }[] {
    const lib = new Map(this.app.rt(sid).data.library.map((m) => [m.id, m]));
    return Object.entries(this.app.rt(sid).data.votes ?? {})
      .filter(([id]) => lib.has(id))
      .map(([id, v]) => ({ id, title: lib.get(id)!.title, artist: lib.get(id)!.artist, up: v.up, down: v.down, score: v.up - v.down }))
      .sort((a, b) => b.score - a.score || b.up - a.up)
      .slice(0, Math.max(1, Math.min(100, limit)));
  }

  publicCharts(sid: string): unknown {
    this.need(sid, 'voting');
    return this.charts(sid);
  }

  private voiceDir(sid: string): string {
    return join(this.app.dataDir, 'listener-voice', sid);
  }

  voice(sid: string, ip: string, contentType: string, data: Buffer, meta: { name?: unknown; text?: unknown }): { ok: true } {
    this.need(sid, 'voice');
    const type = contentType.split(';')[0]!.trim().toLowerCase();
    const ext = VOICE_TYPES[type];
    if (!ext) throw new AppError(415, 'unsupported_media', 'Sprachnachricht als WebM, Ogg, MP3, M4A oder WAV senden');
    if (data.length < 1000) throw new AppError(400, 'too_short', 'Die Aufnahme ist zu kurz');
    if (data.length > MAX_VOICE_BYTES) throw new AppError(413, 'too_large', 'Höchstens 3 MB (etwa 2–3 Minuten)');
    this.limit(sid, 'voice', ip);
    const inbox = (this.app.rt(sid).data.inbox ??= []);
    // Speicher begrenzen: älteste Sprachnachrichten verwerfen
    const voices = inbox.filter((x) => x.kind === 'voice');
    for (const old of voices.slice(MAX_VOICE_FILES - 1)) {
      inbox.splice(inbox.indexOf(old), 1);
      this.dropItem(sid, old);
    }
    const dir = this.voiceDir(sid);
    mkdirSync(dir, { recursive: true });
    const file = `${newId('v')}.${ext}`;
    writeFileSync(join(dir, file), data);
    this.add(sid, { kind: 'voice', file, contentType: type, bytes: data.length, name: clean(meta.name, 40) || undefined, text: clean(meta.text, 300) || undefined });
    return { ok: true };
  }

  private dropItem(sid: string, item: InboxItem): void {
    if (item.file) rmSync(join(this.voiceDir(sid), item.file), { force: true });
  }

  // ---------- Studio ----------

  inbox(sid: string): { items: InboxItem[]; unread: number; config: ListenerConfig; charts: unknown } {
    const items = this.app.rt(sid).data.inbox ?? [];
    return { items, unread: items.filter((x) => x.status === 'new').length, config: this.config(sid), charts: this.charts(sid, 10) };
  }

  voiceFile(sid: string, id: string): { path: string; type: string } {
    const item = (this.app.rt(sid).data.inbox ?? []).find((x) => x.id === id && x.kind === 'voice');
    if (!item?.file) throw new AppError(404, 'not_found', 'Sprachnachricht nicht gefunden');
    const path = join(this.voiceDir(sid), item.file);
    if (!existsSync(path)) throw new AppError(404, 'not_found', 'Datei fehlt');
    return { path, type: item.contentType ?? 'audio/webm' };
  }

  /** queue: Wunsch/Sprachnachricht in die Queue · done: erledigt · delete: entfernen */
  action(p: Principal, sid: string, id: string, action: string): unknown {
    const rt = this.app.rt(sid);
    const inbox = rt.data.inbox ?? [];
    const item = inbox.find((x) => x.id === id);
    if (!item) throw new AppError(404, 'not_found', 'Eintrag nicht gefunden');
    if (action === 'delete') {
      inbox.splice(inbox.indexOf(item), 1);
      this.dropItem(sid, item);
    } else if (action === 'done') {
      item.status = 'done';
    } else if (action === 'queue') {
      let mediaId = item.mediaId;
      if (item.kind === 'voice') {
        // Sprachnachricht als Titel in die Bibliothek übernehmen (Kategorie Voicetrack, Ordner „Hörer“)
        const { path } = this.voiceFile(sid, id);
        const mid = newId('m');
        const file = `${mid}.${item.file!.split('.').pop()}`;
        copyFileSync(path, join(this.app.mediaDir, sid, file));
        this.app.svc.media.addMedia(sid, {
          id: mid, title: `Hörer: ${item.name ?? 'Sprachnachricht'}`.slice(0, 200), artist: '', category: 'voice_track', file, durationMs: null, addedAt: Date.now(), folder: 'Hörer',
        });
        mediaId = mid;
      }
      if (!mediaId) throw new AppError(409, 'not_queueable', 'Dieser Eintrag lässt sich nicht in die Queue legen');
      this.app.queueAdd(sid, mediaId);
      item.status = 'done';
    } else throw new AppError(400, 'invalid_action', 'Aktion: queue, done oder delete');
    this.app.audit.write({ kind: 'listener', event: action, actor: p.id, stationId: sid, item: id, itemKind: item.kind });
    this.app.changed();
    this.app.publish('inbox.changed', sid, { id, action });
    return this.inbox(sid);
  }
}
