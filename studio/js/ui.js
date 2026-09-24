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
 * @param {Array<{name:string,label:string,type?:string,value?:any,options?:Array<[string,string]>,hint?:string,required?:boolean}>} fields
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
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, name: f.name, rows: '8', value: f.value ?? '' });
    } else if (f.options) {
      input = h('select', { id, name: f.name }, ...f.options.map(([v, l]) => h('option', { value: v, selected: String(f.value) === v }, l)));
    } else if (f.type === 'checkbox') {
      input = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
    } else {
      input = h('input', { id, name: f.name, type: f.type ?? 'text', value: f.value ?? '', required: !!f.required, autocomplete: 'off' });
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
