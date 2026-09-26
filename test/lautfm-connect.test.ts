import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nachbau des laut.fm-Verhaltens: Token gilt nur mit dem Origin, für den es ausgestellt wurde;
// /stations kommt verpackt als { stations: [...] }.
const TOKEN = 'abcd1234-efgh-5678-ijkl-9012mnop3456';
const ORIGIN = 'http://studio.local:8750';
const seen: string[] = [];
const mock = createServer((req, res) => {
  seen.push(`${req.method} ${req.url} ${req.headers.origin}`);
  if (req.headers.authorization !== `Bearer ${TOKEN}` || req.headers.origin !== ORIGIN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid token format' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/stations') return res.end(JSON.stringify({ stations: [{ id: 7, name: 'Mein-Radio', display_name: 'Mein Radio', role: 'owner' }, { id: 9, name: 'anderes', role: 'dj' }] }));
  if (req.url === '/stations/7') return res.end(JSON.stringify({ id: 7, name: 'mein-radio' }));
  if (req.url === '/stations/9/live') return res.end(JSON.stringify({ protocol: 'http', server: 'stream.laut.fm', port: 8000, mountpoint: '/anderes', user: 'source', password: 'geheim9' }));
  res.end('{}');
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
process.env.AIRDECK_RADIOADMIN_URL = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

const { AirDeckApp } = await import('../src/server/app.ts');
const { createHttpServer } = await import('../src/server/http.ts');
const { cleanToken, normalizeStations } = await import('../src/server/lautfm.ts');

test('laut.fm: Token säubern und Stationslisten beider Formate verstehen', () => {
  assert.equal(cleanToken(`  Bearer "${TOKEN}"\n`), TOKEN);
  assert.deepEqual(normalizeStations([{ id: 1, name: 'A' }]), [{ id: 1, name: 'a', displayName: 'A', role: 'dj' }]);
  assert.equal(normalizeStations({ stations: [] })?.length, 0);
  assert.equal(normalizeStations({ error: 'x' }), null);
});

test('laut.fm verbinden: Origin wird selbst ermittelt, Station gewählt, Anfragen laufen mit dem richtigen Origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-lautfm-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = app.svc.auth.createToken({ name: 't', scopes: ['*'], roles: ['admin'], stationIds: ['*'] }).token;
  const api = (m: string, p: string, body?: unknown) => fetch(`${root}/api/v1/stations/main${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    // Unsinn wird vorab abgelehnt, ohne laut.fm zu fragen
    assert.equal((await api('POST', '/lautfm/connect', { token: 'kurz' })).status, 400);
    // Falsches Token: klare Meldung
    const bad = await api('POST', '/lautfm/connect', { token: 'x'.repeat(30), pageOrigin: ORIGIN });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message: string }).message, /abgelehnt/);

    // Richtiges Token, eingefügt mit „Bearer “ – Origin kommt von der Studio-Seite
    const r = await api('POST', '/lautfm/connect', { token: `Bearer ${TOKEN}`, pageOrigin: ORIGIN });
    assert.equal(r.status, 200);
    const cfg = (await r.json()) as { origin: string; stationId: number; stationName: string; hasToken: boolean; stations: unknown[] };
    assert.equal(cfg.origin, ORIGIN);
    assert.equal(cfg.stationId, 7, 'eigene Station (owner) automatisch gewählt');
    assert.equal(cfg.stationName, 'mein-radio');
    assert.equal(cfg.hasToken, true);
    assert.equal(cfg.stations.length, 2);

    // Nutzerbericht: laut.fm-Sender fehlten im Dropdown "Meine Sender" - der zweite Sender des Kontos
    // ("anderes", id 9, noch keinem AirDeck-Sender zugeordnet) muss jetzt automatisch als eigener
    // AirDeck-Sender angelegt werden (nur weil hier mit einem globalen Admin-Token verbunden wurde).
    const listStations = () => fetch(`${root}/api/v1/stations`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()) as Promise<Array<{ id: string; name: string }>>;
    const allStations = await listStations();
    const auto = allStations.find((s) => s.id === 'anderes');
    assert.ok(auto, 'zweiter laut.fm-Sender wurde automatisch als eigener AirDeck-Sender angelegt');
    assert.equal(auto?.name, 'anderes');
    const autoLf = await fetch(`${root}/api/v1/stations/anderes/lautfm`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(autoLf.status, 200);
    assert.equal(((await autoLf.json()) as { stationId: number }).stationId, 9);
    // Erneutes Verbinden legt den bereits vorhandenen Sender nicht doppelt an.
    await api('POST', '/lautfm/connect', { pageOrigin: ORIGIN });
    const again2 = await listStations();
    assert.equal(again2.filter((s) => s.id === 'anderes').length, 1);

    // Weiterleitung nutzt den ermittelten Origin
    const st = await api('GET', '/lautfm/ra/stations/7');
    assert.equal(st.status, 200);
    assert.deepEqual(await st.json(), { id: 7, name: 'mein-radio' });

    // Gespeicherter Origin falsch (z. B. von Hand verstellt): Prüfung findet den richtigen wieder
    await api('PUT', '/lautfm', { origin: 'airdeck' });
    const chk = (await (await api('POST', '/lautfm/check')).json()) as { ok: boolean; origin: string };
    assert.equal(chk.ok, false, 'ohne Seiten-Origin kein Treffer unter den Standardnamen');
    const again = await api('POST', '/lautfm/connect', { pageOrigin: ORIGIN });
    assert.equal(again.status, 200, 'erneut verbinden mit gespeichertem Token');
    assert.equal(((await (await api('POST', '/lautfm/check')).json()) as { ok: boolean }).ok, true);
    assert.equal(((await app.svc.lautfm.radioadmin('main', 'GET', '/stations/7')).status), 200);

    // Nutzerbericht: eigener Sender (keine laut.fm-Identität) soll zusätzlich live auf laut.fm zu hören
    // sein, ohne dass dieser Sender selbst unter "laut.fm" verbunden werden muss - eigenes Token je Ausgang.
    const globalApi = (m: string, p: string, body?: unknown) => fetch(`${root}/api/v1${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await globalApi('POST', '/stations', { id: 'eigener-sender', name: 'Eigener Sender' })).status, 200);
    const eigenerApi = (m: string, p: string, body?: unknown) => fetch(`${root}/api/v1/stations/eigener-sender${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    // Ohne Angabe der Station: zwei Sender im Konto -> Liste zur Auswahl statt Raten
    const ambiguous = (await (await eigenerApi('POST', '/lautfm/relay-output', { token: TOKEN, pageOrigin: ORIGIN })).json()) as { stations?: unknown[] };
    assert.equal(ambiguous.stations?.length, 2);
    // Mit gewählter Station: Ausgang wird mit den echten Live-Zugangsdaten angelegt
    const created = await eigenerApi('POST', '/lautfm/relay-output', { token: TOKEN, pageOrigin: ORIGIN, lautfmStationId: 9 });
    assert.equal(created.status, 200);
    const out = (await created.json()) as { host: string; mount: string; port: number };
    assert.equal(out.host, 'stream.laut.fm');
    assert.equal(out.mount, '/anderes');
    assert.equal(out.port, 8000);
    // "eigener-sender" bekam dabei KEINE eigene laut.fm-Identität zugewiesen (bleibt ein eigener Sender)
    const eigenerLf = (await (await eigenerApi('GET', '/lautfm')).json()) as { stationId?: number };
    assert.equal(eigenerLf.stationId, undefined);
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => new Promise<void>((r) => mock.close(() => r())));
