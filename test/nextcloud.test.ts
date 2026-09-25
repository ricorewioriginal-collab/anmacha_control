import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { cleanPath, parseMultistatus } from '../src/server/nextcloud.ts';
import { storedText } from './helpers.ts';

const FILES: Record<string, Buffer> = {
  '/Radio/Hits/Kygo - Firestone.mp3': Buffer.from('ID3-firestone'),
  '/Radio/Hits/Cover.jpg': Buffer.from('jpg'),
  '/Radio/Hits/Deep/Avicii - Levels.mp3': Buffer.from('ID3-levels'),
};
const uploads: Record<string, string> = {};
const DAV = '/remote.php/dav/files/rico%20r';

function multistatus(dir: string): string {
  const kids = new Set<string>();
  for (const f of Object.keys(FILES)) {
    if (!f.startsWith(dir + '/')) continue;
    const rest = f.slice(dir.length + 1).split('/');
    kids.add(rest.length > 1 ? `${dir}/${rest[0]}/` : f);
  }
  const resp = (href: string, isDir: boolean, size = 0) => `<d:response><d:href>${DAV}${href.split('/').map(encodeURIComponent).join('/')}</d:href><d:propstat><d:prop>${isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>audio/mpeg</d:getcontenttype>`}</d:prop></d:propstat></d:response>`;
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${resp(dir + '/', true)}${[...kids].map((k) => (k.endsWith('/') ? resp(k, true) : resp(k, false, FILES[k]!.length))).join('')}</d:multistatus>`;
}

test('WebDAV-Antwort lesen und Pfade absichern', () => {
  const xml = multistatus('/Radio/Hits');
  const list = parseMultistatus(xml, `http://x${DAV}`);
  assert.deepEqual(list.map((e) => [e.path, e.dir]), [['/Radio/Hits', true], ['/Radio/Hits/Kygo - Firestone.mp3', false], ['/Radio/Hits/Cover.jpg', false], ['/Radio/Hits/Deep', true]]);
  assert.equal(cleanPath('a//b/./c/'), '/a/b/c');
  assert.throws(() => cleanPath('/Radio/../../etc'), /Ungültiger Pfad/);
});

test('Nextcloud-Brücke: durchsuchen, übernehmen (ohne Doppelte), Mitschnitt hochladen', async () => {
  const auths = new Set<string>();
  const srv = createServer((req, res) => {
    auths.add(String(req.headers.authorization));
    const path = decodeURIComponent((req.url ?? '').slice(DAV.length)).replace(/\/$/, '');
    let body = Buffer.alloc(0);
    req.on('data', (d) => (body = Buffer.concat([body, d])));
    req.on('end', () => {
      if (req.headers.authorization !== 'Basic ' + Buffer.from('rico r:app-pw').toString('base64')) return void res.writeHead(401).end();
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        return void res.end(multistatus(path));
      }
      if (req.method === 'GET' && FILES[path]) return void res.end(FILES[path]);
      if (req.method === 'MKCOL') return void res.writeHead(201).end();
      if (req.method === 'PUT') {
        uploads[path] = body.toString();
        return void res.writeHead(201).end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-nc-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  try {
    assert.throws(() => app.svc.nextcloud.setNextcloud({ url: 'ftp://x', user: 'a', password: 'b' }), /https/);
    app.svc.nextcloud.setNextcloud({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/`, user: 'rico r', password: 'app-pw', root: '/Radio' });
    assert.ok(!storedText(app).includes('app-pw'), 'Passwort nie im Klartext');

    const top = (await app.svc.nextcloud.nextcloudList('/Hits')) as { entries: { name: string; path: string; dir: boolean; audio: boolean }[] };
    assert.deepEqual(top.entries.map((e) => [e.name, e.dir, e.audio]), [['Deep', true, false], ['Cover.jpg', false, false], ['Kygo - Firestone.mp3', false, true]]);
    assert.equal(top.entries[2]!.path, '/Hits/Kygo - Firestone.mp3');
    await assert.rejects(app.svc.nextcloud.nextcloudList('/../..'), /Ungültiger Pfad/);

    const r = await app.svc.nextcloud.nextcloudImport('main', ['/Hits'], { category: 'music' });
    assert.deepEqual(r, { imported: 2, skipped: 0, errors: [] });
    const lib = app.svc.media.library('main');
    const levels = lib.find((m) => m.title === 'Levels')!;
    assert.equal(levels.artist, 'Avicii');
    assert.equal(levels.folder, 'Hits / Deep');
    assert.equal(readFileSync(app.svc.media.mediaPath('main', levels), 'utf8'), 'ID3-levels');
    assert.deepEqual(await app.svc.nextcloud.nextcloudImport('main', ['/Hits/Kygo - Firestone.mp3'], {}), { imported: 0, skipped: 1, errors: [] });

    // Mitschnitt hochladen
    const rec = { id: 'r1', label: 'Morning Show', startedAt: Date.UTC(2026, 8, 24, 7, 0), bytes: 4, contentType: 'audio/mpeg', file: 'r1.mp3' };
    (app as unknown as { rt(id: string): { data: { recordings: unknown[] } } }).rt('main').data.recordings.push(rec);
    mkdirSync(join(dir, 'recordings', 'main'), { recursive: true });
    writeFileSync(join(dir, 'recordings', 'main', 'r1.mp3'), 'DATA');
    const up = (await app.svc.nextcloud.nextcloudUploadRecording('main', 'r1', 'Replays')) as { uploaded: string };
    assert.equal(up.uploaded, '/Radio/Replays/2026-09-24-07-00 Morning Show.mp3');
    assert.equal(uploads['/Radio/Replays/2026-09-24-07-00 Morning Show.mp3'], 'DATA');
    // Entfernen wirkt (auch nach Neustart): Einstellung und Passwort sind weg
    assert.deepEqual(app.svc.nextcloud.setNextcloud({ remove: true }), { configured: false });
    assert.deepEqual(app.svc.nextcloud.nextcloudConfig(), { configured: false });
    app.docs.flushSync();
    const again = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
    assert.deepEqual(again.svc.nextcloud.nextcloudConfig(), { configured: false });
  } finally {
    app.shutdown();
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
