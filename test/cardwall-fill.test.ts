// Masterprompt-Reality-Check P0 #1 "Cardwall befüllbar machen": Live-Nachweis mit Playwright gegen
// einen echten Server (echter OS-Datei-Drop per DataTransfer.files auf einen Cart-Slot) hat gezeigt,
// dass der Client-Code (dropTarget/dropMedia/upload in studio/js/app.js) bereits funktioniert. Dieser
// Test sichert den Server-Vertrag ab, auf den sich dieser Ablauf stützt (PUT /media mit rohen
// Datei-Bytes wie beim Drag&Drop, danach PATCH /cardwall/:id mit der neuen Medien-ID) - bisher ohne
// jede Testabdeckung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';

function wav(seconds: number, freq: number): Buffer {
  const rate = 22050;
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  return b;
}

test('Cardwall per Drag&Drop befüllen: OS-Datei hochladen und einem Cart-Slot zuweisen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-cardwall-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const { token } = app.svc.auth.createToken({ name: 't', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
  const headers = { Authorization: `Bearer ${token}` };

  try {
    // 1) Genau der Weg, den studio/js/app.js beim Drop einer echten Datei aus dem Explorer geht:
    //    rohe Bytes per PUT an /media, Name/Kategorie/Ordner als Query - kein anderer Upload-Pfad.
    const upload = await fetch(`${base}/stations/main/media?name=${encodeURIComponent('Jingle Sommer.wav')}&category=jingle`, {
      method: 'PUT', headers, body: wav(1, 880),
    });
    assert.equal(upload.status, 200);
    const media = await upload.json() as { id: string; title: string; category: string; durationMs: number | null };
    assert.equal(media.title, 'Jingle Sommer');
    assert.equal(media.category, 'jingle');

    // In der Bibliothek muss die Datei jetzt wirklich auftauchen (nicht nur die Upload-Antwort)
    const lib = await (await fetch(`${base}/stations/main/media`, { headers })).json() as Array<{ id: string }>;
    assert.ok(lib.some((m) => m.id === media.id), 'hochgeladener Titel ist in der Bibliothek');

    // 2) Cart-Slot zuweisen (dasselbe PATCH, das dropTarget() auf einem Cart auslöst)
    const cart = await fetch(`${base}/stations/main/cardwall/cart1`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: media.id, label: media.title.slice(0, 40) }),
    });
    assert.equal(cart.status, 200);
    assert.equal((await cart.json() as { mediaId: string }).mediaId, media.id);

    // Nach "Neustart" (frische Sender-Sicht) muss der Slot belegt bleiben - Persistenz, nicht nur State im Speicher
    const wall = await (await fetch(`${base}/stations/main/cardwall`, { headers })).json() as Array<{ id: string; mediaId: string | null }>;
    assert.equal(wall.find((c) => c.id === 'cart1')?.mediaId, media.id);

    // 3) Cart lässt sich abspielen (echter Trigger, keine Attrappe)
    const fire = await fetch(`${base}/stations/main/cardwall/cart1/trigger`, { method: 'POST', headers });
    assert.equal(fire.status, 200);

    // Nicht-Audiodatei wird abgelehnt, nicht still ignoriert oder als kaputter Datensatz gespeichert
    const rejected = await fetch(`${base}/stations/main/media?name=virus.exe`, { method: 'PUT', headers, body: 'x' });
    assert.equal(rejected.status, 415);
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


const ff = detectFfmpeg(process.cwd());
const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await sleep(25);
  }
}

test('Cardwall spielt mit ffmpeg wirklich Audio auf den Ausgang', { skip: !ff && 'ffmpeg nicht installiert', timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-cardwall-audio-'));
  const got: Buffer[] = [];
  const ice = createServer((req, res) => {
    if (req.url?.startsWith('/admin/')) return void res.end('ok');
    res.writeHead(200);
    res.flushHeaders();
    req.on('data', (d: Buffer) => got.push(d));
  });
  await new Promise<void>((r) => ice.listen(0, '127.0.0.1', r));
  const port = (ice.address() as { port: number }).port;
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const { token } = app.svc.auth.createToken({ name: 't', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
  const headers = { Authorization: `Bearer ${token}` };

  try {
    app.saveOutput(admin, 'main', null, { name: 'Cardwall Test', host: '127.0.0.1', port, mount: '/radio', password: 'pw-123456' });
    app.start();

    const upload = await fetch(`${base}/stations/main/media?name=${encodeURIComponent('Cardwall Ton.wav')}&category=jingle`, {
      method: 'PUT', headers, body: wav(2, 880),
    });
    assert.equal(upload.status, 200);
    const media = await upload.json() as { id: string };

    const patch = await fetch(`${base}/stations/main/cardwall/cart1`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: media.id, label: 'Cardwall Ton' }),
    });
    assert.equal(patch.status, 200);

    const fire = await fetch(`${base}/stations/main/cardwall/cart1/trigger`, { method: 'POST', headers });
    assert.equal(fire.status, 200);

    await until(() => Buffer.concat(got).length > 2500);
    const encoded = Buffer.concat(got);
    assert.ok(encoded.length > 2500, 'Cardwall muss echte Encoderdaten an den Ausgang senden');
    assert.ok(encoded.includes(Buffer.from([0xff])), 'MP3-Frames vom Cardwall-Cart erwartet');
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    ice.closeAllConnections();
    ice.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
