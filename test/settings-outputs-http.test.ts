import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { createHttpServer } from '../src/server/http.ts';

test('Studio-Einstellungen: Outputs und Stream-Profile ueber echte HTTP-Wege verwalten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-settings-http-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  const server = createHttpServer(app, join(import.meta.dirname, '../studio'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const token = app.svc.auth.createToken({ name:'admin', scopes:['*'], roles:['admin'], stationIds:['*'] }).token;
  const H = { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' };

  const call = async (method:string, path:string, body?:unknown) => {
    const r = await fetch(base + path, { method, headers:H, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status:r.status, body:text ? JSON.parse(text) : null };
  };

  try {
    const profile = await call('POST','/stations/main/stream-profiles',{ name:'Mobile AAC', format:'aac', bitrateKbps:64 });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.name, 'Mobile AAC');

    const output = await call('POST','/stations/main/outputs',{
      name:'Demo Stream', type:'icecast', host:'127.0.0.1', port:8000,
      mount:'/airdeck', username:'source', password:'secret-1234', profileId:profile.body.id,
    });
    assert.equal(output.status, 200);
    assert.equal(output.body.name, 'Demo Stream');

    let list = await call('GET','/stations/main/outputs');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].profileId, profile.body.id);
    assert.equal(list.body[0].password, undefined, 'Passwort darf nie zur UI zurueckkommen');

    const patched = await call('PATCH',`/stations/main/outputs/${output.body.id}`,{ name:'Demo Stream 2', mount:'/neu' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.name, 'Demo Stream 2');
    assert.equal(patched.body.mount, '/neu');

    const inUse = await call('DELETE',`/stations/main/stream-profiles/${profile.body.id}`);
    assert.equal(inUse.status, 409, 'benutztes Profil darf nicht geloescht werden');

    assert.equal((await call('DELETE',`/stations/main/outputs/${output.body.id}`)).status, 204);
    assert.equal((await call('DELETE',`/stations/main/stream-profiles/${profile.body.id}`)).status, 204);

    list = await call('GET','/stations/main/outputs');
    assert.deepEqual(list.body, []);
    const profiles = await call('GET','/stations/main/stream-profiles');
    assert.deepEqual(profiles.body, []);
  } finally {
    app.shutdown();
    server.closeAllConnections();
    server.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
