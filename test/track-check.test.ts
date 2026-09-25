import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeTrack, detectFfmpeg, type TrackAnalysis } from '../src/server/ffmpeg.ts';
import { applyTrackCheck, trackWarnings } from '../src/server/services/media.ts';
import type { MediaItem } from '../src/core/automation.ts';

const ff = detectFfmpeg(process.cwd());

test('Track-Check mit echten Dateien: Stille, Übersteuerung, Einblendung, stille Datei', { skip: !ff && 'ffmpeg fehlt', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-tc-'));
  const gen = (name: string, args: string[]) => {
    execFileSync(ff!.ffmpeg, ['-loglevel', 'error', '-y', ...args, join(dir, name)]);
    return join(dir, name);
  };
  try {
    const pad = await analyzeTrack(ff!.ffmpeg, gen('pad.wav', ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=44100', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1']));
    assert.equal(pad!.leadSilenceMs, 1000);
    assert.equal(pad!.tailSilenceMs, 4000);
    assert.ok(pad!.lufs !== null);
    const clip = await analyzeTrack(ff!.ffmpeg, gen('clip.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=2', '-af', 'volume=12']));
    assert.ok(clip!.clippedSamples > 1000, 'Übersteuerung erkannt');
    const fade = await analyzeTrack(ff!.ffmpeg, gen('fade.wav', ['-f', 'lavfi', '-i', 'sine=f=440:d=3', '-af', 'afade=t=in:d=2']));
    assert.equal(fade!.leadSilenceMs, null, 'leise Einblendung wird nicht abgeschnitten');
    const still = await analyzeTrack(ff!.ffmpeg, gen('still.wav', ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2']));
    assert.equal(still!.silent, true);
    assert.equal(still!.leadSilenceMs, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cue-Punkte: automatisch gesetzt, bei Neumessung aktualisiert, von Hand gesetzte bleiben', () => {
  const r = (lead: number | null, tail: number | null, extra: Partial<TrackAnalysis> = {}): TrackAnalysis =>
    ({ lufs: -14, truePeakDb: -1, durationMs: 200_000, leadSilenceMs: lead, tailSilenceMs: tail, clippedSamples: 0, bitrateKbps: 320, silent: false, ...extra });
  const m: MediaItem = { id: 'm', title: 't', artist: '', category: 'music', file: 'x.mp3', durationMs: 200_000, addedAt: 0 };
  applyTrackCheck(m, r(800, 195_000));
  assert.equal(m.cueInMs, 780);
  assert.equal(m.cueOutMs, 195_020);
  assert.equal(m.lufs, -14);
  // erneute Messung ohne Stille: automatische Punkte verschwinden wieder
  applyTrackCheck(m, r(null, null));
  assert.equal(m.cueInMs, undefined);
  assert.equal(m.cueOutMs, undefined);
  // von Hand gesetzt → unangetastet
  m.cueInMs = 5000;
  applyTrackCheck(m, r(800, 195_000));
  assert.equal(m.cueInMs, 5000);
  assert.equal(m.cueOutMs, 195_020);
  // zu kurze Stille wird ignoriert
  const n: MediaItem = { ...m, cueInMs: undefined, cueOutMs: undefined, check: undefined };
  applyTrackCheck(n, r(100, 199_800));
  assert.equal(n.cueInMs, undefined);
  assert.equal(n.cueOutMs, undefined);
  // Hinweise
  applyTrackCheck(n, r(null, null, { clippedSamples: 5000, bitrateKbps: 96 }));
  assert.deepEqual(trackWarnings(n), ['übersteuert (Clipping)', 'niedrige Bitrate (96 kbit/s)']);
});
