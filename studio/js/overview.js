// @ts-check
// Dashboard (Senderübersicht, Abschnitt 5 des Masterprompts): zeigt jeden Sender als Karte mit Logo,
// Status, aktuellem Titel und Betriebsmodus - KEINE komplette Studiooberfläche. Die bisherige "Dashboard"-
// Arbeitsfläche (Decks/Cardwall/Queue/Live) bleibt unter "Studio" erreichbar, nur eine Ansicht weiter.

import { h, run } from './ui.js';

/** @typedef {{ api: import('./api.js').Api, stations: () => any[], openStudio: (id: string) => Promise<void>, manage: (id: string) => Promise<void> }} Ctx */

const MODE_LABEL = /** @type {Record<string, string>} */ ({ AUTO: '24/7 AutoDJ', MANUAL: 'Manuell', LIVE: 'LIVE', EMERGENCY: 'Notfall' });

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountOverview(root, ctx) {
  async function cardData(/** @type {any} */ st) {
    const p = `/stations/${encodeURIComponent(st.id)}`;
    const [auto, mode, outputs] = await Promise.all([
      ctx.api.get(`${p}/automation-source`).catch(() => null),
      ctx.api.get(`${p}/mode`).catch(() => null),
      ctx.api.get(`${p}/outputs`).catch(() => []),
    ]);
    return { st, auto, mode, outputs: outputs ?? [] };
  }

  function card({ st, auto, mode, outputs }) {
    const onAir = !!mode?.bus;
    const live = outputs.some((/** @type {any} */ o) => o.state?.connected);
    const now = auto?.now;
    const nowText = auto?.source === 'none' || !now ? (auto?.source === 'lautfm' ? 'Kein Titel gemeldet' : 'Keine Automation aktiv') : `${now.artist ? `${now.artist} – ` : ''}${now.title || 'Kein Titel gemeldet'}`;
    const logo = st.logo
      ? h('img', { src: `${ctx.api.base}/api/v1/stations/${encodeURIComponent(st.id)}/logo?v=${encodeURIComponent(st.logo)}`, alt: '' })
      : h('span', {}, st.name.split(/\s+/).map((/** @type {string} */ w) => w[0]).join('').slice(0, 3).toUpperCase());
    return h('div', { class: `ov-card${onAir ? ' is-onair' : ''}` },
      h('div', { class: 'ov-head' },
        h('div', { class: `ov-logo${st.logo ? ' has-img' : ''}` }, logo),
        h('div', { class: 'ov-title' }, h('strong', {}, st.name), h('span', { class: 'muted' }, st.slogan || (auto?.source === 'lautfm' ? 'laut.fm Automation' : ''))),
        h('span', { class: `pill ${onAir ? 'active' : ''}` }, onAir ? '● ON AIR' : 'OFF AIR')),
      h('div', { class: 'ov-now-card' },
        h('span', { class: 'ov-now-label' }, 'Jetzt läuft'),
        h('strong', { class: 'ov-now' }, nowText)),
      h('div', { class: 'ov-meta' },
        h('span', { class: 'tag' }, MODE_LABEL[mode?.mode] ?? mode?.mode ?? '–'),
        h('span', { class: `tag${live ? ' live' : ''}` }, live ? `${outputs.length} Ausgang/Ausgänge · aktiv` : outputs.length ? `${outputs.length} Ausgang/Ausgänge` : 'kein Ausgang')),
      h('div', { class: 'ov-actions' },
        h('button', { class: 'btn small', onclick: () => ctx.manage(st.id) }, 'Verwalten'),
        h('button', { class: 'btn small primary', onclick: () => ctx.openStudio(st.id) }, 'Studio öffnen')));
  }

  async function show() {
    root.replaceChildren(h('div', { class: 'empty' }, 'Lade Sender …'));
    const list = ctx.stations();
    const cards = await run(() => Promise.all(list.map(cardData)));
    if (!cards) return;
    const active = cards.filter((x) => x.mode?.bus).length;
    const connected = cards.reduce((n, x) => n + x.outputs.filter((/** @type {any} */ o) => o.state?.connected).length, 0);
    root.replaceChildren(
      h('section', { class: 'ov-hero' },
        h('div', { class: 'ov-hero-copy' },
          h('span', { class: 'ov-kicker' }, 'AIRDECK CONTROL'),
          h('h1', {}, 'Dein Radio. Deine Kontrolle.'),
          h('p', {}, 'Sender, Automation, Streams und Studio auf einen Blick – ohne erfundene Statuswerte.')),
        h('div', { class: 'ov-hero-stats' },
          h('div', { class: 'ov-stat' }, h('span', {}, 'Sender'), h('strong', {}, String(cards.length))),
          h('div', { class: 'ov-stat' }, h('span', {}, 'On Air'), h('strong', {}, String(active))),
          h('div', { class: 'ov-stat' }, h('span', {}, 'verb. Ausgänge'), h('strong', {}, String(connected))))),
      h('section', { class: 'panel ov-stations-panel' },
        h('div', { class: 'panel-head' },
          h('h2', {}, 'Senderübersicht'),
          h('span', { class: 'muted' }, 'Live-Daten aus der aktuellen AirDeck-Instanz')),
        h('div', { class: 'ov-grid' }, ...cards.map(card))));
  }

  return { show, onEvent: () => {} };
}
