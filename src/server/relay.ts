// Relay Core: nimmt Audio aller verbundenen Quellen eines Targets an und leitet
// ausschließlich die von der Source Priority Engine aktivierte Quelle an Ausgänge
// und Mithör-Listener weiter. Die UI steuert das nie direkt.

import type { ServerResponse } from 'node:http';
import type { BroadcastOutput } from './icecast.ts';

interface Session {
  contentType: string;
  /** Erster Chunk (bei WebM/Ogg der Container-Header) für Neustarts von Ausgängen */
  init?: Buffer;
  bytes: number;
  lastDataAt: number;
}

export interface TargetStatus {
  activeSourceId: string | null;
  contentType: string | null;
  listeners: number;
  lastDataAt: number | null;
  bytesIn: number;
}

const NEEDS_INIT = /webm|ogg|opus/i;

/** Abgriff des Sendesignals (z. B. Recorder). */
export interface RelayTap {
  onStart(contentType: string, init?: Buffer): void;
  onData(chunk: Buffer): void;
  onStop(): void;
}

export class RelayTarget {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<ServerResponse>();
  private readonly taps = new Set<RelayTap>();
  private tapsStarted = false;
  private activeId: string | null = null;
  private readonly outputs: () => BroadcastOutput[];

  constructor(outputs: () => BroadcastOutput[]) {
    this.outputs = outputs;
  }

  open(sourceId: string, contentType: string): void {
    this.sessions.set(sourceId, { contentType, bytes: 0, lastDataAt: Date.now() });
  }

  close(sourceId: string): void {
    this.sessions.delete(sourceId);
    if (this.activeId === sourceId) this.setActive(null);
  }

  hasSession(sourceId: string): boolean {
    return this.sessions.has(sourceId);
  }

  data(sourceId: string, chunk: Buffer): void {
    const s = this.sessions.get(sourceId);
    if (!s) return;
    const first = s.bytes === 0;
    s.bytes += chunk.length;
    s.lastDataAt = Date.now();
    if (first && NEEDS_INIT.test(s.contentType)) {
      s.init = chunk;
      // Falls die Quelle schon aktiv ist, bevor Daten kamen: Ausgänge jetzt mit Header starten.
      if (this.activeId === sourceId) {
        this.restartOutputs(s);
        this.startTaps(s);
      }
      return;
    }
    if (sourceId !== this.activeId) return;
    for (const t of this.taps) t.onData(chunk);
    for (const o of this.outputs()) o.write(chunk);
    for (const l of this.listeners) if (l.writableLength < 256 * 1024) l.write(chunk);
  }

  /** Wird bei TAKEOVER_COMPLETED / OFF_AIR aufgerufen. */
  setActive(sourceId: string | null): void {
    if (this.activeId === sourceId) return;
    const prev = this.activeId ? this.sessions.get(this.activeId) : undefined;
    this.activeId = sourceId;
    const next = sourceId ? this.sessions.get(sourceId) : undefined;
    // Formatwechsel: Mithörer trennen, damit Player nicht an gemischten Containern scheitern.
    if (!next || !prev || prev.contentType !== next.contentType || NEEDS_INIT.test(next.contentType)) {
      for (const l of this.listeners) l.end();
      this.listeners.clear();
    }
    this.stopTaps();
    if (!next) {
      for (const o of this.outputs()) o.stop();
      return;
    }
    if (!NEEDS_INIT.test(next.contentType) || next.init) {
      this.restartOutputs(next);
      this.startTaps(next);
    }
  }

  addTap(t: RelayTap): void {
    this.taps.add(t);
    const s = this.activeId ? this.sessions.get(this.activeId) : undefined;
    if (s && this.tapsStarted) t.onStart(s.contentType, s.init);
  }

  removeTap(t: RelayTap): void {
    if (this.taps.delete(t) && this.tapsStarted) t.onStop();
  }

  private startTaps(s: Session): void {
    this.tapsStarted = true;
    for (const t of this.taps) t.onStart(s.contentType, s.init);
  }

  private stopTaps(): void {
    if (!this.tapsStarted) return;
    this.tapsStarted = false;
    for (const t of this.taps) t.onStop();
  }

  addListener(res: ServerResponse): boolean {
    const s = this.activeId ? this.sessions.get(this.activeId) : undefined;
    if (!s) return false;
    res.writeHead(200, { 'Content-Type': s.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (s.init) res.write(s.init);
    this.listeners.add(res);
    res.on('close', () => this.listeners.delete(res));
    return true;
  }

  /** Bereits laufende Ausgänge (z. B. neu angelegt) mit aktivem Format starten. */
  startOutput(o: BroadcastOutput): void {
    const s = this.activeId ? this.sessions.get(this.activeId) : undefined;
    if (s && (!NEEDS_INIT.test(s.contentType) || s.init)) o.start(s.contentType, s.init);
  }

  status(): TargetStatus {
    const s = this.activeId ? this.sessions.get(this.activeId) : undefined;
    return {
      activeSourceId: this.activeId,
      contentType: s?.contentType ?? null,
      listeners: this.listeners.size,
      lastDataAt: s?.lastDataAt ?? null,
      bytesIn: s?.bytes ?? 0,
    };
  }

  /** Quellen ohne Daten seit maxIdleMs (für Health/Silence auf Transportebene). */
  staleSessions(maxIdleMs: number, now = Date.now()): string[] {
    return [...this.sessions.entries()].filter(([, s]) => now - s.lastDataAt > maxIdleMs).map(([id]) => id);
  }

  private restartOutputs(s: Session): void {
    for (const o of this.outputs()) o.start(s.contentType, s.init);
  }
}
