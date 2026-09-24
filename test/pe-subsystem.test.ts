import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error – Build-Skript ohne Typdeklaration
import { setSubsystem } from '../scripts/pe-subsystem.mjs';

test('Windows-Programm ohne Konsolenfenster: PE-Subsystem wird korrekt umgestellt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airdeck-pe-'));
  try {
    const b = Buffer.alloc(512);
    b.write('MZ', 0, 'latin1');
    b.writeUInt32LE(0x80, 0x3c);
    b.write('PE\0\0', 0x80, 'latin1');
    b.writeUInt16LE(0x20b, 0x80 + 24); // PE32+
    b.writeUInt16LE(3, 0x80 + 24 + 68); // Konsole
    const f = join(dir, 'x.exe');
    writeFileSync(f, b);
    assert.equal(setSubsystem(f, 2), 3);
    const after = readFileSync(f);
    assert.equal(after.readUInt16LE(0x80 + 24 + 68), 2);
    assert.equal(Buffer.compare(after.subarray(0, 0x80 + 24 + 68), b.subarray(0, 0x80 + 24 + 68)), 0, 'sonst nichts verändert');
    writeFileSync(join(dir, 'y.exe'), Buffer.from('keine exe'));
    assert.throws(() => setSubsystem(join(dir, 'y.exe'), 2), /MZ|kurz/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
