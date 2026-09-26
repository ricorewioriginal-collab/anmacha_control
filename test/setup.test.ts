import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { parseConf, resolveConfig, updateConf } from '../src/server/config.ts';
import { openDatabase } from '../src/server/db/index.ts';
import { DbDocStore } from '../src/server/repo/docs.ts';

const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-setup-'));
  const config = resolveConfig({ env: { AIRDECK_DATA: dir }, root: dir, packaged: false, desktop: true });
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null, config });
  return { dir, app, conf: () => parseConf(existsSync(config.configFile) ? readFileSync(config.configFile, 'utf8') : '') };
}

test('updateConf: Werte setzen, Kommentare behalten, neue Abschnitte, Entfernen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-conf-'));
  const f = join(dir, 'airdeck.conf');
  writeFileSync(f, '# Kopf\n# mode = local\n\n[network]\nport = 8750\n# bind = local\n');
  updateConf(f, { mode: 'server', 'network.port': 9000, 'database.provider': 'postgres' });
  const t = readFileSync(f, 'utf8');
  assert.ok(t.includes('# Kopf') && t.includes('# bind = local'), 'Kommentare bleiben');
  assert.deepEqual(parseConf(t), { mode: 'server', 'network.port': '9000', 'database.provider': 'postgres' });
  updateConf(f, { 'database.provider': null });
  assert.equal(parseConf(readFileSync(f, 'utf8'))['database.provider'], undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('Setup-Assistent: frische Installation, Schritte, Neustart-Hinweise, bestehende Installation', async () => {
  const { dir, app, conf } = fresh();
  try {
    let s = app.svc.setup.status() as { required: boolean; restart: string[]; steps: Record<string, string> };
    assert.equal(s.required, true, 'frische Installation → Assistent');
    await assert.rejects(app.svc.setup.apply(admin, 'welcome', {}), /Haftungsausschluss/);
    await app.svc.setup.apply(admin, 'welcome', { accept: true });
    await app.svc.setup.apply(admin, 'mode', { mode: 'server' });
    assert.equal(conf().mode, 'server');
    await assert.rejects(app.svc.setup.apply(admin, 'admin', { username: 'chef', password: 'kurz' }), /Passwort/);
    await app.svc.setup.apply(admin, 'admin', { username: 'chef', password: 'Sicheres-Passwort1' });
    assert.equal(app.users.count, 1);
    await app.svc.setup.apply(admin, 'network', { access: 'lan', port: 8760 });
    assert.equal(conf()['network.bind'], 'lan');
    assert.equal(conf()['network.port'], '8760');
    await app.svc.setup.apply(admin, 'station', { name: 'Radio Test', slogan: 'Nur Hits', genre: 'Pop' });
    assert.equal(app.svc.stations.station('main').name, 'Radio Test');
    await app.svc.setup.apply(admin, 'stream', { type: 'icecast', host: '127.0.0.1', port: 8000, mount: '/live', password: 'pw-123456' });
    assert.equal(app.outputs.size, 1);
    // Standardinstallation bleibt manuell: AutoDJ/Autostart nur nach expliziter Auswahl.
    await app.svc.setup.apply(admin, 'automation', {});
    assert.equal((app.playoutView('main') as { config: { autostart: boolean }, status: { running: boolean } }).config.autostart, false);
    assert.equal((app.playoutView('main') as { status: { running: boolean } }).status.running, false);
    await app.svc.setup.apply(admin, 'ai', { skip: true });
    s = (await app.svc.setup.apply(admin, 'finish', {})) as typeof s;
    assert.deepEqual(s.restart.sort(), ['mode', 'network']);
    assert.equal(s.steps.ai, 'skipped');
    assert.equal(s.required, false);
    // nach Neustart abgeschlossen
    app.docs.flushSync();
    const again = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
    assert.equal((again.svc.setup.status() as { completed: boolean }).completed, true);
    again.shutdown();
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Server-Erststart: automatisch angelegtes Admin-Konto (Einmal-Passwort) verhindert den Assistenten nicht', async () => {
  const { dir, app } = fresh();
  try {
    await app.users.create({ username: 'admin', name: 'Administrator', password: 'Einmal-Pass1', roles: ['admin'], stationIds: ['*'], mustChangePassword: true });
    assert.equal((app.svc.setup.status() as { required: boolean }).required, true);
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Bestehende Installation (mit Titeln) bekommt keinen Assistenten aufgezwungen', () => {
  const { dir, app } = fresh();
  try {
    app.svc.media.addMedia('main', { id: 'm1', title: 'x', artist: '', category: 'music', file: 'x.mp3', durationMs: 1000, addedAt: 0 });
    assert.equal((app.svc.setup.status() as { required: boolean }).required, false);
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Ordner einbinden: indizieren, überwachen, nie Originaldateien löschen', async () => {
  const { dir, app } = fresh();
  const music = mkdtempSync(join(tmpdir(), 'airdeck-musik-'));
  try {
    mkdirSync(join(music, 'Pop'));
    writeFileSync(join(music, 'Pop', 'Band - Song.mp3'), 'x');
    writeFileSync(join(music, 'Intro.ogg'), 'x');
    writeFileSync(join(music, 'notiz.txt'), 'x');
    await assert.rejects(app.svc.media.linkFolder('main', { path: 'relativ/pfad' }), /Vollständigen/);
    await assert.rejects(app.svc.media.linkFolder('main', { path: dir }), /Datenordner/);
    await app.svc.setup.apply(admin, 'storage', { link: music, category: 'music' });
    let lib = app.svc.media.library('main');
    assert.equal(lib.length, 2, 'nur Audiodateien');
    const song = lib.find((m) => m.title === 'Song')!;
    assert.equal(song.artist, 'Band');
    assert.equal(song.folder, 'Pop');
    assert.equal(app.svc.media.mediaPath('main', song), join(music, 'Pop', 'Band - Song.mp3'));
    await assert.rejects(app.svc.media.linkFolder('main', { path: join(music, 'Pop') }), /bereits eingebunden/);

    // aus der Bibliothek entfernen löscht die Datei NICHT
    app.svc.media.removeMedia('main', song.id);
    assert.ok(existsSync(join(music, 'Pop', 'Band - Song.mp3')));

    // Überwachung: neue Datei kommt dazu, gelöschte verschwindet (entfernte kommt beim nächsten Abgleich zurück)
    writeFileSync(join(music, 'Neu.flac'), 'x');
    rmSync(join(music, 'Intro.ogg'));
    await app.svc.media.scanLinked();
    lib = app.svc.media.library('main');
    assert.deepEqual(lib.map((m) => m.originalName).sort(), ['Band - Song.mp3', 'Neu.flac']);

    // Laufwerk weg: nichts entfernen
    const moved = `${music}-weg`;
    const { renameSync } = await import('node:fs');
    renameSync(music, moved);
    await app.svc.media.scanLinked();
    assert.equal(app.svc.media.library('main').length, 2);
    assert.equal(app.svc.media.linkedFolders('main')[0]!.error, 'Ordner nicht erreichbar');
    renameSync(moved, music);

    // Einbindung lösen: Einträge weg, Dateien bleiben
    assert.deepEqual(app.svc.media.unlinkFolder('main', music), { removed: 2 });
    assert.equal(app.svc.media.library('main').length, 0);
    assert.ok(existsSync(join(music, 'Neu.flac')));
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
    rmSync(music, { recursive: true, force: true });
  }
});

test('Datenbank wechseln: Verbindung testen, Daten übernehmen, Passwort verschlüsselt', { skip: !process.env.AIRDECK_TEST_PG && 'AIRDECK_TEST_PG nicht gesetzt' }, async () => {
  const { dir, app, conf } = fresh();
  try {
    await assert.rejects(app.svc.setup.apply(admin, 'database', { provider: 'postgres', url: 'postgres://x@127.0.0.1:1/x' }), /nicht erreichbar/);
    app.svc.stations.updateStation('main', { name: 'Umzugsradio' });
    const u = new URL(process.env.AIRDECK_TEST_PG!);
    const password = decodeURIComponent(u.password);
    u.password = '';
    await app.svc.setup.apply(admin, 'database', { provider: 'postgres', url: u.toString(), password });
    assert.equal(conf()['database.provider'], 'postgres');
    assert.ok(!readFileSync(app.config!.configFile, 'utf8').includes(password), 'Passwort nicht in der Datei');
    assert.equal(app.secrets.get('db:password'), password);
    const db = await openDatabase({ provider: 'postgres', url: u.toString(), password });
    const store = await DbDocStore.open(db);
    assert.equal((store.get<unknown>('airdeck', null) as { stations: { name: string }[] }).stations[0]!.name, 'Umzugsradio');
    await db.close();
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
