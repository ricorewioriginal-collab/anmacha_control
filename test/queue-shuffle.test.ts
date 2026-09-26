// Masterprompt V1 Beta, P2 #16 (Shuffle): "Queue mischen" nutzte PlayQueue.shuffle(), einen naiven
// Fisher-Yates ohne Interpreten-Trennung - dieselbe Art von Problem, die für Playlists in #13 schon
// behoben wurde. Jetzt verwendet app.shuffleQueue() dieselbe geteilte shuffleSeparated()-Logik wie die
// Playlist-Shuffle (keine zweite Implementierung).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-qshuffle-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  for (const [id, artist] of [['a1', 'A'], ['a2', 'A'], ['b1', 'B'], ['b2', 'B'], ['c1', 'C'], ['c2', 'C']] as const) {
    app.svc.media.addMedia('main', { id, title: `Titel ${id}`, artist, category: 'music', file: `${id}.mp3`, durationMs: 60_000, addedAt: 0 });
  }
  return { app, done: () => { app.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Queue mischen: kein naiver Zufall, Interpreten werden so weit möglich getrennt, alle Einträge bleiben erhalten', () => {
  const { app, done } = setup();
  try {
    for (const id of ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']) app.queueAdd('main', id);
    const artistOf = (id: string) => id[0]!;
    for (let i = 0; i < 100; i++) {
      app.shuffleQueue('main');
      const ids = (app.queueView('main') as { items: { mediaId: string }[] }).items.map((x) => x.mediaId);
      assert.deepEqual(ids.slice().sort(), ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'], 'keine Einträge verloren/verdoppelt');
      let adjacent = 0;
      for (let k = 1; k < ids.length; k++) if (artistOf(ids[k]!) === artistOf(ids[k - 1]!)) adjacent++;
      assert.ok(adjacent <= 1, `zu viele direkt aufeinanderfolgende gleiche Interpreten: ${ids.join(',')}`);
    }
  } finally {
    done();
  }
});
