import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import { UserStore, hashPassword, verifyPassword } from '../src/server/users.ts';
import { storedText } from './helpers.ts';
import { openSqliteSync } from '../src/server/db/index.ts';
import { DbDocStore } from '../src/server/repo/docs.ts';

test('Passwörter werden mit scrypt gesalzen gespeichert und geprüft', async () => {
  const h1 = await hashPassword('Geheim-Passwort1');
  const h2 = await hashPassword('Geheim-Passwort1');
  assert.notEqual(h1, h2, 'Salz');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('Geheim-Passwort1', h1), true);
  assert.equal(await verifyPassword('falsch', h1), false);
  assert.equal(await verifyPassword('x', 'kaputt'), false);
});

test('Benutzerverwaltung: Login/Logout, Rollen, Passwortwechsel, Sperre, letzter Admin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-users-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown, tok?: string) => {
    const r = await fetch(base + path, { method, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  try {
    assert.deepEqual((await call('GET', '/auth/status')).body, { users: false, pairing: true });
    await app.users.create({ username: 'Chef', password: 'Start-Passwort1', roles: ['admin'], mustChangePassword: true });
    assert.ok(!storedText(app).includes('Start-Passwort1'), 'kein Klartext');

    assert.equal((await call('POST', '/auth/login', { username: 'chef', password: 'falsch' })).status, 401);
    const login = await call('POST', '/auth/login', { username: 'CHEF', password: 'Start-Passwort1' });
    assert.equal(login.status, 200);
    let admin = login.body.token as string;
    assert.match(admin, /^as_/);
    assert.equal((await call('GET', '/me', undefined, admin)).body.user.mustChangePassword, true);
    assert.equal((await call('GET', '/stations', undefined, admin)).status, 403, 'erst Passwort ändern');
    assert.equal((await call('POST', '/auth/password', { current: 'falsch', next: 'Neues-Passwort2' }, admin)).status, 403);
    assert.equal((await call('POST', '/auth/password', { current: 'Start-Passwort1', next: 'kurz' }, admin)).status, 400);
    const changed = await call('POST', '/auth/password', { current: 'Start-Passwort1', next: 'Neues-Passwort2' }, admin);
    assert.equal(changed.status, 200);
    assert.equal((await call('GET', '/stations', undefined, admin)).status, 401, 'alte Sitzung beendet');
    admin = changed.body.token;
    assert.equal((await call('GET', '/stations', undefined, admin)).status, 200);

    // Moderator nur für einen Sender, ohne Einstellungen
    const dj = await call('POST', '/users', { username: 'mia', name: 'Mia', password: 'Mia-Passwort3', roles: ['dj'], stationIds: ['main'], mustChangePassword: false }, admin);
    assert.equal(dj.status, 200);
    const djTok = (await call('POST', '/auth/login', { username: 'mia', password: 'Mia-Passwort3' })).body.token;
    assert.equal((await call('GET', '/stations/main/queue', undefined, djTok)).status, 200);
    assert.equal((await call('POST', '/stations/main/outputs', { name: 'x' }, djTok)).status, 403, 'DJ darf keine Ausgänge anlegen');
    assert.equal((await call('GET', '/users', undefined, djTok)).status, 403, 'DJ sieht keine Benutzer');
    assert.equal((await call('GET', '/ai/settings', undefined, djTok)).status, 403);

    // Sperren beendet Sitzungen
    await call('PATCH', `/users/${dj.body.id}`, { disabled: true }, admin);
    assert.equal((await call('GET', '/stations/main/queue', undefined, djTok)).status, 401);
    assert.equal((await call('POST', '/auth/login', { username: 'mia', password: 'Mia-Passwort3' })).status, 401);

    // letzter Admin bleibt
    const me = (await call('GET', '/me', undefined, admin)).body.user.id;
    assert.equal((await call('PATCH', `/users/${me}`, { roles: ['dj'] }, admin)).status, 409);
    assert.equal((await call('DELETE', `/users/${me}`, undefined, admin)).status, 409);

    // Abmelden
    assert.equal((await call('POST', '/auth/logout', {}, admin)).status, 204);
    assert.equal((await call('GET', '/me', undefined, admin)).status, 401);

    // Sperre nach 5 Fehlversuchen
    for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { username: 'chef', password: `falsch${i}` });
    const locked = await call('POST', '/auth/login', { username: 'chef', password: 'Neues-Passwort2' });
    assert.equal(locked.status, 429);

    // Sitzungen überleben einen Neustart (nur als Hash gespeichert)
    app.docs.flushSync();
    const db = openSqliteSync(join(dir, 'airdeck.db'));
    const store = new UserStore(dir, DbDocStore.openSync(db));
    assert.equal(store.count, 2);
    await db.close();
  } finally {
    app.shutdown();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
