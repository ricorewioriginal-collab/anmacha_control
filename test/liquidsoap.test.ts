import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liquidsoapScript } from '../src/server/liquidsoap.ts';
import type { OutputConfig } from '../src/server/icecast.ts';

const out = (p: Partial<OutputConfig>): OutputConfig => ({
  id: 'o', stationId: 'main', name: 'Haupt', type: 'icecast', host: 'stream.example.org', port: 8000, mount: '/live', username: 'source',
  passwordRef: 'output:o', tls: false, sourceTarget: '/live', enabled: true, ...p,
});

test('Liquidsoap-Skript: alle aktiven Ausgänge, keine Passwörter, SHOUTcast/laut.fm-Priorität', () => {
  const { script, env } = liquidsoapScript([
    out({ name: 'laut.fm', host: 'stream.laut.fm', mount: '/meinradio', priority: 5, bitrateKbps: 192 }),
    out({ name: 'SC', type: 'shoutcast', host: 'sc.example.org', port: 8010, streamId: 2 }),
    out({ name: 'Aus', enabled: false }),
  ], { stationName: 'Radio "Test"', harborPort: 8005, harborMount: '/airdeck', bitrateKbps: 128, processing: true });
  assert.deepEqual(env, ['AIRDECK_LIQ_INPUT_PASSWORD', 'AIRDECK_LIQ_OUT1_PASSWORD', 'AIRDECK_LIQ_OUT2_PASSWORD']);
  assert.match(script, /input\.harbor\("airdeck", port=8005, password=pw\("AIRDECK_LIQ_INPUT_PASSWORD"\)\)/);
  assert.match(script, /mount="\/meinradio\?prio=5"/);
  assert.match(script, /%mp3\(bitrate=192\)/);
  assert.match(script, /protocol="icy", icy_id=2/);
  assert.match(script, /name="Radio \\"Test\\""/, 'Anführungszeichen maskiert');
  assert.match(script, /radio = nrj\(radio\)/);
  assert.equal((script.match(/output\.icecast/g) ?? []).length, 2, 'deaktivierter Ausgang fehlt');
  assert.ok(!/passwordRef|output:o/.test(script), 'keine Secret-Referenzen');
  const none = liquidsoapScript([], { stationName: 'X', harborPort: 8005, harborMount: 'airdeck', bitrateKbps: 128, processing: false });
  assert.match(none.script, /output\.dummy\(radio\)/);
  assert.ok(!none.script.includes('nrj'));
});
