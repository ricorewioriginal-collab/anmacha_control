// Masterprompt V1 Beta, P1 #13 (Playlistverwaltung): Playlists kannten bisher nur eine feste
// Reihenfolge. Neu: Modus "shuffle" mit Interpreten-Trennung (kein naiver Zufall) und "Jetzt neu
// mischen". Dieser Test prüft echtes Verhalten: gespeicherte Reihenfolge, tatsächliches Mischen,
// Interpreten-Trennung so weit möglich, und dass "Abspielen" die richtige Reihenfolge in die Queue legt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { shuffleSeparated } from '../src/server/services/planning.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-plmode-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  // Zwei Titel je Interpret, damit eine naive Mischung oft direkt nebeneinander landen würde
  for (const [id, artist] of [['a1', 'A'], ['a2', 'A'], ['b1', 'B'], ['b2', 'B'], ['c1', 'C'], ['c2', 'C']] as const) {
    app.svc.media.addMedia('main', { id, title: `Titel ${id}`, artist, category: 'music', file: `${id}.mp3`, durationMs: 60_000, addedAt: 0 });
  }
  return { dir, app, done: () => { app.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('shuffleSeparated: löst direkt aufeinanderfolgende gleiche Interpreten auf, wenn möglich', () => {
  const artistOf = (id: string) => id[0]!;
  for (let i = 0; i < 200; i++) {
    const order = shuffleSeparated(['a1', 'a2', 'b1', 'b2', 'c1', 'c2'], artistOf);
    assert.equal(new Set(order).size, 6, 'keine Titel verloren/verdoppelt');
    let adjacent = 0;
    for (let k = 1; k < order.length; k++) if (artistOf(order[k]!) === artistOf(order[k - 1]!)) adjacent++;
    assert.ok(adjacent <= 1, `zu viele direkt aufeinanderfolgende gleiche Interpreten: ${order.join(',')}`);
  }
});

test('Playlist-Modus "shuffle": gespeicherte Mischung, "Jetzt neu mischen", Abspielen nutzt Mischung', () => {
  const { app, done } = setup();
  try {
    const pl = app.svc.planning.savePlaylist('main', null, { name: 'Mix', items: ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'], mode: 'shuffle' });
    assert.equal(pl.mode, 'shuffle');
    assert.equal(pl.shuffleOrder, undefined, 'noch nicht gemischt');

    app.svc.planning.playPlaylist('main', pl.id);
    const first = (app.queueView('main') as { items: { mediaId: string }[] }).items.map((x) => x.mediaId);
    assert.equal(new Set(first).size, 6);
    assert.notDeepEqual(first, pl.items, 'Queue folgt nicht einfach der gespeicherten Reihenfolge (außer durch Zufall)');
    const savedOrder = app.svc.planning.playlists('main').find((p) => p.id === pl.id)!.shuffleOrder;
    assert.deepEqual(savedOrder, first, 'Mischung wird auf der Playlist gespeichert, nicht bei jedem Abspielen neu gewürfelt');

    // Erneutes Abspielen nutzt dieselbe gespeicherte Reihenfolge
    app.svc.planning.playPlaylist('main', pl.id);
    const second = (app.queueView('main') as { items: { mediaId: string }[] }).items.map((x) => x.mediaId);
    assert.deepEqual(second, first);

    // "Jetzt neu mischen": explizit angefordert, kann (muss aber nicht) eine andere Reihenfolge ergeben
    let changed = false;
    for (let i = 0; i < 20 && !changed; i++) {
      app.svc.planning.reshufflePlaylist('main', pl.id);
      const reshuffled = app.svc.planning.playlists('main').find((p) => p.id === pl.id)!.shuffleOrder;
      if (JSON.stringify(reshuffled) !== JSON.stringify(first)) changed = true;
    }
    assert.ok(changed, '"Jetzt neu mischen" liefert über mehrere Versuche tatsächlich andere Reihenfolgen');

    // Zurück auf "manuell": Abspielen folgt wieder exakt der gespeicherten Reihenfolge
    app.svc.planning.savePlaylist('main', pl.id, { mode: 'manual' });
    app.svc.planning.playPlaylist('main', pl.id);
    const manual = (app.queueView('main') as { items: { mediaId: string }[] }).items.map((x) => x.mediaId);
    assert.deepEqual(manual, pl.items);

    // Ändern der Titel-Liste macht eine gespeicherte Mischung ungültig
    app.svc.planning.savePlaylist('main', pl.id, { mode: 'shuffle' });
    app.svc.planning.reshufflePlaylist('main', pl.id);
    app.svc.planning.savePlaylist('main', pl.id, { items: ['a1', 'b1', 'c1'] });
    assert.equal(app.svc.planning.playlists('main').find((p) => p.id === pl.id)!.shuffleOrder, undefined);
  } finally {
    done();
  }
});
