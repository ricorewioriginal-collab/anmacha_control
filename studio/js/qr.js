// @ts-check
// AirDeckCast/Geräte-Pairing: echte QR-Grafik für einen Kopplungslink, statt nur Ziffern zum Abtippen.
// Nutzt die unveränderte, mitgelieferte Bibliothek (vendor/qrcode.js) - kein CDN, kein Netzwerk nötig.
import qrcode from './vendor/qrcode.js';

/**
 * Erzeugt eine echte, scanbare QR-Grafik (Data-URL, GIF) für einen kurzen Text (z. B. einen Kopplungslink).
 * @param {string} text
 * @returns {string}
 */
export function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 8);
}
