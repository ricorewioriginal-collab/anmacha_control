import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { analyzeLoudness, detectFfmpeg } from '../src/server/ffmpeg.ts';
import { DSP_PRESETS, dspFilter, trackGainDb } from '../src/server/playout.ts';
import type { MediaItem } from '../src/core/automation.ts';

const ff = detectFfmpeg(process.cwd());
const item = (p: Partial<MediaItem>): MediaItem => ({ id: 'x', title: 't', artist: 'a', category: 'music', file: 'x.mp3', durationMs: 1000, addedAt: 0, ...p });

test('Lautheitsangleich: Ziel, Grenzen, Spitzenpegel, manueller Gain hat Vorrang', () => {
  const loud = { auto: true, targetLufs: -16 };
  assert.equal(trackGainDb(item({ lufs: -20, truePeakDb: -6 }), loud, true), 4);
  assert.equal(trackGainDb(item({ lufs: -8, truePeakDb: 0 }), loud, true), -8);
  assert.equal(trackGainDb(item({ lufs: -40, truePeakDb: -30 }), loud, true), 12, 'höchstens +12 dB');
  assert.equal(trackGainDb(item({ lufs: -22, truePeakDb: -2 }), loud, false), 1, 'ohne Limiter bis −1 dBTP');
  assert.equal(trackGainDb(item({ lufs: -22, truePeakDb: -2 }), loud, true), 4, 'mit Limiter 3 dB Reserve');
  assert.equal(trackGainDb(item({ lufs: -20, gainDb: -3 }), loud, true), -3);
  assert.equal(trackGainDb(item({ lufs: -20, category: 'voice_track' }), loud, true), 0, 'Sprache bleibt unangetastet');
  assert.equal(trackGainDb(item({ lufs: -20 }), { auto: false, targetLufs: -16 }, true), 0);
  assert.equal(trackGainDb(item({}), loud, true), 0, 'ohne Messung keine Änderung');
});

test('Klangprofile ergeben gültige ffmpeg-Filterketten', { skip: !ff && 'ffmpeg nicht installiert' }, () => {
  for (const [name, p] of Object.entries(DSP_PRESETS)) {
    const f = dspFilter(p.dsp);
    assert.ok(f, name);
    execFileSync(ff!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=0.5', '-ac', '2', '-af', f!, '-f', 'null', '-']);
  }
  assert.match(dspFilter({ ...DSP_PRESETS.pop!.dsp, targetLufs: -99 })!, /loudnorm=I=-30/, 'Ziel wird begrenzt');
});

test('Titel werden automatisch gemessen (EBU R128)', { skip: !ff && 'ffmpeg nicht installiert', timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-loud-'));
  try {
    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    mkdirSync(join(dir, 'media', 'main'), { recursive: true });
    const file = join(dir, 'media', 'main', 'leise.mp3');
    execFileSync(ff!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-af', 'volume=-20dB', '-c:a', 'libmp3lame', '-b:a', '128k', file]);
    const direct = await analyzeLoudness(ff!.ffmpeg, file);
    assert.ok(direct && direct.lufs < -30 && direct.lufs > -55, `LUFS plausibel: ${direct?.lufs}`);
    const m = app.addMedia('main', item({ id: 'm1', file: 'leise.mp3', durationMs: null }));
    for (let i = 0; i < 100 && m.lufs == null; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(m.lufs, direct!.lufs);
    assert.ok(m.truePeakDb! < 0);
    assert.deepEqual(app.loudnessStatus('main'), { total: 1, measured: 1, pending: 0, running: false });
    app.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
