// @ts-check
// Gemeinsame UI-Helfer für alle Studio-Ansichten (DOM, Formatierung, Dialoge, Statuszeile).
// Nutzerinhalte werden ausschließlich per textContent gesetzt (kein innerHTML).


/** @param {string} id */
export const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node|string|null|undefined|false)} children
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && typeof v !== 'string') /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** @param {number|null|undefined} ms */
export function fmt(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** @param {number} at */
export function clockTime(at) {
  return new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** @param {string} msg @param {boolean} [err] */
export function status(msg, err = false) {
  const el = $('status-text');
  el.textContent = `${new Date().toLocaleTimeString('de-DE')} · ${msg}`;
  el.classList.toggle('err', err);
}

/** @param {() => Promise<any>} fn */
export async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), true);
    return undefined;
  }
}


// ---------- Dialoge ----------

/**
 * @param {string} title
 * @param {Array<{name:string,label:string,type?:string,value?:any,options?:Array<[string,string]>,hint?:string,required?:boolean,suggest?:string[]}>} fields
 * @param {string} [submitLabel]
 * @returns {Promise<Record<string, any>|null>}
 */
export function formDialog(title, fields, submitLabel = 'Speichern') {
  const dlg = /** @type {HTMLDialogElement} */ ($('dialog'));
  const form = /** @type {HTMLFormElement} */ ($('dialog-form'));
  form.replaceChildren(h('h3', {}, title));
  for (const f of fields) {
    const id = `f-${f.name}`;
    /** @type {HTMLElement} */
    let input;
    if (f.type === 'days') {
      const set = new Set(Array.isArray(f.value) ? f.value : []);
      input = h('div', { class: 'days', id }, ...DAYS.map((d, i) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: `${f.name}_${i}`, checked: set.has(i) }), d)));
    } else if (f.type === 'file') {
      input = h('input', { id, name: f.name, type: 'file', accept: f.value ?? '' });
    } else if (f.type === 'info') {
      input = h('output', { id, class: 'info' }, String(f.value ?? ''));
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, name: f.name, rows: '8', value: f.value ?? '' });
    } else if (f.options) {
      input = h('select', { id, name: f.name }, ...f.options.map(([v, l]) => h('option', { value: v, selected: String(f.value) === v }, l)));
    } else if (f.type === 'checkbox') {
      input = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
    } else {
      input = h('input', { id, name: f.name, type: f.type ?? 'text', value: f.value ?? '', required: !!f.required, autocomplete: 'off', ...(f.suggest?.length ? { list: `${id}-list` } : {}) });
      if (f.suggest?.length) input = h('div', { class: 'with-list' }, input, h('datalist', { id: `${id}-list` }, ...f.suggest.map((x) => h('option', { value: x }))));
    }
    form.append(h('div', { class: 'field' }, h('label', { for: id }, f.label), input, f.hint ? h('small', {}, f.hint) : null));
  }
  form.append(
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Abbrechen'),
      h('button', { class: 'btn primary', value: 'ok' }, submitLabel)),
  );
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      /** @type {Record<string, any>} */
      const out = {};
      for (const f of fields) {
        if (f.type === 'info') continue;
        if (f.type === 'file') {
          out[f.name] = /** @type {HTMLInputElement} */ (form.elements.namedItem(f.name)).files?.[0] ?? null;
          continue;
        }
        if (f.type === 'days') {
          out[f.name] = DAYS.map((_, i) => i).filter((i) => /** @type {HTMLInputElement} */ (form.elements.namedItem(`${f.name}_${i}`)).checked);
          continue;
        }
        const el = /** @type {HTMLInputElement} */ (form.elements.namedItem(f.name));
        out[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
      }
      resolve(out);
    };
    dlg.returnValue = '';
    dlg.showModal();
  });
}

/** Wochentage (0 = Montag) */
export const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export const mediaTitle = (/** @type {any} */ m) => (m ? (m.artist ? `${m.artist} – ${m.title}` : m.title) : '–');

/** Datei im Browser speichern. @param {Blob} blob @param {string} name */
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Icons (eigene Linien-Icons, 24×24, ohne externe Bibliothek) ----------

const ICONS = /** @type {Record<string, string>} */ ({
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  calendar: 'M4 5h16v16H4zM4 9h16M8 3v4M16 3v4',
  record: 'M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  radio: 'M4 10h16v10H4zM7 10l10-6M8 15m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M14 14h4M14 17h4',
  settings: 'M12 15a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3a1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0a3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0a3 3 0 0 1 6 0z',
  mic: 'M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8',
  jingle: 'M9 18V5l12-2v13M6 21a3 3 0 1 0 0-6a3 3 0 0 0 0 6zM18 19a3 3 0 1 0 0-6a3 3 0 0 0 0 6z',
  star: 'M12 2l3.1 6.3l6.9 1l-5 4.9l1.2 6.8L12 17.8L5.8 21l1.2-6.8l-5-4.9l6.9-1z',
  news: 'M4 4h13v16H6a2 2 0 0 1-2-2zM17 8h3v10a2 2 0 0 1-2 2M8 8h5M8 12h5M8 16h3',
  ad: 'M3 11v2a1 1 0 0 0 1 1h3l6 5V5L7 10H4a1 1 0 0 0-1 1zM17 8a5 5 0 0 1 0 8M20 5a9 9 0 0 1 0 14',
  sweeper: 'M3 12c3-6 6-6 9 0s6 6 9 0M3 17c3-4 6-4 9 0',
  tts: 'M4 4h16v12H8l-4 4zM8 9h8M8 12h5',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  id: 'M4 6h16v12H4zM8 10h.01M8 14h8M12 10h4',
  humor: 'M12 22a10 10 0 1 0 0-20a10 10 0 0 0 0 20zM8 14s1.5 2 4 2s4-2 4-2M9 9h.01M15 9h.01',
  event: 'M4 5h16v16H4zM4 9h16M9 14l2 2l4-4',
  voice: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M3 11h1M20 11h1',
  bed: 'M3 18h18M5 18V9h14v9M9 13h6',
  stream: 'M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0M12 12v8',
  play: 'M7 4l13 8l-13 8z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  stop: 'M6 6h12v12H6z',
  prev: 'M6 5v14M19 5l-10 7l10 7z',
  next: 'M18 5v14M5 5l10 7L5 19z',
  eject: 'M5 15h14l-7-10zM5 19h14',
  headphones: 'M3 18v-6a9 9 0 0 1 18 0v6M3 18a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2zM21 18a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  user: 'M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  plus: 'M12 5v14M5 12h14',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  queue: 'M3 6h18M3 12h12M3 18h8M17 15l4 3l-4 3z',
  grid: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  bolt: 'M13 2L3 14h8l-1 8l10-12h-8z',
  cpu: 'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  signal: 'M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16',
  menu: 'M3 6h18M3 12h18M3 18h18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  auto: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  cloud: 'M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z',
  update: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6M12 8v5l3 2',
  lautfm: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2',
});

/** SVG-Icon als Element. @param {string} name @param {number} [size] */
export function icon(name, size = 18) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] ?? ICONS.music);
  svg.append(p);
  return svg;
}

/** Ersetzt alle <i data-icon="name"> im Dokument durch SVG-Icons. @param {ParentNode} [root] */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    const size = Number(/** @type {HTMLElement} */ (el).dataset.size) || 18;
    el.replaceWith(icon(/** @type {HTMLElement} */ (el).dataset.icon ?? 'music', size));
  }
}

/** Kategorie → Icon/Farbe für Cardwall und Schnelltrigger. */
export const CATEGORY_STYLE = /** @type {Record<string, { icon: string, color: string }>} */ ({
  music: { icon: 'music', color: '#1f7ae0' }, jingle: { icon: 'jingle', color: '#e2542b' }, sweeper: { icon: 'sweeper', color: '#6a4de0' },
  station_id: { icon: 'id', color: '#1f9ec2' }, drop: { icon: 'drop', color: '#b43ad6' }, news: { icon: 'news', color: '#5a5ee8' },
  ad: { icon: 'ad', color: '#e0a21f' }, voice_track: { icon: 'voice', color: '#1fae6a' }, tts: { icon: 'tts', color: '#28a3a8' },
  bed: { icon: 'bed', color: '#4b6a8f' }, stream: { icon: 'stream', color: '#c23a6e' },
});
