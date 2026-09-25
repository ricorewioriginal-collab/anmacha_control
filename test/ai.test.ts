import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirDeckApp } from '../src/server/app.ts';
import { cleanSpeech, parseFeed, parsePicks } from '../src/server/ai/director.ts';
import { chat } from '../src/server/ai/providers.ts';
import { storedText } from './helpers.ts';

let mock: Server;
let base: string;
let dir: string;
const calls: { path: string; auth?: string; body: any }[] = [];
let failPrimary = false;

const RSS = `<?xml version="1.0"?><rss><channel><title>X</title>
<item><title><![CDATA[Stadtfest am Wochenende]]></title><description>Am Samstag &amp; Sonntag in der Innenstadt.</description></item>
<item><title>Neue Radwege eröffnet</title></item></channel></rss>`;

before(async () => {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      const send = (status: number, data: unknown, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
      };
      if (req.url === '/feed.xml') return send(200, RSS, 'application/rss+xml');
      if (req.url?.startsWith('/bad/')) return send(401, { error: { message: 'Invalid API key' } });
      if (req.url?.endsWith('/models')) return send(200, { data: [{ id: 'mock-large' }, { id: 'mock-small' }] });
      if (req.url?.endsWith('/audio/speech')) return send(200, Buffer.alloc(4096, 0xff), 'audio/mpeg');
      if (req.url?.endsWith('/chat/completions')) {
        if (failPrimary && req.url.startsWith('/primary/')) return send(500, { error: { message: 'kaputt' } });
        const sys = String(body.messages[0].content);
        const user = String(body.messages[1].content);
        let content: string;
        if (sys.includes('Musikredakteur')) content = 'Hier: {"picks":["t2","t99","t2","t1"]}';
        else if (user.includes('Nachrichten zur vollen Stunde')) content = user.includes('Stadtfest') ? 'Die Nachrichten: Stadtfest am Wochenende. Neue Radwege.' : 'LEER';
        else content = '**Moderation:** "Das war Kygo mit Firestone – und jetzt Avicii!" [lacht]';
        return send(200, { choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'airdeck-ai-'));
});

after(() => {
  mock.close();
  rmSync(dir, { recursive: true, force: true });
});

const admin = { id: 't', tokenId: 't', roles: ['admin'], stationIds: ['*'], scopes: ['*'] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(20);
  }
}

test('Sprechtext wird gesäubert, Ablehnungen und leere Antworten erkannt', () => {
  assert.equal(cleanSpeech('**Moderation:** "Hallo Leute!" [lacht]', 40), 'Hallo Leute!');
  assert.throws(() => cleanSpeech('   ', 40), /Leer/);
  assert.throws(() => cleanSpeech('Als KI kann ich das nicht.', 40), /abgelehnt/);
  const long = Array.from({ length: 80 }, (_, i) => `Wort${i}`).join(' ') + '.';
  assert.ok(cleanSpeech(long, 20).split(' ').length <= 26);
});

test('RSS-Schlagzeilen und KI-Auswahl werden streng geprüft', () => {
  assert.deepEqual(parseFeed(RSS), ['Stadtfest am Wochenende – Am Samstag & Sonntag in der Innenstadt.', 'Neue Radwege eröffnet']);
  const aliases = new Map([['t1', 'a'], ['t2', 'b']]);
  assert.deepEqual(parsePicks('{"picks":["t2","t9","T1","t2"]}', aliases, 5), ['b', 'a']);
  assert.deepEqual(parsePicks('keine Ahnung', aliases, 5), []);
  assert.deepEqual(parsePicks('["t1"]', aliases, 5), ['a']);
});

test('Provider: leere Antwort ist ein Fehler, fehlender Key wird gemeldet', async () => {
  const p = { id: 'x', name: 'X', kind: 'openai' as const, role: 'text' as const, enabled: true };
  await assert.rejects(chat(p, undefined, { model: 'm', system: 's', prompt: 'p', maxTokens: 10, timeoutMs: 1000 }), /API-Key/);
  const empty = (async () => Response.json({ choices: [{ message: { content: '  ' } }] })) as unknown as typeof fetch;
  await assert.rejects(chat(p, 'k', { model: 'm', system: 's', prompt: 'p', maxTokens: 10, timeoutMs: 1000 }, empty), /Leere Antwort/);
});

test('KI-Automation: Moderation, Fallback, Kosten, Budget, Freigabe, Musikplanung', async () => {
  const app = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
  try {
    const view = app.ai.update({
      providers: [
        { id: 'primary', name: 'Primär', role: 'text', kind: 'openai_compat', baseUrl: `${base}/primary/v1`, key: 'sk-geheim-1' },
        { id: 'backup', name: 'Backup', role: 'text', kind: 'openai_compat', baseUrl: `${base}/backup/v1` },
        { id: 'tts', name: 'Stimme', role: 'voice', kind: 'openai_compat', baseUrl: `${base}/v1` },
      ],
      pricing: [{ providerId: 'primary', model: 'mock-large', inPerM: 2, outPerM: 10 }],
    }) as { providers: { hasKey: boolean }[] };
    assert.equal(view.providers[0]!.hasKey, true);
    assert.ok(!storedText(app).includes('sk-geheim-1'), 'Key nie im Klartext gespeichert');
    assert.deepEqual(await app.ai.models('primary'), ['mock-large', 'mock-small']);
    assert.throws(() => app.ai.update({ providers: [{ id: 'y', role: 'voice', kind: 'google' }] }), /passt nicht/);

    assert.throws(() => app.svc.ai.setAiConfig(admin, 'main', { enabled: true }), /Text-Provider/);
    const add = (title: string, artist: string, category: 'music' | 'station_id') =>
      app.svc.media.addMedia('main', { id: `m-${title}`, title, artist, category, file: `${title}.mp3`, durationMs: 180_000, addedAt: Date.now() });
    const kygo = add('Firestone', 'Kygo', 'music');
    add('Wake Me Up', 'Avicii', 'music');
    add('Believer', 'Imagine Dragons', 'music');
    add('ID', 'Sender', 'station_id');
    app.svc.ai.setAiConfig(admin, 'main', {
      enabled: true, everySongs: 1, maxWords: 30,
      text: { providerId: 'primary', model: 'mock-large', fallback: { providerId: 'backup', model: 'mock-small' } },
      voice: { providerId: 'tts', voice: 'alloy', model: 'tts-1' },
      sources: [{ name: 'Lokal', url: `${base}/feed.xml`, kind: 'rss', use: 'news' }],
    });

    // Moderation nach einem Musiktitel → Sprachdatei vorne in der Queue
    app.setNowPlaying('main', kygo.id, 'A');
    await until(() => (app.director.view('main') as { log: unknown[] }).log.length > 0);
    const q = (app.queueView('main') as { items: { origin: string; media: { generatedBy?: string; category: string } }[] }).items;
    assert.equal(q[0]!.origin, 'ai');
    assert.equal(q[0]!.media.generatedBy, 'ai');
    assert.equal(q[0]!.media.category, 'voice_track');
    const log = (app.director.view('main') as { log: { ok: boolean; detail: string; cost: number }[] }).log;
    assert.equal(log[0]!.ok, true);
    assert.equal(log[0]!.detail, 'Das war Kygo mit Firestone – und jetzt Avicii!');
    assert.ok(Math.abs(log[0]!.cost - (1000 * 2 + 200 * 10) / 1e6) < 1e-9, 'Kosten nach hinterlegtem Preis');
    const chatCall = calls.find((c) => c.path === '/primary/v1/chat/completions')!;
    assert.equal(chatCall.auth, 'Bearer sk-geheim-1');
    assert.match(chatCall.body.messages[1].content, /Gerade lief: Kygo – Firestone/);
    assert.equal(calls.find((c) => c.path === '/v1/audio/speech')!.body.input, 'Das war Kygo mit Firestone – und jetzt Avicii!');

    // Primär fällt aus → Fallback übernimmt; Nutzung wird pro Provider gezählt
    failPrimary = true;
    const viaBackup = await app.director.produce('main', 'break');
    assert.ok(viaBackup);
    assert.match((app.director.view('main') as { log: { providerId: string }[] }).log[0]!.providerId, /^backup\+/);
    const usage = app.ai.usageView() as { byProvider: Record<string, { errors: number; calls: number }> };
    assert.equal(usage.byProvider.primary!.errors, 1);
    failPrimary = false;

    // Nachrichten nur aus der hinterlegten Quelle
    const news = await app.director.produce('main', 'news');
    assert.ok(news && 'category' in news && news.category === 'news');
    assert.match((app.director.view('main') as { log: { detail: string }[] }).log[0]!.detail, /Stadtfest/, 'Nachrichten stammen aus dem Feed');

    // Hartes Budget: Primär gesperrt, Backup (ohne Preis) springt ein
    app.ai.update({ budgets: { providers: { primary: { hard: 0.000001 } }, stations: {} } });
    assert.equal(app.ai.budgetState('primary', 'main'), 'hard');
    const before = calls.filter((c) => c.path.startsWith('/primary/')).length;
    assert.ok(await app.director.produce('main', 'break'));
    assert.equal(calls.filter((c) => c.path.startsWith('/primary/')).length, before, 'gesperrter Provider wird nicht aufgerufen');
    app.ai.update({ budgets: { providers: {}, stations: {} } });

    // Freigabe-Modus: nichts landet ungeprüft auf Sendung
    app.svc.ai.setAiConfig(admin, 'main', { approval: true });
    const lenBefore = (app.queueView('main') as { items: unknown[] }).items.length;
    const pending = await app.director.produce('main', 'break');
    assert.ok(pending && 'text' in pending);
    assert.equal((app.queueView('main') as { items: unknown[] }).items.length, lenBefore);
    app.director.approve('main', pending.id);
    assert.equal((app.queueView('main') as { items: { mediaId: string }[] }).items[0]!.mediaId, pending.mediaId);
    assert.throws(() => app.director.reject('main', pending.id), /nicht gefunden/);

    // Musikplanung: nur gültige, freie Titel; Rückfall bleibt möglich
    app.queueClear('main');
    app.svc.ai.setAiConfig(admin, 'main', { approval: false, everySongs: 0, music: { enabled: true, lookahead: 2, jingleEvery: 0 } });
    const added = await app.director.maintainMusic('main', true);
    assert.ok(added >= 1 && added <= 2);
    const picked = (app.queueView('main') as { items: { origin: string; media: { category: string; id: string } }[] }).items;
    assert.ok(picked.every((x) => x.origin === 'ai' && x.media.category === 'music'));
    assert.ok(!picked.some((x) => x.media.id === kygo.id), 'zuletzt gespielter Titel wird nicht vorgeschlagen');

    // Konfiguration überlebt den Neustart
    app.shutdown();
    const again = new AirDeckApp(dir, { stableMs: 0, ffmpeg: null });
    assert.equal(again.svc.ai.aiConfig('main').enabled, true);
    assert.equal(again.svc.ai.aiConfig('main').text.fallback?.providerId, 'backup');
    again.shutdown();
  } finally {
    app.shutdown();
  }
});
