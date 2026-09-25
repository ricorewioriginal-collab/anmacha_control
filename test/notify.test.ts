import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { alertText, sign, validateExportPath, validateWebhookUrl } from '../src/server/notify.ts';

const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(20);
  }
}

test('Validierung und Alarmtexte', () => {
  assert.throws(() => validateWebhookUrl('ftp://x'), /http/);
  assert.throws(() => validateExportPath('relativ.txt'), /absoluten/);
  assert.equal(sign('k', 'b'), 'sha256=' + createHmac('sha256', 'k').update('b').digest('hex'));
  assert.match(alertText({ event: 'off_air', station: 'main', at: '', data: {} }), /OFF AIR/);
});

test('Webhook (signiert), Now-Playing-Datei und Stream-Ereignisse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-notify-'));
  const got: { event: string; sig?: string; body: string }[] = [];
  const hook = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push({ event: String(req.headers['x-airdeck-event']), sig: req.headers['x-airdeck-signature'] as string, body });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  try {
    app.addMedia('main', { id: 'a', title: 'Believer', artist: 'Imagine Dragons', category: 'music', file: 'a.mp3', durationMs: 1000, addedAt: 0 });
    const npFile = join(dir, 'export', 'nowplaying.txt');
    assert.throws(() => app.svc.notifications.setIntegrations(admin, 'main', { webhooks: [{ url: 'nope', events: [] }] }), /URL/);
    const cfg = app.svc.notifications.setIntegrations(admin, 'main', {
      webhooks: [{ url, events: ['now_playing', 'off_air', 'on_air_changed', 'bogus'], secret: 'geheim' }],
      nowPlayingFile: npFile,
    }) as { webhooks: { events: string[]; hasSecret: boolean }[] };
    assert.deepEqual(cfg.webhooks[0]!.events, ['now_playing', 'off_air', 'on_air_changed']);
    assert.equal(cfg.webhooks[0]!.hasSecret, true);
    assert.ok(!JSON.stringify(cfg).includes('geheim'));

    app.setNowPlaying('main', 'a', 'A');
    await until(() => got.some((g) => g.event === 'now_playing'));
    const np = got.find((g) => g.event === 'now_playing')!;
    assert.equal(np.sig, 'sha256=' + createHmac('sha256', 'geheim').update(np.body).digest('hex'));
    assert.equal(JSON.parse(np.body).data.title, 'Believer');
    assert.equal(readFileSync(npFile, 'utf8'), 'Imagine Dragons - Believer');
    assert.equal(JSON.parse(readFileSync(`${npFile}.json`, 'utf8')).artist, 'Imagine Dragons');

    // Quelle geht auf Sendung und wieder weg → on_air_changed + off_air
    const auto = app.engine.list('main').find((s) => s.type === 'automation')!;
    app.studioChunk(admin, 'main', auto.id, 'audio/mpeg', Buffer.from('x'), true);
    app.engine.disconnect(auto.id);
    await until(() => got.some((g) => g.event === 'off_air') && got.some((g) => g.event === 'on_air_changed'));

    const t = (await app.svc.notifications.testIntegrations('main')) as { webhooks: { ok: boolean }[] };
    assert.equal(t.webhooks[0]!.ok, true);
  } finally {
    app.shutdown();
    hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Notfall-Ordner wird genutzt, wenn nichts anderes spielt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-em-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  try {
    app.addMedia('main', { id: 'n1', title: 'Notfall', artist: '', category: 'jingle', file: 'n.mp3', durationMs: 1000, addedAt: 0, folder: 'Notfall' });
    app.savePlayoutConfig('main', { emergencyFolder: 'Notfall' });
    const pick = (app as unknown as { emergencyPick(s: string): { id: string } | null }).emergencyPick('main');
    assert.equal(pick?.id, 'n1');
  } finally {
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
