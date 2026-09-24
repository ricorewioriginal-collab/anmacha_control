// @ts-check
// laut.fm Radioadmin in AirDeck: Playlists, Titel, Sendeplan, Statistik, Benutzer, Station, Live.
// Alle Aufrufe laufen über den lokalen AirDeck-Server (Token bleibt verschlüsselt dort), nur dokumentierte
// Endpunkte der Radioadmin-API. Kein eigener PHP-Server nötig.

import { DAYS, clockTime, fmt, formDialog, h, run, status } from './ui.js';

const TABS = /** @type {const} */ ([
  ['overview', 'Übersicht'], ['playlists', 'Playlists'], ['tracks', 'Titel'], ['schedule', 'Sendeplan'],
  ['stats', 'Statistik'], ['users', 'Benutzer'], ['station', 'Station'], ['live', 'Live'],
]);
const ROLES = /** @type {Array<[string,string]>} */ ([['owner', 'Inhaber'], ['editor', 'Editor'], ['dj', 'DJ']]);

/** @typedef {{ api: import('./api.js').Api, url: (p: string) => string }} Ctx */

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountLautfm(root, ctx) {
  let tab = 'overview';
  /** @type {any} */ let cfg = null;
  /** @type {any[]} */ let playlists = [];
  /** @type {HTMLAudioElement|null} */ let pre = null;

  /** Radioadmin-Aufruf über den AirDeck-Proxy. @param {string} method @param {string} path @param {any} [body] */
  const ra = (method, path, body) => ctx.api.req(method, ctx.url(`/lautfm/ra${path}`), body);
  const st = () => `/stations/${cfg.stationId}`;
  /** @param {string} title @param {...(Node|string|null|false)} body */
  const card = (title, ...body) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title)), ...body);
  /** @param {string} k @param {any} v */
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'muted' }, k), h('span', {}, v === null || v === undefined || v === '' ? '–' : String(v)));
  const content = h('div', { class: 'lf-content' });

  async function show() {
    cfg = await ctx.api.get(ctx.url('/lautfm'));
    render();
  }

  function render() {
    const connected = cfg?.hasToken && cfg?.stationId;
    const head = h('div', { class: 'lf-head' },
      h('div', { class: 'lf-title' }, h('strong', {}, 'laut.fm Radioadmin'), h('span', { class: 'muted' }, connected ? ` · Station ${cfg.stationName ?? cfg.stationId}` : ' · nicht verbunden')),
      h('div', { class: 'tabs' }, ...TABS.map(([id, label]) => h('button', { 'aria-pressed': String(tab === id), disabled: !connected, onclick: () => { tab = id; renderTab(); } }, label))),
      h('button', { class: 'btn small', onclick: configure }, connected ? 'Verbindung …' : 'Verbinden …'));
    root.replaceChildren(head, content);
    if (connected) renderTab();
    else content.replaceChildren(card('Mit laut.fm verbinden',
      h('p', {}, 'AirDeck verwaltet deine laut.fm-Station direkt über die offizielle Radioadmin-API – ohne eigenen Server.'),
      h('ol', {},
        h('li', {}, 'Auf „Token bei laut.fm holen“ klicken und bei laut.fm anmelden – der Zugriff für „', h('code', {}, cfg?.origin ?? 'airdeck'), '“ wird bestätigt und das Token angezeigt.'),
        h('li', {}, 'Token kopieren, hier unter „Token eingeben“ einfügen, Station wählen – fertig.')),
      h('p', { class: 'muted' }, 'Das Token wird verschlüsselt auf diesem Gerät gespeichert und nie an den Browser zurückgegeben.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => window.open(cfg?.loginUrl ?? 'https://radioadmin.laut.fm/login?callback_url=airdeck', '_blank', 'noopener') }, 'Token bei laut.fm holen'),
        h('button', { class: 'btn primary', onclick: configure }, 'Token eingeben …'))));
  }

  async function configure() {
    const v = await formDialog('laut.fm-Verbindung', [
      { name: 'token', label: cfg?.hasToken ? 'Radioadmin-Token (leer = unverändert)' : 'Radioadmin-Token', type: 'password', value: '', hint: `Token holen: ${cfg?.loginUrl ?? ''} · Übersicht: radioadmin.laut.fm/tokens` },
      { name: 'origin', label: 'Callback / Origin des Tokens', value: cfg?.origin ?? 'airdeck', hint: 'Muss exakt der callback_url entsprechen, mit der das Token erzeugt wurde (Standard: airdeck)' },
      ...(cfg?.hasToken ? [{ name: 'remove', label: 'Token entfernen', type: 'checkbox', value: false }] : []),
    ], 'Weiter');
    if (!v) return;
    if (v.remove) {
      cfg = await run(() => ctx.api.put(ctx.url('/lautfm'), { token: '', stationId: null }));
      return render();
    }
    cfg = (await run(() => ctx.api.put(ctx.url('/lautfm'), { origin: v.origin, ...(v.token ? { token: v.token } : {}) }))) ?? cfg;
    if (!cfg?.hasToken) return render();
    // Stationen des Tokens abrufen und auswählen
    const list = await run(() => ra('GET', '/stations'));
    if (!Array.isArray(list) || !list.length) {
      if (Array.isArray(list)) status('Token gültig, aber keine Station zugeordnet', true);
      return render();
    }
    const pick = list.length === 1 ? { stationId: String(list[0].id) } : await formDialog('Station wählen', [
      { name: 'stationId', label: 'Station', value: String(cfg.stationId ?? list[0].id), options: list.map((s) => /** @type {[string,string]} */ ([String(s.id), `${s.name} (${s.role ?? ''})`])) },
    ], 'Übernehmen');
    if (!pick) return render();
    const chosen = list.find((s) => String(s.id) === pick.stationId);
    cfg = await run(() => ctx.api.put(ctx.url('/lautfm'), { stationId: Number(pick.stationId), stationName: chosen?.name ?? '' }));
    status(`Mit laut.fm-Station „${chosen?.name}“ verbunden`);
    render();
  }

  function renderTab() {
    root.querySelectorAll('.lf-head .tabs button').forEach((b, i) => b.setAttribute('aria-pressed', String(TABS[i][0] === tab)));
    content.replaceChildren(h('div', { class: 'empty' }, 'Lade …'));
    const fn = { overview, playlists: playlistsTab, tracks, schedule, stats, users, station, live }[tab];
    run(async () => content.replaceChildren(...(await fn())));
  }

  async function loadPlaylists() {
    const r = await ra('GET', `${st()}/playlists`);
    playlists = r?.playlists ?? [];
    return playlists;
  }

  // ---------- Übersicht ----------
  async function overview() {
    const [info, state, statsNow, current, song] = await Promise.all([
      ra('GET', st()), ra('GET', `${st()}/state`).catch(() => null), ra('GET', `${st()}/stats`).catch(() => null),
      ra('GET', `${st()}/current_playlist`).catch(() => null),
      cfg.stationName ? ctx.api.get(`/lautfm/public/station/${cfg.stationName}/current_song`).catch(() => null) : null,
    ]);
    return [h('div', { class: 'view-grid' },
      card('Station', kv('Name', info.name), kv('Beschreibung', info.description), kv('Format', info.format), kv('DJs', info.djs), kv('Genres', (info.genres ?? []).join(', ')),
        kv('Streaming-Server', state?.active ? 'aktiv ✔' : 'inaktiv'),
        !state?.active ? h('button', { class: 'btn primary', onclick: () => run(async () => { await ra('POST', `${st()}/state`); status('Station aktiviert'); renderTab(); }) }, 'Station aktivieren') : null),
      card('Jetzt', kv('Titel', song ? `${song.artist?.name ?? ''} – ${song.title ?? ''}` : null), kv('Hörer jetzt', statsNow?.listeners_now), kv('Position', statsNow?.position_now),
        kv('Playlist', current?.playlist_info?.title), kv('Grund', current?.playlist_info?.reason)),
      card('Nächste Titel', ...(current?.tracks ?? []).slice(0, 12).map((/** @type {any} */ t) => h('div', { class: 'kv' }, h('span', {}, `${t.artist ?? ''} – ${t.title ?? ''}`), h('span', { class: 'muted num' }, fmt((t.length ?? t.duration ?? 0) * 1000)))))),
    ];
  }

  // ---------- Playlists ----------
  async function playlistsTab() {
    await loadPlaylists();
    const detail = h('div', {});
    const list = h('div', { class: 'lf-pl' }, ...playlists.map((p) => h('button', { class: 'lf-pl-item', onclick: () => run(async () => detail.replaceChildren(...(await plDetail(p)))) },
      h('span', { class: 'pl-dot', style: `background:${/^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#666'}` }), h('span', {}, p.title), h('span', { class: 'muted num' }, `${p.size ?? 0} · ${fmt((p.duration ?? 0) * 1000)}`))));
    return [h('div', { class: 'lf-split' },
      card('Playlists', h('button', { class: 'btn small primary', onclick: newPlaylist }, '＋ Neue Playlist'), list), detail)];
  }

  async function newPlaylist() {
    const v = await formDialog('Neue laut.fm-Playlist', [
      { name: 'title', label: 'Name', required: true },
      { name: 'color', label: 'Farbe', type: 'color', value: '#19c3e6' },
      { name: 'description', label: 'Beschreibung' },
      { name: 'shuffled', label: 'Gemischt abspielen', type: 'checkbox', value: true },
    ]);
    if (v) await run(async () => { await ra('POST', `${st()}/playlists`, v); status('Playlist angelegt'); renderTab(); });
  }

  /** @param {any} p */
  async function plDetail(p) {
    const r = await ra('GET', `${st()}/playlists/${p.id}/tracks`);
    const tracks = r?.tracks ?? [];
    return [card(`Playlist: ${p.title}`,
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn small', onclick: () => editPlaylist(p) }, 'Bearbeiten'),
        h('button', { class: 'btn small', onclick: () => addTrackById(p) }, '＋ Titel-ID'),
        h('button', { class: 'btn small danger', onclick: () => confirm(`Playlist „${p.title}“ bei laut.fm löschen?`) && run(async () => { await ra('DELETE', `${st()}/playlists/${p.id}`); renderTab(); }) }, 'Löschen')),
      trackTable(tracks, (t) => h('button', { title: 'Aus Playlist entfernen', onclick: () => run(async () => { await ra('DELETE', `${st()}/playlists/${p.id}/entries/${t.id}`); status('Entfernt'); renderTab(); }) }, '✕')))];
  }

  /** @param {any} p */
  async function editPlaylist(p) {
    const v = await formDialog('Playlist bearbeiten', [
      { name: 'title', label: 'Name', value: p.title, required: true },
      { name: 'color', label: 'Farbe', type: 'color', value: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#19c3e6' },
      { name: 'description', label: 'Beschreibung', value: p.description ?? '' },
      { name: 'shuffled', label: 'Gemischt abspielen', type: 'checkbox', value: !!p.shuffled },
    ]);
    if (v) await run(async () => { await ra('PATCH', `${st()}/playlists/${p.id}`, v); renderTab(); });
  }

  /** @param {any} p */
  async function addTrackById(p) {
    const v = await formDialog('Titel hinzufügen', [{ name: 'track_id', label: 'Titel-ID (aus „Titel“-Suche)', type: 'number', required: true }], 'Hinzufügen');
    if (v?.track_id) await run(async () => { await ra('POST', `${st()}/playlists/${p.id}`, { track_id: v.track_id }); status('Hinzugefügt'); renderTab(); });
  }

  /** @param {any[]} tracks @param {(t: any) => HTMLElement} [action] */
  function trackTable(tracks, action) {
    if (!tracks.length) return h('div', { class: 'empty' }, 'Keine Titel.');
    return h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
      h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Interpret'), h('th', {}, 'Titel'), h('th', {}, 'Genre'), h('th', { class: 'num' }, 'Dauer'), h('th', {}))),
      h('tbody', {}, ...tracks.map((t) => h('tr', {},
        h('td', { class: 'num muted' }, String(t.id)), h('td', {}, typeof t.artist === 'object' ? t.artist?.name ?? '' : t.artist ?? ''), h('td', {}, t.title ?? ''),
        h('td', {}, t.genre ?? ''), h('td', { class: 'num' }, fmt((t.duration ?? t.length ?? 0) * 1000)),
        h('td', { class: 'act' }, h('button', { title: 'Vorhören', onclick: () => prelisten(t) }, '▶'), action ? action(t) : null))))));
  }

  /** @param {any} t */
  async function prelisten(t) {
    pre?.pause();
    const blob = await run(() => ctx.api.blob(ctx.url(`/lautfm/ra${st()}/tracks/${t.id}/prelisten`)));
    if (!blob) return;
    pre = new Audio(URL.createObjectURL(blob));
    pre.play().catch(() => {});
  }

  // ---------- Titel ----------
  async function tracks() {
    await loadPlaylists();
    const results = h('div', {});
    const form = h('form', { class: 'lf-search', onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); search(); } },
      h('input', { name: 'artist', placeholder: 'Interpret' }), h('input', { name: 'title', placeholder: 'Titel' }), h('input', { name: 'genre', placeholder: 'Genre' }),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'own' }), 'nur eigene'),
      h('button', { class: 'btn primary' }, 'Suchen'));
    const search = () => run(async () => {
      const fd = new FormData(/** @type {HTMLFormElement} */ (form));
      const q = new URLSearchParams();
      for (const k of ['artist', 'title', 'genre']) if (String(fd.get(k) ?? '').trim()) q.set(k, String(fd.get(k)).trim());
      if (fd.get('own')) q.set('own', 'true');
      const r = await ra('GET', `${st()}/tracks?${q}`);
      results.replaceChildren(trackTable(r?.tracks ?? [], (t) => h('select', {
        title: 'Zu Playlist hinzufügen',
        onchange: (/** @type {Event} */ e) => {
          const sel = /** @type {HTMLSelectElement} */ (e.target);
          if (!sel.value) return;
          run(async () => { await ra('POST', `${st()}/playlists/${sel.value}`, { track_id: t.id }); status('Zur Playlist hinzugefügt'); });
          sel.value = '';
        },
      }, h('option', { value: '' }, '＋ Playlist'), ...playlists.map((p) => h('option', { value: String(p.id) }, p.title)))));
    });
    const upload = h('label', { class: 'btn' }, '⭱ MP3 zu laut.fm hochladen', h('input', { type: 'file', accept: '.mp3,audio/mpeg', multiple: true, hidden: true, onchange: uploadTracks }));
    const queued = h('button', { class: 'btn small', onclick: () => run(async () => {
      const [q, inc] = await Promise.all([ra('GET', `${st()}/tracks;queued`), ra('GET', `${st()}/tracks;incomplete`)]);
      results.replaceChildren(card('In Verarbeitung', trackTable([...(q?.tracks ?? []), ...(inc?.tracks ?? [])])));
    }) }, 'Uploads in Verarbeitung');
    return [card('Titel suchen', form, h('div', { class: 'row-btns' }, upload, queued)), results];
  }

  /** @param {Event} e */
  async function uploadTracks(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const files = [...(input.files ?? [])];
    input.value = '';
    let ok = 0;
    for (const f of files) {
      status(`laut.fm-Upload: ${f.name} …`);
      const fd = new FormData();
      fd.append('track', f);
      fd.append('private', 'false');
      if (await run(() => ra('POST', `${st()}/tracks`, fd))) ok++;
    }
    status(`${ok}/${files.length} Datei(en) an laut.fm übertragen – laut.fm verarbeitet sie jetzt`, ok < files.length);
  }

  // ---------- Sendeplan (Slots: Tag*24 + Stunde, Montag = 0) ----------
  async function schedule() {
    const [sched] = await Promise.all([ra('GET', `${st()}/schedule`), loadPlaylists()]);
    const s = Array.isArray(sched) ? sched[0] : sched;
    /** @type {Record<number, number>} */
    const grid = {};
    for (const e of s?.entries ?? []) for (let i = 0; i < e.duration; i++) grid[e.slot + i] = e.playlist_id;
    const plById = new Map(playlists.map((p) => [p.id, p]));
    const base = plById.get(s?.base_playlist_id);
    const table = h('table', { class: 'lf-grid' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), ...DAYS.map((d) => h('th', {}, d)))),
      h('tbody', {}, ...Array.from({ length: 24 }, (_, hour) => h('tr', {}, h('th', { class: 'num' }, `${String(hour).padStart(2, '0')}:00`),
        ...DAYS.map((_, day) => {
          const slot = day * 24 + hour;
          const pl = plById.get(grid[slot]);
          return h('td', { title: pl ? pl.title : base ? `Basis: ${base.title}` : '', style: pl && /^#[0-9a-f]{6}$/i.test(pl.color) ? `background:${pl.color}33;border-left:3px solid ${pl.color}` : '', onclick: () => editSlot(s, grid, slot) }, pl ? pl.title : '');
        })))));
    return [card('Sendeplan', h('p', { class: 'muted' }, `Basis-Playlist: ${base?.title ?? '–'} · Zelle anklicken, um eine Stunde zu belegen`), h('div', { class: 'table-wrap' }, table))];
  }

  /** @param {any} s @param {Record<number, number>} grid @param {number} slot */
  async function editSlot(s, grid, slot) {
    const v = await formDialog(`${DAYS[Math.floor(slot / 24)]} ${String(slot % 24).padStart(2, '0')}:00`, [
      { name: 'playlist', label: 'Playlist', value: String(grid[slot] ?? ''), options: [['', '– Basis-Playlist –'], ...playlists.filter((p) => p.id !== s?.base_playlist_id).map((p) => /** @type {[string,string]} */ ([String(p.id), p.title]))] },
      { name: 'hours', label: 'Für wie viele Stunden', type: 'number', value: 1 },
    ]);
    if (!v) return;
    const next = { ...grid };
    for (let i = 0; i < Math.max(1, Math.min(168 - slot, Number(v.hours) || 1)); i++) {
      if (v.playlist) next[slot + i] = Number(v.playlist);
      else delete next[slot + i];
    }
    // zusammenhängende Slots gleicher Playlist zu Einträgen zusammenfassen
    const entries = [];
    for (let i = 0; i < 168; i++) {
      const id = next[i];
      if (id === undefined) continue;
      const last = entries[entries.length - 1];
      if (last && last.playlist_id === id && last.slot + last.duration === i) last.duration++;
      else entries.push({ playlist_id: id, slot: i, duration: 1 });
    }
    await run(async () => { await ra('PATCH', `${st()}/schedule`, { base_playlist_id: s?.base_playlist_id, entries }); status('Sendeplan gespeichert'); renderTab(); });
  }

  // ---------- Statistik ----------
  async function stats() {
    const [s, day] = await Promise.all([ra('GET', `${st()}/stats`), ra('GET', `${st()}/tracks/stats/24h`).catch(() => [])]);
    const log = (/** @type {Record<string, number>} */ o) => Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const max = Math.max(1, ...log(s?.switchons_log).map(([, v]) => v));
    return [h('div', { class: 'view-grid' },
      card('Hörer', kv('Jetzt', s?.listeners_now), kv('Position', s?.position_now),
        h('div', { class: 'bars' }, ...log(s?.switchons_log).map(([d, v]) => h('div', { class: 'bar', title: `${d}: ${v} Einschaltungen` }, h('i', { style: `height:${(v / max) * 100}%` }), h('span', {}, d.slice(5)))))),
      card('Gespielte Titel (24 h)', h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Start'), h('th', {}, 'Titel'), h('th', { class: 'num' }, 'Hörer'), h('th', {}, ''))),
        h('tbody', {}, ...(Array.isArray(day) ? day : []).slice(0, 300).map((/** @type {any} */ t) => h('tr', {},
          h('td', { class: 'num' }, t.started_at ? clockTime(new Date(t.started_at).getTime()) : ''),
          h('td', {}, `${t.artist?.name ?? ''} – ${t.title ?? ''}`), h('td', { class: 'num' }, String(t.listeners ?? '')), h('td', {}, t.live ? h('span', { class: 'pill failed' }, 'live') : ''))))))))];
  }

  // ---------- Benutzer ----------
  async function users() {
    const r = await ra('GET', `${st()}/users`);
    const list = r?.users ?? [];
    return [card('Benutzer', h('button', { class: 'btn small primary', onclick: invite }, '＋ Einladen'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'list' }, h('tbody', {}, ...list.map((/** @type {any} */ u) => h('tr', {},
        h('td', {}, `${u.name ?? ''} ${u.surname ?? ''}`), h('td', {}, u.email ?? ''),
        h('td', {}, h('select', { onchange: (/** @type {Event} */ e) => run(async () => { await ra('PATCH', `${st()}/users/${u.id}`, { role: /** @type {HTMLSelectElement} */ (e.target).value }); status('Rolle geändert'); }) },
          ...ROLES.map(([v, l]) => h('option', { value: v, selected: u.role === v }, l)))),
        h('td', { class: 'act' }, h('button', { title: 'Entfernen', onclick: () => confirm('Benutzer entfernen?') && run(async () => { await ra('DELETE', `${st()}/users/${u.id}`); renderTab(); }) }, '✕'))))))))];
  }

  async function invite() {
    const v = await formDialog('Benutzer einladen', [{ name: 'email', label: 'E-Mail', type: 'email', required: true }, { name: 'role', label: 'Rolle', value: 'dj', options: ROLES }], 'Einladen');
    if (v) await run(async () => { await ra('POST', `${st()}/users`, v); status('Einladung versendet'); renderTab(); });
  }

  // ---------- Station ----------
  async function station() {
    const s = await ra('GET', st());
    const fields = /** @type {const} */ ([['description', 'Beschreibung'], ['format', 'Format'], ['djs', 'DJs'], ['location', 'Ort'], ['website', 'Website'], ['twitter_name', 'X/Twitter'], ['facebook_page', 'Facebook'], ['instagram_name', 'Instagram']]);
    const form = h('form', { class: 'lf-form', onsubmit: (/** @type {Event} */ e) => {
      e.preventDefault();
      const fd = new FormData(/** @type {HTMLFormElement} */ (form));
      /** @type {Record<string, any>} */
      const body = {};
      for (const [k] of fields) if (String(fd.get(k) ?? '') !== String(s[k] ?? '')) body[k] = String(fd.get(k) ?? '');
      const genres = String(fd.get('genres') ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 3);
      if (genres.join(',') !== (s.genres ?? []).join(',')) body.genres = genres;
      if (!Object.keys(body).length) return status('Keine Änderungen');
      run(async () => { await ra('PATCH', st(), body); status('Station gespeichert'); });
    } },
      ...fields.map(([k, l]) => h('div', { class: 'field' }, h('label', {}, l), h('input', { name: k, value: s[k] ?? '' }))),
      h('div', { class: 'field' }, h('label', {}, 'Genres (max. 3, kommagetrennt)'), h('input', { name: 'genres', value: (s.genres ?? []).join(', ') })),
      h('button', { class: 'btn primary' }, 'Speichern'));
    const logo = h('label', { class: 'btn' }, 'Logo hochladen', h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif', hidden: true, onchange: (/** @type {Event} */ e) => {
      const f = /** @type {HTMLInputElement} */ (e.target).files?.[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('image', f);
      run(async () => { await ra('PUT', `${st()}/images/logo`, fd); status('Logo hochgeladen'); });
    } }));
    return [h('div', { class: 'view-grid' }, card(`Station ${s.name}`, form), card('Bilder', s.logo_image_url ? h('img', { src: s.logo_image_url, alt: 'Logo', class: 'lf-logo' }) : null, logo))];
  }

  // ---------- Live ----------
  async function live() {
    const l = await ra('GET', `${st()}/live`);
    return [card('Live-Zugang (Encoder)',
      kv('Server', l.server), kv('Port', l.port), kv('Mountpoint', l.mountpoint), kv('Benutzer', l.user), kv('Format', `${l.format ?? ''} ${l.bitrate ?? ''} kbit/s ${l.samplerate ?? ''} Hz`),
      kv('Passwort', l.password ? '•••••••• (wird nicht angezeigt)' : '–'), kv('Status', l.active ? 'live verbunden' : 'nicht live'),
      h('p', { class: 'muted' }, 'AirDeck kann diesen Zugang als Ausgang übernehmen: Das Sendesignal (Automation, Live, Mikrofon) geht dann direkt zu laut.fm. Mit Priorität (?prio=) verdrängt AirDeck eine niedrigere Quelle bzw. lässt sich von einer höheren verdrängen.'),
      h('button', { class: 'btn primary', onclick: async () => {
        const v = await formDialog('Als AirDeck-Ausgang übernehmen', [{ name: 'priority', label: 'Priorität ?prio= (leer = ohne)', type: 'number', value: '' }], 'Übernehmen');
        if (v) await run(async () => { await ctx.api.post(ctx.url('/lautfm/live-output'), { priority: v.priority }); status('laut.fm-Ausgang angelegt – sendet, sobald eine Quelle auf Sendung ist'); });
      } }, 'Als Ausgang übernehmen'))];
  }

  return { show: () => run(show) };
}
