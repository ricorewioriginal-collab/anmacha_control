// Masterprompt V1 Beta, P2 #22 (externe Stream-Metadaten): ICY-Metadaten (StreamTitle) aus einem externen
// Stream lesen, damit "Jetzt läuft" bei einem eingebundenen externen Stream echte Titel zeigt statt nur
// den einmalig beim Anlegen eingetragenen. Test baut einen echten HTTP-Server, der das ICY-Protokoll
// (icy-metaint, Längen-Byte, Metadaten-Block) exakt nachbildet - kein Mock der Parser-Funktion selbst.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { IcyMetadataReader, parseIcyMetadataBlock, parseStreamTitle } from '../src/server/icy.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout');
    await wait(20);
  }
}

test('parseStreamTitle/parseIcyMetadataBlock: "Interpret - Titel" und reiner Titel', () => {
  assert.deepEqual(parseStreamTitle('Kygo - Firestone'), { artist: 'Kygo', title: 'Firestone' });
  assert.deepEqual(parseStreamTitle('Nachrichten 12 Uhr'), { artist: '', title: 'Nachrichten 12 Uhr' });
  assert.equal(parseStreamTitle(''), null);
  assert.deepEqual(parseIcyMetadataBlock(`StreamTitle='Kygo - Firestone';StreamUrl='';`), { artist: 'Kygo', title: 'Firestone' });
  assert.equal(parseIcyMetadataBlock('kein StreamTitle hier'), null);
});

function icyMetaBlock(title: string): Buffer {
  const text = `StreamTitle='${title}';`;
  const padded = Math.ceil(text.length / 16) * 16;
  const buf = Buffer.alloc(1 + padded);
  buf[0] = padded / 16;
  buf.write(text, 1, 'utf8');
  return buf;
}

test('IcyMetadataReader liest echte ICY-Metadaten (metaint, Längen-Byte, StreamTitle) und meldet Titeländerungen', async () => {
  const metaint = 200;
  let titleToSend = 'Kygo - Firestone';
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-metaint': String(metaint) });
    let sentAudio = 0;
    const timer = setInterval(() => {
      // metaint Bytes Audio (0xAA als Füllwert reicht, der Reader liest sie nur mit)
      res.write(Buffer.alloc(metaint, 0xaa));
      sentAudio += metaint;
      res.write(icyMetaBlock(titleToSend));
    }, 15);
    req.on('close', () => clearInterval(timer));
    void sentAudio;
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;

  const seen: Array<{ artist: string; title: string } | null> = [];
  const reader = new IcyMetadataReader(`http://127.0.0.1:${port}/stream`, { onTitle: (t) => seen.push(t) });
  try {
    reader.start();
    await until(() => seen.some((t) => t?.title === 'Firestone'));
    assert.deepEqual(seen.find((t) => t?.title === 'Firestone'), { artist: 'Kygo', title: 'Firestone' });

    // Titel ändert sich am Server - der Reader muss die Änderung erkennen (keine Wiederholung desselben Titels)
    titleToSend = 'Avicii - Levels';
    await until(() => seen.some((t) => t?.title === 'Levels'));
    assert.deepEqual(seen.at(-1), { artist: 'Avicii', title: 'Levels' });
    const firestoneCount = seen.filter((t) => t?.title === 'Firestone').length;
    assert.ok(firestoneCount >= 1 && firestoneCount < 20, 'derselbe Titel wird nicht bei jedem Metadaten-Block erneut gemeldet');
  } finally {
    reader.stop();
    srv.closeAllConnections();
    srv.close();
  }
});

test('IcyMetadataReader: Server ohne icy-metaint liefert einfach keine Titel (kein Fehler, keine Endlosschleife)', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.alloc(1000, 0xaa));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const seen: Array<{ artist: string; title: string } | null> = [];
  const reader = new IcyMetadataReader(`http://127.0.0.1:${port}/stream`, { onTitle: (t) => seen.push(t) });
  try {
    reader.start();
    await wait(300);
    assert.deepEqual(seen, [], 'keine Titel ohne icy-metaint, aber auch kein Absturz');
  } finally {
    reader.stop();
    srv.closeAllConnections();
    srv.close();
  }
});
