import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';

const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };

test('Hörerbereich: aus bis eingeschaltet, Wunsch, Gruß, Voting, Sprachnachricht, Posteingang, Grenzen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-hoerer-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const pub = `${root}/api/v1/public/stations/main/listener`;
  const post = (p: string, body: unknown) => fetch(pub + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const token = app.svc.auth.createToken({ name: 't', scopes: ['*'], roles: ['admin'], stationIds: ['*'] }).token;
  const api = (m: string, p: string, body?: unknown) => fetch(`${root}/api/v1/stations/main${p}`, { method: m, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    for (const [id, title, artist, category] of [['a', 'Sommerhit', 'Band', 'music'], ['b', 'Winterlied', 'Chor', 'music'], ['j', 'Jingle', 'Radio', 'jingle']] as const) {
      app.svc.media.addMedia('main', { id, title, artist, category, file: `${id}.mp3`, durationMs: 1000, addedAt: 0 });
    }
    // Standard: aus
    assert.equal((await fetch(pub)).status, 404);
    // Vorabanfrage von fremder Webseite (Einbettung)
    const pre = await fetch(pub + '/request', { method: 'OPTIONS', headers: { Origin: 'https://mein-sender.de', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');

    app.svc.listeners.setConfig(admin, 'main', { requests: true, messages: true, voting: true, voice: true, welcome: 'Hallo!' });
    const info = (await (await fetch(pub)).json()) as { station: { name: string }; welcome: string; voice: boolean };
    assert.equal(info.welcome, 'Hallo!');
    assert.equal(info.voice, true);

    // Suche: nur Musik, nur Titel/Interpret
    const found = (await (await fetch(`${pub}/search?q=hit`)).json()) as Record<string, unknown>[];
    assert.deepEqual(found, [{ id: 'a', title: 'Sommerhit', artist: 'Band' }]);
    assert.deepEqual(await (await fetch(`${pub}/search?q=jingle`)).json(), [], 'Jingles sind nicht wünschbar');

    // Wunsch + Grenze (3 in 10 min)
    assert.equal((await post('/request', { mediaId: 'a', name: 'Rico\u0000<b>', text: 'Grüße an alle' })).status, 200);
    assert.equal((await post('/request', { mediaId: 'j' })).status, 404, 'nur Musik');
    await post('/request', { mediaId: 'b' });
    await post('/request', { mediaId: 'b' });
    assert.equal((await post('/request', { mediaId: 'b' })).status, 429);

    // Gruß
    assert.equal((await post('/message', { text: ' ' })).status, 400);
    assert.equal((await post('/message', { name: 'Anna', text: 'Liebe Grüße\nnach Hannover' })).status, 200);

    // Voting: einmal je Titel, Charts
    assert.equal((await post('/vote', { mediaId: 'a', up: true })).status, 200);
    assert.equal((await post('/vote', { mediaId: 'a', up: true })).status, 429);
    await post('/vote', { mediaId: 'b', up: false });
    const charts = (await (await fetch(`${pub}/charts`)).json()) as { id: string; score: number }[];
    assert.deepEqual(charts.map((c) => [c.id, c.score]), [['a', 1], ['b', -1]]);

    // Sprachnachricht
    assert.equal((await fetch(`${pub}/voice`, { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: 'x'.repeat(2000) })).status, 415);
    assert.equal((await fetch(`${pub}/voice?name=Tom`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(4 * 1024 * 1024) })).status, 413);
    assert.equal((await fetch(`${pub}/voice?name=Tom&text=Hallo`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(5000, 1) })).status, 200);

    // Posteingang im Studio
    const inbox = (await (await api('GET', '/inbox')).json()) as { items: { id: string; kind: string; name?: string; text?: string; title?: string }[]; unread: number };
    assert.equal(inbox.unread, 5);
    const req = inbox.items.find((x) => x.kind === 'request' && x.title === 'Band – Sommerhit')!;
    assert.equal(req.name, 'Rico<b>', 'Steuerzeichen entfernt, Text bleibt reiner Text');
    assert.equal(inbox.items.find((x) => x.kind === 'message')!.text, 'Liebe Grüße nach Hannover');
    const voice = inbox.items.find((x) => x.kind === 'voice')!;
    const audio = await fetch(`${root}/api/v1/stations/main/inbox/${voice.id}/audio?token=${token}`);
    assert.equal(audio.status, 200);
    assert.equal((await audio.arrayBuffer()).byteLength, 5000);

    // Wunsch in die Queue, Sprachnachricht in Bibliothek + Queue
    assert.equal((await api('POST', `/inbox/${req.id}/queue`)).status, 200);
    assert.equal((await api('POST', `/inbox/${voice.id}/queue`)).status, 200);
    const queue = app.queueView('main') as { items: { mediaId: string; media: { category: string; folder?: string } }[] };
    assert.equal(queue.items[0]!.mediaId, 'a');
    assert.equal(queue.items[1]!.media.category, 'voice_track');
    assert.equal(queue.items[1]!.media.folder, 'Hörer');
    const after = (await (await api('GET', '/inbox')).json()) as { unread: number };
    assert.equal(after.unread, 3);

    // Sender nicht öffentlich → Hörerbereich zu
    app.svc.stations.updateStation('main', { publicStatus: false });
    assert.equal((await fetch(pub)).status, 404);
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
