// Masterprompt V1 Beta, P3 #32 (AirDeckCast-Failover): bisher galt "ein Ausgang verbindet sich neu, wenn
// die Verbindung abbricht" - aber bei einem dauerhaften Problem (falsches Passwort, Zielserver dauerhaft
// weg) blieb der Sender auf diesem Ziel einfach stumm, ohne Ersatz. Ein Ausgang kann jetzt failoverFor
// einen anderen Ausgang setzen: er springt nur ein, solange dessen Primärziel nicht "connected" ist, und
// tritt automatisch wieder zurück, sobald das Primärziel wieder verbunden ist.
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

/** Fake-Icecast, das nur die richtige Basic-Auth akzeptiert (falsches Passwort = 403, dauerhaft, kein Retry). */
function authIcecast(expectedAuth: string): { server: import('node:http').Server; port: Promise<number>; bytes: { n: number } } {
  const bytes = { n: 0 };
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/admin/')) return void res.end('ok');
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(403);
      return void res.end();
    }
    res.writeHead(200);
    res.flushHeaders();
    req.on('data', (d: Buffer) => (bytes.n += d.length));
  });
  const port = new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
  return { server, port, bytes };
}

test(
  'AirDeckCast-Failover: Ersatzziel springt ein, solange das Primärziel nicht verbunden ist, und tritt bei Erholung automatisch zurück',
  { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'airdeck-failover-'));
    const goodAuth = 'Basic ' + Buffer.from('source:richtig-123456').toString('base64');
    const primary = authIcecast(goodAuth);
    const backup = authIcecast(goodAuth);
    const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
    try {
      wav(join(app.mediaDir, 'main', 'a.wav'), 30, 440);
      app.svc.media.addMedia('main', { id: 'a.wav', title: 'a', artist: 'A', category: 'music', file: 'a.wav', durationMs: null, addedAt: 0 });
      app.setAutomation('main', { autoFill: false });
      app.queueAdd('main', 'a.wav');

      const primaryPort = await primary.port;
      const backupPort = await backup.port;

      // Primärziel zunächst mit falschem Passwort - bleibt dauerhaft im Fehlerstatus (Auth wird nicht wiederholt)
      const p = app.saveOutput(admin, 'main', null, { name: 'primary', host: '127.0.0.1', port: primaryPort, mount: '/radio', password: 'falsches-pw' }) as { id: string };
      const b = app.saveOutput(admin, 'main', null, { name: 'backup', host: '127.0.0.1', port: backupPort, mount: '/radio-backup', password: 'richtig-123456', failoverFor: p.id }) as { id: string };

      app.start();
      app.startPlayout(admin, 'main', { format: 'mp3', bitrateKbps: 128 });
      const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
      await until(() => app.engine.get(auto.id)?.state === 'active');

      // Primär bleibt im Fehlerstatus, Backup springt ein und bekommt echte Daten
      await until(() => (app.listOutputs('main') as { id: string; state: { status: string } }[]).find((x) => x.id === p.id)?.state.status === 'error');
      await until(() => backup.bytes.n > 20_000, 15_000);
      assert.ok(backup.bytes.n > 20_000, `Backup bekommt Daten, solange das Primärziel nicht verbunden ist (${backup.bytes.n} Bytes)`);

      // Primärziel "reparieren" (richtiges Passwort) - Backup muss automatisch zurücktreten
      app.saveOutput(admin, 'main', p.id, { password: 'richtig-123456' });
      await until(() => (app.listOutputs('main') as { id: string; state: { status: string } }[]).find((x) => x.id === p.id)?.state.status === 'connected');
      await until(() => primary.bytes.n > 20_000, 15_000);
      const backupAtRecovery = backup.bytes.n;
      await wait(500);
      assert.ok(primary.bytes.n > 20_000, `Primärziel bekommt nach der Reparatur wieder echte Daten (${primary.bytes.n} Bytes)`);
      assert.equal(backup.bytes.n, backupAtRecovery, 'Backup bekommt nach der Wiederherstellung des Primärziels keine weiteren Daten mehr (ist zurückgetreten)');
      assert.equal((app.listOutputs('main') as { id: string; state: { status: string } }[]).find((x) => x.id === b.id)?.state.status, 'idle', 'Backup ist wieder im Ruhezustand');
    } finally {
      app.shutdown();
      primary.server.closeAllConnections();
      primary.server.close();
      backup.server.closeAllConnections();
      backup.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
