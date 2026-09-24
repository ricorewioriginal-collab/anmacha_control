// AI Radio Director: moderiert, liest Nachrichten zur vollen Stunde und plant Musik – pro Sender voll konfigurierbar.
// Grundsätze: KI ist nie Single Point of Failure (Fehler → überspringen, Sendeuhr übernimmt),
// nichts wird erfunden (Nachrichten/Wetter nur aus hinterlegten Quellen), jede Entscheidung wird protokolliert.

import type { MediaItem, QueueEntry } from '../../core/automation.ts';
import type { AiService, TextTarget, VoiceTarget } from './service.ts';
import { AiError } from './providers.ts';

export interface AiSource {
  id: string;
  name: string;
  url: string;
  kind: 'rss' | 'json' | 'text';
  use: 'news' | 'weather' | 'info';
}

export interface AiStationConfig {
  enabled: boolean;
  /** Moderationen erst nach Freigabe im Studio senden */
  approval: boolean;
  /** Moderation nach jedem n-ten Musiktitel (0 = aus) */
  everySongs: number;
  /** Nachrichten kurz vor der vollen Stunde vorbereiten (nur mit Nachrichtenquelle) */
  topOfHourNews: boolean;
  language: string;
  persona: string;
  style: string;
  maxWords: number;
  sources: AiSource[];
  text: TextTarget & { fallback?: TextTarget };
  voice: VoiceTarget & { fallback?: VoiceTarget };
  music: { enabled: boolean; lookahead: number; instructions: string; jingleEvery: number };
  /** So viele KI-Sprachdateien bleiben in der Bibliothek, ältere werden gelöscht */
  keepGenerated: number;
}

export const DEFAULT_AI: AiStationConfig = {
  enabled: false,
  approval: false,
  everySongs: 3,
  topOfHourNews: false,
  language: 'Deutsch',
  persona: 'Alex, freundliche Moderation',
  style: 'locker, kurz, positiv, duzt die Hörer',
  maxWords: 45,
  sources: [],
  text: { providerId: '', model: '', maxTokens: 600 },
  voice: { providerId: '', voice: '' },
  music: { enabled: false, lookahead: 3, instructions: '', jingleEvery: 4 },
  keepGenerated: 30,
};

export interface DirectorHost {
  station(id: string): { name: string; slogan: string };
  library(id: string): MediaItem[];
  queue(id: string): QueueEntry[];
  history(id: string): string[];
  insert(id: string, mediaId: string, index: number): void;
  addGenerated(id: string, audio: Buffer, ext: string, title: string, category: MediaItem['category']): MediaItem;
  remove(id: string, mediaId: string): void;
  nowPlayingId(id: string): string | null;
  pickJingle(id: string): MediaItem | null;
  event(id: string, type: string, payload: Record<string, unknown>): void;
}

export interface Pending {
  id: string;
  kind: 'break' | 'news';
  text: string;
  mediaId: string;
  createdAt: number;
}

export interface Decision {
  at: number;
  kind: string;
  ok: boolean;
  detail: string;
  providerId?: string;
  model?: string;
  cost?: number;
  ms?: number;
}

interface Runtime {
  songs: number;
  songsSinceJingle: number;
  busy: boolean;
  musicBusy: boolean;
  newsFor: string | null;
  pending: Pending[];
  log: Decision[];
  lastMusicAttempt: number;
}

// ---------- reine Hilfsfunktionen (getestet) ----------

const REFUSAL = /\b(als (eine )?ki\b|as an ai\b|i can(no|')t\b|ich kann (dir )?(dabei )?nicht helfen)/i;

/** Sprechtext säubern und prüfen. Wirft bei unbrauchbarer Antwort. */
export function cleanSpeech(raw: string, maxWords: number): string {
  let t = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[[^\]]{0,80}\]/g, ' ') // Regieanweisungen [lacht]
    .replace(/[*_#>`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(moderation|sprechtext|text|nachrichten)\s*:\s*/i, '')
    .replace(/^["„“»«']+|["„“»«']+$/g, '')
    .trim();
  if (!t) throw new Error('Leerer Sprechtext');
  if (REFUSAL.test(t)) throw new Error('Modell hat abgelehnt oder über sich selbst gesprochen');
  const words = t.split(' ');
  const limit = Math.ceil(maxWords * 1.3);
  if (words.length > limit) {
    const cut = words.slice(0, limit).join(' ');
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = end > 20 ? cut.slice(0, end + 1) : cut.replace(/[,;:\s]+$/, '') + '.';
  }
  return t;
}

/** Schlagzeilen aus RSS/Atom (ohne XML-Bibliothek, robust gegen CDATA). */
export function parseFeed(xml: string, max = 6): string[] {
  const out: string[] = [];
  const re = /<(item|entry)\b[\s\S]*?<title\b[^>]*>([\s\S]*?)<\/title>[\s\S]*?(?:<description\b[^>]*>([\s\S]*?)<\/description>|<summary\b[^>]*>([\s\S]*?)<\/summary>|<\/\1>)/gi;
  const txt = (s: string | undefined) => (s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
  for (let m = re.exec(xml); m && out.length < max; m = re.exec(xml)) {
    const title = txt(m[2]);
    const desc = txt(m[3] ?? m[4]).slice(0, 220);
    if (title) out.push(desc && !desc.startsWith(title) ? `${title} – ${desc}` : title);
  }
  return out;
}

/** Auswahl der KI prüfen: nur bekannte Kürzel, keine Doppelten. */
export function parsePicks(raw: string, aliases: ReadonlyMap<string, string>, max: number): string[] {
  const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(raw);
  if (!m) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data as { picks?: unknown }).picks;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of list) {
    const id = aliases.get(String(x).trim().toLowerCase());
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
      if (out.length >= max) break;
    }
  }
  return out;
}

const song = (m: MediaItem | undefined) => (m ? (m.artist ? `${m.artist} – ${m.title}` : m.title) : '–');
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export function systemPrompt(c: AiStationConfig, station: { name: string; slogan: string }, words: number): string {
  return [
    `Du bist ${c.persona || 'die Moderation'} beim Radiosender „${station.name}“${station.slogan ? ` (${station.slogan})` : ''}.`,
    `Sprache: ${c.language || 'Deutsch'}. Stil: ${c.style || 'natürlich'}.`,
    'Schreibe ausschließlich den gesprochenen Text: keine Regieanweisungen, keine Emojis, keine Aufzählungszeichen, kein Markdown.',
    `Höchstens ${words} Wörter.`,
    'Erfinde keine Fakten. Nachrichten, Wetter, Termine und Zahlen nur aus den mitgelieferten Quellen; ohne Quelle nicht erwähnen.',
    'Titel und Interpreten exakt so nennen wie angegeben.',
  ].join('\n');
}

// ---------- Director ----------

type Fetch = typeof fetch;

export class AiDirector {
  private readonly rt = new Map<string, Runtime>();
  private readonly feedCache = new Map<string, { at: number; text: string }>();
  private readonly host: DirectorHost;
  private readonly ai: AiService;
  private readonly config: (id: string) => AiStationConfig;
  fetchFn: Fetch;
  now: () => Date = () => new Date();

  constructor(host: DirectorHost, ai: AiService, config: (id: string) => AiStationConfig, fetchFn: Fetch = fetch) {
    this.host = host;
    this.ai = ai;
    this.config = config;
    this.fetchFn = fetchFn;
  }

  private state(id: string): Runtime {
    let r = this.rt.get(id);
    if (!r) {
      r = { songs: 0, songsSinceJingle: 0, busy: false, musicBusy: false, newsFor: null, pending: [], log: [], lastMusicAttempt: 0 };
      this.rt.set(id, r);
    }
    return r;
  }

  view(id: string): unknown {
    const r = this.state(id);
    return { busy: r.busy, musicBusy: r.musicBusy, songsSinceBreak: r.songs, pending: r.pending, log: r.log.slice(0, 50) };
  }

  private decide(id: string, d: Omit<Decision, 'at'>): void {
    const r = this.state(id);
    const entry = { at: Date.now(), ...d };
    r.log.unshift(entry);
    if (r.log.length > 100) r.log.length = 100;
    this.host.event(id, 'ai.decision', entry);
  }

  /** Vom Playout bei jedem Titelstart aufgerufen. */
  onTrack(id: string, m: MediaItem): void {
    const c = this.config(id);
    if (!c.enabled) return;
    const r = this.state(id);
    if (m.category === 'music') {
      r.songs++;
      r.songsSinceJingle++;
    }
    const now = this.now();
    const hourKey = `${now.toISOString().slice(0, 11)}${now.getHours() + 1}`;
    if (c.topOfHourNews && now.getMinutes() >= 50 && r.newsFor !== hourKey && c.sources.some((s) => s.use === 'news')) {
      r.newsFor = hourKey;
      void this.produce(id, 'news');
    } else if (c.everySongs > 0 && m.category === 'music' && r.songs >= c.everySongs) {
      const next = this.host.library(id).find((x) => x.id === this.host.queue(id)[0]?.mediaId);
      // nicht doppelt moderieren, wenn schon Sprache/Jingle als Nächstes kommt
      if (!next || next.category === 'music') void this.produce(id, 'break');
    }
    if (c.music.enabled) void this.maintainMusic(id);
  }

  /** Regelmäßig (Tick) aufgerufen: hält die KI-Musikplanung gefüllt. */
  tick(id: string): void {
    const c = this.config(id);
    if (c.enabled && c.music.enabled && Date.now() - this.state(id).lastMusicAttempt > 30_000) void this.maintainMusic(id);
  }

  // ---------- Quellen ----------

  private async source(s: AiSource): Promise<string | null> {
    const hit = this.feedCache.get(s.url);
    if (hit && Date.now() - hit.at < 15 * 60_000) return hit.text;
    try {
      const r = await this.fetchFn(s.url, { headers: { 'User-Agent': 'AirDeck/1.0 (Radio-Automation)' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.text()).slice(0, 512 * 1024);
      const text = s.kind === 'rss' ? parseFeed(body).join('\n') : body.replace(/\s+/g, ' ').slice(0, 1500);
      if (!text) throw new Error('keine Inhalte');
      this.feedCache.set(s.url, { at: Date.now(), text });
      return text;
    } catch (err) {
      this.decide('*', { kind: 'source', ok: false, detail: `${s.name}: ${(err as Error).message}` });
      return null;
    }
  }

  private async context(c: AiStationConfig, uses: AiSource['use'][]): Promise<string[]> {
    const parts: string[] = [];
    for (const s of c.sources.filter((x) => uses.includes(x.use))) {
      const t = await this.source(s);
      if (t) parts.push(`[${s.use === 'news' ? 'Nachrichten' : s.use === 'weather' ? 'Wetter' : 'Info'} – ${s.name}]\n${t}`);
    }
    return parts;
  }

  // ---------- Moderation / Nachrichten ----------

  /** Erzeugt eine Moderation (Text → Stimme → Bibliothek → Queue oder Freigabe). */
  async produce(id: string, kind: 'break' | 'news'): Promise<Pending | MediaItem | null> {
    const c = this.config(id);
    const r = this.state(id);
    if (r.busy) return null;
    r.busy = true;
    const started = Date.now();
    try {
      const lib = new Map(this.host.library(id).map((m) => [m.id, m]));
      const now = this.now();
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const current = lib.get(this.host.nowPlayingId(id) ?? '');
      const next = lib.get(this.host.queue(id).find((q) => lib.get(q.mediaId)?.category === 'music')?.mediaId ?? '');
      const recent = this.host.history(id).slice(1, 5).map((x) => song(lib.get(x))).filter((x) => x !== '–');
      const words = kind === 'news' ? c.maxWords * 3 : c.maxWords;
      let prompt: string;
      if (kind === 'news') {
        const news = await this.context(c, ['news']);
        if (!news.length) throw new Error('Keine Nachrichtenquelle erreichbar – Nachrichten entfallen');
        const weather = await this.context(c, ['weather']);
        prompt = [
          `Anlass: Nachrichten zur vollen Stunde (${(now.getHours() + 1) % 24}:00 Uhr), ${WEEKDAYS[now.getDay()]}.`,
          'Fasse die wichtigsten 3 bis 5 Meldungen neutral und sachlich zusammen, danach kurz das Wetter, falls eine Wetterquelle vorliegt.',
          ...news, ...weather,
        ].join('\n\n');
      } else {
        const extra = await this.context(c, ['weather', 'info']);
        prompt = [
          `Anlass: kurze Moderation zwischen zwei Titeln. Uhrzeit ${time}, ${WEEKDAYS[now.getDay()]}.`,
          `Gerade lief: ${song(current)}`,
          `Als Nächstes: ${song(next)}`,
          recent.length ? `Davor: ${recent.join('; ')}` : '',
          ...extra,
          'Schreibe jetzt den Moderationstext.',
        ].filter(Boolean).join('\n');
      }
      const text = await this.ai.text(id, kind === 'news' ? 'news' : 'moderation', [c.text, c.text.fallback], systemPrompt(c, this.host.station(id), words), prompt);
      const speech = cleanSpeech(text.text, words);
      const audio = await this.ai.voice(id, kind, [c.voice, c.voice.fallback], speech);
      const title = kind === 'news' ? `KI-Nachrichten ${(now.getHours() + 1) % 24}:00` : `KI-Moderation ${time}`;
      const media = this.host.addGenerated(id, audio.audio, audio.ext, title, kind === 'news' ? 'news' : 'voice_track');
      r.songs = 0;
      const cost = text.cost + audio.cost;
      this.decide(id, { kind, ok: true, detail: speech, providerId: `${text.providerId}+${audio.providerId}`, model: text.model, cost, ms: Date.now() - started });
      this.cleanup(id, c);
      if (c.approval) {
        const p: Pending = { id: `p${Date.now().toString(36)}`, kind, text: speech, mediaId: media.id, createdAt: Date.now() };
        r.pending.unshift(p);
        this.expirePending(id);
        this.host.event(id, 'ai.pending', { pending: r.pending });
        return p;
      }
      this.host.insert(id, media.id, 0);
      return media;
    } catch (err) {
      // Rückfall: nichts einfügen, die Automation läuft normal weiter
      this.decide(id, { kind, ok: false, detail: (err as Error).message, ms: Date.now() - started });
      if (kind === 'break') r.songs = 0;
      return null;
    } finally {
      r.busy = false;
    }
  }

  approve(id: string, pendingId: string): void {
    const r = this.state(id);
    const p = r.pending.find((x) => x.id === pendingId);
    if (!p) throw new AiError('not_found', 'Freigabe nicht gefunden oder verfallen');
    r.pending = r.pending.filter((x) => x !== p);
    this.host.insert(id, p.mediaId, 0);
    this.decide(id, { kind: 'approved', ok: true, detail: p.text });
    this.host.event(id, 'ai.pending', { pending: r.pending });
  }

  reject(id: string, pendingId: string): void {
    const r = this.state(id);
    const p = r.pending.find((x) => x.id === pendingId);
    if (!p) throw new AiError('not_found', 'Freigabe nicht gefunden oder verfallen');
    r.pending = r.pending.filter((x) => x !== p);
    this.host.remove(id, p.mediaId);
    this.decide(id, { kind: 'rejected', ok: true, detail: p.text });
    this.host.event(id, 'ai.pending', { pending: r.pending });
  }

  /** Nicht freigegebene Moderationen verfallen nach 30 Minuten (sonst veraltet). */
  private expirePending(id: string): void {
    const r = this.state(id);
    const old = r.pending.filter((p) => Date.now() - p.createdAt > 30 * 60_000);
    for (const p of old) this.host.remove(id, p.mediaId);
    r.pending = r.pending.filter((p) => !old.includes(p));
  }

  /** Alte KI-Sprachdateien löschen (Platz sparen), nie die aktuelle oder eingeplante. */
  private cleanup(id: string, c: AiStationConfig): void {
    const busy = new Set([this.host.nowPlayingId(id), ...this.host.queue(id).map((q) => q.mediaId), ...this.state(id).pending.map((p) => p.mediaId)]);
    const generated = this.host.library(id).filter((m) => m.generatedBy === 'ai').sort((a, b) => b.addedAt - a.addedAt);
    for (const m of generated.slice(Math.max(1, c.keepGenerated))) if (!busy.has(m.id)) this.host.remove(id, m.id);
  }

  // ---------- Musikplanung ----------

  async maintainMusic(id: string, force = false): Promise<number> {
    const c = this.config(id);
    const r = this.state(id);
    if (r.musicBusy) return 0;
    const lib = new Map(this.host.library(id).map((m) => [m.id, m]));
    const queue = this.host.queue(id);
    const queuedMusic = queue.filter((q) => lib.get(q.mediaId)?.category === 'music').length;
    const need = Math.max(0, Math.min(10, c.music.lookahead) - queuedMusic);
    if (!need && !force) return 0;
    r.musicBusy = true;
    r.lastMusicAttempt = Date.now();
    const started = Date.now();
    try {
      const history = this.host.history(id);
      const blocked = new Set([...history.slice(0, 20), ...queue.map((q) => q.mediaId)]);
      const pool = [...lib.values()].filter((m) => m.category === 'music' && !blocked.has(m.id));
      if (!pool.length) throw new Error('Keine freien Musiktitel in der Bibliothek');
      // Zufällige Auswahl begrenzt die Token-Kosten
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      const cands = pool.slice(0, 60);
      const aliases = new Map(cands.map((m, i) => [`t${i + 1}`, m.id]));
      const now = this.now();
      const count = Math.max(1, need || c.music.lookahead);
      const prompt = [
        `Uhrzeit ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}, ${WEEKDAYS[now.getDay()]}.`,
        `Zuletzt gespielt: ${history.slice(0, 5).map((x) => song(lib.get(x))).join('; ') || '–'}`,
        c.music.instructions ? `Vorgaben des Senders: ${c.music.instructions}` : '',
        `Wähle die nächsten ${count} Titel in sinnvoller Reihenfolge (Tageszeit, Energie, Abwechslung bei Interpreten und Genres).`,
        `Antworte nur mit JSON: {"picks":["t3","t7"]}`,
        'Kandidaten:',
        ...cands.map((m, i) => `t${i + 1} | ${song(m)}${m.genre ? ` | ${m.genre}` : ''}${m.year ? ` | ${m.year}` : ''}${m.bpm ? ` | ${m.bpm} BPM` : ''}`),
      ].filter(Boolean).join('\n');
      const system = `Du bist Musikredakteur beim Sender „${this.host.station(id).name}“. Du wählst ausschließlich aus der Kandidatenliste und antwortest nur mit JSON.`;
      const res = await this.ai.text(id, 'music', [{ ...c.text, maxTokens: Math.max(c.text.maxTokens ?? 0, 300) }, c.text.fallback], system, prompt);
      const picks = parsePicks(res.text, aliases, count);
      if (!picks.length) throw new Error('KI-Auswahl unbrauchbar – Sendeuhr übernimmt');
      let index = this.host.queue(id).length;
      for (const mid of picks) {
        if (c.music.jingleEvery > 0 && r.songsSinceJingle + (index - queue.length) >= c.music.jingleEvery) {
          const j = this.host.pickJingle(id);
          if (j) this.host.insert(id, j.id, index++);
          r.songsSinceJingle = -(index - queue.length);
        }
        this.host.insert(id, mid, index++);
      }
      this.decide(id, { kind: 'music', ok: true, detail: picks.map((x) => song(lib.get(x))).join(' · '), providerId: res.providerId, model: res.model, cost: res.cost, ms: Date.now() - started });
      return picks.length;
    } catch (err) {
      this.decide(id, { kind: 'music', ok: false, detail: (err as Error).message, ms: Date.now() - started });
      return 0;
    } finally {
      r.musicBusy = false;
    }
  }
}
