import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';

test('Studio-HTTP-Vertrag: Medien → Queue → Verschieben → Deck laden → Queue next', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-ui-http-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const token = app.svc.auth.createToken({ name:'ui', scopes:['*'], roles:['admin'], stationIds:['*'] }).token;
  const H = { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' };

  app.svc.media.addMedia('main', { id:'a', title:'A', artist:'Alpha', category:'music', file:'a.mp3', durationMs:1000, addedAt:0 });
  app.svc.media.addMedia('main', { id:'b', title:'B', artist:'Beta', category:'music', file:'b.mp3', durationMs:1000, addedAt:0 });

  const call = async (method:string, path:string, body?:unknown) => {
    const r = await fetch(base + path, { method, headers:H, body: body === undefined ? undefined : JSON.stringify(body) });
    const txt = await r.text();
    return { status:r.status, body: txt ? JSON.parse(txt) : null };
  };

  try {
    assert.equal((await call('POST','/stations/main/queue',{mediaId:'a'})).status, 204);
    assert.equal((await call('POST','/stations/main/queue',{mediaId:'b'})).status, 204);
    let q = (await call('GET','/stations/main/queue')).body;
    assert.deepEqual(q.items.map((x:any)=>x.mediaId), ['a','b']);

    const uid = q.items[1].uid;
    assert.equal((await call('POST',`/stations/main/queue/${uid}/move`,{index:0})).status, 200);
    q = (await call('GET','/stations/main/queue')).body;
    assert.deepEqual(q.items.map((x:any)=>x.mediaId), ['b','a']);

    assert.equal((await call('PUT','/stations/main/decks/A',{mediaId:'b',status:'cued'})).status, 200);
    const decks = (await call('GET','/stations/main/decks')).body;
    assert.equal(decks.find((d:any)=>d.id==='A').mediaId, 'b');
    assert.equal(decks.find((d:any)=>d.id==='A').status, 'cued');

    const next = await call('POST','/stations/main/queue/next');
    assert.equal(next.status, 200);
    assert.equal(next.body.media.id, 'b');
    q = (await call('GET','/stations/main/queue')).body;
    assert.deepEqual(q.items.map((x:any)=>x.mediaId), ['a']);
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
