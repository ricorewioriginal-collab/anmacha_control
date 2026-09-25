import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import { discover, startResponder } from '../src/server/discovery.ts';

async function serve(app: AirDeckApp): Promise<{ server: Server; base: string }> {
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1` };
}

test('Kopplung: Desktop ohne Benutzerkonten – Handy verbindet sich per Code (AUDIT 5.1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-dev-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const { server, base } = await serve(app);
  const admin = app.svc.auth.desktopToken();
  const call = (method: string, path: string, body?: unknown, tok?: string) =>
    fetch(base + path, { method, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    // Ausgangslage aus dem Audit: keine Benutzer, aber Kopplung möglich
    assert.deepEqual(await (await call('GET', '/auth/status')).json(), { users: false, pairing: true });

    // Code nur mit Recht zur Token-Verwaltung
    const dj = app.svc.auth.createToken({ name: 'dj', scopes: ['queue:read'], roles: ['dj'], stationIds: ['main'] }).token;
    assert.equal((await call('POST', '/pairing', {}, dj)).status, 403);
    const p = (await (await call('POST', '/pairing', { role: 'dj', stationIds: ['main'] }, admin)).json()) as { code: string; role: string; addresses: string[] };
    assert.match(p.code, /^\d{6}$/);
    assert.equal(p.role, 'dj');
    assert.ok(Array.isArray(p.addresses));

    // Einlösen: Geräte-Token mit genau diesen Rechten
    const r = await call('POST', '/pair', { code: p.code, name: 'Pixel 8', platform: 'android' });
    assert.equal(r.status, 200);
    const d = (await r.json()) as { token: string; device: { id: string; role: string }; server: { api: string } };
    assert.equal(d.device.role, 'dj');
    assert.equal(d.server.api, '1.0');
    const me = (await (await call('GET', '/me', undefined, d.token)).json()) as { roles: string[]; stationIds: string[]; scopes: string[] };
    assert.deepEqual(me.roles, ['dj']);
    assert.deepEqual(me.stationIds, ['main']);
    assert.ok(!me.scopes.includes('*') && !me.scopes.includes('tokens:write'));

    // einmalig
    assert.equal((await call('POST', '/pair', { code: p.code })).status, 403);

    // Geräteliste und Widerruf
    const list = (await (await call('GET', '/devices', undefined, admin)).json()) as { id: string; name: string; device: { platform: string } }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'Pixel 8');
    assert.equal(list[0]!.device.platform, 'android');
    assert.equal((await call('DELETE', `/devices/${list[0]!.id}`, undefined, admin)).status, 204);
    assert.equal((await call('GET', '/me', undefined, d.token)).status, 401);

    // Sperre nach wiederholten Fehlversuchen
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await call('POST', '/pair', { code: '000000' })).status;
    assert.equal(last, 429);
    const fresh = (await (await call('POST', '/pairing', {}, admin)).json()) as { code: string };
    assert.equal((await call('POST', '/pair', { code: fresh.code })).status, 429, 'gesperrt – auch ein gültiger Code hilft nicht');
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kopplungscode läuft nach 5 Minuten ab und gibt nie mehr Sender frei als erlaubt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-dev-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  try {
    const op = { id: 'op', tokenId: 'op', roles: ['operator'], stationIds: ['main'], scopes: ['tokens:write'] };
    const p = app.svc.devices.createPairing(op, { stationIds: ['*', 'fremd'] });
    assert.deepEqual(p.stationIds, ['main'], 'nur eigene Sender');
    const orig = Date.now;
    Date.now = () => orig() + 5 * 60_000 + 1;
    try {
      assert.throws(() => app.svc.devices.redeem(p.code, {}, '10.0.0.9'), /abgelaufen/);
    } finally {
      Date.now = orig;
    }
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LAN-Erkennung: Antwort mit Name, Version und LAN-Status; fremde Anfragen werden ignoriert', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const r = await startResponder(() => ({ id: 'abc', name: 'Testfunk', host: 'pc', version: '1.2.3', api: '1.0', port: 8750, lan: false }), { port });
  assert.ok(r, 'Responder gestartet');
  try {
    const found = await discover({ port, targets: ['127.0.0.1'], timeoutMs: 500 });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.name, 'Testfunk');
    assert.equal(found[0]!.lan, false);
    assert.equal(found[0]!.url, 'http://127.0.0.1:8750', 'auf dem eigenen PC trotzdem erreichbar');
    // zweiter Responder auf demselben Port (zweite Instanz) → sauber ohne Absturz
    const again = await startResponder(() => ({ id: 'x', name: 'x', host: 'x', version: 'x', api: '1.0', port: 1, lan: true }), { port });
    again?.close();
  } finally {
    r!.close();
  }
});
