// KI-Dienst: Provider-Verwaltung (Keys verschlüsselt), Primär/Fallback, Kosten- und Budgetkontrolle.
// Preise werden NICHT vorgegeben – sie trägt der Betreiber pro Modell ein. Ohne Preis wird nur gezählt.

import { FileDocStore, type DocStore } from '../repo/docs.ts';
import { AiError, TEXT_KINDS, VOICE_KINDS, chat, listModels, listVoices, speak, type ChatResult, type ProviderConfig, type SpeechResult } from './providers.ts';

export interface Pricing {
  providerId: string;
  model: string;
  /** Preis je 1 Mio. Eingabe-Token */
  inPerM?: number;
  /** Preis je 1 Mio. Ausgabe-Token */
  outPerM?: number;
  /** Preis je 1 Mio. Zeichen (TTS) */
  perMChars?: number;
}

export interface Budget {
  /** Warnschwelle pro Monat */
  soft?: number;
  /** Harte Grenze pro Monat: darüber wird der Provider nicht mehr genutzt */
  hard?: number;
}

export interface AiSettings {
  providers: ProviderConfig[];
  pricing: Pricing[];
  budgets: { providers: Record<string, Budget>; stations: Record<string, Budget> };
  currency: string;
}

export interface UsageRow {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  chars: number;
  cost: number;
  errors: number;
}

export interface UsageEntry {
  at: number;
  stationId: string;
  providerId: string;
  model: string;
  kind: 'text' | 'voice';
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  chars: number;
  cost: number;
  ms: number;
  ok: boolean;
  error?: string;
}

interface UsageState {
  month: string;
  byProvider: Record<string, UsageRow>;
  byStation: Record<string, UsageRow>;
  previous?: { month: string; byProvider: Record<string, UsageRow>; byStation: Record<string, UsageRow> };
  recent: UsageEntry[];
}

export interface TextTarget {
  providerId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface VoiceTarget {
  providerId: string;
  voice: string;
  model?: string;
  speed?: number;
}

const emptyRow = (): UsageRow => ({ calls: 0, inputTokens: 0, outputTokens: 0, chars: 0, cost: 0, errors: 0 });
const month = (d = new Date()) => d.toISOString().slice(0, 7);
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

type Fetch = typeof fetch;

export class AiService {
  private readonly docs: DocStore;
  private settings: AiSettings;
  private readonly usage: UsageState;
  private readonly getKey: (ref: string) => string | undefined;
  private readonly setKey: (ref: string, value: string | null) => void;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private readonly softWarned = new Set<string>();
  fetchFn: Fetch;

  constructor(dataDir: string, keys: { get: (ref: string) => string | undefined; set: (ref: string, value: string | null) => void }, log: (event: string, data: Record<string, unknown>) => void, fetchFn: Fetch = fetch, docs: DocStore = new FileDocStore(dataDir)) {
    this.docs = docs;
    this.settings = { providers: [], pricing: [], budgets: { providers: {}, stations: {} }, currency: 'EUR', ...docs.get<Partial<AiSettings>>('ai', {}) };
    this.usage = { month: month(), byProvider: {}, byStation: {}, recent: [], ...docs.get<Partial<UsageState>>('ai-usage', {}) };
    docs.bind('ai-usage', () => this.usage);
    this.getKey = keys.get;
    this.setKey = keys.set;
    this.log = log;
    this.fetchFn = fetchFn;
  }

  flush(): void {
    this.docs.flushSync();
  }

  // ---------- Einstellungen ----------

  view(): unknown {
    return {
      ...this.settings,
      providers: this.settings.providers.map((p) => ({ ...p, hasKey: !!this.getKey(`ai:${p.id}`) })),
      kinds: { text: TEXT_KINDS, voice: VOICE_KINDS },
    };
  }

  provider(id: string): ProviderConfig {
    const p = this.settings.providers.find((x) => x.id === id);
    if (!p) throw new AiError('unknown_provider', `KI-Provider „${id}“ nicht gefunden`);
    return p;
  }

  update(input: Record<string, any>): unknown {
    const next: AiSettings = structuredClone(this.settings);
    // Keys erst schreiben, wenn alles gültig ist (keine halben Änderungen)
    const keyOps: [string, string | null][] = [];
    if (Array.isArray(input.providers)) {
      const seen = new Set<string>();
      next.providers = input.providers.slice(0, 30).map((raw: Record<string, any>) => {
        const id = String(raw.id ?? '').trim().toLowerCase();
        if (!ID.test(id) || seen.has(id)) throw new AiError('invalid', `Ungültige oder doppelte Provider-ID „${id}“`);
        seen.add(id);
        const role = raw.role === 'voice' ? 'voice' : 'text';
        const kinds: readonly string[] = role === 'voice' ? VOICE_KINDS : TEXT_KINDS;
        if (!kinds.includes(raw.kind)) throw new AiError('invalid', `Typ „${raw.kind}“ passt nicht zu ${role === 'voice' ? 'Sprache' : 'Text'}`);
        const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
        if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new AiError('invalid', 'Basis-URL muss mit http:// oder https:// beginnen');
        if (raw.kind === 'openai_compat' && !baseUrl) throw new AiError('invalid', 'Kompatibler Provider braucht eine Basis-URL (z. B. http://localhost:11434/v1)');
        const p: ProviderConfig = {
          id, role, kind: raw.kind, name: String(raw.name ?? id).slice(0, 60), enabled: raw.enabled !== false,
          ...(baseUrl ? { baseUrl } : {}), ...(typeof raw.binPath === 'string' && raw.binPath.trim() ? { binPath: raw.binPath.trim() } : {}),
        };
        // Key: leer = unverändert, "-" = löschen
        if (typeof raw.key === 'string' && raw.key) keyOps.push([`ai:${id}`, raw.key === '-' ? null : raw.key.trim()]);
        return p;
      });
      for (const old of this.settings.providers) if (!seen.has(old.id)) keyOps.push([`ai:${old.id}`, null]);
    }
    if (Array.isArray(input.pricing)) {
      next.pricing = input.pricing.slice(0, 200).map((x: Record<string, unknown>) => {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
        return { providerId: String(x.providerId ?? ''), model: String(x.model ?? ''), inPerM: num(x.inPerM), outPerM: num(x.outPerM), perMChars: num(x.perMChars) };
      }).filter((x: Pricing) => x.providerId && x.model);
    }
    if (input.budgets && typeof input.budgets === 'object') {
      const clean = (o: unknown) => Object.fromEntries(Object.entries((o ?? {}) as Record<string, Budget>).map(([k, b]) => [k, {
        soft: typeof b?.soft === 'number' && b.soft > 0 ? b.soft : undefined,
        hard: typeof b?.hard === 'number' && b.hard > 0 ? b.hard : undefined,
      }]));
      next.budgets = { providers: clean(input.budgets.providers), stations: clean(input.budgets.stations) };
    }
    if (typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency)) next.currency = input.currency;
    for (const [ref, v] of keyOps) this.setKey(ref, v);
    this.settings = next;
    this.docs.set('ai', next);
    return this.view();
  }

  // ---------- Kosten / Budget ----------

  cost(providerId: string, model: string, u: { inputTokens?: number; outputTokens?: number; chars?: number }): number {
    const p = this.settings.pricing.find((x) => x.providerId === providerId && (x.model === model || x.model === '*'));
    if (!p) return 0;
    return ((u.inputTokens ?? 0) * (p.inPerM ?? 0) + (u.outputTokens ?? 0) * (p.outPerM ?? 0) + (u.chars ?? 0) * (p.perMChars ?? 0)) / 1_000_000;
  }

  private rollMonth(): void {
    const m = month();
    if (this.usage.month === m) return;
    this.usage.previous = { month: this.usage.month, byProvider: this.usage.byProvider, byStation: this.usage.byStation };
    this.usage.month = m;
    this.usage.byProvider = {};
    this.usage.byStation = {};
    this.softWarned.clear();
  }

  /** 'hard' = gesperrt, 'soft' = Warnung, 'ok' */
  budgetState(providerId: string, stationId: string): 'ok' | 'soft' | 'hard' {
    this.rollMonth();
    const checks: [Budget | undefined, UsageRow | undefined, string][] = [
      [this.settings.budgets.providers[providerId], this.usage.byProvider[providerId], `provider:${providerId}`],
      [this.settings.budgets.stations[stationId], this.usage.byStation[stationId], `station:${stationId}`],
    ];
    let state: 'ok' | 'soft' | 'hard' = 'ok';
    for (const [b, row, key] of checks) {
      const spent = row?.cost ?? 0;
      if (b?.hard !== undefined && spent >= b.hard) return 'hard';
      if (b?.soft !== undefined && spent >= b.soft) {
        state = 'soft';
        if (!this.softWarned.has(key)) {
          this.softWarned.add(key);
          this.log('budget_soft', { scope: key, spent, soft: b.soft, currency: this.settings.currency });
        }
      }
    }
    return state;
  }

  private record(e: UsageEntry): void {
    this.rollMonth();
    for (const [map, key] of [[this.usage.byProvider, e.providerId], [this.usage.byStation, e.stationId]] as const) {
      const row = (map[key] ??= emptyRow());
      row.calls++;
      row.inputTokens += e.inputTokens;
      row.outputTokens += e.outputTokens;
      row.chars += e.chars;
      row.cost += e.cost;
      if (!e.ok) row.errors++;
    }
    this.usage.recent.unshift(e);
    if (this.usage.recent.length > 200) this.usage.recent.length = 200;
    this.docs.touch('ai-usage');
  }

  usageView(): unknown {
    this.rollMonth();
    return { ...this.usage, currency: this.settings.currency, budgets: this.settings.budgets };
  }

  // ---------- Aufrufe mit Fallback ----------

  private usable(t: { providerId: string } | undefined, role: 'text' | 'voice'): ProviderConfig | null {
    if (!t?.providerId) return null;
    const p = this.settings.providers.find((x) => x.id === t.providerId);
    return p && p.enabled && p.role === role ? p : null;
  }

  /** Text erzeugen: Primär, bei Fehler/Budget der Fallback. Wirft, wenn beide scheitern. */
  async text(stationId: string, purpose: string, targets: (TextTarget | undefined)[], system: string, prompt: string, timeoutMs = 30_000): Promise<ChatResult & { providerId: string; model: string; cost: number }> {
    const errors: string[] = [];
    for (const t of targets) {
      const p = this.usable(t, 'text');
      if (!p || !t) continue;
      if (this.budgetState(p.id, stationId) === 'hard') {
        errors.push(`${p.name}: Budget ausgeschöpft`);
        continue;
      }
      const started = Date.now();
      try {
        const r = await chat(p, this.getKey(`ai:${p.id}`), { model: t.model, system, prompt, maxTokens: t.maxTokens ?? 600, temperature: t.temperature, timeoutMs }, this.fetchFn);
        const cost = this.cost(p.id, t.model, r);
        this.record({ at: started, stationId, providerId: p.id, model: t.model, kind: 'text', purpose, inputTokens: r.inputTokens, outputTokens: r.outputTokens, chars: 0, cost, ms: Date.now() - started, ok: true });
        return { ...r, providerId: p.id, model: t.model, cost };
      } catch (err) {
        const msg = (err as Error).message;
        errors.push(`${p.name}: ${msg}`);
        this.record({ at: started, stationId, providerId: p.id, model: t.model, kind: 'text', purpose, inputTokens: 0, outputTokens: 0, chars: 0, cost: 0, ms: Date.now() - started, ok: false, error: msg });
      }
    }
    throw new AiError('all_failed', errors.length ? errors.join(' · ') : 'Kein Text-Provider konfiguriert');
  }

  async voice(stationId: string, purpose: string, targets: (VoiceTarget | undefined)[], text: string, timeoutMs = 60_000): Promise<SpeechResult & { providerId: string; cost: number }> {
    const errors: string[] = [];
    for (const t of targets) {
      const p = this.usable(t, 'voice');
      if (!p || !t) continue;
      if (this.budgetState(p.id, stationId) === 'hard') {
        errors.push(`${p.name}: Budget ausgeschöpft`);
        continue;
      }
      const started = Date.now();
      const model = t.model ?? '';
      try {
        const r = await speak(p, this.getKey(`ai:${p.id}`), { text, voice: t.voice, model: t.model, speed: t.speed, timeoutMs }, this.fetchFn);
        const cost = this.cost(p.id, model, { chars: r.chars });
        this.record({ at: started, stationId, providerId: p.id, model, kind: 'voice', purpose, inputTokens: 0, outputTokens: 0, chars: r.chars, cost, ms: Date.now() - started, ok: true });
        return { ...r, providerId: p.id, cost };
      } catch (err) {
        const msg = (err as Error).message;
        errors.push(`${p.name}: ${msg}`);
        this.record({ at: started, stationId, providerId: p.id, model, kind: 'voice', purpose, inputTokens: 0, outputTokens: 0, chars: 0, cost: 0, ms: Date.now() - started, ok: false, error: msg });
      }
    }
    throw new AiError('all_failed', errors.length ? errors.join(' · ') : 'Kein Sprach-Provider konfiguriert');
  }

  models(id: string): Promise<string[]> {
    const p = this.provider(id);
    return listModels(p, this.getKey(`ai:${p.id}`), this.fetchFn);
  }

  voices(id: string): Promise<{ id: string; name: string }[]> {
    const p = this.provider(id);
    return listVoices(p, this.getKey(`ai:${p.id}`), this.fetchFn);
  }
}
