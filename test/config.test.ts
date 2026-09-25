import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseConf, resolveConfig, type ResolveInput } from '../src/server/config.ts';

function fsOf(files: Record<string, string>): Pick<ResolveInput, 'exists' | 'read'> {
  return { exists: (p) => p in files, read: (p) => files[p] ?? '' };
}
const base = { root: '/opt/ad', packaged: true, desktop: true, platform: 'linux' as const, home: '/home/u' };

test('parseConf: Abschnitte, Kommentare, Anführungszeichen, BOM', () => {
  const c = parseConf('\uFEFF# x\nmode = hybrid\n[network]\nport=9000\n; y\n[paths]\ndata = "D:\\\\AirDeck data"\nkaputt\n');
  assert.deepEqual(c, { mode: 'hybrid', 'network.port': '9000', 'paths.data': 'D:\\\\AirDeck data' });
});

test('ohne airdeck.conf: bisherige Orte und Verhalten bleiben', () => {
  const desk = resolveConfig({ ...base, env: {}, ...fsOf({}) });
  assert.equal(desk.mode, 'local');
  assert.equal(desk.paths.data, '/home/u/.airdeck/data');
  assert.equal(desk.paths.media, '/home/u/.airdeck/data/media');
  assert.equal(desk.configFile, '/home/u/.airdeck/data/config/airdeck.conf');
  assert.equal(desk.host, '127.0.0.1');
  assert.equal(desk.port, 8750);
  assert.equal(desk.system, false);
  const dev = resolveConfig({ ...base, packaged: false, desktop: false, env: {}, ...fsOf({}) });
  assert.equal(dev.mode, 'server');
  assert.equal(dev.paths.data, '/opt/ad/data');
  // LAN-Einstellung aus dem Studio gilt weiter
  const lan = resolveConfig({ ...base, env: {}, ...fsOf({ '/home/u/.airdeck/data/network.json': '{"lan":true}' }) });
  assert.equal(lan.host, '0.0.0.0');
});

test('systemweite Installation (Linux-Paket) wird an /etc/airdeck erkannt', () => {
  const c = resolveConfig({ ...base, desktop: false, env: {}, ...fsOf({ '/etc/airdeck/airdeck.conf': 'mode = server\n[network]\nbind = lan\nport = 8800\n' }) });
  assert.equal(c.system, true);
  assert.equal(c.paths.data, '/var/lib/airdeck');
  assert.equal(c.paths.logs, '/var/log/airdeck');
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 8800);
});

test('Windows-Dienst: ProgramData', () => {
  const pd = '/ProgramData'; // Pfadlogik des Testsystems; unter Windows C:\ProgramData
  const file = join(pd, 'AirDeck', 'config', 'airdeck.conf');
  const c = resolveConfig({ ...base, platform: 'win32', env: { ProgramData: pd }, ...fsOf({ [file]: 'mode=local' }) });
  assert.equal(c.system, true);
  assert.equal(c.paths.data, join(pd, 'AirDeck', 'data'));
});

test('relative Pfade ab Konfigurationsordner, Umgebung hat Vorrang, ungültige Werte fallen zurück', () => {
  const env = { AIRDECK_CONFIG: '/srv/ad/airdeck.conf', AIRDECK_PORT: '9100' };
  const files = { '/srv/ad/airdeck.conf': 'mode = quatsch\n[paths]\ndata = ./d\nmedia = /mnt/musik\n[network]\nport = 70000\nbind = 192.168.1.5\n' };
  const c = resolveConfig({ ...base, env, ...fsOf(files) });
  assert.equal(c.paths.data, '/srv/ad/d');
  assert.equal(c.paths.media, '/mnt/musik');
  assert.equal(c.paths.backups, '/srv/ad/d/backups');
  assert.equal(c.mode, 'local');
  assert.equal(c.port, 9100);
  assert.equal(c.host, '192.168.1.5');
  const bad = resolveConfig({ ...base, env: { AIRDECK_CONFIG: '/srv/ad/airdeck.conf', AIRDECK_MODE: 'HYBRID' }, ...fsOf(files) });
  assert.equal(bad.port, 8750);
  assert.equal(bad.mode, 'hybrid');
});
