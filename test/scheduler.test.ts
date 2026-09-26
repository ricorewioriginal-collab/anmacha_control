import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockDue, dueJobs, inWindow, nextClockOccurrence, nextHardMark, nextOccurrence, parseM3U, toM3U, weekday, type ClockEvent, type ScheduledJob } from '../src/core/scheduler.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('weekday: Montag = 0, Sonntag = 6', () => {
  assert.equal(weekday(new Date(2026, 8, 21)), 0); // Mo 21.09.2026
  assert.equal(weekday(new Date(2026, 8, 27)), 6);
});

test('nextOccurrence für alle Wiederholungen', () => {
  const base = at(2026, 9, 25, 18, 0); // Freitag
  assert.equal(nextOccurrence({ at: base, repeat: 'none' }, base), null);
  assert.equal(nextOccurrence({ at: base, repeat: 'hourly' }, base), at(2026, 9, 25, 19, 0));
  assert.equal(nextOccurrence({ at: base, repeat: 'daily' }, base), at(2026, 9, 26, 18, 0));
  assert.equal(nextOccurrence({ at: base, repeat: 'weekdays' }, base), at(2026, 9, 28, 18, 0)); // Montag
  assert.equal(nextOccurrence({ at: base, repeat: 'weekly' }, base), at(2026, 10, 2, 18, 0));
  // lange Pause (PC war aus): nächster Termin liegt in der Zukunft
  const later = at(2026, 12, 1, 12, 0);
  const n = nextOccurrence({ at: base, repeat: 'daily' }, later)!;
  assert.equal(n, at(2026, 12, 1, 18, 0));
});

test('dueJobs liefert Jobs im Intervall (from, to]', () => {
  const jobs = [{ at: 10 }, { at: 20 }, { at: 30 }];
  assert.deepEqual(dueJobs(jobs, 10, 30).map((j) => j.at), [20, 30]);
});

test('clockDue beachtet Minuten, Stunden und Tage', () => {
  const ev = (p: Partial<ClockEvent>): ClockEvent => ({ id: 'x', enabled: true, minutes: [0], hours: [], days: [], kind: 'folder', mode: 'track', ...p });
  const d = new Date(2026, 8, 25, 14, 0); // Freitag 14:00
  assert.equal(clockDue([ev({})], d).length, 1);
  assert.equal(clockDue([ev({ minutes: [30] })], d).length, 0);
  assert.equal(clockDue([ev({ hours: [15] })], d).length, 0);
  assert.equal(clockDue([ev({ days: [4] })], d).length, 1);
  assert.equal(clockDue([ev({ days: [0] })], d).length, 0);
  assert.equal(clockDue([ev({ enabled: false })], d).length, 0);
});

const ev = (p: Partial<ClockEvent>): ClockEvent => ({ id: 'x', enabled: true, minutes: [0], hours: [], days: [], kind: 'folder', mode: 'track', ...p });

test('nextClockOccurrence findet den nächsten passenden Zeitpunkt (Minute/Stunde/Wochentag)', () => {
  const fri1400 = at(2026, 9, 25, 14, 0); // Freitag 14:00
  assert.equal(nextClockOccurrence(ev({ minutes: [0] }), fri1400), at(2026, 9, 25, 15, 0));
  assert.equal(nextClockOccurrence(ev({ minutes: [30] }), fri1400), at(2026, 9, 25, 14, 30));
  assert.equal(nextClockOccurrence(ev({ minutes: [0], hours: [8] }), fri1400), at(2026, 9, 26, 8, 0));
  // Nur Montags (Wochentag 0), jede Stunde erlaubt - erster Treffer ist Montag 00:00
  assert.equal(nextClockOccurrence(ev({ minutes: [0], days: [0] }), fri1400), at(2026, 9, 28, 0, 0));
  assert.equal(nextClockOccurrence(ev({ enabled: false }), fri1400), null);
  assert.equal(nextClockOccurrence(ev({ minutes: [] }), fri1400), null);
});

test('nextHardMark: nur mode "now" zählt als harter Termin, innerhalb des Vorlauf-Fensters', () => {
  const now = at(2026, 9, 25, 11, 55);
  const hardAt12 = ev({ id: 'news', minutes: [0], hours: [12], mode: 'now' });
  const softAt12 = ev({ id: 'soft', minutes: [0], hours: [12], mode: 'track' });
  assert.equal(nextHardMark([hardAt12], [], now, 3600e3), at(2026, 9, 25, 12, 0));
  // "track"/"fx"-Modus ist kein harter Termin
  assert.equal(nextHardMark([softAt12], [], now, 3600e3), null);
  // Außerhalb des Vorlauf-Fensters wird er nicht gemeldet
  assert.equal(nextHardMark([hardAt12], [], now, 60_000), null);
  // Zeitplan-Job im Modus "sofort" zählt ebenfalls, der frühere der beiden gewinnt
  const job: ScheduledJob = { id: 'j', at: at(2026, 9, 25, 11, 58), repeat: 'none', kind: 'media', mode: 'now' };
  assert.equal(nextHardMark([hardAt12], [job], now, 3600e3), job.at);
});

test('inWindow inkl. Fenster über Mitternacht', () => {
  const w = { days: [4], from: '22:00', to: '02:00' }; // Freitagnacht
  assert.equal(inWindow(w, new Date(2026, 8, 25, 23, 0)), true); // Fr 23:00
  assert.equal(inWindow(w, new Date(2026, 8, 26, 1, 0)), true); // Sa 01:00 (gehört zu Fr)
  assert.equal(inWindow(w, new Date(2026, 8, 26, 3, 0)), false);
  assert.equal(inWindow({ days: [], from: '06:00', to: '10:00' }, new Date(2026, 8, 22, 9, 59)), true);
  assert.equal(inWindow({ days: [], from: '06:00', to: '10:00' }, new Date(2026, 8, 22, 10, 0)), false);
});

test('M3U lesen und schreiben', () => {
  const text = '#EXTM3U\r\n#EXTINF:215,Avicii - Wake Me Up\r\nmusic\\Avicii - Wake Me Up.mp3\r\n# Kommentar\r\nhttp://stream.example/live\r\n';
  const e = parseM3U(text);
  assert.equal(e.length, 2);
  assert.equal(e[0]!.title, 'Avicii - Wake Me Up');
  assert.equal(e[0]!.durationMs, 215000);
  assert.equal(e[1]!.path, 'http://stream.example/live');
  const out = toM3U([{ title: 'T', artist: 'A', durationMs: 5000, path: 'a.mp3' }]);
  assert.ok(out.startsWith('#EXTM3U') && out.includes('#EXTINF:5,A - T'));
});
