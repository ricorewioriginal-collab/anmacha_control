// @ts-check
// Playlistverwaltung (Masterprompt V1 Beta, Abschnitt 11-14): eigener Arbeitsbereich - Medienverwaltung
// besitzt die Medien, Playlistverwaltung organisiert sie, Sendeplan plant sie ein, Automation spielt sie
// ab. Nutzt dieselben Server-Endpunkte/dasselbe Datenmodell wie die kompakte Playlist-Liste im Sendeplan
// (keine zweite Playlist-Engine); die Kurzansicht dort bleibt bestehen, weil Playlists von dort direkt in
// den Sendeplan gezogen werden.

import { formDialog, h, mediaTitle, fmt, run, status } from './ui.js';
import { panel, iconBtn } from './planning.js';

/** @typedef {{ api: import('./api.js').Api, url: (p: string) => string, library: () => any[], folders: () => Promise<string[]> }} Ctx */

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountPlaylistManagement(root, ctx) {
  /** @type {any[]} */ let playlists = [];
  /** @type {string[]} */ let folders = [];
  /** @type {string|null} */ let openPl = null;

  async function load() {
    [playlists, folders] = await Promise.all([ctx.api.get(ctx.url('/playlists')), ctx.folders()]);
    render();
  }

  const move = (/** @type {string[]} */ arr, /** @type {number} */ a, /** @type {number} */ b) => {
    const c = [...arr];
    const [x] = c.splice(a, 1);
    c.splice(b, 0, /** @type {string} */ (x));
    return c;
  };

  const saveItems = (/** @type {any} */ p, /** @type {string[]} */ items) => run(async () => { await ctx.api.patch(ctx.url(`/playlists/${p.id}`), { items }); await load(); });
  const saveMode = (/** @type {any} */ p, /** @type {string} */ mode) => run(async () => { await ctx.api.patch(ctx.url(`/playlists/${p.id}`), { mode }); await load(); });
  const reshuffle = (/** @type {any} */ p) => run(async () => { await ctx.api.post(ctx.url(`/playlists/${p.id}/shuffle`)); status(`„${p.name}“ neu gemischt`); await load(); });

  /** @param {any} p */
  function playlistItemRow(p, /** @type {string[]} */ order, /** @type {Map<string,any>} */ byId, /** @type {string} */ id, /** @type {number} */ i) {
    return h('li', {},
      h('span', {}, mediaTitle(byId.get(id))), h('span', { class: 'muted num' }, fmt(byId.get(id)?.durationMs)),
      h('span', { class: 'act' },
        p.mode === 'shuffle' || i === 0 ? null : iconBtn('Nach oben', '↑', () => saveItems(p, move(p.items, i, i - 1))),
        p.mode === 'shuffle' || i >= order.length - 1 ? null : iconBtn('Nach unten', '↓', () => saveItems(p, move(p.items, i, i + 1))),
        iconBtn('Entfernen', '✕', () => saveItems(p, p.items.filter((/** @type {string} */ x) => x !== id)))));
  }

  /** @param {any} p @param {Map<string,any>} byId */
  function playlistCard(p, byId) {
    const open = openPl === p.id;
    const order = p.mode === 'shuffle' && p.shuffleOrder?.length === p.items.length ? p.shuffleOrder : p.items;
    const totalMs = p.items.reduce((/** @type {number} */ a, /** @type {string} */ id) => a + (byId.get(id)?.durationMs ?? 0), 0);
    const head = h('div', { class: 'pl-head' },
      h('span', { class: 'pl-dot', style: `background:${p.color}` }),
      h('button', { class: 'pl-name', onclick: () => { openPl = open ? null : p.id; render(); } }, `${open ? '▾' : '▸'} ${p.name}`),
      h('span', { class: 'muted' }, `${p.items.length} Titel · ${fmt(totalMs)}`),
      h('select', {
        title: 'Wiedergabe-Modus', value: p.mode ?? 'manual',
        onchange: (/** @type {Event} */ e) => saveMode(p, /** @type {HTMLSelectElement} */ (e.target).value),
      }, h('option', { value: 'manual', selected: (p.mode ?? 'manual') === 'manual' }, 'Manuell'), h('option', { value: 'shuffle', selected: p.mode === 'shuffle' }, 'Shuffle')),
      p.mode === 'shuffle' ? iconBtn('Jetzt neu mischen', '🔀', () => reshuffle(p)) : null,
      h('span', { class: 'act' },
        iconBtn('Abspielen (ersetzt die Queue)', '▶', () => run(async () => { await ctx.api.post(ctx.url(`/playlists/${p.id}/play`)); status(`Playlist „${p.name}“ läuft${p.mode === 'shuffle' ? ' (gemischt)' : ''}`); })),
        iconBtn('Titel hinzufügen', '＋', () => addItems(p)),
        iconBtn('Umbenennen/Farbe', '✎', () => editMeta(p)),
        iconBtn('Duplizieren', '⧉', () => duplicate(p)),
        iconBtn('Löschen', '✕', () => confirm(`Playlist „${p.name}“ löschen?`) && run(async () => { await ctx.api.del(ctx.url(`/playlists/${p.id}`)); await load(); }))));
    const items = open ? h('ol', { class: 'pl-items' }, ...order.map((/** @type {string} */ id, /** @type {number} */ i) => playlistItemRow(p, order, byId, id, i))) : null;
    return h('div', { class: 'pl' }, head, items);
  }

  function render() {
    const byId = new Map(ctx.library().map((/** @type {any} */ m) => [m.id, m]));
    const cards = playlists.length
      ? playlists.map((p) => playlistCard(p, byId))
      : [h('div', { class: 'empty' }, 'Noch keine Playlists. Über „＋ Playlist“ anlegen oder in der Medienverwaltung Titel zu einer Playlist hinzufügen.')];
    root.replaceChildren(panel('Playlistverwaltung', [
      h('button', { class: 'btn small', onclick: newPlaylist }, '＋ Playlist'),
    ], h('div', {}, ...cards)));
  }

  async function newPlaylist() {
    const v = await formDialog('Neue Playlist', [
      { name: 'name', label: 'Name', value: '', required: true },
      { name: 'color', label: 'Farbe', type: 'color', value: '#19c3e6' },
    ]);
    if (v) await run(async () => { await ctx.api.post(ctx.url('/playlists'), v); await load(); });
  }

  /** @param {any} p */
  async function editMeta(p) {
    const v = await formDialog('Playlist bearbeiten', [
      { name: 'name', label: 'Name', value: p.name, required: true },
      { name: 'color', label: 'Farbe', type: 'color', value: p.color },
    ]);
    if (v) await run(async () => { await ctx.api.patch(ctx.url(`/playlists/${p.id}`), v); await load(); });
  }

  /** @param {any} p */
  async function duplicate(p) {
    await run(async () => { await ctx.api.post(ctx.url('/playlists'), { name: `${p.name} (Kopie)`, color: p.color, items: p.items }); await load(); });
  }

  /** @param {any} p */
  async function addItems(p) {
    const lib = [...ctx.library()].sort((a, b) => mediaTitle(a).localeCompare(mediaTitle(b), 'de'));
    const v = await formDialog(`Zu „${p.name}“ hinzufügen`, [
      { name: 'folder', label: 'Ganzen Ordner hinzufügen', value: '', options: [['', '– kein Ordner –'], ...folders.map((f) => /** @type {[string,string]} */ ([f, f]))] },
      { name: 'mediaId', label: 'oder einzelnen Titel', value: '', options: [['', '–'], ...lib.map((/** @type {any} */ m) => /** @type {[string,string]} */ ([m.id, mediaTitle(m)]))] },
    ], 'Hinzufügen');
    if (!v) return;
    const add = v.folder ? lib.filter((/** @type {any} */ m) => (m.folder ?? '') === v.folder).map((/** @type {any} */ m) => m.id) : v.mediaId ? [v.mediaId] : [];
    if (add.length) await saveItems(p, [...p.items, ...add]);
  }

  return { show: () => run(load), onEvent: (/** @type {string} */ t) => { if (['playlists.changed', 'library.changed'].includes(t) && root.isConnected && !root.hidden) run(load); } };
}
