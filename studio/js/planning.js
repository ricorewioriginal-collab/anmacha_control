// @ts-check
// Ansichten „Planung“ (Zeitplan, Stunden-Uhr, Sendeplan, Playlists, Verlauf) und „Recorder“.

import { DAYS, clockTime, download, fmt, formDialog, h, mediaTitle, run, status } from './ui.js';

const REPEAT = /** @type {Record<string,string>} */ ({ none: 'einmalig', hourly: 'stündlich', daily: 'täglich', weekdays: 'Mo–Fr', weekly: 'wöchentlich' });
const MODE = /** @type {Record<string,string>} */ ({ now: 'sofort (Crossfade)', track: 'nach dem Titel', fx: 'über der Musik' });
const KIND = /** @type {Record<string,string>} */ ({ media: 'Titel', folder: 'Ordner (Rotation)', url: 'URL / Stream', playlist: 'Playlist' });

/**
 * @typedef {{ api: import('./api.js').Api, url: (p: string) => string, library: () => any[], folders: () => Promise<string[]> }} Ctx
 */

const daysText = (/** @type {number[]} */ d) => (!d?.length || d.length === 7 ? 'täglich' : d.map((i) => DAYS[i]).join(' '));
const localInput = (/** @type {number} */ t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// --- Sendeplan-Gitter (Drag & Drop) -----------------------------------------------------------
const SP_PX_PER_MIN = 1; // 60px je Stunde
/** @param {string} t */
const spToMin = (t) => { const [hh, mm] = t.split(':').map(Number); return (hh || 0) * 60 + (mm || 0); };
/** @param {number} m */
const spFromMin = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`;
/** @param {number} m */
const spSnap = (m) => Math.max(0, Math.min(1440 - 15, Math.round(m / 15) * 15));
/** @param {number[]} days @param {number} from @param {number} to */
const spSwapDay = (days, from, to) => { const set = new Set(days); set.delete(from); set.add(to); return [...set].sort((a, b) => a - b); };

/** Beschreibung eines Ziels (Job/Uhr-Event). @param {any} t @param {Ctx} ctx @param {any[]} playlists */
function targetText(t, ctx, playlists) {
  const what =
    t.kind === 'media' ? mediaTitle(ctx.library().find((m) => m.id === t.mediaId)) :
    t.kind === 'folder' ? `Ordner „${t.folder}“` :
    t.kind === 'playlist' ? `Playlist „${playlists.find((p) => p.id === t.playlistId)?.name ?? '?'}“` : t.kind;
  return `${t.label ? t.label + ' · ' : ''}${what} · ${MODE[t.mode] ?? t.mode}`;
}

/** Felder für Ziel-Auswahl. @param {Ctx} ctx @param {any[]} playlists @param {string[]} folders @param {any} [v] */
function targetFields(ctx, playlists, folders, v = {}) {
  const lib = [...ctx.library()].sort((a, b) => mediaTitle(a).localeCompare(mediaTitle(b), 'de'));
  return [
    { name: 'label', label: 'Bezeichnung', value: v.label ?? '' },
    { name: 'kind', label: 'Was', value: v.kind ?? 'media', options: Object.entries(KIND) },
    { name: 'mediaId', label: 'Titel (bei „Titel“)', value: v.mediaId ?? lib[0]?.id ?? '', options: lib.map((m) => /** @type {[string,string]} */ ([m.id, mediaTitle(m)])) },
    { name: 'folder', label: 'Ordner (bei „Ordner“)', value: v.folder ?? folders[0] ?? '', options: folders.map((f) => /** @type {[string,string]} */ ([f, f])) },
    { name: 'url', label: 'URL (bei „URL / Stream“)', value: v.url ?? '', hint: 'z. B. Nachrichten-Stream oder MP3-Link' },
    { name: 'durationMin', label: 'Dauer in Minuten (bei Streams)', type: 'number', value: '' },
    { name: 'playlistId', label: 'Playlist (bei „Playlist“)', value: v.playlistId ?? playlists[0]?.id ?? '', options: playlists.map((p) => /** @type {[string,string]} */ ([p.id, p.name])) },
    { name: 'mode', label: 'Wiedergabe', value: v.mode ?? 'track', options: Object.entries(MODE) },
  ];
}

/** @param {Record<string, any>} v */
function targetBody(v) {
  return { label: v.label, kind: v.kind, mediaId: v.mediaId, folder: v.folder, url: v.url, durationMs: v.durationMin ? v.durationMin * 60000 : undefined, playlistId: v.playlistId, mode: v.mode };
}

/** @param {string} title @param {HTMLElement[]} actions @param {HTMLElement} body */
export const panel = (title, actions, body) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title), ...actions), body);
/** @param {string[]} heads @param {HTMLElement[]} rows @param {string} empty */
const table = (heads, rows, empty) =>
  rows.length
    ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ...heads.map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)))
    : h('div', { class: 'empty' }, empty);
/** @param {...(HTMLElement|null)} btns */
const act = (...btns) => h('td', { class: 'act' }, ...btns);
/** @param {string} title @param {string} label @param {() => void} fn */
export const iconBtn = (title, label, fn) => h('button', { title, onclick: fn }, label);

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountPlanning(root, ctx) {
  /** @type {any} */ let plan = { jobs: [], clockEvents: [], plans: [], activePlanId: null };
  /** @type {any[]} */ let playlists = [];
  /** @type {any[]} */ let history = [];
  /** @type {string[]} */ let folders = [];
  let openPl = /** @type {string|null} */ (null);

  async function load() {
    [plan, playlists, history, folders] = await Promise.all([
      ctx.api.get(ctx.url('/planning')), ctx.api.get(ctx.url('/playlists')), ctx.api.get(ctx.url('/history?limit=200')), ctx.folders(),
    ]);
    render();
  }

  function render() {
    const byId = new Map(ctx.library().map((m) => [m.id, m]));
    // --- Zeitplan ---
    const jobs = panel('Zeitplan', [h('button', { class: 'btn small primary', onclick: addJob }, '＋ Einplanen')],
      table(['Zeitpunkt', 'Wiederholung', 'Was', ''], plan.jobs.map((/** @type {any} */ j) => h('tr', {},
        h('td', {}, new Date(j.at).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
        h('td', {}, REPEAT[j.repeat]), h('td', {}, targetText(j, ctx, playlists)),
        act(iconBtn('Löschen', '✕', () => run(async () => { await ctx.api.del(ctx.url(`/jobs/${j.id}`)); await load(); }))))),
      'Nichts eingeplant. Einzelne Titel, Ordner, Streams oder Playlists zu einem Zeitpunkt starten – einmalig oder wiederholt.'));
    // --- Stunden-Uhr ---
    const clock = panel('Stunden-Uhr', [h('button', { class: 'btn small primary', onclick: () => editClock() }, '＋ Event')],
      table(['Minute', 'Stunden', 'Tage', 'Was', ''], plan.clockEvents.map((/** @type {any} */ e) => h('tr', { style: e.enabled ? '' : 'opacity:.5' },
        h('td', { class: 'num' }, e.minutes.map((/** @type {number} */ m) => `:${String(m).padStart(2, '0')}`).join(' ')),
        h('td', {}, e.hours.length ? e.hours.join(', ') : 'jede'), h('td', {}, daysText(e.days)), h('td', {}, targetText(e, ctx, playlists)),
        act(iconBtn('Jetzt auslösen', '▶', () => run(() => ctx.api.post(ctx.url(`/clock-events/${e.id}/fire`)))),
          iconBtn('Bearbeiten', '✎', () => editClock(e)),
          iconBtn('Löschen', '✕', () => run(async () => { await ctx.api.del(ctx.url(`/clock-events/${e.id}`)); await load(); }))))),
      'Wiederkehrende Elemente zur vollen Minute, z. B. Station-ID zu :00, Jingle zu :30.'));
    // --- Sendeplan ---
    const sched = panel('Sendeplan', [h('button', { class: 'btn small primary', onclick: () => editPlan() }, '＋ Sendung')],
      h('div', {},
        h('p', { class: 'muted', style: 'margin:0 0 8px' }, 'Sendung ziehen zum Verschieben (Zeit/Tag), unteren Rand ziehen für die Dauer, Playlist auf ein freies Feld ziehen für eine neue Sendung.'),
        schedGrid(),
        h('div', { style: 'margin-top:12px' }, table(['Sendung', 'Tage', 'Zeit', 'Playlist', ''], plan.plans.map((/** @type {any} */ p) => h('tr', { class: p.id === plan.activePlanId ? 'active-row' : '' },
          h('td', {}, p.label, p.id === plan.activePlanId ? h('span', { class: 'pill active', style: 'margin-left:6px' }, 'läuft') : null),
          h('td', {}, daysText(p.days)), h('td', { class: 'num' }, `${p.from}–${p.to}`),
          h('td', {}, `${playlists.find((x) => x.id === p.playlistId)?.name ?? '?'}${p.shuffle ? ' · gemischt' : ''}`),
          act(iconBtn('Bearbeiten', '✎', () => editPlan(p)), iconBtn('Löschen', '✕', () => run(async () => { await ctx.api.del(ctx.url(`/plans/${p.id}`)); await load(); }))))),
          'Kein Sendeplan: Die Automation folgt der Sendeuhr. Mit Sendungen spielt im Zeitfenster die gewählte Playlist.'))));
    // --- Playlists ---
    const pls = panel('Playlists', [
      h('button', { class: 'btn small', onclick: saveQueue }, 'Queue speichern'),
      h('label', { class: 'btn small' }, 'M3U importieren', h('input', { type: 'file', accept: '.m3u,.m3u8,audio/x-mpegurl', hidden: true, onchange: importM3U })),
      h('button', { class: 'btn small primary', onclick: () => editPl() }, '＋ Playlist'),
    ], h('div', {}, ...(playlists.length ? playlists.map((p) => {
      const open = openPl === p.id;
      return h('div', { class: 'pl' },
        h('div', {
          class: 'pl-head', draggable: true, title: 'In den Sendeplan ziehen für eine neue Sendung',
          ondragstart: (/** @type {DragEvent} */ e) => e.dataTransfer?.setData('application/json', JSON.stringify({ mode: 'new', playlistId: p.id, name: p.name })),
        },
          h('span', { class: 'pl-dot', style: `background:${p.color}` }),
          h('button', { class: 'pl-name', onclick: () => { openPl = open ? null : p.id; render(); } }, `${open ? '▾' : '▸'} ${p.name}`),
          h('span', { class: 'muted' }, `${p.items.length} Titel · ${fmt(p.items.reduce((/** @type {number} */ a, /** @type {string} */ id) => a + (byId.get(id)?.durationMs ?? 0), 0))}`),
          h('span', { class: 'act' },
            iconBtn('Abspielen (ersetzt die Queue)', '▶', () => run(async () => { await ctx.api.post(ctx.url(`/playlists/${p.id}/play`)); status(`Playlist „${p.name}“ läuft`); })),
            iconBtn('Titel hinzufügen', '＋', () => addToPl(p)),
            iconBtn('Umbenennen/Farbe', '✎', () => editPl(p)),
            iconBtn('Löschen', '✕', () => confirm(`Playlist „${p.name}“ löschen?`) && run(async () => { await ctx.api.del(ctx.url(`/playlists/${p.id}`)); await load(); })))),
        open ? h('ol', { class: 'pl-items' }, ...p.items.map((/** @type {string} */ id, /** @type {number} */ i) => h('li', {},
          h('span', {}, mediaTitle(byId.get(id))), h('span', { class: 'muted num' }, fmt(byId.get(id)?.durationMs)),
          h('span', { class: 'act' },
            i > 0 ? iconBtn('Nach oben', '↑', () => savePlItems(p, move(p.items, i, i - 1))) : null,
            iconBtn('Entfernen', '✕', () => savePlItems(p, p.items.filter((/** @type {string} */ _, /** @type {number} */ k) => k !== i))))))) : null);
    }) : [h('div', { class: 'empty' }, 'Noch keine Playlists. Aktuelle Queue speichern oder M3U importieren.')])));
    // --- Verlauf ---
    const hist = panel('Verlauf', [h('button', { class: 'btn small', onclick: exportHistory }, 'CSV')],
      table(['Zeit', 'Titel', 'Art'], history.slice(0, 200).map((x) => h('tr', {},
        h('td', { class: 'num' }, clockTime(x.at)), h('td', {}, x.artist ? `${x.artist} – ${x.title}` : x.title), h('td', {}, h('span', { class: 'tag' }, x.category)))),
      'Noch nichts gespielt.'));
    root.replaceChildren(h('div', { class: 'view-grid' }, jobs, clock, sched, pls, hist));
  }

  /** Sendeplan als Wochengitter: Sendungen ziehen (Zeit/Tag), unteren Rand ziehen (Dauer), Playlist hineinziehen (neu). */
  function schedGrid() {
    const cols = DAYS.map((_, day) => {
      const dayPlans = plan.plans.filter((/** @type {any} */ p) => !p.days?.length || p.days.length === 7 || p.days.includes(day));
      const blocks = dayPlans.map((/** @type {any} */ p) => {
        const from = spToMin(p.from);
        const toRaw = spToMin(p.to);
        const overnight = toRaw <= from;
        const top = from * SP_PX_PER_MIN;
        const height = Math.max(18, ((overnight ? 1440 : toRaw) - from) * SP_PX_PER_MIN);
        const daily = !p.days?.length || p.days.length === 7;
        return h('div', {
          class: `sp-block${p.id === plan.activePlanId ? ' active' : ''}`,
          style: `top:${top}px;height:${height}px`,
          draggable: true,
          title: `${p.label} · ${daysText(p.days)} · ${p.from}–${p.to} · Klicken zum Bearbeiten`,
          ondragstart: (/** @type {DragEvent} */ e) => { const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect(); e.dataTransfer?.setData('application/json', JSON.stringify({ mode: 'move', planId: p.id, fromDay: day, grabY: e.clientY - r.top })); },
          onclick: () => editPlan(p),
        },
          h('span', { class: 'sp-label' }, p.label),
          h('span', { class: 'sp-time num' }, `${p.from}–${p.to}`),
          overnight ? null : h('span', {
            class: 'sp-resize', title: 'Dauer ändern', draggable: true,
            onclick: (/** @type {Event} */ e) => e.stopPropagation(),
            ondragstart: (/** @type {DragEvent} */ e) => { e.stopPropagation(); e.dataTransfer?.setData('application/json', JSON.stringify({ mode: 'resize', planId: p.id })); },
          }));
      });
      return h('div', {
        class: 'sp-col', 'data-day': String(day),
        ondragover: (/** @type {DragEvent} */ e) => e.preventDefault(),
        ondrop: (/** @type {DragEvent} */ e) => onSchedDrop(e, day),
      }, ...blocks);
    });
    const hours = Array.from({ length: 24 }, (_, hh) => h('div', { class: 'sp-hourlabel', style: `top:${hh * 60 * SP_PX_PER_MIN}px` }, `${String(hh).padStart(2, '0')}:00`));
    return h('div', { class: 'sp-grid' },
      h('div', { class: 'sp-head' }, h('div', { class: 'sp-corner' }), ...DAYS.map((d) => h('div', { class: 'sp-day' }, d))),
      h('div', { class: 'sp-scroll' },
        h('div', { class: 'sp-body' },
          h('div', { class: 'sp-hours' }, ...hours),
          ...cols)));
  }

  /** @param {DragEvent} e @param {number} day */
  async function onSchedDrop(e, day) {
    e.preventDefault();
    const raw = e.dataTransfer?.getData('application/json');
    if (!raw) return;
    /** @type {any} */ const data = JSON.parse(raw);
    const col = /** @type {HTMLElement} */ (e.currentTarget);
    const rect = col.getBoundingClientRect();
    if (data.mode === 'new') {
      if (!playlists.length) return;
      const start = spSnap((e.clientY - rect.top) / SP_PX_PER_MIN);
      const body = { label: data.name, days: [day], from: spFromMin(start), to: spFromMin(start + 60), playlistId: data.playlistId, shuffle: false };
      return run(async () => { await ctx.api.post(ctx.url('/plans'), body); status(`Sendung „${data.name}“ eingeplant`); await load(); });
    }
    const p = plan.plans.find((/** @type {any} */ x) => x.id === data.planId);
    if (!p) return;
    if (data.mode === 'resize') {
      const from = spToMin(p.from);
      const end = spSnap((e.clientY - rect.top) / SP_PX_PER_MIN);
      if (end <= from + 15) return;
      return run(async () => { await ctx.api.patch(ctx.url(`/plans/${p.id}`), { ...p, to: spFromMin(end) }); await load(); });
    }
    // Verschieben: Zeit ändert sich immer, Tag nur bei nicht-täglichen Sendungen (sonst wäre unklar, welcher Tag gemeint ist)
    const start = spSnap((e.clientY - rect.top - (data.grabY ?? 0)) / SP_PX_PER_MIN);
    let dur = spToMin(p.to) - spToMin(p.from);
    if (dur <= 0) dur += 1440;
    const daily = !p.days?.length || p.days.length === 7;
    const days = daily || day === data.fromDay ? p.days : spSwapDay(p.days, data.fromDay, day);
    const body = { ...p, from: spFromMin(start), to: spFromMin(start + dur), days };
    return run(async () => { await ctx.api.patch(ctx.url(`/plans/${p.id}`), body); await load(); });
  }

  /** @param {string[]} arr @param {number} a @param {number} b */
  const move = (arr, a, b) => { const c = [...arr]; const [x] = c.splice(a, 1); c.splice(b, 0, /** @type {string} */ (x)); return c; };
  /** @param {any} p @param {string[]} items */
  const savePlItems = (p, items) => run(async () => { await ctx.api.patch(ctx.url(`/playlists/${p.id}`), { items }); await load(); });

  async function addJob() {
    const v = await formDialog('Einplanen', [
      { name: 'at', label: 'Zeitpunkt', type: 'datetime-local', value: localInput(Date.now() + 3600e3 - (Date.now() % 3600e3)), required: true },
      { name: 'repeat', label: 'Wiederholung', value: 'none', options: Object.entries(REPEAT) },
      ...targetFields(ctx, playlists, folders),
    ], 'Einplanen');
    if (!v) return;
    await run(async () => { await ctx.api.post(ctx.url('/jobs'), { at: new Date(v.at).toISOString(), repeat: v.repeat, ...targetBody(v) }); status('Eingeplant ✔'); await load(); });
  }

  /** @param {any} [e] */
  async function editClock(e) {
    const v = await formDialog(e ? 'Uhr-Event bearbeiten' : 'Uhr-Event', [
      { name: 'minutes', label: 'Minuten (kommagetrennt, 0–59)', value: e ? e.minutes.join(', ') : '0', required: true },
      { name: 'hours', label: 'Stunden (leer = jede Stunde, z. B. 6-18 oder 7, 12, 17)', value: e?.hours.join(', ') ?? '' },
      { name: 'days', label: 'Tage (keine Auswahl = täglich)', type: 'days', value: e?.days ?? [] },
      ...targetFields(ctx, playlists, folders, e),
      { name: 'enabled', label: 'Aktiv', type: 'checkbox', value: e?.enabled ?? true },
    ]);
    if (!v) return;
    const nums = (/** @type {string} */ t, /** @type {number} */ max) => {
      const out = new Set();
      for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
        const r = /^(\d+)-(\d+)$/.exec(part);
        if (r) for (let i = +r[1]; i <= Math.min(+r[2], max); i++) out.add(i);
        else if (/^\d+$/.test(part) && +part <= max) out.add(+part);
      }
      return [...out];
    };
    const body = { ...targetBody(v), minutes: nums(v.minutes, 59), hours: nums(v.hours, 23), days: v.days, enabled: v.enabled };
    await run(async () => { await (e ? ctx.api.patch(ctx.url(`/clock-events/${e.id}`), body) : ctx.api.post(ctx.url('/clock-events'), body)); await load(); });
  }

  /** @param {any} [p] */
  async function editPlan(p) {
    if (!playlists.length) return status('Zuerst eine Playlist anlegen', true);
    const v = await formDialog(p ? 'Sendung bearbeiten' : 'Sendung im Sendeplan', [
      { name: 'label', label: 'Name der Sendung', value: p?.label ?? '', required: true },
      { name: 'days', label: 'Tage (keine Auswahl = täglich)', type: 'days', value: p?.days ?? [] },
      { name: 'from', label: 'Von', type: 'time', value: p?.from ?? '20:00', required: true },
      { name: 'to', label: 'Bis (kleiner als „Von“ = über Mitternacht, gleich = ganzer Tag)', type: 'time', value: p?.to ?? '22:00', required: true },
      { name: 'playlistId', label: 'Playlist', value: p?.playlistId ?? playlists[0].id, options: playlists.map((x) => /** @type {[string,string]} */ ([x.id, x.name])) },
      { name: 'shuffle', label: 'Gemischt (mit Rotationsregeln)', type: 'checkbox', value: p?.shuffle ?? false },
    ]);
    if (!v) return;
    await run(async () => { await (p ? ctx.api.patch(ctx.url(`/plans/${p.id}`), v) : ctx.api.post(ctx.url('/plans'), v)); await load(); });
  }

  /** @param {any} [p] */
  async function editPl(p) {
    const v = await formDialog(p ? 'Playlist bearbeiten' : 'Neue Playlist', [
      { name: 'name', label: 'Name', value: p?.name ?? '', required: true },
      { name: 'color', label: 'Farbe', type: 'color', value: p?.color ?? '#19c3e6' },
    ]);
    if (!v) return;
    await run(async () => { await (p ? ctx.api.patch(ctx.url(`/playlists/${p.id}`), v) : ctx.api.post(ctx.url('/playlists'), v)); await load(); });
  }

  /** @param {any} p */
  async function addToPl(p) {
    const lib = [...ctx.library()].sort((a, b) => mediaTitle(a).localeCompare(mediaTitle(b), 'de'));
    const v = await formDialog(`Zu „${p.name}“ hinzufügen`, [
      { name: 'folder', label: 'Ganzen Ordner hinzufügen', value: '', options: [['', '– kein Ordner –'], ...folders.map((f) => /** @type {[string,string]} */ ([f, f]))] },
      { name: 'mediaId', label: 'oder einzelnen Titel', value: '', options: [['', '–'], ...lib.map((m) => /** @type {[string,string]} */ ([m.id, mediaTitle(m)]))] },
    ], 'Hinzufügen');
    if (!v) return;
    const add = v.folder ? lib.filter((m) => (m.folder ?? '') === v.folder).map((m) => m.id) : v.mediaId ? [v.mediaId] : [];
    if (add.length) await savePlItems(p, [...p.items, ...add]);
  }

  async function saveQueue() {
    const v = await formDialog('Queue als Playlist speichern', [{ name: 'name', label: 'Name', value: `Queue ${new Date().toLocaleDateString('de-DE')}`, required: true }]);
    if (v) await run(async () => { await ctx.api.post(ctx.url('/playlists'), { fromQueue: true, name: v.name }); await load(); });
  }

  /** @param {Event} e */
  async function importM3U(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const text = await file.text();
    const r = await run(() => ctx.api.post(ctx.url('/m3u/import'), { text, playlistName: file.name.replace(/\.m3u8?$/i, '') }));
    if (r) {
      status(`M3U: ${r.matched} Titel zugeordnet${r.missing.length ? `, ${r.missing.length} nicht in der Bibliothek` : ''}`, r.missing.length > 0);
      await load();
    }
  }

  function exportHistory() {
    const esc = (/** @type {string} */ x) => `"${String(x).replace(/"/g, '""')}"`;
    const csv = ['Zeit;Interpret;Titel;Art', ...history.map((x) => [new Date(x.at).toLocaleString('de-DE'), x.artist, x.title, x.category].map(esc).join(';'))].join('\r\n');
    download(new Blob(['﻿' + csv], { type: 'text/csv' }), `verlauf-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return { show: () => run(load), onEvent: (/** @type {string} */ t) => { if (['planning.changed', 'playlists.changed', 'now_playing.changed'].includes(t) && root.isConnected && !root.hidden) run(load); } };
}

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountRecorder(root, ctx) {
  /** @type {any} */ let data = { recordings: [], recording: null, recPlans: [] };
  /** @type {HTMLAudioElement|null} */ let player = null;

  async function load() {
    data = await ctx.api.get(ctx.url('/recordings'));
    render();
  }

  function render() {
    const cur = data.recording;
    const head = panel('Aufnahme', [], h('div', { class: 'rec-now' },
      h('span', { class: `pill ${cur ? 'failed' : ''}` }, cur ? '● REC' : 'bereit'),
      h('span', {}, cur ? `${cur.label} · seit ${clockTime(cur.startedAt)} · ${(cur.bytes / 1048576).toFixed(1)} MB` : 'Nimmt das Sendesignal (aktive Quelle) auf – egal ob Automation, Live oder Mikrofon.'),
      cur
        ? h('button', { class: 'btn danger', onclick: () => run(async () => { await ctx.api.post(ctx.url('/recorder/stop')); await load(); }) }, '■ Stop')
        : h('button', { class: 'btn primary', onclick: startRec }, '● Aufnahme starten')));
    const list = panel('Mitschnitte / Replays', [],
      table(['Start', 'Name', 'Dauer', 'Größe', ''], data.recordings.map((/** @type {any} */ r) => h('tr', {},
        h('td', { class: 'num' }, new Date(r.startedAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
        h('td', {}, r.label), h('td', { class: 'num' }, r.endedAt ? fmt(r.endedAt - r.startedAt) : 'läuft'),
        h('td', { class: 'num' }, `${(r.bytes / 1048576).toFixed(1)} MB`),
        act(iconBtn('Anhören', '▶', () => listen(r)), iconBtn('Herunterladen', '⭳', () => save(r)),
          r.endedAt ? iconBtn('In die Nextcloud hochladen', '☁', () => run(async () => {
            status('Lade Mitschnitt in die Nextcloud …');
            const u = await ctx.api.post(ctx.url(`/recordings/${r.id}/nextcloud`), { dir: 'AirDeck-Mitschnitte' });
            status(`In der Nextcloud: ${u.uploaded}`);
          })) : null,
          iconBtn('Löschen', '✕', () => confirm(`„${r.label}“ löschen?`) && run(async () => { await ctx.api.del(ctx.url(`/recordings/${r.id}`)); await load(); }))))),
      'Noch keine Aufnahmen.'));
    const plans = panel('Automatische Aufnahmen', [h('button', { class: 'btn small primary', onclick: addPlan }, '＋ Zeitfenster')],
      table(['Name', 'Tage', 'Zeit', ''], data.recPlans.map((/** @type {any} */ p) => h('tr', {},
        h('td', {}, p.label), h('td', {}, daysText(p.days)), h('td', { class: 'num' }, `${p.from}–${p.to}`),
        act(iconBtn('Löschen', '✕', () => run(async () => { await ctx.api.del(ctx.url(`/rec-plans/${p.id}`)); await load(); }))))),
      'Z. B. jede Sendung „Morning Show“ Mo–Fr 06:00–10:00 automatisch mitschneiden.'));
    root.replaceChildren(h('div', { class: 'view-grid' }, head, list, plans));
  }

  async function startRec() {
    const v = await formDialog('Aufnahme starten', [{ name: 'label', label: 'Name', value: `Sendung ${new Date().toLocaleString('de-DE')}` }], 'Starten');
    if (v) await run(async () => { await ctx.api.post(ctx.url('/recorder/start'), { label: v.label }); await load(); });
  }

  async function addPlan() {
    const v = await formDialog('Automatische Aufnahme', [
      { name: 'label', label: 'Name', value: 'Sendung', required: true },
      { name: 'days', label: 'Tage (keine Auswahl = täglich)', type: 'days', value: [] },
      { name: 'from', label: 'Von', type: 'time', value: '20:00', required: true },
      { name: 'to', label: 'Bis', type: 'time', value: '22:00', required: true },
    ]);
    if (v) await run(async () => { await ctx.api.post(ctx.url('/rec-plans'), v); await load(); });
  }

  /** @param {any} r */
  async function listen(r) {
    player?.pause();
    const blob = await run(() => ctx.api.blob(ctx.url(`/recordings/${r.id}/file`)));
    if (!blob) return;
    player = new Audio(URL.createObjectURL(blob));
    player.play().catch(() => status('Wiedergabe nicht möglich', true));
    status(`Replay: ${r.label}`);
  }

  /** @param {any} r */
  async function save(r) {
    const blob = await run(() => ctx.api.blob(ctx.url(`/recordings/${r.id}/file`)));
    if (blob) download(blob, `${r.label}.${r.file.split('.').pop()}`);
  }

  return { show: () => run(load), onEvent: (/** @type {string} */ t) => { if (t === 'recorder.changed' && !root.hidden) run(load); } };
}
