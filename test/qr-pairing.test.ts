// Masterprompt V1 Beta, P4 (Plattform): Geräte-Pairing gab es bereits vollständig (Kopplungscode,
// Geräteliste, Widerruf - siehe test/devices.test.ts), aber der Code musste bisher abgetippt werden.
// Ein Bild allein ("sieht aus wie ein QR-Code") beweist nicht, dass es wirklich scanbar ist - dieser
// Test erzeugt die echte QR-Grafik mit derselben Funktion, die das Studio verwendet, dekodiert sie mit
// einer unabhängigen, echten QR-Bibliothek (jsQR) und prüft, dass exakt die erwartete Kopplungs-URL
// herauskommt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { GifReader } from 'omggif';
// @ts-expect-error – Browser-Modul ohne Typdeklaration
import { qrDataUrl } from '../studio/js/qr.js';

// jsqr ist ein reines CJS-Paket; sein .d.ts passt nicht zu "moduleResolution: nodenext" ohne
// esModuleInterop - per createRequire laden statt die globale tsconfig dafür aufzuweichen.
const jsQR = createRequire(import.meta.url)('jsqr') as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

function decodeGifDataUrl(dataUrl: string): { width: number; height: number; rgba: Uint8ClampedArray } {
  const b64 = dataUrl.replace(/^data:image\/gif;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const reader = new GifReader(buf);
  const rgba = new Uint8ClampedArray(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, rgba);
  return { width: reader.width, height: reader.height, rgba };
}

test('AirDeckCast-Geräte-Pairing: die erzeugte QR-Grafik ist eine echte, unabhängig scanbare QR-Codierung des Kopplungslinks', () => {
  const url = 'http://192.168.1.20:8750/#pair=384021';
  const dataUrl = qrDataUrl(url);
  assert.match(dataUrl, /^data:image\/gif;base64,/, 'echte GIF-Grafik, kein Platzhalter');

  const { width, height, rgba } = decodeGifDataUrl(dataUrl);
  assert.ok(width > 20 && height > 20, 'QR-Grafik hat eine plausible Größe');

  const result = jsQR(rgba, width, height);
  assert.ok(result, 'eine unabhängige QR-Bibliothek erkennt und dekodiert die Grafik');
  assert.equal(result!.data, url, 'der dekodierte Inhalt ist genau der Kopplungslink, den das Studio codiert hat');
});

test('AirDeckCast-Geräte-Pairing: unterschiedliche Codes/Adressen ergeben unterschiedliche, aber je für sich korrekt lesbare QR-Grafiken', () => {
  for (const url of ['http://10.0.0.5:8750/#pair=000001', 'https://radio.example.org/#pair=999999']) {
    const { width, height, rgba } = decodeGifDataUrl(qrDataUrl(url));
    const result = jsQR(rgba, width, height);
    assert.equal(result?.data, url);
  }
});
