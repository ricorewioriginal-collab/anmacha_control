// Masterprompt V1 Beta, P2 #23 (Preflight/Simulation): "Ein UI-Button gilt nicht als Funktion" - es gab
// bisher überhaupt keine Möglichkeit, den Sendeplan VOR der Sendezeit auf fehlende Dateien/Streams, leere
// Ordner/Playlists oder zu kleine Pools zu prüfen; Probleme fielen erst live beim Abspielen auf. Dieser
// Test deckt echte, konkrete Fehlerbilder ab: gelöschte Datei, leerer Ordner, Playlist mit fehlenden
// Titeln, und ein Pool, der für die aktuell eingestellte Rotationsregel zu klein ist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import type { PreflightItem } from '../src/server/services/planning.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-preflight-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  return { app, done: () => { app.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Preflight: gelöschte Datei eines Zeitplan-Jobs wird als "missing" gemeldet', () => {
  const { app, done } = setup();
  try {
    app.setAutomation('main', { clock: { id: 'c', name: 'c', slots: [] } }); // keine Uhr-Vorlage-Pools in diesem Test
    writeFileSync(join(app.mediaDir, 'main', 'song.mp3'), 'fake-audio');
    app.svc.media.addMedia('main', { id: 'song', title: 'Song', artist: 'A', category: 'music', file: 'song.mp3', durationMs: 60_000, addedAt: 0 });
    app.svc.planning.saveJob('main', { at: Date.now() + 3_600_000, repeat: 'none', kind: 'media', mediaId: 'song', mode: 'now', label: 'Testsong' });
    // Datei nachträglich manuell weg (unvollständiges Backup/Restore, versehentlich gelöscht)
    unlinkSync(app.svc.media.mediaPath('main', app.svc.media.media('main', 'song')));

    const report = app.svc.planning.preflight('main');
    const item = report.items.find((i: PreflightItem) => i.source === 'job' && i.label === 'Testsong')!;
    assert.equal(item.status, 'missing');
    assert.match(item.message, /Song/);
    assert.equal(report.summary.problems, 1);
  } finally {
    done();
  }
});

test('Preflight: vergangener einmaliger Job wird nicht mehr geprüft, wiederkehrender schon', () => {
  const { app, done } = setup();
  try {
    app.svc.media.addMedia('main', { id: 'a', title: 'A', artist: '', category: 'music', file: 'a.mp3', durationMs: 60_000, addedAt: 0 });
    app.svc.planning.saveJob('main', { at: Date.now() - 3_600_000, repeat: 'none', kind: 'media', mediaId: 'a', mode: 'now', label: 'Vorbei' });
    app.svc.planning.saveJob('main', { at: Date.now() - 3_600_000, repeat: 'daily', kind: 'media', mediaId: 'a', mode: 'now', label: 'TäglichWiederkehrend' });
    const report = app.svc.planning.preflight('main');
    assert.ok(!report.items.some((i: PreflightItem) => i.label === 'Vorbei'), 'vergangener Einmal-Job wird nicht mehr geprüft');
    assert.ok(report.items.some((i: PreflightItem) => i.label === 'TäglichWiederkehrend'), 'wiederkehrender Job (auch mit Termin in der Vergangenheit) wird geprüft');
  } finally {
    done();
  }
});

test('Preflight: leerer Ordner eines Uhr-Events wird gemeldet, sobald er nachträglich leer wird', () => {
  const { app, done } = setup();
  try {
    app.svc.media.addMedia('main', { id: 'r1', title: 'R1', artist: '', category: 'music', file: 'r1.mp3', durationMs: 60_000, addedAt: 0, folder: 'Rock' });
    app.svc.planning.saveClockEvent('main', null, { kind: 'folder', folder: 'Rock', minutes: [0], hours: [], days: [], mode: 'track', label: 'Rockblock' });
    app.svc.media.removeMedia('main', 'r1'); // Ordner ist jetzt leer
    const report = app.svc.planning.preflight('main');
    const item = report.items.find((i: PreflightItem) => i.label === 'Rockblock')!;
    assert.equal(item.status, 'empty');
  } finally {
    done();
  }
});

test('Preflight: Playlist mit teils fehlenden Titeln wird als Warnung gemeldet, komplett leere als Problem', () => {
  const { app, done } = setup();
  try {
    writeFileSync(join(app.mediaDir, 'main', 'x1.mp3'), 'fake');
    writeFileSync(join(app.mediaDir, 'main', 'x2.mp3'), 'fake');
    app.svc.media.addMedia('main', { id: 'x1', title: 'X1', artist: '', category: 'music', file: 'x1.mp3', durationMs: 60_000, addedAt: 0 });
    app.svc.media.addMedia('main', { id: 'x2', title: 'X2', artist: '', category: 'music', file: 'x2.mp3', durationMs: 60_000, addedAt: 0 });
    const pl = app.svc.planning.savePlaylist('main', null, { name: 'Mix', items: ['x1', 'x2'] });
    app.svc.planning.savePlan('main', null, { label: 'Abendshow', days: [0], from: '20:00', to: '22:00', playlistId: pl.id, shuffle: false });
    // Datei nur auf der Platte weg (Eintrag/Playlist-Referenz bleiben, wie bei einem unvollständigen
    // Backup/Restore oder versehentlichem manuellem Löschen im Dateisystem)
    unlinkSync(join(app.mediaDir, 'main', 'x1.mp3'));
    let report = app.svc.planning.preflight('main');
    let item = report.items.find((i: PreflightItem) => i.label === 'Abendshow')!;
    assert.equal(item.status, 'warning');

    unlinkSync(join(app.mediaDir, 'main', 'x2.mp3'));
    report = app.svc.planning.preflight('main');
    item = report.items.find((i: PreflightItem) => i.label === 'Abendshow')!;
    assert.equal(item.status, 'empty');
  } finally {
    done();
  }
});

test('Preflight: Pool zu klein für aktuelle Rotationsregel wird als Warnung gemeldet (Uhr-Vorlage)', () => {
  const { app, done } = setup();
  try {
    for (const id of ['m1', 'm2']) {
      writeFileSync(join(app.mediaDir, 'main', `${id}.mp3`), 'fake');
      app.svc.media.addMedia('main', { id, title: id, artist: id, category: 'music', file: `${id}.mp3`, durationMs: 60_000, addedAt: 0 });
    }
    app.setAutomation('main', { clock: { id: 'c', name: 'c', slots: ['music'] }, rotation: { artistSeparation: 0, titleSeparation: 10, genreSeparation: 0 } });
    const report = app.svc.planning.preflight('main');
    const pool = report.items.find((i: PreflightItem) => i.source === 'pool' && i.label.includes('music'))!;
    assert.equal(pool.status, 'warning');
    assert.match(pool.message, /2 Titel/);

    // Mit gelockerter Regel (titleSeparation kleiner als Pool) ist derselbe Pool wieder ok
    app.setAutomation('main', { rotation: { artistSeparation: 0, titleSeparation: 1, genreSeparation: 0 } });
    const report2 = app.svc.planning.preflight('main');
    assert.equal(report2.items.find((i: PreflightItem) => i.source === 'pool')!.status, 'ok');
  } finally {
    done();
  }
});
