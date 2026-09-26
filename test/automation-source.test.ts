// Nutzerbericht: Automation muss erkennen, ob AirDeck-Server-Playout oder laut.fm (über den
// Radioadmin) einen Sender automatisiert - und bei laut.fm den echten aktuellen Titel zeigen statt
// leerer Decks (den nächsten Titel kennt AirDeck dabei nicht, laut.fm veröffentlicht ihn nicht vorab).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mock = createServer((req, res) => {
  const j = (d: unknown) => res.end(JSON.stringify(d));
  if (req.url === '/station/meinsender') return j({ name: 'meinsender', display_name: 'Mein Sender' });
  if (req.url === '/station/meinsender/current_song') return j({ title: 'Titelmelodie', artist: { name: 'DJ Beispiel' } });
  if (req.url === '/station/meinsender/listeners') return j(3);
  if (req.url === '/station/meinsender/last_songs') return j([]);
  res.writeHead(404).end();
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
process.env.AIRDECK_LAUTFM_API_URL = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

const { AirDeckApp } = await import('../src/server/app.ts');
const { createHttpServer } = await import('../src/server/http.ts');

test('Automationsquelle erkennen: AirDeck-Playout, laut.fm (Radioadmin) oder keine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-autosrc-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = app.svc.auth.createToken({ name: 't', scopes: ['*'], roles: ['admin'], stationIds: ['*'] }).token;
  const get = () => fetch(`${base}/api/v1/stations/main/automation-source`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()) as Promise<{ source: string; now: unknown }>;
  try {
    // Weder AirDeck-Playout noch laut.fm verbunden
    assert.deepEqual(await get(), { source: 'none', now: null });

    // laut.fm verbunden (Radioadmin macht die Automation) - echter Titel aus der öffentlichen API
    app.rt('main').data.lautfm = { stationName: 'meinsender' };
    const r = await get();
    assert.equal(r.source, 'lautfm');
    assert.deepEqual(r.now, { artist: 'DJ Beispiel', title: 'Titelmelodie', started_at: null, ends_at: null });

    // AirDeck-Server-Playout hat Vorrang, auch wenn nebenbei noch laut.fm konfiguriert ist
    app.playouts.set('main', { playout: { status: () => ({ running: true }), stop: () => {} } } as never);
    assert.deepEqual(await get(), { source: 'airdeck', now: null });
  } finally {
    app.shutdown();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => new Promise<void>((r) => mock.close(() => r())));
