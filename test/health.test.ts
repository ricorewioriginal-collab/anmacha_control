import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthManager, aiState, nodeState, storageReport, type HealthSource } from '../src/server/health.ts';
import { detectFfmpeg, type FfmpegInfo } from '../src/server/ffmpeg.ts';
import { AirDeckApp } from '../src/server/app.ts';

const ff: FfmpegInfo = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ffplay: null, version: 'ffmpeg version 7.1 Copyright', encoders: { mp3: true, opus: true }, source: 'bundled' };

function source(dir: string, over: Partial<HealthSource> = {}): HealthSource {
  return {
    name: 'AirDeck', version: '1.2.3', build: 'dev', mode: 'local', packaged: false,
    paths: { config: dir, data: dir, media: dir, logs: join(dir, 'logs'), backups: join(dir, 'backups') },
    ffmpeg: () => ff,
    database: () => ({ provider: 'json', state: 'READY' }),
    aiProviders: () => [],
    outputs: () => [],
    encoders: () => [],
    ...over,
  };
}

test('Node-Version', () => {
  assert.equal(nodeState('22.18.0'), 'READY');
  assert.equal(nodeState('24.1.0'), 'READY');
  assert.equal(nodeState('22.17.9'), 'OUTDATED');
  assert.equal(nodeState('20.0.0'), 'OUTDATED');
});

test('KI-Zustand: aus, bereit, Fehler', () => {
  assert.equal(aiState([]).state, 'off');
  assert.equal(aiState([{ id: 'a', name: 'A', kind: 'openai', enabled: false, hasKey: false }]).state, 'off');
  assert.equal(aiState([{ id: 'a', name: 'A', kind: 'openai_compat', enabled: true, hasKey: false }]).state, 'ready');
  const r = aiState([{ id: 'a', name: 'A', kind: 'anthropic', enabled: true, hasKey: false }, { id: 'p', name: 'P', kind: 'piper', enabled: true, hasKey: false, binPath: '/gibt/es/nicht' }]);
  assert.equal(r.state, 'error');
  assert.equal(r.problems.length, 2);
});

test('Zusammenfassung: ok, ohne ffmpeg eingeschränkt, Stream-Zustand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-h-'));
  try {
    const ok = new HealthManager(source(dir)).summary();
    assert.equal(ok.status, 'ok');
    assert.equal(ok.encoder, 'idle');
    assert.equal(ok.stream, 'idle');
    assert.equal(ok.api, '1.0');

    const noFf = new HealthManager(source(dir, { ffmpeg: () => null }));
    assert.equal(noFf.summary().status, 'degraded');
    assert.equal(noFf.summary().audio, 'unavailable');
    assert.equal(noFf.dependencies().find((d) => d.id === 'ffmpeg')!.state, 'MISSING');

    const outs = [{ id: 'o1', stationId: 's1', name: 'Ice', status: 'connected' }, { id: 'o2', stationId: 's2', name: 'SC', status: 'error', error: 'auth' }];
    const h = new HealthManager(source(dir, { outputs: () => outs, encoders: () => [{ stationId: 's1', running: true, encoder: 'running', format: 'mp3', bitrateKbps: 128 }] }));
    assert.equal(h.summary().stream, 'connected');
    assert.equal(h.summary().encoder, 'running');
    // Senderfilter für Einzelberichte
    assert.deepEqual((h.stream((s) => s === 's2') as { outputs: unknown[] }).outputs.length, 1);
    // Ein fremder verbundener Sender darf den Fehler des eigenen Senders nicht verdecken.
    assert.equal((h.stream((s) => s === 's2') as { state: string }).state, 'error');
    assert.equal((h.stream((s) => s === 's1') as { state: string }).state, 'connected');
    assert.deepEqual(h.stream(() => false), { state: 'idle', outputs: [] });

    const noLame = new HealthManager(source(dir, { ffmpeg: () => ({ ...ff, encoders: { mp3: false, opus: true } }) }));
    assert.equal(noLame.dependencies().find((d) => d.id === 'ffmpeg')!.state, 'BROKEN');
    assert.equal(noLame.summary().encoder, 'unavailable');

    const dbErr = new HealthManager(source(dir, { database: () => ({ provider: 'json', state: 'BROKEN' }) }));
    assert.equal(dbErr.summary().status, 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Speicher: nicht vorhandener Datenordner = Fehler', () => {
  const r = storageReport({ config: '/x', data: '/gibt/es/nicht', media: '/gibt/es/nicht', logs: '/x', backups: '/x' });
  assert.equal(r.state, 'error');
});

test('ffmpeg: fehlgeschlagene Erkennung wird im Hintergrund wiederholt', { skip: !detectFfmpeg(process.cwd()) && 'kein ffmpeg im System' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-r-'));
  const path = process.env.PATH;
  process.env.PATH = '';
  const app = new AirDeckApp(dir, { appRoot: dir, ffmpegRetryS: [0.05, 0.05] });
  process.env.PATH = path;
  try {
    assert.equal(app.ffmpeg, null);
    assert.equal(app.health.summary().audio, 'unavailable');
    app.start();
    const end = Date.now() + 10_000;
    while (!app.ffmpeg && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.ok(app.ffmpeg, 'ffmpeg nach erneuter Suche gefunden');
    assert.equal(app.health.summary().audio, 'ok');
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
