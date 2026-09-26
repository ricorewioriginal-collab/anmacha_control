// @ts-check
// QR-Code per Kamera scannen - Gegenstück zu qr.js (das den Code erzeugt): dieselbe Kopplungsseite
// (#pair=<code> bzw. #token=<...>-Verbindungslink), aber statt Tippen wird die Handy-/Webcam-Kamera
// genutzt. Läuft in der Android-App (Capacitor-WebView) genauso wie in jedem Desktop-Browser mit
// Kamera - kein natives Plugin nötig, nur getUserMedia + der vendorierte jsQR-Dekoder.
// Eigener Dialog (statt des gemeinsamen "dialog"/"dialog-form"): ein Scan wird typischerweise aus
// einem bereits offenen formDialog heraus gestartet (Kopplungscode-Feld), ein zweites <dialog>
// vermeidet Konflikte mit dessen offener Promise/onclose-Verdrahtung.
import { $, h } from './ui.js';

/**
 * Zerlegt den dekodierten QR-Inhalt (dieselbe URL, die qr.js für „Gerät koppeln“ erzeugt:
 * "<Server-Adresse>/#pair=<6-stelliger Code>") in Kopplungscode und - falls enthalten -
 * Server-Adresse. Eigene, testbare Funktion statt Regex-Duplizierung an der Aufrufstelle.
 * @param {string} raw
 * @returns {{ code: string, server: string|null }|null}
 */
export function parsePairingPayload(raw) {
  const code = /[#&]pair=(\d{6})(?!\d)/.exec(raw)?.[1];
  if (!code) return null;
  const server = /^(https?:\/\/[^#\s]+?)\/?#/.exec(raw)?.[1] ?? null;
  return { code, server };
}

/**
 * Öffnet einen Dialog mit Live-Kamerabild und liefert den dekodierten QR-Inhalt (z. B. eine URL mit
 * "#pair=123456" oder "#token=..."), oder null bei Abbruch/Fehler.
 * @returns {Promise<string|null>}
 */
export async function scanQrCode() {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  const jsQR = /** @type {any} */ (window).jsQR;
  if (typeof jsQR !== 'function') return null;

  const dlg = /** @type {HTMLDialogElement} */ ($('scan-dialog'));
  const video = /** @type {HTMLVideoElement} */ (h('video', { autoplay: true, playsinline: true, muted: true, style: 'display:block;width:100%;max-width:360px;margin:0 auto;border-radius:8px;background:#000' }));
  const hint = h('p', { class: 'muted', style: 'text-align:center;margin:10px 0 0' }, 'Kamera wird gestartet …');
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, 'Abbrechen');
  dlg.replaceChildren(
    h('h3', {}, 'QR-Code scannen'),
    video,
    hint,
    h('div', { class: 'dialog-actions' }, cancelBtn),
  );

  /** @type {MediaStream|null} */
  let stream = null;
  let stopped = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const stop = () => {
    stopped = true;
    for (const t of stream?.getTracks() ?? []) t.stop();
  };

  /** @type {(v: string|null) => void} */
  let finish = () => {};
  const result = new Promise((resolve) => { finish = resolve; });
  const close = (/** @type {string|null} */ v) => {
    stop();
    dlg.onclose = null;
    if (dlg.open) dlg.close();
    finish(v);
  };
  cancelBtn.onclick = () => close(null);
  dlg.onclose = () => close(null); // Escape-Taste o. Ä.
  dlg.showModal();

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    hint.textContent = 'Kein Kamerazugriff (Berechtigung verweigert oder keine Kamera vorhanden).';
    return result;
  }
  if (stopped) { for (const t of stream.getTracks()) t.stop(); return result; }
  video.srcObject = stream;
  hint.textContent = 'QR-Code vor die Kamera halten …';

  const tick = () => {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(frame.data, frame.width, frame.height);
      if (code?.data) {
        close(code.data);
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return result;
}
