// @ts-check
// Medienverwaltung (Masterprompt V1 Beta, Abschnitt 9): eigenständiger Arbeitsbereich, der die
// bestehende Mediathek (MediaService) nutzt - keine zweite, konkurrierende Mediendatenbank. Die
// bisherige "kompakte Medienansicht innerhalb der Automation" (Archiv-Tabelle im Studio-Arbeitsbereich)
// bleibt unverändert bestehen; diese Ansicht ergänzt Suche/Filter/Sortierung über die ganze Bibliothek,
// Mehrfach-Upload/Ordner-Import, Metadaten-Bearbeitung, Integritätsprüfung (fehlende Dateien, Duplikate,
// Relink) sowie Aktionen zum Senden an Deck/Queue/Playlist/Cardwall.
//
// Abschnitt 10 (Nextcloud): Nextcloud soll NICHT als isoliertes Halb-Feature danebenstehen, sondern
// als weitere Quelle direkt hier auswählbar sein ("AirDeck-Bibliothek" und "Nextcloud" nebeneinander,
// über Reiter). Die eigenständige Nextcloud-Ansicht (Verbindung einrichten, eigener Nav-Punkt) bleibt
// zusätzlich bestehen; hier wird ihre bereits vorhandene Browse-/Import-Logik nur eingebettet
// (mountNextcloud direkt wiederverwendet, keine zweite Nextcloud-Anbindung).

import { $, CATEGORY_STYLE, clockTime, fmt, formDialog, h, mediaTitle, run, status } from './ui.js';
import { mountNextcloud } from './nextcloud.js';

const CATEGORY_LABEL = /** @type {Record<string,string>} */ ({
  music: 'Musik', jingle: 'Jingle', sweeper: 'Sweeper', station_id: 'Station-ID', drop: 'Drop', news: 'Nachrichten',
  ad: 'Werbung', voice_track: 'Voicetrack', tts: 'TTS', bed: 'Bett', stream: 'Stream',
});

const SORTS = /** @type {Record<string, (a: any, b: any) => number>} */ ({
  added: (a, b) => b.addedAt - a.addedAt,
  title: (a, b) => mediaTitle(a).localeCompare(mediaTitle(b), 'de'),
  artist: (a, b) => (a.artist || '').localeCompare(b.artist || '', 'de'),
  duration: (a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0),
});

/**
 * @typedef {{ api: import('./api.js').Api, url: (p: string) => string, library: () => any[], folders: () => Promise<string[]>,
 *   mediaUrl: (id: string) => string, sendToDeck: (deckId: string, media: any) => void, upload: (files: File[]) => Promise<any[]> }} Ctx
 */

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountMediaManagement(root, ctx) {
  let q = '';
  let cat = '';
  let folder = '';
  let sort = 'added';
  const selected = new Set();
  // Eigener Zwischenspeicher statt direkt ctx.library() (= S.library in app.js): S.library wird bei
  // 'library.changed' erst asynchron nachgeladen, NACHDEM alle Views (also auch dieser hier) informiert
  // wurden - ein sofortiges refresh() aus onEvent() würde sonst mit veralteten Daten rendern.
  let items = ctx.library();

  async function reload() {
    items = (await run(() => ctx.api.get(ctx.url('/media')))) ?? items;
    refresh();
  }

  async function pickCart(media) {
    const carts = await run(() => ctx.api.get(ctx.url('/cardwall')));
    if (!carts) return;
    const v = await formDialog('An Cardwall senden', [
      { name: 'cart', label: 'Slot', value: carts[0]?.id ?? '', options: carts.map((/** @type {any} */ c) => /** @type {[string,string]} */ ([c.id, `${c.label || c.id}${c.mediaId ? ' (belegt)' : ''}`])) },
    ], 'Zuweisen');
    if (!v) return;
    await run(() => ctx.api.patch(ctx.url(`/cardwall/${encodeURIComponent(v.cart)}`), { mediaId: media.id, label: media.title?.slice(0, 40) }));
  }

  async function pickPlaylist(media) {
    const lists = await run(() => ctx.api.get(ctx.url('/playlists')));
    if (!lists) return;
    const v = await formDialog('Zu Playlist hinzufügen', [
      { name: 'pl', label: 'Playlist', value: lists[0]?.id ?? '', options: [...lists.map((/** @type {any} */ p) => /** @type {[string,string]} */ ([p.id, p.name])), ['', 'Neue Playlist …']] },
      { name: 'name', label: 'Name (bei „Neue Playlist“)', value: '' },
    ], 'Hinzufügen');
    if (!v) return;
    if (v.pl) {
      const pl = lists.find((/** @type {any} */ p) => p.id === v.pl);
      await run(() => ctx.api.patch(ctx.url(`/playlists/${encodeURIComponent(v.pl)}`), { items: [...(pl?.items ?? []), media.id] }));
    } else if (v.name?.trim()) {
      await run(() => ctx.api.post(ctx.url('/playlists'), { name: v.name.trim(), items: [media.id] }));
    } else return;
    status(`„${media.title}“ zur Playlist hinzugefügt`);
  }

  function actions(m) {
    return h('div', { class: 'row act' },
      ...['A', 'B', 'C', 'D'].map((d) => h('button', { title: `An Deck ${d} senden`, onclick: () => ctx.sendToDeck(d, m) }, d)),
      h('button', { title: 'In Queue', onclick: () => run(() => ctx.api.post(ctx.url('/queue'), { mediaId: m.id })) }, '＋Q'),
      h('button', { title: 'Zu Playlist', onclick: () => pickPlaylist(m) }, '＋P'),
      h('button', { title: 'An Cardwall', onclick: () => pickCart(m) }, '＋C'),
      h('button', { title: 'Metadaten bearbeiten', onclick: () => editMeta(m) }, '✎'),
      h('button', { title: 'Vorhören', onclick: () => preview(m) }, '▶'),
      h('button', { title: 'Löschen', onclick: () => confirm(`„${m.title}“ endgültig löschen?`) && run(() => ctx.api.del(ctx.url(`/media/${encodeURIComponent(m.id)}`)).then(reload)) }, '✕'));
  }

  /** @type {HTMLAudioElement|null} */ let previewEl = null;
  function preview(m) {
    if (m.url) return void window.open(m.url, '_blank');
    if (!previewEl) { previewEl = /** @type {HTMLAudioElement} */ (h('audio', { controls: true, style: 'position:fixed;bottom:12px;right:12px;z-index:50;background:#0a1524;border-radius:8px' })); document.body.append(previewEl); }
    previewEl.src = ctx.mediaUrl(m.id);
    previewEl.play().catch(() => {});
  }

  async function editMeta(m) {
    const v = await formDialog('Metadaten bearbeiten', [
      { name: 'title', label: 'Titel', value: m.title },
      { name: 'artist', label: 'Interpret', value: m.artist },
      { name: 'album', label: 'Album', value: m.album ?? '' },
      { name: 'genre', label: 'Genre', value: m.genre ?? '' },
      { name: 'category', label: 'Kategorie', value: m.category, options: Object.entries(CATEGORY_LABEL) },
      { name: 'folder', label: 'Ordner/Tag', value: m.folder ?? '' },
      { name: 'bpm', label: 'BPM', type: 'number', value: m.bpm ?? '' },
      { name: 'cueInMs', label: 'Cue-In (ms)', type: 'number', value: m.cueInMs ?? '' },
      { name: 'cueOutMs', label: 'Cue-Out (ms)', type: 'number', value: m.cueOutMs ?? '' },
      { name: 'gainDb', label: 'Gain (dB)', type: 'number', value: m.gainDb ?? '' },
    ]);
    if (v) await run(() => ctx.api.patch(ctx.url(`/media/${encodeURIComponent(m.id)}`), v).then(reload));
  }

  function row(m) {
    const format = (m.linkedPath ?? m.file ?? '').split('.').pop()?.toUpperCase() || (m.url ? 'URL' : '–');
    const tr = h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', checked: selected.has(m.id), onchange: (/** @type {Event} */ e) => { if (/** @type {HTMLInputElement} */ (e.target).checked) selected.add(m.id); else selected.delete(m.id); } })),
      h('td', {}, m.title, m.check?.silent ? h('span', { class: 'track-warn', title: 'Datei ist still' }, ' ⚠') : null),
      h('td', {}, m.artist),
      h('td', {}, h('span', { class: 'tag cat', style: `--c:${CATEGORY_STYLE[m.category]?.color ?? '#2f8cff'}` }, CATEGORY_LABEL[m.category] ?? m.category)),
      h('td', {}, m.folder ?? ''),
      h('td', { class: 'num' }, fmt(m.durationMs)),
      h('td', { class: 'num muted' }, format),
      h('td', { class: 'num muted' }, m.lufs != null ? `${m.lufs.toFixed(1)} LUFS` : '–'),
      h('td', {}, actions(m)));
    return tr;
  }

  function renderIntegrity(data) {
    if (!data) return h('div', { class: 'muted' }, 'Integritätsprüfung nicht verfügbar');
    if (!data.missing.length && !data.duplicates.length) return h('div', { class: 'muted' }, 'Keine fehlenden Dateien, keine Duplikate gefunden.');
    return h('div', {},
      data.missing.length ? h('div', {},
        h('strong', {}, `Fehlende Dateien (${data.missing.length})`),
        h('ul', { class: 'plain-list' }, ...data.missing.map((/** @type {any} */ m) => h('li', {},
          `${mediaTitle(m)} `,
          data.orphans.length
            ? h('span', {}, h('select', { 'data-relink': m.id }, ...data.orphans.map((/** @type {string} */ f) => h('option', { value: f }, f))),
                h('button', { onclick: (/** @type {Event} */ e) => relink(m.id, /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).previousElementSibling)) }, 'Verknüpfen'))
            : h('span', { class: 'muted' }, ' (keine passende Datei im Medienordner gefunden)')))))
        : null,
      data.duplicates.length ? h('div', {},
        h('strong', {}, `Mögliche Duplikate (${data.duplicates.length} Gruppen)`),
        h('ul', { class: 'plain-list' }, ...data.duplicates.map((/** @type {any[]} */ g) => h('li', {}, g.map((/** @type {any} */ m) => mediaTitle(m)).join('  ·  ')))))
        : null);
  }

  async function relink(id, select) {
    const file = /** @type {HTMLSelectElement} */ (select).value;
    if (!file) return;
    await run(() => ctx.api.post(ctx.url(`/media/${encodeURIComponent(id)}/relink`), { file }));
    status('Titel neu verknüpft');
    await refreshIntegrity();
    await reload();
  }

  const integrityBox = h('div', { class: 'panel', style: 'margin-top:12px' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Integritätsprüfung'), h('button', { class: 'btn small', onclick: () => refreshIntegrity() }, 'Prüfen')),
    h('div', { id: 'mm-integrity' }, h('span', { class: 'muted' }, 'Noch nicht geprüft')));

  async function refreshIntegrity() {
    const data = await run(() => ctx.api.get(ctx.url('/media/integrity')));
    integrityBox.querySelector('#mm-integrity')?.replaceWith(h('div', { id: 'mm-integrity' }, renderIntegrity(data)));
  }

  const tbody = h('tbody', {});
  const searchInput = h('input', { type: 'search', placeholder: 'Suche: Titel, Interpret, Ordner …', value: q, oninput: (/** @type {Event} */ e) => { q = /** @type {HTMLInputElement} */ (e.target).value; refresh(); } });
  const catSel = h('select', {}, h('option', { value: '' }, 'Alle Kategorien'), ...Object.entries(CATEGORY_LABEL).map(([k, l]) => h('option', { value: k }, l)));
  catSel.addEventListener('change', () => { cat = /** @type {HTMLSelectElement} */ (catSel).value; refresh(); });
  const folderSel = h('select', {}, h('option', { value: '' }, 'Alle Ordner'));
  folderSel.addEventListener('change', () => { folder = /** @type {HTMLSelectElement} */ (folderSel).value; refresh(); });
  const sortSel = h('select', {}, h('option', { value: 'added' }, 'Neueste zuerst'), h('option', { value: 'title' }, 'Titel A–Z'), h('option', { value: 'artist' }, 'Interpret A–Z'), h('option', { value: 'duration' }, 'Länge'));
  sortSel.addEventListener('change', () => { sort = /** @type {HTMLSelectElement} */ (sortSel).value; refresh(); });

  const fileInput = /** @type {HTMLInputElement} */ (h('input', { type: 'file', multiple: true, accept: 'audio/*', hidden: true, onchange: (/** @type {Event} */ e) => { const inp = /** @type {HTMLInputElement} */ (e.target); if (inp.files?.length) ctx.upload([...inp.files]).then(reload).finally(() => (inp.value = '')); } }));
  const folderInput = /** @type {HTMLInputElement} */ (h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, onchange: (/** @type {Event} */ e) => { const inp = /** @type {HTMLInputElement} */ (e.target); if (inp.files?.length) ctx.upload([...inp.files]).then(reload).finally(() => (inp.value = '')); } }));

  const dropZone = h('div', { class: 'panel drop-hint', id: 'mm-drop' }, 'Dateien oder Ordner per Ziehen & Ablegen hierher, oder: ',
    h('button', { class: 'btn small', onclick: () => fileInput.click() }, 'Dateien wählen …'),
    ' ', h('button', { class: 'btn small', onclick: () => folderInput.click() }, 'Ordner importieren …'), fileInput, folderInput);
  dropZone.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dropZone.classList.add('drop'); } });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drop'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drop');
    if (e.dataTransfer?.files.length) ctx.upload([...e.dataTransfer.files]).then(reload);
  });

  const bulkBar = h('div', { class: 'row', id: 'mm-bulk' },
    h('button', { class: 'btn small', onclick: async () => {
      if (!selected.size || !confirm(`${selected.size} Titel endgültig löschen?`)) return;
      for (const id of [...selected]) await run(() => ctx.api.del(ctx.url(`/media/${encodeURIComponent(id)}`)));
      selected.clear();
      await reload();
    } }, 'Auswahl löschen'));

  function refresh() {
    const list = items
      .filter((m) => (!cat || m.category === cat) && (!folder || (m.folder ?? '') === folder) && (!q || `${m.title} ${m.artist} ${m.folder ?? ''} ${m.album ?? ''}`.toLowerCase().includes(q.toLowerCase())))
      .sort(SORTS[sort])
      .slice(0, 1000);
    tbody.replaceChildren(...list.map(row));
    $('mm-count') && ($('mm-count').textContent = `${list.length} von ${items.length} Titel${selected.size ? ` · ${selected.size} ausgewählt` : ''}`);
  }

  // ---------- Quellen-Reiter: AirDeck-Bibliothek / Nextcloud (Abschnitt 10, nebeneinander statt isoliert) ----------

  let source = 'library';
  const nextcloudPane = h('div', { hidden: true });
  let nextcloudView = null;

  const libraryPane = h('div', {},
    dropZone,
    h('div', { class: 'row', style: 'margin:8px 0' }, searchInput, catSel, folderSel, sortSel),
    bulkBar,
    h('div', { class: 'table-wrap', id: 'mm-drop-table' },
      h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, 'Titel'), h('th', {}, 'Interpret'), h('th', {}, 'Kategorie'), h('th', {}, 'Ordner'), h('th', {}, 'Länge'), h('th', {}, 'Format'), h('th', {}, 'Lautheit'), h('th', {}, 'Aktionen'))),
        tbody)),
    integrityBox);

  function tabBtn(id, label) {
    return h('button', { class: `btn small${source === id ? ' primary' : ''}`, onclick: () => selectSource(id) }, label);
  }
  const tabBar = h('div', { class: 'row' });
  function renderTabs() {
    tabBar.replaceChildren(tabBtn('library', 'AirDeck-Bibliothek'), tabBtn('nextcloud', 'Nextcloud'));
  }

  async function selectSource(id) {
    source = id;
    renderTabs();
    libraryPane.hidden = id !== 'library';
    nextcloudPane.hidden = id !== 'nextcloud';
    if (id === 'nextcloud') {
      if (!nextcloudView) nextcloudView = mountNextcloud(nextcloudPane, ctx);
      await nextcloudView.show();
    }
  }

  async function show() {
    const folders = await ctx.folders();
    const cur = /** @type {HTMLSelectElement} */ (folderSel).value;
    folderSel.replaceChildren(h('option', { value: '' }, 'Alle Ordner'), ...folders.map((f) => h('option', { value: f, selected: f === cur }, f)));
    renderTabs();
    root.replaceChildren(
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Medienverwaltung'), h('span', { class: 'muted', id: 'mm-count' }, '')),
        tabBar,
        libraryPane,
        nextcloudPane));
    libraryPane.hidden = source !== 'library';
    nextcloudPane.hidden = source !== 'nextcloud';
    items = ctx.library();
    refresh();
    void refreshIntegrity();
    if (source === 'nextcloud' && nextcloudView) await nextcloudView.show();
  }

  return { show, onEvent: (/** @type {string} */ kind) => { if (kind === 'library.changed') void reload(); } };
}
