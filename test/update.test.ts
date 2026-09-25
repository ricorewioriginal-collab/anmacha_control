import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SOURCE, Updater, buildFromBody, isNewer } from '../src/server/update.ts';

const SHA = 'a'.repeat(7) + 'b'.repeat(33);
const payload = Buffer.from('MZ-fake-setup-binary');
const digest = 'sha256:' + createHash('sha256').update(payload).digest('hex');

function mockFetch(opts: { status?: number; digest?: string } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.includes('/releases/tags/') || url.endsWith('/releases/latest')) {
      if (opts.status) return new Response('{}', { status: opts.status });
      return Response.json({
        body: `Automatisch gebaut aus ${SHA}`, published_at: '2026-09-24T10:00:00Z',
        assets: [
          { name: 'AirDeck-Setup.exe', size: payload.length, digest: opts.digest ?? digest, url: 'https://api.github.com/repos/x/y/releases/assets/1' },
          { name: 'AirDeck-Windows-Portable.zip', size: 5, url: 'https://api.github.com/repos/x/y/releases/assets/2' },
          { name: 'AirDeck-Android.apk', size: 7, url: 'https://api.github.com/repos/x/y/releases/assets/3' },
        ],
      });
    }
    return new Response(payload);
  }) as typeof fetch;
  return { fn, calls };
}

test('Build-Kennung und Versionsvergleich', () => {
  assert.equal(buildFromBody(`gebaut aus ${SHA}`), 'aaaaaaa');
  assert.equal(buildFromBody('ohne sha'), null);
  assert.equal(isNewer('1234567', 'abcdef0'), true);
  assert.equal(isNewer('abcdef0', 'abcdef0'), false);
  assert.equal(isNewer('dev', 'abcdef0'), false, 'Entwicklungsstand wird nie überschrieben');
  assert.equal(isNewer('1234567', null), false);
});

test('GitHub-Release wird gelesen, Token nur als Header', async () => {
  const m = mockFetch();
  const u = new Updater('1234567', m.fn);
  const info = await u.check(DEFAULT_SOURCE, 'geheim');
  assert.equal(info.latest, 'aaaaaaa');
  assert.equal(info.available, true);
  assert.equal(info.assets.setup?.name, 'AirDeck-Setup.exe');
  assert.equal(info.assets.portable?.size, 5);
  assert.equal(info.assets.apk?.name, 'AirDeck-Android.apk');
  assert.equal(m.calls[0]!.headers.Authorization, 'Bearer geheim');
  assert.ok(!m.calls[0]!.url.includes('geheim'));
  await u.check(DEFAULT_SOURCE);
  assert.equal(m.calls.length, 1, 'Ergebnis wird zwischengespeichert');
});

test('Privates Repository ohne Token: verständliche Fehlermeldung statt leerer Antwort', async () => {
  const info = await new Updater('1234567', mockFetch({ status: 404 }).fn).check(DEFAULT_SOURCE);
  assert.equal(info.available, false);
  assert.match(info.error ?? '', /Zugriffstoken/);
});

test('Download prüft SHA-256, manipulierte Datei wird verworfen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-upd-'));
  try {
    const ok = new Updater('1234567', mockFetch().fn);
    const info = await ok.check(DEFAULT_SOURCE);
    const file = await ok.download(info.assets.setup!, undefined, dir);
    assert.deepEqual(readFileSync(file), payload);

    const bad = new Updater('1234567', mockFetch({ digest: 'sha256:' + '0'.repeat(64) }).fn);
    const info2 = await bad.check(DEFAULT_SOURCE);
    await assert.rejects(bad.download(info2.assets.setup!, undefined, dir), /Prüfsumme/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Eigene Update-Adresse (Manifest)', async () => {
  const fn = (async () => Response.json({ build: 'feedbeef00', assets: { setup: { url: 'https://example.org/s.exe', size: 3, sha256: 'ab' } } })) as unknown as typeof fetch;
  const info = await new Updater('1234567', fn).check({ repo: '', tag: '', manifestUrl: 'https://example.org/update.json' });
  assert.equal(info.latest, 'feedbee');
  assert.equal(info.assets.setup?.digest, 'sha256:ab');
  assert.equal(info.available, true);
});

test('Release-Kanal: „latest“ und der eingefrorene Kanal „nightly“ nutzen das neueste Release', async () => {
  const { releasePath } = await import('../src/server/update.ts');
  assert.equal(releasePath('latest'), 'releases/latest');
  assert.equal(releasePath('nightly'), 'releases/latest');
  assert.equal(releasePath(''), 'releases/latest');
  assert.equal(releasePath('build-7'), 'releases/tags/build-7');
  const { fn, calls } = mockFetch();
  const info = await new Updater('1234567', fn).check({ repo: 'x/y', tag: 'nightly' });
  assert.ok(calls[0]!.url.endsWith('/repos/x/y/releases/latest'));
  assert.equal(info.assets.setup?.name, 'AirDeck-Setup.exe');
});
