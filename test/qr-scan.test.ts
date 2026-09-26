// Masterprompt V1 Beta, P4 (Plattform): "native Android-Kamera-QR-Scan" - Gegenstück zu
// test/qr-pairing.test.ts (das die erzeugte QR-Grafik prüft): hier wird geprüft, dass a) die
// tatsächlich ausgelieferte, vendorierte jsQR-Datei (studio/js/vendor/jsqr.js - nicht nur die
// npm-Testabhängigkeit) eine echte, vom Studio erzeugte QR-Grafik korrekt dekodiert, und b) die
// Kopplungs-URL aus dem dekodierten Text (Server-Adresse + Kopplungscode) korrekt herausgelöst wird
// (studio/js/qrscan.js: parsePairingPayload) - exakt die Logik, die app.js beim Kamera-Scan nutzt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { GifReader } from 'omggif';
// @ts-expect-error – Browser-Modul ohne Typdeklaration
import { qrDataUrl } from '../studio/js/qr.js';
// @ts-expect-error – Browser-Modul ohne Typdeklaration
import { parsePairingPayload } from '../studio/js/qrscan.js';

// Die vendorierte jsQR-Datei ist ein UMD-Bundle, das sich an "self" (Browser-Fensterobjekt) hängt -
// in Node existiert das nicht automatisch. Echte Datei laden (kein Nachbau/keine Kopie), im aktuellen
// globalen Kontext ausführen, mit "self = globalThis" versehen, damit sie sich genauso verhält wie im
// Browser/der Android-WebView.
(globalThis as unknown as { self?: unknown }).self ??= globalThis;
vm.runInThisContext(readFileSync(new URL('../studio/js/vendor/jsqr.js', import.meta.url), 'utf8'), { filename: 'vendor-jsqr.js' });
const jsQR = (globalThis as unknown as { jsQR: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null }).jsQR;

function decodeGifDataUrl(dataUrl: string): { width: number; height: number; rgba: Uint8ClampedArray } {
  const b64 = dataUrl.replace(/^data:image\/gif;base64,/, '');
  const reader = new GifReader(Buffer.from(b64, 'base64'));
  const rgba = new Uint8ClampedArray(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, rgba);
  return { width: reader.width, height: reader.height, rgba };
}

test('Kamera-Scan: die ausgelieferte vendorierte jsQR-Datei dekodiert eine echte, vom Studio erzeugte QR-Grafik', () => {
  assert.equal(typeof jsQR, 'function', 'vendor/jsqr.js setzt window.jsQR wie vom UMD-Wrapper erwartet');
  const url = 'http://192.168.1.20:8750/#pair=384021';
  const { width, height, rgba } = decodeGifDataUrl(qrDataUrl(url));
  const result = jsQR(rgba, width, height);
  assert.equal(result?.data, url, 'dieselbe Grafik, die die Kopplungsseite anzeigt, wird von der ausgelieferten Kamera-Scan-Bibliothek korrekt gelesen');
});

test('parsePairingPayload: Server-Adresse und Kopplungscode werden aus dem gescannten Link herausgelöst', () => {
  assert.deepEqual(parsePairingPayload('http://192.168.1.20:8750/#pair=384021'), { code: '384021', server: 'http://192.168.1.20:8750' });
  assert.deepEqual(parsePairingPayload('https://radio.example.org/#pair=999999'), { code: '999999', server: 'https://radio.example.org' });
  // Direkter Hash ohne Adresse (z. B. schon auf dem richtigen Server, wie bei tryAutoPair()) - kein Server, aber Code vorhanden.
  assert.deepEqual(parsePairingPayload('#pair=000001'), { code: '000001', server: null });
});

test('parsePairingPayload: beliebiger anderer QR-Inhalt (kein AirDeck-Kopplungslink) wird abgelehnt statt einen falschen Code zu liefern', () => {
  for (const bad of ['https://example.org/', 'http://x/#token=abc123', '#pair=12345', '#pair=1234567', 'zufälliger Text']) {
    assert.equal(parsePairingPayload(bad), null, `"${bad}" ist kein gültiger Kopplungslink`);
  }
});
