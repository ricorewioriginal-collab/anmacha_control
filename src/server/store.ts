// Einfache lokale Persistenz (Local-First): JSON-Dateien mit atomarem Schreiben.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileAtomic(file: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    // Defekte Datei nicht überschreiben, sondern sichern und mit Default starten.
    renameSync(file, `${file}.corrupt-${Date.now()}`);
    console.error(`[store] ${file} war defekt und wurde gesichert:`, (err as Error).message);
    return fallback;
  }
}

/** Schreibt entprellt, damit häufige Änderungen die Platte nicht belasten. */
export class DebouncedJson<T> {
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly get: () => T;
  private readonly delayMs: number;
  /** Wird nach jedem erfolgreichen Schreiben aufgerufen (z. B. Sync) */
  onWrite: (() => void) | null = null;

  constructor(file: string, get: () => T, delayMs = 300) {
    this.file = file;
    this.get = get;
    this.delayMs = delayMs;
  }

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    writeFileAtomic(this.file, JSON.stringify(this.get(), null, 1));
    this.onWrite?.();
  }
}

/** Append-only Audit-Log (JSON Lines) mit einfacher Größenrotation. */
export class AuditLog {
  private readonly file: string;
  private readonly recent: unknown[] = [];
  private readonly maxBytes: number;

  constructor(file: string, maxBytes = 10 * 1024 * 1024) {
    this.file = file;
    this.maxBytes = maxBytes;
    mkdirSync(dirname(file), { recursive: true });
  }

  write(entry: Record<string, unknown>): void {
    const line = { at: new Date().toISOString(), ...entry };
    this.recent.push(line);
    if (this.recent.length > 500) this.recent.shift();
    try {
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, JSON.stringify(line) + '\n');
    } catch (err) {
      console.error('[audit] Schreiben fehlgeschlagen:', (err as Error).message);
    }
  }

  tail(n = 100): unknown[] {
    return this.recent.slice(-n);
  }
}
