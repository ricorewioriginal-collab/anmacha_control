// KI-Provider-Abstraktion: Text (LLM) und Sprache (TTS) mit eigenen API-Keys.
// Keine erfundenen Antworten: jeder Fehler, jede leere Antwort wird als Fehler gemeldet.

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TextKind = 'openai' | 'anthropic' | 'google' | 'openai_compat';
export type VoiceKind = 'openai' | 'elevenlabs' | 'openai_compat' | 'piper';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: TextKind | VoiceKind;
  /** 'text' oder 'voice' */
  role: 'text' | 'voice';
  /** Für openai_compat (Ollama, LM Studio, Kokoro-FastAPI …) oder eigene Proxys */
  baseUrl?: string;
  /** Piper: Pfad zur ausführbaren Datei */
  binPath?: string;
  enabled: boolean;
}

export interface ChatRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface SpeechRequest {
  text: string;
  voice: string;
  model?: string;
  speed?: number;
  timeoutMs: number;
}

export interface SpeechResult {
  audio: Buffer;
  ext: 'mp3' | 'wav';
  chars: number;
}

export class AiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const TEXT_KINDS: readonly TextKind[] = ['openai', 'anthropic', 'google', 'openai_compat'];
export const VOICE_KINDS: readonly VoiceKind[] = ['openai', 'elevenlabs', 'openai_compat', 'piper'];

type Fetch = typeof fetch;

const OPENAI = 'https://api.openai.com/v1';
const ANTHROPIC = 'https://api.anthropic.com/v1';
const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta';
const ELEVEN = 'https://api.elevenlabs.io/v1';

function base(p: ProviderConfig, fallback: string): string {
  return (p.baseUrl?.trim() || fallback).replace(/\/+$/, '');
}

async function readError(r: Response): Promise<string> {
  const t = await r.text().catch(() => '');
  try {
    const j = JSON.parse(t) as { error?: { message?: string } | string; detail?: { message?: string } | string; message?: string };
    const e = j.error ?? j.detail ?? j.message;
    return typeof e === 'string' ? e : e?.message ?? t.slice(0, 200);
  } catch {
    return t.slice(0, 200) || r.statusText;
  }
}

async function call(fetchFn: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let r: Response;
  try {
    r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error;
    throw new AiError(e.name === 'TimeoutError' ? 'timeout' : 'network', e.name === 'TimeoutError' ? `Zeitüberschreitung nach ${timeoutMs} ms` : `Nicht erreichbar: ${e.message}`);
  }
  if (!r.ok) {
    const msg = await readError(r);
    throw new AiError(r.status === 401 || r.status === 403 ? 'auth' : r.status === 429 ? 'rate_limit' : 'provider', `${r.status}: ${msg}`);
  }
  return r;
}

// ---------- Text ----------

export async function chat(p: ProviderConfig, key: string | undefined, req: ChatRequest, fetchFn: Fetch = fetch): Promise<ChatResult> {
  if (p.kind !== 'openai_compat' && !key) throw new AiError('no_key', `Kein API-Key für „${p.name}“ hinterlegt`);
  if (!req.model) throw new AiError('no_model', 'Kein Modell gewählt');
  let out: ChatResult;
  if (p.kind === 'openai' || p.kind === 'openai_compat') {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }],
      // OpenAI erwartet bei aktuellen Modellen max_completion_tokens; kompatible Server (Ollama, LM Studio) max_tokens
      [p.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    const r = await call(fetchFn, `${base(p, OPENAI)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    }, req.timeoutMs);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    out = { text: j.choices?.[0]?.message?.content ?? '', inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 };
  } else if (p.kind === 'anthropic') {
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.prompt }] };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    const r = await call(fetchFn, `${base(p, ANTHROPIC)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    }, req.timeoutMs);
    const j = (await r.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    out = { text: (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''), inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
  } else if (p.kind === 'google') {
    const gen: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
    if (req.temperature !== undefined) gen.temperature = req.temperature;
    const r = await call(fetchFn, `${base(p, GOOGLE)}/models/${encodeURIComponent(req.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key! },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: 'user', parts: [{ text: req.prompt }] }], generationConfig: gen }),
    }, req.timeoutMs);
    const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    out = {
      text: parts.filter((x) => !x.thought).map((x) => x.text ?? '').join(''),
      inputTokens: j.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: (j.usageMetadata?.candidatesTokenCount ?? 0) + (j.usageMetadata?.thoughtsTokenCount ?? 0),
    };
  } else {
    throw new AiError('unsupported', `Provider-Typ ${p.kind} liefert keinen Text`);
  }
  out.text = out.text.trim();
  if (!out.text) throw new AiError('empty', 'Leere Antwort vom Modell (evtl. Token-Limit zu klein)');
  return out;
}

/** Verfügbare Modelle beim Anbieter abfragen (nichts wird vorgegeben oder erfunden). */
export async function listModels(p: ProviderConfig, key: string | undefined, fetchFn: Fetch = fetch): Promise<string[]> {
  const t = 15_000;
  if (p.kind === 'piper') return [];
  if (p.kind === 'openai' || p.kind === 'openai_compat') {
    const r = await call(fetchFn, `${base(p, OPENAI)}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} }, t);
    const j = (await r.json()) as { data?: { id: string }[]; models?: { name: string }[] };
    return (j.data?.map((m) => m.id) ?? j.models?.map((m) => m.name) ?? []).sort();
  }
  if (p.kind === 'anthropic') {
    const r = await call(fetchFn, `${base(p, ANTHROPIC)}/models?limit=100`, { headers: { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' } }, t);
    return ((await r.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
  }
  if (p.kind === 'google') {
    const r = await call(fetchFn, `${base(p, GOOGLE)}/models?pageSize=200`, { headers: { 'x-goog-api-key': key ?? '' } }, t);
    const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return (j.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
  }
  if (p.kind === 'elevenlabs') {
    const r = await call(fetchFn, `${ELEVEN}/models`, { headers: { 'xi-api-key': key ?? '' } }, t);
    return ((await r.json()) as { model_id: string; can_do_text_to_speech?: boolean }[]).filter((m) => m.can_do_text_to_speech !== false).map((m) => m.model_id);
  }
  return [];
}

/** Stimmen (nur wo der Anbieter eine Liste liefert). */
export async function listVoices(p: ProviderConfig, key: string | undefined, fetchFn: Fetch = fetch): Promise<{ id: string; name: string }[]> {
  if (p.kind !== 'elevenlabs') return [];
  const r = await call(fetchFn, `${ELEVEN}/voices`, { headers: { 'xi-api-key': key ?? '' } }, 15_000);
  return (((await r.json()) as { voices?: { voice_id: string; name: string }[] }).voices ?? []).map((v) => ({ id: v.voice_id, name: v.name }));
}

// ---------- Sprache ----------

export async function speak(p: ProviderConfig, key: string | undefined, req: SpeechRequest, fetchFn: Fetch = fetch): Promise<SpeechResult> {
  const text = req.text.trim();
  if (!text) throw new AiError('empty', 'Kein Text zum Sprechen');
  if (!req.voice) throw new AiError('no_voice', 'Keine Stimme gewählt');
  let audio: Buffer;
  let ext: 'mp3' | 'wav' = 'mp3';
  if (p.kind === 'openai' || p.kind === 'openai_compat') {
    if (p.kind === 'openai' && !key) throw new AiError('no_key', `Kein API-Key für „${p.name}“ hinterlegt`);
    const body: Record<string, unknown> = { model: req.model, voice: req.voice, input: text, response_format: 'mp3' };
    if (req.speed) body.speed = req.speed;
    const r = await call(fetchFn, `${base(p, OPENAI)}/audio/speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body),
    }, req.timeoutMs);
    audio = Buffer.from(await r.arrayBuffer());
  } else if (p.kind === 'elevenlabs') {
    if (!key) throw new AiError('no_key', `Kein API-Key für „${p.name}“ hinterlegt`);
    const body: Record<string, unknown> = { text, ...(req.model ? { model_id: req.model } : {}) };
    if (req.speed) body.voice_settings = { speed: req.speed };
    const r = await call(fetchFn, `${base(p, ELEVEN)}/text-to-speech/${encodeURIComponent(req.voice)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': key }, body: JSON.stringify(body),
    }, req.timeoutMs);
    audio = Buffer.from(await r.arrayBuffer());
  } else if (p.kind === 'piper') {
    audio = await piper(p.binPath || 'piper', req.voice, text, req.speed, req.timeoutMs);
    ext = 'wav';
  } else {
    throw new AiError('unsupported', `Provider-Typ ${p.kind} liefert keine Sprache`);
  }
  // Plausibilität: echte Audiodaten statt Fehlerseite
  if (audio.length < 256) throw new AiError('empty', 'Anbieter lieferte keine Audiodaten');
  return { audio, ext, chars: text.length };
}

/** Lokales Piper-TTS (offline): Text über stdin, Stimme = Pfad zur .onnx-Datei. */
function piper(bin: string, model: string, text: string, speed: number | undefined, timeoutMs: number): Promise<Buffer> {
  const out = join(tmpdir(), `airdeck-piper-${process.pid}-${Date.now()}.wav`);
  const args = ['--model', model, '--output_file', out, ...(speed ? ['--length_scale', String(1 / speed)] : [])];
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-500)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new AiError('piper', `Piper nicht startbar: ${e.message}`));
    });
    p.on('close', async (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new AiError('piper', `Piper beendet mit ${code}: ${err.trim().slice(-200)}`);
        resolve(await readFile(out));
      } catch (e) {
        reject(e instanceof AiError ? e : new AiError('piper', (e as Error).message));
      } finally {
        rm(out, { force: true }).catch(() => {});
      }
    });
    p.stdin.end(text);
  });
}
