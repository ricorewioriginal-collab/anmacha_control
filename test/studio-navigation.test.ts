import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '../studio/index.html'), 'utf8');

test('Studio-Navigation: jeder sichtbare View-Link hat ein echtes Ziel', () => {
  const views = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(views.length > 0);
  for (const view of new Set(views)) {
    assert.match(html, new RegExp(`id="view-${view}"`), `data-view="${view}" braucht #view-${view}`);
  }
});

test('Studio-Navigation: jeder Sprung verweist auf ein vorhandenes Element', () => {
  const jumps = [...html.matchAll(/data-jump="([^"]+)"/g)].map((m) => m[1]!);
  for (const id of new Set(jumps)) {
    assert.match(html, new RegExp(`id="${id}"`), `data-jump="${id}" braucht #${id}`);
  }
});

test('Studio-HTML: IDs sind eindeutig und Nextcloud ist nur in Medien integriert', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], [], `doppelte IDs: ${[...new Set(dup)].join(', ')}`);
  assert.doesNotMatch(html, /data-view="nextcloud"/, 'kein separater Nextcloud-Menüpunkt');
  assert.match(html, /id="view-nextcloud"/, 'interne View bleibt für die integrierte Logik verfügbar');
});

test('Referenzlayout: zentrale Studio-Bereiche bleiben im DOM vorhanden', () => {
  for (const id of ['decks', 'carts-panel', 'carts', 'work-panel', 'queue-body', 'live-panel', 'outputs']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} fehlt`);
  }
});
