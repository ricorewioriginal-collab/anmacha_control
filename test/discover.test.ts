// Masterprompt P0#6 "Pairing-Probleme": discovery.ts (echte UDP-LAN-Erkennung, node:dgram) existierte
// bereits und ist unit-getestet (test/devices.test.ts), war aber an KEINER Stelle der Studio-UI
// erreichbar - reine tote Backend-Logik, kein Browser kann selbst UDP sprechen. Neuer Endpunkt
// GET /discover lässt den Browser den bereits verbundenen Server stellvertretend suchen, eingebaut ins
// "Server wechseln"-Menü (App.js discoverServers()). Dieser Test prüft den neuen HTTP-Vertrag: nur für
// Administration, liefert die echten discover()-Ergebnisse durch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import { startResponder, DISCOVERY_PORT } from '../src/server/discovery.ts';

test('GET /discover: nur für Administration, findet echte AirDeck-Instanzen im Netz (echtes UDP, kein Mock)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-disc-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const admin = app.svc.auth.createToken({ name: 'admin', scopes: ['*'], roles: ['admin'], stationIds: ['*'] }).token;
  const viewer = app.svc.auth.createToken({ name: 'v', scopes: [], roles: ['viewer'], stationIds: ['main'] }).token;

  // Eigener Responder auf dem echten Standardport (wie main.ts es im Betrieb auch tut) - falls der
  // Port in dieser Umgebung schon belegt ist, ist dieser Teil nicht sinnvoll prüfbar und wird übersprungen.
  const responder = await startResponder(() => ({ id: 'test-instance', name: 'Test-Sender', host: 'x', version: 'x', api: '1.0', port: 9999, lan: true }), { port: DISCOVERY_PORT });
  try {
    assert.equal((await fetch(`${base}/discover`, { headers: { Authorization: `Bearer ${viewer}` } })).status, 403, 'ohne Administration abgelehnt');

    const r = await fetch(`${base}/discover`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(r.status, 200);
    const { found } = (await r.json()) as { found: Array<{ id: string; name: string; port: number; url: string | null }> };
    assert.ok(Array.isArray(found));
    if (responder) {
      const self = found.find((f) => f.id === 'test-instance');
      assert.ok(self, 'eigener Test-Responder wird über den echten Endpunkt gefunden');
      assert.equal(self?.name, 'Test-Sender');
      assert.equal(self?.port, 9999);
      assert.ok(self?.url, 'als lan:true kommt eine verbindbare URL zurück');
    }
  } finally {
    responder?.close();
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
