// Masterprompt V1 Beta, P2 #22 (externe Stream-Metadaten): ein extern eingeplanter Stream soll als "Jetzt
// läuft" den ECHTEN, sich ändernden Titel zeigen (aus ICY-Metadaten gelesen), nicht nur den einmalig beim
// Anlegen eingetragenen Platzhalter. Test treibt den kompletten echten Ablauf: echter Sendebus/ffmpeg
// spielt die externe URL, ein echter lokaler HTTP-Server liefert Audio + ICY-Metadaten (StreamTitle) wie
// ein echter Icecast/SHOUTcast-Server (nur wenn der Client "Icy-MetaData: 1" anfragt - ffmpeg selbst bekommt
// weiterhin sauberes Audio ohne eingemischte Metadaten-Bytes, genau wie bei einem echten Icecast-Server).
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

function icyMetaBlock(title: string): Buffer {
  const text = `StreamTitle='${title}';`;
  const padded = Math.ceil(text.length / 16) * 16;
  const buf = Buffer.alloc(1 + padded);
  buf[0] = padded / 16;
  buf.write(text, 1, 'utf8');
  return buf;
}

test(
  'Externer Stream als Programminhalt zeigt echte ICY-Metadaten als "Jetzt läuft", nicht nur den Platzhaltertitel',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-icynow-'));
    const got: Buffer[] = [];
    const ice = createServer((req, res) => {
      if (req.url?.startsWith('/admin/')) return void res.end('ok');
      res.writeHead(200);
      res.flushHeaders();
      req.on('data', (d: Buffer) => got.push(d));
    });
    await new Promise<void>((r) => ice.listen(0, '127.0.0.1', r));
    const port = (ice.address() as { port: number }).port;

    // "Externer Stream": liefert nur dann ICY-Metadaten eingemischt, wenn der Client sie per
    // Icy-MetaData: 1 angefordert hat (wie ein echter Icecast/SHOUTcast-Server) - ffmpeg fragt das nicht
    // an und bekommt daher sauberes, unverändertes Audio zum Abspielen.
    const audio = wav(30, 660);
    const metaint = 8192;
    let currentTitle = 'Nachrichten';
    const streamSrv = createServer((req, res) => {
      const wantsIcy = req.headers['icy-metadata'] === '1';
      if (!wantsIcy) {
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(audio);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-metaint': String(metaint) });
      let pos = 0;
      const timer = setInterval(() => {
        if (res.writableEnded) return clearInterval(timer);
        const chunk = audio.subarray(pos, pos + metaint);
        pos = (pos + metaint) % audio.length;
        res.write(chunk.length === metaint ? chunk : Buffer.concat([chunk, Buffer.alloc(metaint - chunk.length, 0)]));
        res.write(icyMetaBlock(currentTitle));
      }, 15);
      req.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((r) => streamSrv.listen(0, '127.0.0.1', r));
    const streamPort = (streamSrv.address() as { port: number }).port;

    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    try {
      writeFileSync(join(app.mediaDir, 'main', 'a.wav'), wav(4, 440));
      app.svc.media.addMedia('main', { id: 'a.wav', title: 'a', artist: 'A', category: 'music', file: 'a.wav', durationMs: null, addedAt: 0 });
      const streamMedia = app.svc.media.addUrlMedia('main', { url: `http://127.0.0.1:${streamPort}/live`, title: 'Externer Stream (Platzhalter)' });

      app.setAutomation('main', { autoFill: false });
      app.queueAdd('main', 'a.wav');
      app.queueAdd('main', streamMedia.id);

      app.saveOutput(admin, 'main', null, { name: 'ice', host: '127.0.0.1', port, mount: '/radio', password: 'pw-123456' });
      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128, crossfadeMs: 500 });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      await until(() => app.engine.get(auto.id)?.state === 'active');
      await until(() => (app.nowPlaying('main') as { mediaId: string } | null)?.mediaId === streamMedia.id);

      // Solange kein ICY-Titel eingetroffen ist, zeigt "Jetzt läuft" noch den Platzhalter - kein Absturz.
      // Sobald der ICY-Reader den ersten Block gelesen hat, muss der ECHTE Titel erscheinen.
      await until(() => (app.nowPlaying('main') as { media: { title: string } }).media.title === 'Nachrichten', 10_000);

      // Themenwechsel auf dem externen Stream - "Jetzt läuft" muss live nachziehen, ohne dass AirDeck
      // selbst den Titel wechselt (immer noch derselbe Programm-Slot/dieselbe Medien-ID).
      currentTitle = 'Kygo - Firestone';
      await until(() => {
        const np = app.nowPlaying('main') as { mediaId: string; media: { artist: string; title: string } };
        return np.mediaId === streamMedia.id && np.media.artist === 'Kygo' && np.media.title === 'Firestone';
      }, 10_000);

      // Die eigentliche Bibliothek bleibt unverändert (Live-Titel überschreibt nie den gespeicherten Eintrag)
      assert.equal(app.svc.media.media('main', streamMedia.id).title, 'Externer Stream (Platzhalter)');

      app.stopPlayout(admin, 'main');
    } finally {
      app.shutdown();
      ice.closeAllConnections();
      ice.close();
      streamSrv.closeAllConnections();
      streamSrv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
