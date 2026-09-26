// Masterprompt V1 Beta, P3 #31 (AirDeckCast-Teststream "AIRDECKCAST TEST"): bisher gab es keine Möglichkeit,
// die komplette Ausliefer-Kette (Hauptstream + Zusatzprofile + HLS) auf einen Blick zu prüfen, ohne die
// Automation zu unterbrechen. "Ausgang zeigt verbunden" bedeutet nicht "es kommen wirklich Daten an" -
// dieser Test prüft echten Datenzuwachs an jedem Ziel während eines kurzen, echt hörbaren Testtons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

function fakeIcecast(): { server: import('node:http').Server; port: Promise<number>; bytes: { n: number } } {
  const bytes = { n: 0 };
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/admin/')) return void res.end('ok');
    res.writeHead(200);
    res.flushHeaders();
    req.on('data', (d: Buffer) => (bytes.n += d.length));
  });
  const port = new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
  return { server, port, bytes };
}

test(
  'AirDeckCast-Teststream: Testton läuft über den Sendebus, ohne die Automation zu unterbrechen, und wird an Hauptstream, Zusatzprofil und HLS auf echten Datenzuwachs geprüft',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-cast-test-'));
    const main = fakeIcecast();
    const mobile = fakeIcecast();
    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    try {
      wav(join(app.mediaDir, 'main', 'a.wav'), 30, 440);
      app.svc.media.addMedia('main', { id: 'a.wav', title: 'a', artist: 'A', category: 'music', file: 'a.wav', durationMs: null, addedAt: 0 });
      app.setAutomation('main', { autoFill: false });
      app.queueAdd('main', 'a.wav');

      const mainPort = await main.port;
      const mobilePort = await mobile.port;
      const profile = app.saveStreamProfile(admin, 'main', null, { name: 'Mobile AAC', format: 'aac', bitrateKbps: 64 }) as { id: string };
      app.saveOutput(admin, 'main', null, { name: 'main-out', host: '127.0.0.1', port: mainPort, mount: '/radio', password: 'pw-123456' });
      app.saveOutput(admin, 'main', null, { name: 'mobile-out', host: '127.0.0.1', port: mobilePort, mount: '/mobile', password: 'pw-123456', profileId: profile.id });

      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128, hls: { enabled: true, bitrateKbps: 96, segmentSeconds: 2 } });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      await until(() => app.engine.get(auto.id)?.state === 'active');
      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === 'a.wav');

      const report = await app.runAirDeckCastTest('main');

      assert.equal(report.outputs.length, 2, 'beide aktivierten Ausgänge werden geprüft');
      const byName = new Map(report.outputs.map((o) => [o.name, o]));
      assert.ok(byName.get('main-out')!.ok, `Hauptstream bekommt während des Tests echte zusätzliche Bytes (${byName.get('main-out')!.bytesDelta})`);
      assert.ok(byName.get('mobile-out')!.ok, `Zusatzprofil-Ausgang bekommt während des Tests echte zusätzliche Bytes (${byName.get('mobile-out')!.bytesDelta})`);
      assert.ok(report.hls?.enabled && report.hls.ok, 'HLS-Segmente wachsen während des Tests');
      assert.ok(report.ok, 'Gesamtergebnis: alle Ziele haben echte Daten erhalten');

      // Die normale Automation lief währenddessen unbeeinflusst weiter (Testton läuft als Cart darüber, nicht in der Queue)
      assert.equal((app.nowPlaying('main') as { mediaId: string }).mediaId, 'a.wav', 'Testton stört die laufende Automation nicht');
      assert.equal(app.svc.media.library('main').some((m) => m.id === '_airdeckcast_test'), false, 'Testton landet nicht in der Medienbibliothek');
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
