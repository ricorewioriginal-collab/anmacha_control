import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, openSqliteSync, databaseConfig } from '../src/server/db/index.ts';
import { SCHEMA_VERSION, upsertSql, deleteSql } from '../src/server/db/schema.ts';
import { DbDocStore, importJsonFiles } from '../src/server/repo/docs.ts';
import type { DatabaseProvider } from '../src/server/db/types.ts';

const state = () => ({
  version: 1,
  stations: [{ id: 'main', name: 'Radio' }, { id: 'b', name: 'Zwei' }],
  sources: [{ id: 's1', stationId: 'main', priority: 1 }],
  outputs: [{ id: 'o1', stationId: 'b', name: 'Ice' }],
  data: {
    main: {
      library: [{ id: 'm1', title: 'Eins', artist: 'A', category: 'music', file: 'm1.mp3', durationMs: 1000, addedAt: 5 }, { id: 'm2', title: 'Zwei', category: 'jingle', file: 'm2.mp3' }],
      queue: [{ uid: 'q1', mediaId: 'm2', addedAt: 1, origin: 'manual' }, { uid: 'q2', mediaId: 'm1', addedAt: 2, origin: 'clock' }],
      clock: { id: 'c', name: 'Uhr', slots: ['music'] },
      cardwall: [], rotation: { artistSeparation: 3 }, history: ['m1'], clockCursor: 2, autoFill: true, minQueue: 3,
      playlists: [{ id: 'p1', name: 'Morgen', color: '#fff', items: ['m1', 'm2', 'm1'] }],
      playLog: [{ at: 10, mediaId: 'm1', title: 'Eins', artist: 'A', category: 'music' }],
      jobs: [{ id: 'j1', at: 0 }],
      lautfm: { station: 'x' },
    },
    b: { library: [], queue: [], cardwall: [], history: [], clockCursor: 0, autoFill: false, minQueue: 0 },
  },
});

/** Dieselben Prüfungen für jede Datenbank (DATABASE.md „Tests“) */
async function roundtrip(db: DatabaseProvider) {
  const a = await DbDocStore.open(db);
  const s = state();
  a.set('airdeck', s);
  a.set('users', [{ id: 'u1', username: 'admin', createdAt: '1' }]);
  a.set('bridge-keys', { 'az:1': 'main' });
  a.set('ai', { providers: [] });
  await a.flush();
  assert.equal(a.status().state, 'ok');

  const b = await DbDocStore.open(db);
  assert.deepEqual(b.get('airdeck', null), s);
  assert.deepEqual(b.get('users', null), [{ id: 'u1', username: 'admin', createdAt: '1' }]);
  assert.deepEqual(b.get('bridge-keys', null), { 'az:1': 'main' });
  assert.deepEqual(b.get('ai', null), { providers: [] });

  // Änderungen: umsortieren, löschen, hinzufügen – nur diese Zeilen werden geschrieben
  const s2 = state();
  s2.data.main.queue.reverse();
  s2.data.main.library.pop();
  s2.data.main.playlists[0]!.items = ['m1'];
  s2.stations.pop();
  delete (s2.data as Record<string, unknown>).b;
  s2.outputs = [];
  b.set('airdeck', s2);
  await b.flush();
  const c = await DbDocStore.open(db);
  assert.deepEqual(c.get('airdeck', null), s2);
  assert.equal((await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM media'))[0]!.n, 1);
  // Einstellungen der Sender und globale Einstellungen löschen sich nicht gegenseitig
  assert.deepEqual(c.get('ai', null), { providers: [] });
}

test('SQLite: Migration, Laden/Speichern, nur Änderungen, Übernahme der JSON-Dateien', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-db-'));
  try {
    const db = openSqliteSync(join(dir, 'airdeck.db'));
    assert.equal((await db.query<{ value: string }>("SELECT value FROM meta WHERE name = 'schema_version'"))[0]!.value, String(SCHEMA_VERSION));
    await roundtrip(db);

    // synchroner Start und synchrones letztes Speichern
    const s = DbDocStore.openSync(db);
    s.set('update', { tag: 'latest' });
    s.flushSync();
    assert.deepEqual(DbDocStore.openSync(db).get('update', null), { tag: 'latest' });
    await db.close();

    // JSON-Übernahme: Dateien werden eingelesen und umbenannt, nicht gelöscht
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify([{ id: 't1', hash: 'h', createdAt: 'x' }]));
    writeFileSync(join(dir, 'nextcloud.json'), '{"url":"https://nc"}');
    writeFileSync(join(dir, 'ai.json'), '{kaputt');
    const db2 = openSqliteSync(join(dir, 'airdeck.db'));
    const st = DbDocStore.openSync(db2);
    const got = await importJsonFiles(dir, st);
    assert.deepEqual(got.sort(), ['nextcloud', 'tokens']);
    assert.ok(existsSync(join(dir, 'tokens.json.imported')) && !existsSync(join(dir, 'tokens.json')));
    assert.deepEqual(DbDocStore.openSync(db2).get('tokens', null), [{ id: 't1', hash: 'h', createdAt: 'x' }]);
    // bisheriger KI-Stand aus der Datenbank bleibt, die defekte Datei wird gesichert
    assert.deepEqual(DbDocStore.openSync(db2).get('ai', null), { providers: [] });
    await db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Datenbank ausgefallen: Stand bleibt im Speicher, Schreiben wird wiederholt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-db-'));
  try {
    const db = openSqliteSync(join(dir, 'airdeck.db'));
    const s = DbDocStore.openSync(db);
    let fail = true;
    const orig = db.transaction.bind(db);
    db.transaction = (async (fn: never) => {
      if (fail) throw new Error('Verbindung verloren');
      return orig(fn);
    }) as typeof db.transaction;
    const events: string[] = [];
    s.onStatus = (x) => events.push(x.state);
    s.set('update', { tag: 'x' });
    await assert.rejects(s.flush());
    assert.equal(s.status().state, 'error');
    assert.deepEqual(s.get('update', null), { tag: 'x' });
    fail = false;
    await s.flush();
    assert.equal(s.status().state, 'ok');
    assert.deepEqual(events, ['error', 'ok']);
    assert.deepEqual(DbDocStore.openSync(db).get('update', null), { tag: 'x' });
    await db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQL-Hilfen je Dialekt', () => {
  assert.equal(upsertSql('sqlite', 't', ['a', 'b'], ['a'], 2), 'INSERT INTO t (a, b) VALUES (?, ?), (?, ?) ON CONFLICT (a) DO UPDATE SET b = excluded.b');
  assert.equal(upsertSql('mysql', 't', ['a', 'b'], ['a']), 'INSERT INTO t (a, b) VALUES (?, ?) ON DUPLICATE KEY UPDATE b = VALUES(b)');
  assert.equal(deleteSql('t', ['a', 'b'], 2), 'DELETE FROM t WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)');
  const c = databaseConfig({ 'database.provider': 'MariaDB', 'database.url': 'mysql://u:p@h/db' }, {}, '/d');
  assert.equal(c.provider, 'mysql');
  assert.equal(databaseConfig({}, {}, '/d').url, join('/d', 'airdeck.db'));
});

// Server-Datenbanken: in der CI als Service-Container (AIRDECK_TEST_PG / AIRDECK_TEST_MYSQL_URL)
for (const [provider, env] of [['postgres', 'AIRDECK_TEST_PG'], ['mysql', 'AIRDECK_TEST_MYSQL_URL'], ['mysql', 'AIRDECK_TEST_MARIADB_URL']] as const) {
  test(`${env}: dieselben Prüfungen`, { skip: !process.env[env] && `${env} nicht gesetzt` }, async () => {
    const db = await openDatabase({ provider, url: process.env[env]! });
    try {
      for (const t of ['stations', 'sources', 'outputs', 'media', 'queue_items', 'playlists', 'playlist_items', 'clock_templates', 'play_log', 'jobs', 'settings', 'users', 'bridge_keys']) await db.exec(`DELETE FROM ${t}`);
      await roundtrip(db);
      assert.ok((await db.health()).ok);
    } finally {
      await db.close();
    }
  });
}

test('postgres: Passwort getrennt von der Adresse (AIRDECK_DB_PASSWORD)', { skip: !process.env.AIRDECK_TEST_PG && 'AIRDECK_TEST_PG nicht gesetzt' }, async () => {
  const u = new URL(process.env.AIRDECK_TEST_PG!);
  const password = decodeURIComponent(u.password);
  u.password = '';
  const db = await openDatabase({ provider: 'postgres', url: u.toString(), password });
  try {
    assert.ok((await db.health()).ok);
  } finally {
    await db.close();
  }
});
