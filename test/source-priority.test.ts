import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SourcePriorityEngine,
  validatePriority,
  type Actor,
  type EngineEvent,
  type SourceConfig,
} from '../src/core/source-priority.ts';

const admin: Actor = { id: 'admin', roles: ['admin'], stationIds: ['*'] };
const dj: Actor = { id: 'dj', roles: ['dj'], stationIds: ['st1'] };
const foreign: Actor = { id: 'x', roles: ['dj'], stationIds: ['st2'] };

function cfg(id: string, priority: number, extra: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id,
    stationId: 'st1',
    name: id,
    type: 'automation',
    target: '/live',
    priority,
    takeoverPolicy: 'auto',
    allowedRoles: ['dj', 'operator'],
    ...extra,
  };
}

function setup(opts = {}) {
  let t = 1000;
  const e = new SourcePriorityEngine({ now: () => t, ...opts });
  const events: EngineEvent[] = [];
  e.on((ev) => events.push(ev));
  return { e, events, advance: (ms: number) => (t += ms) };
}

test('Priority-Validierung: nur positive Ganzzahlen', () => {
  assert.equal(validatePriority(1), 1);
  for (const bad of [0, -1, 1.5, NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => validatePriority(bad), /positive Ganzzahl/);
  }
  const { e } = setup();
  assert.throws(() => e.addSource(cfg('a', 0)));
  assert.throws(() => e.addSource(cfg('b', -5)));
  assert.throws(() => e.addSource(cfg('c', 2.5)));
});

test('erste verbundene Quelle geht auf Sendung', () => {
  const { e } = setup();
  e.addSource(cfg('auto', 10));
  e.connect('auto');
  assert.equal(e.activeFor('st1', '/live')?.id, 'auto');
});

test('Priority 1 verdrängt Priority 10', () => {
  const { e, events } = setup();
  e.addSource(cfg('auto', 10));
  e.addSource(cfg('live', 1, { type: 'live_studio' }));
  e.connect('auto');
  e.connect('live', dj);
  assert.equal(e.activeFor('st1', '/live')?.id, 'live');
  assert.equal(e.get('auto')?.state, 'standby');
  assert.ok(events.some((x) => x.type === 'SOURCE_DISPLACED' && x.sourceId === 'auto'));
});

test('Priority 10 verdrängt Priority 1 nicht', () => {
  const { e } = setup();
  e.addSource(cfg('live', 1));
  e.addSource(cfg('auto', 10));
  e.connect('live');
  e.connect('auto');
  assert.equal(e.activeFor('st1', '/live')?.id, 'live');
  assert.throws(() => e.requestTakeover('auto', dj), /gleiche oder höhere Priorität/);
});

test('gleiche Priorität: sendende Quelle bleibt (deterministisch)', () => {
  const { e } = setup();
  e.addSource(cfg('a', 5));
  e.addSource(cfg('b', 5));
  e.connect('a');
  e.connect('b');
  assert.equal(e.activeFor('st1', '/live')?.id, 'a');
  e.disconnect('a');
  assert.equal(e.activeFor('st1', '/live')?.id, 'b');
});

test('nicht autorisierte Übernahme wird abgelehnt', () => {
  const { e, events } = setup();
  e.addSource(cfg('auto', 10));
  e.addSource(cfg('live', 1, { allowedRoles: ['studio'] }));
  e.connect('auto');
  assert.throws(() => e.connect('live', dj), /Nicht autorisiert/);
  assert.equal(e.activeFor('st1', '/live')?.id, 'auto');
  assert.ok(events.some((x) => x.type === 'TAKEOVER_REJECTED'));
});

test('falscher Sender wird abgelehnt', () => {
  const { e } = setup();
  e.addSource(cfg('auto', 10));
  e.addSource(cfg('live', 1, { takeoverPolicy: 'manual' }));
  e.connect('auto');
  e.connect('live');
  assert.throws(() => e.requestTakeover('live', foreign), /Nicht autorisiert/);
  assert.throws(() => e.requestTakeover('live', admin, { stationId: 'st2' }), /anderen Sender/);
  e.requestTakeover('live', dj, { stationId: 'st1' });
  assert.equal(e.activeFor('st1', '/live')?.id, 'live');
});

test('Quellen verschiedener Targets beeinflussen sich nicht', () => {
  const { e } = setup();
  e.addSource(cfg('a', 10));
  e.addSource(cfg('b', 1, { target: '/other' }));
  e.connect('a');
  e.connect('b');
  assert.equal(e.activeFor('st1', '/live')?.id, 'a');
  assert.equal(e.activeFor('st1', '/other')?.id, 'b');
});

test('Disconnect führt zu Fallback auf beste verfügbare Quelle', () => {
  const { e, events } = setup();
  e.addSource(cfg('emergency', 100, { type: 'emergency' }));
  e.addSource(cfg('backup', 20));
  e.addSource(cfg('live', 1));
  e.connect('emergency');
  e.connect('backup');
  e.connect('live');
  e.disconnect('live');
  assert.equal(e.activeFor('st1', '/live')?.id, 'backup');
  assert.ok(events.some((x) => x.type === 'FALLBACK_COMPLETED' && x.sourceId === 'backup'));
});

test('konfigurierte Fallback-Quelle hat Vorrang', () => {
  const { e } = setup();
  e.addSource(cfg('backup', 20));
  e.addSource(cfg('emergency', 100, { takeoverPolicy: 'manual' }));
  e.addSource(cfg('live', 1, { fallbackSourceId: 'emergency' }));
  e.connect('backup');
  e.connect('emergency');
  e.connect('live');
  e.fail('live', 'encoder lost');
  assert.equal(e.activeFor('st1', '/live')?.id, 'emergency');
});

test('Fallback-Kette läuft über mehrere Stufen, wenn die erste Stufe nicht erreichbar ist', () => {
  const { e } = setup();
  // "manualStudio" ist die vom Betreiber gewünschte 2. Stufe, aber (noch) nicht verbunden.
  // "auto"-Quellen mit schlechterer Priorität dürfen die explizit verkettete, gesunde
  // "emergency"-Quelle (takeoverPolicy 'manual') nicht verdrängen - vorher wurde bei nicht
  // erreichbarer 1. Stufe komplett auf reine Prioritäts-Reihenfolge unter 'auto'-Quellen
  // zurückgefallen, wodurch eine verkettete 'manual'-Quelle nie gefunden wurde.
  e.addSource(cfg('live', 1, { type: 'live_studio', fallbackSourceId: 'manualStudio' }));
  e.addSource(cfg('manualStudio', 50, { takeoverPolicy: 'manual', fallbackSourceId: 'emergency' }));
  e.addSource(cfg('emergency', 100, { takeoverPolicy: 'manual' }));
  e.connect('live');
  e.connect('emergency');
  // manualStudio bewusst NICHT verbunden - Betreiber ist (noch) nicht am Reserve-Studio.
  e.fail('live', 'encoder lost');
  assert.equal(e.activeFor('st1', '/live')?.id, 'emergency', 'Kette wird bis zur erreichbaren Stufe durchlaufen');
});

test('Ringkette in der Fallback-Konfiguration führt nicht zur Endlosschleife', () => {
  const { e, events } = setup();
  // Fehlkonfiguration: a -> b -> a. Beide sind nicht erreichbar (nicht verbunden), eine echte
  // 'auto'-Quelle mit niedrigerer Priorität muss trotzdem gefunden werden statt dass die Engine
  // in der Ringkette hängen bleibt.
  e.addSource(cfg('live', 1, { fallbackSourceId: 'a' }));
  e.addSource(cfg('a', 20, { takeoverPolicy: 'manual', fallbackSourceId: 'b' }));
  e.addSource(cfg('b', 21, { takeoverPolicy: 'manual', fallbackSourceId: 'a' }));
  e.addSource(cfg('auto', 90));
  e.connect('live');
  e.connect('auto');
  // a und b bewusst nicht verbunden.
  const start = Date.now();
  e.fail('live', 'encoder lost');
  assert.ok(Date.now() - start < 1000, 'kein Hängenbleiben in der Ringkette');
  assert.equal(e.activeFor('st1', '/live')?.id, 'auto');
  assert.ok(events.some((x) => x.type === 'FALLBACK_COMPLETED' && x.sourceId === 'auto'));
});

test('ohne Fallback-Quelle wird OFF_AIR gemeldet', () => {
  const { e, events } = setup();
  e.addSource(cfg('live', 1));
  e.connect('live');
  e.disconnect('live');
  assert.equal(e.activeFor('st1', '/live'), undefined);
  assert.ok(events.some((x) => x.type === 'OFF_AIR'));
});

test('Netzwerk-Flapping erzeugt keinen Takeover-Sturm', () => {
  const { e, events, advance } = setup({ stableMs: 3000 });
  e.addSource(cfg('auto', 10));
  e.addSource(cfg('live', 1));
  e.connect('auto');
  for (let i = 0; i < 10; i++) {
    e.connect('live');
    advance(500);
    e.tick();
    e.disconnect('live');
    advance(500);
  }
  assert.equal(events.filter((x) => x.type === 'TAKEOVER_COMPLETED').length, 1); // nur der Erststart
  assert.equal(e.activeFor('st1', '/live')?.id, 'auto');
  e.connect('live');
  advance(3000);
  e.tick();
  assert.equal(e.activeFor('st1', '/live')?.id, 'live');
});

test('Cooldown verhindert Kaskaden automatischer Übernahmen', () => {
  const { e, advance } = setup({ cooldownMs: 5000 });
  e.addSource(cfg('auto', 10));
  e.addSource(cfg('remote', 2));
  e.addSource(cfg('live', 1));
  e.connect('auto');
  e.connect('remote');
  e.connect('live');
  assert.equal(e.activeFor('st1', '/live')?.id, 'remote');
  advance(5000);
  e.tick();
  e.connect('live');
  e.updateSource('live', { name: 'Live Studio' }); // löst Auswertung aus
  assert.equal(e.activeFor('st1', '/live')?.id, 'live');
});

test('ungesunde Quelle fällt aus und löst Fallback aus', () => {
  const { e } = setup();
  e.addSource(cfg('auto', 10));
  e.addSource(cfg('live', 1));
  e.connect('auto');
  e.connect('live');
  e.setHealth('live', false, 'silence');
  assert.equal(e.get('live')?.state, 'failed');
  assert.equal(e.activeFor('st1', '/live')?.id, 'auto');
});

test('gesperrte Quelle kann nicht übernehmen', () => {
  const { e } = setup();
  e.addSource(cfg('auto', 10));
  e.addSource(cfg('live', 1, { blocked: true }));
  e.connect('auto');
  assert.throws(() => e.connect('live'), /gesperrt/);
  e.updateSource('live', { blocked: false });
  e.connect('live');
  assert.equal(e.activeFor('st1', '/live')?.id, 'live');
});

test('Operator Override erlaubt niedrigere Priorität nur mit Rolle', () => {
  const { e } = setup();
  e.addSource(cfg('live', 1));
  e.addSource(cfg('auto', 10));
  e.connect('live');
  e.connect('auto');
  assert.throws(() => e.requestTakeover('auto', dj, { force: true }), /Override/);
  e.requestTakeover('auto', { id: 'op', roles: ['operator'], stationIds: ['st1'] }, { force: true });
  assert.equal(e.activeFor('st1', '/live')?.id, 'auto');
});

test('Release gibt an Automation zurück', () => {
  const { e } = setup();
  e.addSource(cfg('auto', 10));
  e.addSource(cfg('live', 1));
  e.connect('auto');
  e.connect('live', dj);
  e.release('live', dj);
  assert.equal(e.activeFor('st1', '/live')?.id, 'auto');
});

test('Neustart rekonstruiert Konfiguration ohne konkurrierende aktive Quellen', () => {
  const { e } = setup();
  e.addSource(cfg('auto', 10, { credentialRef: 'secret:auto' }));
  e.addSource(cfg('live', 1));
  e.connect('auto');
  e.connect('live');
  const restored = SourcePriorityEngine.restore(JSON.parse(JSON.stringify(e.exportConfig())));
  assert.equal(restored.list().filter((s) => s.state === 'active').length, 0);
  restored.connect('auto');
  restored.connect('live');
  assert.equal(restored.list().filter((s) => s.state === 'active').length, 1);
  assert.equal(restored.get('auto')?.credentialRef, 'secret:auto');
});

test('Priority-Änderung wird validiert und neu ausgewertet', () => {
  const { e } = setup();
  e.addSource(cfg('a', 10));
  e.addSource(cfg('b', 20));
  e.connect('a');
  e.connect('b');
  assert.throws(() => e.updateSource('b', { priority: 0 }));
  e.updateSource('b', { priority: 5 });
  assert.equal(e.activeFor('st1', '/live')?.id, 'b');
});
