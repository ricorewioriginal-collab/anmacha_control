// Setzt das Subsystem einer Windows-.exe (PE32/PE32+): 2 = GUI (kein Konsolenfenster), 3 = Konsole.
// Node erkennt fehlende Konsolen-Handles und schreibt Ausgaben dann ins Leere (bzw. in die Logdatei).
import { closeSync, openSync, readSync, writeSync } from 'node:fs';

/** @param {string} file @param {2|3} subsystem @returns {number} vorheriger Wert */
export function setSubsystem(file, subsystem) {
  const fd = openSync(file, 'r+');
  try {
    const at = (/** @type {number} */ pos, /** @type {number} */ len) => {
      const b = Buffer.alloc(len);
      if (readSync(fd, b, 0, len, pos) !== len) throw new Error('Datei zu kurz');
      return b;
    };
    if (at(0, 2).toString('latin1') !== 'MZ') throw new Error('Keine Windows-Programmdatei (MZ fehlt)');
    const pe = at(0x3c, 4).readUInt32LE(0);
    if (at(pe, 4).toString('latin1') !== 'PE\0\0') throw new Error('PE-Signatur fehlt');
    const opt = pe + 24;
    const magic = at(opt, 2).readUInt16LE(0);
    if (magic !== 0x10b && magic !== 0x20b) throw new Error(`Unbekannter Optional Header (0x${magic.toString(16)})`);
    const pos = opt + 68; // Subsystem liegt bei PE32 und PE32+ an derselben Stelle
    const prev = at(pos, 2).readUInt16LE(0);
    if (prev !== 2 && prev !== 3) throw new Error(`Unerwartetes Subsystem ${prev}`);
    const out = Buffer.alloc(2);
    out.writeUInt16LE(subsystem, 0);
    writeSync(fd, out, 0, 2, pos);
    return prev;
  } finally {
    closeSync(fd);
  }
}
