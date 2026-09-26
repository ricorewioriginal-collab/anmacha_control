import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-workflows-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  for (const [id, artist] of [['a','Alpha'],['b','Beta'],['c','Gamma']] as const) {
    app.svc.media.addMedia('main', {
      id, title: `Titel ${id.toUpperCase()}`, artist, category: 'music',
      file: `${id}.mp3`, durationMs: 60_000, addedAt: 0,
    });
  }
  return { dir, app };
}

test('Playlist → Queue: Abspielen ersetzt die Queue in Playlist-Reihenfolge', () => {
  const { dir, app } = fresh();
  try {
    app.queueAdd('main', 'c');
    const pl = app.svc.planning.savePlaylist('main', null, { name: 'Morgen', items: ['a','b'] });
    app.svc.planning.playPlaylist('main', pl.id);
    const q = app.queueView('main') as { items: { mediaId: string; origin: string }[] };
    assert.deepEqual(q.items.map((x) => x.mediaId), ['a','b']);
    assert.ok(q.items.every((x) => x.origin === 'manual'));
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Sendeplan → AutoFill: aktive Sendung befüllt die Queue aus ihrer Playlist', () => {
  const { dir, app } = fresh();
  try {
    const pl = app.svc.planning.savePlaylist('main', null, { name: 'Tagesprogramm', items: ['b','c'] });
    app.svc.planning.savePlan('main', null, {
      label: 'Ganztags-Test',
      days: [],
      from: '00:00',
      to: '23:59',
      playlistId: pl.id,
      shuffle: false,
    });
    app.rt('main').queue.clear();
    app.autoFill(app.rt('main'), true);
    const q = app.queueView('main') as { items: { mediaId: string; origin: string }[] };
    assert.ok(q.items.length > 0, 'aktive Sendung muss die Queue befüllen');
    assert.ok(q.items.every((x) => ['b','c'].includes(x.mediaId)), 'nur Titel der geplanten Playlist');
    assert.ok(q.items.every((x) => x.origin === 'plan'), 'Herkunft muss Sendeplan sein');
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Sendeplan schützt verwendete Playlist vor Löschen', () => {
  const { dir, app } = fresh();
  try {
    const pl = app.svc.planning.savePlaylist('main', null, { name: 'Fix', items: ['a'] });
    app.svc.planning.savePlan('main', null, {
      label: 'Fixe Sendung', days: [], from: '08:00', to: '09:00', playlistId: pl.id, shuffle: false,
    });
    assert.throws(() => app.svc.planning.deletePlaylist('main', pl.id), /Sendeplan/);
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
