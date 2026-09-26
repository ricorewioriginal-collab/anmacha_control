import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlayQueue,
  SilenceDetector,
  backtime,
  fillFromClock,
  parseFileName,
  pickNext,
  playLength,
  type MediaItem,
} from '../src/core/automation.ts';

function m(id: string, artist: string, category: MediaItem['category'] = 'music', durationMs = 180_000, genre?: string): MediaItem {
  return { id, artist, title: id, category, file: `${id}.mp3`, durationMs, addedAt: 0, genre };
}

test('parseFileName trennt Interpret und Titel', () => {
  assert.deepEqual(parseFileName('music/Avicii - Wake Me Up.mp3'), { artist: 'Avicii', title: 'Wake Me Up' });
  assert.deepEqual(parseFileName('Jingle 01.wav'), { artist: '', title: 'Jingle 01' });
});

test('playLength berücksichtigt Cue und Segue', () => {
  assert.equal(playLength({ ...m('a', 'x'), cueInMs: 1000, cueOutMs: 170_000, segueMs: 5000 }), 164_000);
  assert.equal(playLength({ ...m('a', 'x'), durationMs: null }), null);
});

test('pickNext beachtet Interpret- und Titeltrennung', () => {
  const lib = [m('a1', 'A'), m('a2', 'A'), m('b1', 'B'), m('c1', 'C')];
  const next = pickNext(lib, 'music', ['a1'], { artistSeparation: 2, titleSeparation: 3 }, () => 0);
  assert.ok(next && next.artist !== 'A');
});

test('pickNext beachtet Genre-Trennung, wenn eingestellt (P2 #17 Rotation)', () => {
  // Zwei "Pop"-Titel, ein "Rock"-Titel: mit genreSeparation muss zuerst der Rock-Titel kommen
  const lib = [m('p1', 'A', 'music', 180_000, 'Pop'), m('p2', 'B', 'music', 180_000, 'Pop'), m('r1', 'C', 'music', 180_000, 'Rock')];
  const withGenre = pickNext(lib, 'music', ['p1'], { artistSeparation: 0, titleSeparation: 0, genreSeparation: 2 }, () => 0);
  assert.equal(withGenre?.genre, 'Rock');
  // Ohne Genre-Trennung (Standard: 0 = aus) darf wieder Pop kommen
  const withoutGenre = pickNext(lib, 'music', ['p1'], { artistSeparation: 0, titleSeparation: 0 }, () => 0);
  assert.equal(withoutGenre?.genre, 'Pop');
});

test('pickNext beachtet Hard-Time-Grenze (P2 #19 Soft Timing): wählt einen passenden statt blind einen zu langen Titel', () => {
  const lib = [m('long', 'A', 'music', 6 * 60_000), m('short', 'B', 'music', 90_000)];
  // Nur noch 2 Minuten bis zum harten Termin: der 6-Minuten-Titel passt nicht, der 90-Sekunden-Titel schon
  const fits = pickNext(lib, 'music', [], { artistSeparation: 0, titleSeparation: 0 }, () => 0, 120_000);
  assert.equal(fits?.id, 'short');
  // Ohne Grenze bleibt die normale Auswahl möglich (hier zufällig, aber nicht ausgeschlossen)
  const noLimit = pickNext(lib, 'music', [], { artistSeparation: 0, titleSeparation: 0 }, () => 0);
  assert.ok(noLimit);
});

test('pickNext: passt kein Titel mehr in die Restzeit, wird sanft gelandet (kürzester Titel statt Überziehen)', () => {
  const lib = [m('long1', 'A', 'music', 5 * 60_000), m('long2', 'B', 'music', 4 * 60_000)];
  // Nur noch 30 Sekunden übrig - keiner passt, also der kürzeste (long2)
  const landed = pickNext(lib, 'music', [], { artistSeparation: 0, titleSeparation: 0 }, () => 0, 30_000);
  assert.equal(landed?.id, 'long2');
});

test('fillFromClock berücksichtigt einen Hard-Time-Termin über mehrere Slots hinweg', () => {
  const lib = [m('long', 'A', 'music', 6 * 60_000), m('short', 'B', 'music', 60_000)];
  const q = new PlayQueue();
  const now = Date.now();
  // Termin in 90 Sekunden: für den ersten Musik-Slot passt nur "short" (60s), danach ist der Termin praktisch erreicht
  fillFromClock(q, lib, { id: 'c', name: 'c', slots: ['music'] }, [], 0, 1, undefined, () => 0, { at: now + 90_000, startAt: now });
  assert.equal(q.list()[0]?.mediaId, 'short');
});

test('pickNext lockert Regeln statt stehen zu bleiben', () => {
  const lib = [m('a1', 'A')];
  assert.equal(pickNext(lib, 'music', ['a1'])?.id, 'a1');
  assert.equal(pickNext(lib, 'jingle', []), null);
});

test('PlayQueue add/move/remove', () => {
  const q = new PlayQueue();
  const a = q.add('a');
  const b = q.add('b');
  q.add('c', 'manual', 0);
  assert.deepEqual(q.list().map((x) => x.mediaId), ['c', 'a', 'b']);
  q.move(b.uid, 0);
  assert.deepEqual(q.list().map((x) => x.mediaId), ['b', 'c', 'a']);
  assert.ok(q.remove(a.uid));
  assert.equal(q.shift()?.mediaId, 'b');
  assert.equal(q.length, 1);
});

test('fillFromClock füllt nach Sendeuhr und überspringt leere Kategorien', () => {
  const lib = [m('s1', 'St', 'station_id', 5000), m('a', 'A'), m('b', 'B'), m('c', 'C')];
  const q = new PlayQueue();
  fillFromClock(q, lib, { id: 'c', name: 'c', slots: ['station_id', 'jingle', 'music', 'music'] }, [], 0, 3, undefined, () => 0);
  const ids = q.list().map((x) => x.mediaId);
  assert.equal(ids.length, 3);
  assert.equal(ids[0], 's1');
  assert.equal(new Set(ids).size, 3);
});

test('backtime berechnet Startzeiten und Abweichung', () => {
  const lib = new Map([['a', m('a', 'A', 'music', 60_000)], ['b', m('b', 'B', 'music', 30_000)]]);
  const q = new PlayQueue();
  q.add('a');
  q.add('b');
  const r = backtime(q.list(), lib, 0, 10_000, 120_000);
  assert.equal(r.rows[0]!.startsAt, 10_000);
  assert.equal(r.rows[1]!.startsAt, 70_000);
  assert.equal(r.deviationMs, -20_000);
});

test('SilenceDetector löst nach Dauer aus und meldet Erholung', () => {
  const d = new SilenceDetector({ thresholdDb: -50, durationMs: 1000 });
  assert.equal(d.feed(-60, 0), null);
  assert.equal(d.feed(-60, 999), null);
  assert.equal(d.feed(-60, 1000), 'silence');
  assert.equal(d.feed(-60, 2000), null);
  assert.equal(d.feed(-10, 2100), 'recovered');
  assert.equal(d.isSilent, false);
});
