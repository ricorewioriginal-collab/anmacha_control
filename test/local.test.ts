import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShoutcastOutput, shoutcastPassword } from '../src/server/shoutcast.ts';
import { parseIcecastStatus, parseShoutcastV1, parseShoutcastV2 } from '../src/server/stats.ts';
import { dspFilter, Playout, DEFAULT_PLAYOUT } from '../src/server/playout.ts';
import { detectFfmpeg, probeMedia } from '../src/server/ffmpeg.ts';
import { PlayQueue } from '../src/core/automation.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(20);
  }
}
const ff = detectFfmpeg(process.cwd());

test('SHOUTcast: Legacy-Source-Protokoll (Passwort → OK2 → icy-Header → Daten)', async () => {
  let received = '';
  const srv = createServer((sock) => {
    let stage = 0;
    sock.on('data', (d) => {
      received += d.toString('latin1');
      if (stage === 0 && received.includes('\r\n')) {
        stage = 1;
        sock.write(received.startsWith('geheim:#2\r\n') ? 'OK2\r\nicy-caps:11\r\n\r\n' : 'invalid password\r\n');
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port - 1; // Source-Port = Port+1
  const out = new ShoutcastOutput({
    id: 'o', stationId: 'main', name: 'Test', type: 'shoutcast', host: '127.0.0.1', port, mount: '/', username: '', passwordRef: 'x',
    tls: false, sourceTarget: '/live', enabled: true, streamId: 2, bitrateKbps: 128,
  }, () => 'geheim');
  out.start('audio/mpeg');
  await until(() => out.state.status === 'connected');
  out.write(Buffer.from('MP3DATA'));
  await until(() => received.includes('MP3DATA'));
  assert.ok(received.includes('content-type:audio/mpeg') && received.includes('icy-br:128'));
  out.stop();
  // Opus ist bei SHOUTcast nicht erlaubt → klarer Fehler statt Fake-Funktion
  out.start('audio/ogg');
  assert.equal(out.state.errorCategory, 'unsupported');
  out.stop();
  srv.close();
  assert.equal(shoutcastPassword({}, 'pw'), 'pw');
});

test('Hörerstatistik: Icecast, SHOUTcast v1 und v2', () => {
  const ice = JSON.stringify({ icestats: { source: [{ listenurl: 'http://x:8000/radio', listeners: 7 }, { listenurl: 'http://x:8000/other', listeners: 1 }] } });
  assert.equal(parseIcecastStatus(ice, '/radio'), 7);
  assert.equal(parseIcecastStatus(JSON.stringify({ icestats: { source: { listenurl: 'http://x/a', listeners: 3 } } }), 'a'), 3);
  assert.equal(parseIcecastStatus(ice, '/fehlt'), null);
  assert.equal(parseShoutcastV1('<html><body>12,1,40,100,10,128,Song</body></html>'), 12);
  assert.equal(parseShoutcastV2('{"currentlisteners":5}'), 5);
});

test('DSP-Filterkette', () => {
  assert.equal(dspFilter({ eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], compressor: false, limiter: false }), null);
  const f = dspFilter({ eq: [3, 0, 0, 0, 0, 0, 0, 0, 0, -20], compressor: true, limiter: true })!;
  assert.ok(f.includes('equalizer=f=60:t=o:w=1:g=3') && f.includes('equalizer=f=16000:t=o:w=1:g=-12'));
  assert.ok(f.includes('acompressor') && f.endsWith('alimiter=limit=0.95:level=disabled'));
});

test('Queue mischen behält alle Einträge', () => {
  const q = new PlayQueue();
  for (const id of ['a', 'b', 'c', 'd']) q.add(id);
  q.shuffle(() => 0);
  assert.deepEqual(q.list().map((x) => x.mediaId).sort(), ['a', 'b', 'c', 'd']);
});

test('ID3-Tags, AAC-Stream mit DSP und Mikrofon/Line-In (ffmpeg)', { skip: !ff && 'ffmpeg fehlt', timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-local-'));
  try {
    const file = join(dir, 'song.mp3');
    execFileSync(ff!.ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-metadata', 'title=Mondlicht', '-metadata', 'artist=Luna', '-metadata', 'genre=Pop', '-metadata', 'date=1999', file]);
    const probe = await probeMedia(ff!.ffprobe!, file);
    assert.equal(probe.tags.title, 'Mondlicht');
    assert.equal(probe.tags.artist, 'Luna');
    assert.equal(probe.tags.year, 1999);
    assert.ok(probe.durationMs! >= 1900);

    const chunks: Buffer[] = [];
    const logs: string[] = [];
    let type = '';
    const media = { id: 's', title: 'Mondlicht', artist: 'Luna', category: 'music' as const, file: 'song.mp3', durationMs: probe.durationMs, addedAt: 0 };
    const po = new Playout(ff!.ffmpeg, {
      nextTrack: () => media, mediaPath: () => file, onNowPlaying: () => {}, onStreamStart: (t) => (type = t),
      onStreamData: (d) => chunks.push(d), onStreamStop: () => {}, onSilence: () => {}, log: (e) => logs.push(e),
    }, { ...DEFAULT_PLAYOUT, format: 'aac', bitrateKbps: 64, fadeInMs: 300, inputDevice: 'test', dsp: { eq: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0], compressor: true, limiter: true } },
    { inputArgs: () => ['-f', 'lavfi', '-i', 'sine=f=1000'] });
    assert.throws(() => po.setMic(true), /Aufnahmegerät/); // vor dem Start kein Eingang
    po.start();
    await until(() => po.status().input === 'running');
    po.setMic(true);
    await until(() => Buffer.concat(chunks).length > 3000);
    assert.equal(type, 'audio/aac');
    const data = Buffer.concat(chunks);
    assert.ok(data[0] === 0xff && (data[1]! & 0xf0) === 0xf0, 'ADTS-Header erwartet');
    assert.equal(po.status().micOn, true);
    po.stop();
    assert.ok(logs.includes('mic_on'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
