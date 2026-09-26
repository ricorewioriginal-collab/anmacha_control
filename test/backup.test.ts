// Nutzerbericht/Masterprompt-Audit: Sicherung war nur in STORAGE.md dokumentiert, aber nirgends
// implementiert. Dieser Test beweist einen echten Sicherung->Datenverlust->Wiederherstellung-Ablauf,
// nicht nur dass die Funktion existiert und keinen Fehler wirft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import { DbDocStore } from '../src/server/repo/docs.ts';

test('Sicherung und Wiederherstellung: echter Datenverlust wird rückgängig gemacht', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-backup-'));
  try {
    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
    const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
    const { token } = app.svc.auth.createToken({ name: 't', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
    const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

    try {
      // Echten Zustand anlegen: zweiter Sender, Medien, Playlist
      assert.equal((await call('POST', '/stations', { id: 'zweiter', name: 'Zweiter Sender' })).status, 200);
      app.svc.media.addMedia('main', { id: 'm1', title: 'Titel A', artist: 'Band', category: 'music', file: 'a.mp3', durationMs: 180_000, addedAt: 1 });
      app.svc.media.addMedia('main', { id: 'm2', title: 'Titel B', artist: 'Band', category: 'music', file: 'b.mp3', durationMs: 200_000, addedAt: 2 });
      const pl = await (await call('POST', '/stations/main/playlists', { name: 'Meine Liste', color: '#19c3e6' })).json() as { id: string };
      await call('PATCH', `/stations/main/playlists/${pl.id}`, { items: ['m1', 'm2'] });
      await (app.docs as DbDocStore).flush();

      // Sicherung erstellen
      const backup = await app.svc.backup.create();
      assert.match(backup.file, /^airdeck-backup-.*\.tar\.gz$/);
      assert.ok(backup.bytes > 0);
      assert.ok(existsSync(join(dir, 'backups', backup.file)));
      assert.deepEqual(app.svc.backup.list().map((b) => b.file), [backup.file]);

      // Echter Datenverlust: zweiter Sender gelöscht, ein Medientitel entfernt, Playlist geändert
      app.svc.stations.deleteStation({ id: 'x', tokenId: 'x', roles: ['admin'], stationIds: ['*'], scopes: ['*'] }, 'zweiter');
      app.svc.media.removeMedia('main', 'm2');
      await call('PATCH', `/stations/main/playlists/${pl.id}`, { items: ['m1'] });
      await (app.docs as DbDocStore).flush();
      assert.equal(app.svc.stations.listStations({ id: 'x', tokenId: 'x', roles: ['admin'], stationIds: ['*'], scopes: ['*'] }).find((s) => s.id === 'zweiter'), undefined);

      // Wiederherstellen (kein requestRestart im Test verdrahtet -> restarting: false, DB-Stand ist trotzdem korrekt)
      const restored = await app.svc.backup.restore(backup.file);
      assert.equal(restored.restarting, false);
      assert.ok((restored.tables.stations ?? 0) >= 2, 'beide Sender wieder in der Tabelle');
      assert.ok((restored.tables.media ?? 0) >= 2, 'beide Medientitel wieder in der Tabelle');

      // Der laufende Prozess hält noch den alten (kaputten) Stand im Speicher - erst ein Neustart lädt aus der DB.
      // Das ist dokumentiertes Verhalten (STORAGE.md: "betroffene Dienste neu starten"), darum hier direkt
      // gegen die Datenbank prüfen, nicht gegen den Cache des laufenden Prozesses.
      server.closeAllConnections();
      server.close();
      app.shutdown();

      const app2 = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
      try {
        const p: Parameters<typeof app2.svc.stations.listStations>[0] = { id: 'x', tokenId: 'x', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
        const stations = app2.svc.stations.listStations(p).map((s) => s.id).sort();
        assert.deepEqual(stations, ['main', 'zweiter'], 'zweiter Sender ist nach Wiederherstellung wieder da');
        assert.deepEqual(app2.svc.media.library('main').map((m) => m.id).sort(), ['m1', 'm2'], 'beide Medientitel sind wieder da');
        assert.deepEqual(app2.svc.planning.playlists('main').find((x) => x.id === pl.id)?.items, ['m1', 'm2'], 'Playlist hat wieder beide Titel');
      } finally {
        app2.shutdown();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
});

test('Wiederherstellung: falsche Prüfsumme wird abgelehnt (kein stiller Datenverlust durch beschädigte Sicherung)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-backup-'));
  try {
    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
    try {
      const backup = await app.svc.backup.create();
      const { readFileSync, writeFileSync } = await import('node:fs');
      const { gunzipSync, gzipSync } = await import('node:zlib');
      const { readTar, writeTar } = await import('../src/server/tar.ts');
      const path = join(dir, 'backups', backup.file);
      const entries = readTar(gunzipSync(readFileSync(path)));
      // Echten Dateiinhalt verändern (nicht ein ungenutztes Tar-Header-Feld), ohne die Prüfsumme im Manifest anzupassen
      const stations = entries.find((e) => e.name === 'tables/stations.jsonl')!;
      stations.data = Buffer.concat([stations.data, Buffer.from('\nmanipuliert')]);
      writeFileSync(path, gzipSync(writeTar(entries)));
      await assert.rejects(app.svc.backup.restore(backup.file), /Prüfsumme/);
    } finally {
      app.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
});
