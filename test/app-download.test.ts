import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';

test('APK-Download aus dem Windows-Paket, Netzwerk-Einstellung und Verbindungsinfo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'airdeck-root-'));
  const data = join(root, 'data');
  mkdirSync(join(root, 'android'), { recursive: true });
  const apk = Buffer.from('PK\x03\x04fake-apk');
  writeFileSync(join(root, 'android', 'AirDeck-Android.apk'), apk);
  const app = new AirDeckApp(data, { stableMs: 0, ffmpeg: null, appRoot: root });
  const token = app.createToken({ name: 'a', scopes: ['*'], roles: ['admin'], stationIds: ['*'] }).token;
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // öffentlich, damit das Handy sie ohne Login laden kann
    const r = await fetch(`${base}/download/AirDeck-Android.apk`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), apk);

    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const c1 = (await (await fetch(`${base}/api/v1/app/connect`, { headers: auth })).json()) as { lan: boolean; listening: boolean; apk: string };
    assert.equal(c1.lan, false);
    assert.equal(c1.apk, 'local');
    const c2 = (await (await fetch(`${base}/api/v1/app/network`, { method: 'PUT', headers: auth, body: JSON.stringify({ lan: true }) })).json()) as { lan: boolean; restartNeeded: boolean };
    assert.equal(c2.lan, true);
    assert.equal(c2.restartNeeded, !process.env.AIRDECK_HOST, 'Umschalten wirkt nach Neustart');
    // ohne Admin-Rechte kein Zugriff
    const dj = app.createToken({ name: 'dj', scopes: ['*'], roles: ['dj'], stationIds: ['main'] }).token;
    assert.equal((await fetch(`${base}/api/v1/app/connect`, { headers: { Authorization: `Bearer ${dj}` } })).status, 403);
  } finally {
    app.shutdown();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
