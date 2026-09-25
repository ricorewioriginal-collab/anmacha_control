// @ts-check
// Hörer-Interaktion im Studio: Posteingang (Wünsche, Grüße, Sprachnachrichten), Voting-Charts, Einstellungen.
import { formDialog, h, run, status } from './ui.js';

const KIND = /** @type {Record<string, string>} */ ({ request: '🎵 Wunsch', message: '💬 Gruß', voice: '🎙 Sprachnachricht' });

/** @typedef {{ api: import('./api.js').Api, url: (p: string) => string, stationId: () => string, onUnread: (n: number) => void }} Ctx */

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountListeners(root, ctx) {
  /** @param {string} title @param {...(Node|string|null|false)} body */
  const card = (title, ...body) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title)), ...body);
  const time = (/** @type {number} */ t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  async function show() {
    const d = await ctx.api.get(ctx.url('/inbox'));
    ctx.onUnread(d.unread);
    const c = d.config;
    const any = c.requests || c.messages || c.voting || c.voice;
    const link = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}hoerer.html?s=${encodeURIComponent(ctx.stationId())}`;
    const act = (/** @type {any} */ it, /** @type {string} */ a) => run(async () => { await ctx.api.post(ctx.url(`/inbox/${encodeURIComponent(it.id)}/${a}`)); show(); });
    root.replaceChildren(...[
      h('div', { class: 'lf-head' }, h('div', { class: 'lf-title' }, h('strong', {}, 'Hörer'), h('span', { class: 'muted' }, ` · ${d.unread} neu`)),
        h('button', { class: 'btn small', onclick: () => settings(c) }, 'Einstellungen')),
      !any ? card('Hörerbereich ist aus', h('p', {}, 'Hörer können Musik wünschen, grüßen, abstimmen und Sprachnachrichten schicken – sobald du es unter „Einstellungen“ einschaltest. Alles läuft über AirDeck, mit Schutz vor Missbrauch.')) : null,
      any ? card('Hörerseite', h('p', { class: 'muted' }, 'Link für Hörer (auch auf deiner Webseite einbettbar):'),
        h('div', { class: 'row' }, h('code', {}, link), h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(link).then(() => status('Link kopiert')) }, 'Kopieren'),
          h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(`<iframe src="${link}" style="width:100%;height:640px;border:0" allow="microphone" title="Hörerbereich"></iframe>`).then(() => status('Einbettungs-Code kopiert')) }, 'Einbetten'))) : null,
      card('Posteingang',
        ...(d.items.length ? d.items.map((/** @type {any} */ it) => h('div', { class: `inbox-item${it.status === 'new' ? ' new' : ''}` },
          h('div', { class: 'row' }, h('strong', {}, KIND[it.kind] ?? it.kind), h('span', { class: 'muted' }, ` · ${time(it.at)}${it.name ? ` · ${it.name}` : ''}`)),
          it.title ? h('div', {}, it.title) : null,
          it.text ? h('div', { class: 'muted' }, `„${it.text}“`) : null,
          it.kind === 'voice' ? h('audio', { controls: true, preload: 'none', src: `${ctx.api.base}/api/v1${ctx.url(`/inbox/${encodeURIComponent(it.id)}/audio`)}?token=${encodeURIComponent(ctx.api.token)}`, style: 'width:100%' }) : null,
          h('div', { class: 'row' },
            it.kind !== 'message' ? h('button', { class: 'btn small primary', onclick: () => act(it, 'queue') }, it.kind === 'voice' ? 'In Bibliothek + Queue' : 'In die Queue') : null,
            it.status === 'new' ? h('button', { class: 'btn small', onclick: () => act(it, 'done') }, 'Erledigt') : null,
            h('button', { class: 'btn small danger', onclick: () => act(it, 'delete') }, 'Löschen'))))
          : [h('div', { class: 'empty' }, 'Noch nichts eingegangen.')])),
      c.voting ? card('Hörer-Charts (Voting)', ...(d.charts.length ? [h('ol', {}, ...d.charts.map((/** @type {any} */ t) => h('li', {}, `${t.artist ? `${t.artist} – ` : ''}${t.title} · ${t.score > 0 ? '+' : ''}${t.score} (${t.up}👍 ${t.down}👎)`)))] : [h('div', { class: 'empty' }, 'Noch keine Stimmen.')])) : null,
    ].filter((n) => n !== null));
  }

  /** @param {any} c */
  async function settings(c) {
    const v = await formDialog('Hörerbereich', [
      { name: 'info', label: 'Schutz', type: 'info', value: 'Begrenzt je Absender (z. B. 3 Wünsche in 10 Minuten, 1 Stimme je Titel in 12 Stunden). IP-Adressen werden nicht gespeichert. Nur reiner Text.' },
      { name: 'requests', label: 'Musikwunsch (Suche in der Musikbibliothek)', type: 'checkbox', value: c.requests },
      { name: 'messages', label: 'Grüße & Nachrichten (Wunschbox)', type: 'checkbox', value: c.messages },
      { name: 'voting', label: 'Song-Voting mit Hörer-Charts', type: 'checkbox', value: c.voting },
      { name: 'voice', label: 'Sprachnachricht ans Studio (bis 2 Minuten)', type: 'checkbox', value: c.voice },
      { name: 'welcome', label: 'Begrüßung auf der Hörerseite', value: c.welcome ?? '' },
    ]);
    if (!v) return;
    await run(() => ctx.api.put(ctx.url('/listener'), v));
    show();
  }

  /** Nur den Zähler für die Navigation aktualisieren (ohne Ansicht aufzubauen). */
  const unread = () => ctx.api.get(ctx.url('/inbox')).then((d) => ctx.onUnread(d.unread)).catch(() => {});
  unread();

  return {
    show,
    /** @param {string} type @param {any} data */
    onEvent(type, data) {
      if (type === 'inbox.new') {
        status(`Hörer: ${KIND[data.kind] ?? data.kind}${data.name ? ` von ${data.name}` : ''}`);
        if (!root.hidden) show();
        else unread();
      }
    },
  };
}
