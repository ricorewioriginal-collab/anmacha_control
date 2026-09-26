// Minimales USTAR-Archiv ohne Abhängigkeit: reicht für die Sicherung (Backup), die keine Sonderfälle
// (Verzeichnisse, Symlinks, sehr lange Pfade >100 Zeichen) braucht. gzip kommt aus node:zlib.

export interface TarFile {
  name: string;
  data: Buffer;
}

function octal(n: number, len: number): Buffer {
  return Buffer.from(n.toString(8).padStart(len - 1, '0') + '\0', 'ascii');
}

function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, 'utf8') > 100) throw new Error(`Tar: Dateiname zu lang: ${name}`);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  octal(0o644, 8).copy(h, 100);
  octal(0, 8).copy(h, 108); // uid
  octal(0, 8).copy(h, 116); // gid
  octal(size, 12).copy(h, 124);
  octal(Math.floor(Date.now() / 1000), 12).copy(h, 136);
  h.fill(0x20, 148, 156); // chksum-Feld erst als Leerzeichen für die Berechnung
  h.write('0', 156, 1, 'ascii'); // typeflag: reguläre Datei
  h.write('ustar', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  octal(sum, 8).copy(h, 148);
  h[154] = 0; // chksum endet mit NUL statt Leerzeichen+NUL bei 8 Byte
  return h;
}

/** Baut ein einfaches (nicht komprimiertes) tar-Archiv aus mehreren Dateien. */
export function writeTar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const size = f.data.length;
    parts.push(header(f.name, size), f.data);
    const pad = (512 - (size % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // zwei Null-Blöcke als Ende-Markierung
  return Buffer.concat(parts);
}

/** Liest ein tar-Archiv zurück in einzelne Dateien (nur reguläre Dateien, wie von writeTar erzeugt). */
export function readTar(buf: Buffer): TarFile[] {
  const out: TarFile[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break; // Ende-Markierung
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    off += 512;
    out.push({ name, data: Buffer.from(buf.subarray(off, off + size)) });
    off += size + ((512 - (size % 512)) % 512);
  }
  return out;
}
