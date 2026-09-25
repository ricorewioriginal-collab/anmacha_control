// Decks in der Engine (Server): von Hand laden, starten, pausieren, stoppen; AutoDJ belegt A/B.
// Echtes ffmpeg, wird übersprungen, wenn ffmpeg fehlt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { detectFfmpeg } from '../src/server/ffmpeg.ts';
import type { PlayoutStatus } from '../src/server/playout.ts';

const ff = detectFfmpeg(process.cwd());
const admin = { id: 'admin', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
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

test('Decks: Handbetrieb (MANUAL) und AutoDJ (AUTO) in der Engine', { skip: !ff && 'ffmpeg nicht installiert', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-decks-'));
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: ff });
  const levels: { rmsDb: number; decks: Record<string, number> }[] = [];
  const lv = (l: { decks: Record<string, number> }, d: string) => l.decks[d] ?? -90;
  const unsub = app.subscribe((e) => {
    if (e.type === 'playout.level') levels.push(e.payload as never);
  });
  try {
    for (const [id, secs, freq] of [['a', 6, 440], ['b', 6, 550], ['j', 2, 880]] as const) {
      wav(join(app.mediaDir, 'main', `${id}.wav`), secs, freq);
      app.svc.media.addMedia('main', { id, title: id, artist: 'x', category: id === 'j' ? 'jingle' : 'music', file: `${id}.wav`, durationMs: secs * 1000, addedAt: 0 });
    }
    app.setBaseMode(admin, 'main', 'MANUAL');
    app.start();
    const st = () => app.playoutView('main') as { status: PlayoutStatus | null };
    const deck = (id: string) => st().status!.decks.find((d) => d.id === id)!;

    app.savePlayoutConfig('main', { silenceMs: 2000 });
    // Einspieler aus der Cartwall startet die Engine, damit er auf Sendung geht
    const slot = app.cardwall('main')[0]!;
    app.updateCart('main', slot.id, { mediaId: 'j' });
    assert.equal(app.playouts.has('main'), false);
    app.triggerCart('main', slot.id);
    assert.equal(app.playouts.has('main'), true, 'Cart startet die Engine');
    await wait(2300); // Jingle (2 s) ausspielen lassen, damit die Pegelprüfungen unten sauber sind
    // Laden startet die Engine (falls nötig), spielt aber nichts
    app.deckAction(admin, 'main', 'A', 'load', { mediaId: 'a' });
    assert.equal(deck('A').state, 'cued');
    await wait(700);
    assert.equal(st().status!.current, null, 'MANUAL: nichts startet von selbst');

    // Start → spielt, Pegel nur auf Deck A
    app.deckAction(admin, 'main', 'A', 'play', {});
    assert.equal(deck('A').state, 'playing');
    await until(() => levels.some((l) => lv(l, 'A') > -40));
    const last = levels.at(-1)!;
    assert.ok(lv(last, 'B') <= -90 && lv(last, 'C') <= -90, 'leere Decks zeigen keinen Pegel');

    // Pause hält die Position, Fortsetzen macht dort weiter
    await wait(800);
    app.deckAction(admin, 'main', 'A', 'pause', {});
    const paused = deck('A');
    assert.equal(paused.state, 'paused');
    assert.ok(paused.positionMs > 500, `Position ${paused.positionMs}`);
    levels.length = 0;
    await wait(700);
    assert.ok(levels.length && levels.slice(-2).every((l) => lv(l, 'A') <= -90 && l.rmsDb < -60), 'nach Pause kein Signal mehr');
    app.deckAction(admin, 'main', 'A', 'play', {});
    assert.ok(deck('A').positionMs >= paused.positionMs);

    // Deck C parallel (Jingle), A läuft weiter
    app.deckAction(admin, 'main', 'C', 'play', { mediaId: 'j' });
    assert.equal(deck('C').state, 'playing');
    assert.equal(deck('A').state, 'playing');
    // Laden in ein laufendes Deck wird abgelehnt
    assert.throws(() => app.deckAction(admin, 'main', 'A', 'load', { mediaId: 'b' }), /spielt gerade/);

    // Stopp: zurück an den Anfang, danach Stille – und in MANUAL übernimmt KEINE Automation
    app.deckAction(admin, 'main', 'A', 'stop', {});
    assert.equal(deck('A').state, 'cued');
    assert.equal(deck('A').positionMs, 0);
    await until(() => deck('C').state === 'cued', 5000); // Jingle zu Ende → steht wieder bereit
    await wait(2600); // länger als die Stille-Erkennung
    assert.equal(st().status!.current, null, 'Stille in MANUAL startet keinen Titel');
    assert.equal(app.modeOf('main').mode, 'MANUAL');

    // Auswerfen
    app.deckAction(admin, 'main', 'C', 'eject', {});
    assert.equal(deck('C').state, 'empty');

    // AutoDJ: Automation belegt ein freies Hauptdeck selbst
    app.queueAdd('main', 'b');
    app.setBaseMode(admin, 'main', 'AUTO');
    await until(() => st().status!.current?.mediaId === 'b');
    const auto = st().status!.decks.find((d) => d.mediaId === 'b')!;
    assert.equal(auto.auto, true);
    assert.equal(auto.state, 'playing');
  } finally {
    unsub();
    app.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
