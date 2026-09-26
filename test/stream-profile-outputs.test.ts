// Masterprompt V1 Beta, P3 #28 (AirDeckCast: alternative Profile über die API/UI nutzbar): #26 gab dem
// Sendebus (Playout) die Fähigkeit, mehrere Encoder-Profile gleichzeitig aus demselben Programmbus zu
// speisen - aber ein Nutzer konnte das noch nirgends konfigurieren. Dieser Test prüft die komplette
// Kette von außen: ein Zusatzprofil per API anlegen, einen zweiten Ausgang darauf verweisen lassen,
// beide echten Icecast-Mounts (Standard + Profil) empfangen unabhängig voneinander echtes, dekodierbares
// Audio in ihrem jeweils eigenen Format/Bitrate - nicht nur "Verbindung hergestellt".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';

const ff = detectFfmpeg(process.cwd());
const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(25);
  }
}

function wav(file: string, seconds: number, freq: number): void {
  const rate = 22050;
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  writeFileSync(file, b);
}

function decodeToPcm(ffmpeg: string, data: Buffer, inputFormat: string): Promise<Int16Array> {
  return new Promise((resolveP, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', inputFormat, '-i', 'pipe:0', '-f', 's16le', '-ar', '22050', '-ac', '1', 'pipe:1'], { windowsHide: true });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      resolveP(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
    p.stdin.write(data);
    p.stdin.end();
  });
}

function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return Math.sqrt(sum / pcm.length);
}

/** Fake-Icecast: nimmt die HTTP-PUT-Quelle an und sammelt die rohen (noch kodierten) Bytes. */
function fakeIcecast(): { server: import('node:http').Server; port: Promise<number>; chunks: Buffer[]; contentType: Promise<string> } {
  const chunks: Buffer[] = [];
  let resolveType: (t: string) => void;
  const contentType = new Promise<string>((r) => (resolveType = r));
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/admin/')) return void res.end('ok');
    resolveType(String(req.headers['content-type'] ?? ''));
    res.writeHead(200);
    res.flushHeaders();
    req.on('data', (d: Buffer) => chunks.push(d));
  });
  const port = new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
  return { server, port, chunks, contentType };
}

test(
  'AirDeckCast API: Zusatzprofil per Ausgang nutzbar - Hauptstream und Zusatzprofil senden gleichzeitig echtes, unabhängiges Audio',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-profile-api-'));
    const main = fakeIcecast();
    const mobile = fakeIcecast();
    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    try {
      wav(join(app.mediaDir, 'main', 'a.wav'), 6, 440);
      app.svc.media.addMedia('main', { id: 'a.wav', title: 'a', artist: 'A', category: 'music', file: 'a.wav', durationMs: null, addedAt: 0 });
      app.setAutomation('main', { autoFill: false });
      app.queueAdd('main', 'a.wav');

      const mainPort = await main.port;
      const mobilePort = await mobile.port;

      // Zusatzprofil per API anlegen (wie über den "Profile"-Dialog im Studio)
      const profile = app.saveStreamProfile(admin, 'main', null, { name: 'Mobile AAC', format: 'aac', bitrateKbps: 64 }) as { id: string };
      assert.ok(profile.id, 'Profil bekommt eine ID');
      assert.deepEqual(app.listStreamProfiles('main'), [profile]);

      // Zwei Ausgänge: Hauptstream (Standardprofil) und ein zweiter, der explizit das Zusatzprofil nutzt
      app.saveOutput(admin, 'main', null, { name: 'main-out', host: '127.0.0.1', port: mainPort, mount: '/radio', password: 'pw-123456' });
      app.saveOutput(admin, 'main', null, { name: 'mobile-out', host: '127.0.0.1', port: mobilePort, mount: '/mobile', password: 'pw-123456', profileId: profile.id });

      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128 });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      await until(() => app.engine.get(auto.id)?.state === 'active');

      await until(() => main.chunks.reduce((n, b) => n + b.length, 0) > 20_000 && mobile.chunks.reduce((n, b) => n + b.length, 0) > 10_000);
      app.stopPlayout(admin, 'main');
      await wait(300);

      assert.equal(await main.contentType, 'audio/mpeg');
      assert.equal(await mobile.contentType, 'audio/aac');

      const mainPcm = await decodeToPcm(ff!.ffmpeg, Buffer.concat(main.chunks), 'mp3');
      const mobilePcm = await decodeToPcm(ff!.ffmpeg, Buffer.concat(mobile.chunks), 'aac');
      assert.ok(mainPcm.length > 5000, 'Hauptstream liefert echtes, dekodierbares Audio');
      assert.ok(mobilePcm.length > 5000, 'Zusatzprofil-Ausgang liefert echtes, dekodierbares Audio - über einen eigenen Icecast-Mount');

      const rmsMain = rms(mainPcm);
      const rmsMobile = rms(mobilePcm);
      assert.ok(rmsMain > 500, `Hauptstream enthält hörbares Signal (RMS=${rmsMain})`);
      assert.ok(rmsMobile > 500, `Zusatzprofil-Ausgang enthält hörbares Signal (RMS=${rmsMobile}) - derselbe Programmbus, nicht Stille`);

      // Löschen eines noch benutzten Profils muss abgelehnt werden (Ausgang referenziert es noch)
      assert.throws(() => app.removeStreamProfile(admin, 'main', profile.id), /wird von einer Ausgabe verwendet/);
    } finally {
      app.shutdown();
      main.server.closeAllConnections();
      main.server.close();
      mobile.server.closeAllConnections();
      mobile.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
