// Mitschnitte (Recorder/Replays) und Aufnahme-Zeitfenster.

import type { AirDeckApp } from '../app.ts';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateWindow, type RecordingPlan } from '../../core/scheduler.ts';
import { AppError, newId, type ActiveRecording, type Recording } from '../model.ts';

export class RecorderService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  readonly recorders = new Map<string, ActiveRecording>();

  recordings(stationId: string): unknown {
    const rt = this.app.rt(stationId);
    const active = this.recorders.get(stationId);
    return { recordings: [...(rt.data.recordings ?? [])].reverse(), recording: active ? active.rec : null, recPlans: rt.data.recPlans ?? [] };
  }

  startRecording(stationId: string, label?: string, planId?: string, target = '/live'): Recording {
    const rt = this.app.rt(stationId);
    if (this.recorders.has(stationId)) throw new AppError(409, 'busy', 'Es läuft bereits eine Aufnahme');
    const dir = join(this.app.dataDir, 'recordings', stationId);
    mkdirSync(dir, { recursive: true });
    const baseLabel = (label?.trim() || `Mitschnitt ${new Date().toLocaleString('de-DE')}`).slice(0, 80);
    let part = 0;
    const active: ActiveRecording = {
      rec: { id: '', label: baseLabel, startedAt: Date.now(), bytes: 0, contentType: '', file: '', planId },
      stream: null,
      target,
      tap: {
        onStart: (type, init) => {
          part++;
          const ext = type.includes('mpeg') ? 'mp3' : type.includes('ogg') ? 'ogg' : type.includes('webm') ? 'webm' : type.includes('aac') ? 'aac' : 'bin';
          const rec: Recording = { id: newId('rec'), label: part > 1 ? `${baseLabel} (Teil ${part})` : baseLabel, startedAt: Date.now(), bytes: 0, contentType: type, file: '', planId };
          rec.file = `${rec.id}.${ext}`;
          active.rec = rec;
          active.stream = createWriteStream(join(dir, rec.file));
          (rt.data.recordings ??= []).push(rec);
          if (init) this.recWrite(active, init);
          this.app.publish('recorder.changed', stationId, this.recordings(stationId));
          this.app.changed();
        },
        onData: (chunk) => this.recWrite(active, chunk),
        onStop: () => {
          active.stream?.end();
          active.stream = null;
          active.rec.endedAt = Date.now();
          this.app.changed();
        },
      },
    };
    this.recorders.set(stationId, active);
    this.app.relayFor(stationId, target).addTap(active.tap);
    this.app.audit.write({ kind: 'recorder', event: 'start', stationId, planId });
    this.app.publish('recorder.changed', stationId, this.recordings(stationId));
    return active.rec;
  }

  stopRecording(stationId: string): void {
    const active = this.recorders.get(stationId);
    if (!active) return;
    this.recorders.delete(stationId);
    this.app.relayFor(stationId, active.target).removeTap(active.tap);
    this.app.audit.write({ kind: 'recorder', event: 'stop', stationId });
    this.app.publish('recorder.changed', stationId, this.recordings(stationId));
    this.app.changed();
  }

  recWrite(active: ActiveRecording, chunk: Buffer): void {
    if (!active.stream) return;
    // Platte zu langsam: lieber Lücke als Speicher volllaufen lassen
    if (active.stream.writableLength > 8 * 1024 * 1024) return;
    active.stream.write(chunk);
    active.rec.bytes += chunk.length;
  }

  recordingFile(stationId: string, id: string): { path: string; rec: Recording } {
    const rec = this.app.rt(stationId).data.recordings?.find((r) => r.id === id);
    if (!rec) throw new AppError(404, 'not_found', 'Aufnahme nicht gefunden');
    return { path: join(this.app.dataDir, 'recordings', stationId, rec.file), rec };
  }

  deleteRecording(stationId: string, id: string): void {
    const rt = this.app.rt(stationId);
    const { path, rec } = this.recordingFile(stationId, id);
    if (this.recorders.get(stationId)?.rec.id === rec.id) throw new AppError(409, 'busy', 'Aufnahme läuft noch');
    rmSync(path, { force: true });
    rt.data.recordings = (rt.data.recordings ?? []).filter((r) => r.id !== id);
    this.app.publish('recorder.changed', stationId, this.recordings(stationId));
    this.app.changed();
  }

  saveRecPlan(stationId: string, id: string | null, input: Record<string, unknown>): RecordingPlan {
    const rt = this.app.rt(stationId);
    const list = (rt.data.recPlans ??= []);
    const plan: RecordingPlan = {
      id: id ?? newId('rp'), label: String(input.label ?? 'Aufnahme').slice(0, 80), days: Array.isArray(input.days) ? input.days.map(Number) : [],
      from: String(input.from ?? ''), to: String(input.to ?? ''),
    };
    try {
      validateWindow(plan);
    } catch (err) {
      throw new AppError(400, 'invalid_window', (err as Error).message);
    }
    const i = list.findIndex((p) => p.id === plan.id);
    if (i === -1) list.push(plan);
    else list[i] = plan;
    this.app.publish('recorder.changed', stationId, this.recordings(stationId));
    this.app.changed();
    return plan;
  }

  deleteRecPlan(stationId: string, id: string): void {
    const rt = this.app.rt(stationId);
    rt.data.recPlans = (rt.data.recPlans ?? []).filter((p) => p.id !== id);
    this.app.publish('recorder.changed', stationId, this.recordings(stationId));
    this.app.changed();
  }
}
