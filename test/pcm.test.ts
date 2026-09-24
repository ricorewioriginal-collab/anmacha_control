import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PcmFifo, busRmsDb, busToS16, mixInto } from '../src/core/pcm.ts';

test('PcmFifo liest ganze Frames auch bei unausgerichteten Chunks', () => {
  const f = new PcmFifo();
  const src = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) src.writeInt16LE(i * 100, i * 2);
  f.push(src.subarray(0, 3));
  f.push(src.subarray(3, 9));
  f.push(src.subarray(9));
  assert.equal(f.frames, 4);
  const { samples, got } = f.read(3);
  assert.equal(got, 3);
  assert.deepEqual([...samples], [0, 100, 200, 300, 400, 500]);
  const rest = f.read(4);
  assert.equal(rest.got, 1);
  assert.deepEqual([...rest.samples], [600, 700, 0, 0, 0, 0, 0, 0]); // Unterlauf → Stille
});

test('mixInto summiert mit Gain-Rampe', () => {
  const bus = new Float32Array(4);
  mixInto(bus, new Int16Array([16384, 16384, 16384, 16384]), 1, 0);
  assert.ok(Math.abs(bus[0]! - 0.5) < 1e-6);
  assert.ok(bus[2]! < bus[0]!);
});

test('busToS16 begrenzt weich statt zu übersteuern', () => {
  const out = busToS16(new Float32Array([2, -2, 0.5]));
  assert.ok(out.readInt16LE(0) <= 32767 && out.readInt16LE(0) > 30000);
  assert.ok(out.readInt16LE(2) >= -32768 && out.readInt16LE(2) < -30000);
  assert.equal(out.readInt16LE(4), Math.round(0.5 * 32767));
});

test('busRmsDb', () => {
  assert.equal(busRmsDb(new Float32Array(10)), -90);
  assert.ok(Math.abs(busRmsDb(new Float32Array([1, 1, 1, 1]))) < 1e-9);
});
