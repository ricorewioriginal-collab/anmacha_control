// @ts-check
// Handbuch als echte In-App-Ansicht (Masterprompt V1 Beta, Abschnitt 41): bisher öffnete "Handbuch" eine
// eigenständige externe Seite (handbuch.html) in einem neuen Tab/Fenster, mit eigener Kopfzeile - keine
// gemeinsame Seitenleiste/Kopfzeile mit dem Studio. Diese Ansicht lädt denselben Inhalt (eine Quelle,
// kein zweiter Handbuchtext) per fetch aus handbuch.html und bettet ihn direkt in den Studio-Arbeitsbereich
// ein: gleiche Seitenleiste, gleicher Sender-Umschalter, gleiche Kopfzeile. Interne Sprungmarken (#anchor)
// scrollen innerhalb der Ansicht, statt den App-URL-Hash zu verändern (der für Login/Token reserviert ist).
// Ein externer Link (falls im Handbuch vorhanden) öffnet weiterhin einen neuen Tab (Systembrowser).

import { h } from './ui.js';

/** @param {HTMLElement} root */
export function mountHandbuch(root) {
  let loaded = false;

  function filter(/** @type {string} */ q) {
    const term = q.trim().toLowerCase();
    for (const section of root.querySelectorAll('main section')) {
      const match = !term || /** @type {HTMLElement} */ (section).textContent?.toLowerCase().includes(term);
      /** @type {HTMLElement} */ (section).hidden = !match;
    }
    for (const a of root.querySelectorAll('nav.toc a')) {
      const id = a.getAttribute('href')?.slice(1);
      const target = id ? root.querySelector(`#${CSS.escape(id)}`) : null;
      /** @type {HTMLElement} */ (a).hidden = !!target && /** @type {HTMLElement} */ (target).hidden;
    }
  }

  async function load() {
    const res = await fetch('handbuch.html');
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const wrap = doc.querySelector('.wrap');
    if (!wrap) { root.replaceChildren(h('div', { class: 'empty' }, 'Handbuch konnte nicht geladen werden.')); return; }
    wrap.classList.add('hb-wrap');
    // Externe Links (falls vorhanden) im Systembrowser öffnen, interne Sprungmarken bleiben normale Links
    for (const a of wrap.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') ?? '';
      if (!href.startsWith('#')) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); }
    }
    const search = h('input', { class: 'hb-search', type: 'search', placeholder: 'Im Handbuch suchen …', oninput: (/** @type {Event} */ e) => filter(/** @type {HTMLInputElement} */ (e.target).value) });
    root.replaceChildren(search, wrap);
    root.addEventListener('click', (e) => {
      const a = /** @type {HTMLElement} */ (e.target).closest?.('a[href^="#"]');
      if (!a) return;
      e.preventDefault();
      const id = a.getAttribute('href')?.slice(1);
      const target = id ? root.querySelector(`#${CSS.escape(id)}`) : null;
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    loaded = true;
  }

  return { show: () => (loaded ? undefined : load()), onEvent: () => {} };
}
