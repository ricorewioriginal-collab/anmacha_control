// @ts-check
// Fenster-System fürs Dashboard (Desktop): verschieben, Größe ändern, abdocken (frei schwebend),
// ausblenden, Layout pro Gerät speichern. Auf schmalen Bildschirmen bleibt das mobile Layout.

import { h, icon } from './ui.js';

const KEY = 'airdeck.layout.v1';
const COLS = 12;
const ROW = 44;
const GAP = 12;
const DESKTOP = '(min-width: 1100px)';

/** @typedef {{w:number,h:number,hidden?:boolean,float?:{x:number,y:number,w:number,h:number}|null}} Win */
/** @typedef {{order:string[],wins:Record<string,Win>,locked?:boolean}} Layout */

/** Standard: angelehnt an das bisherige Dashboard */
const DEFAULTS = /** @type {Record<string, Win>} */ ({
  decks: { w: 12, h: 5 },
  carts: { w: 6, h: 6 },
  np: { w: 3, h: 6 },
  stream: { w: 3, h: 4 },
  playout: { w: 3, h: 3 },
  lib: { w: 5, h: 8 },
  queue: { w: 4, h: 8 },
  quick: { w: 3, h: 4 },
  live: { w: 3, h: 4 },
  processing: { w: 3, h: 4 },
  meters: { w: 3, h: 3 },
  sources: { w: 3, h: 6 },
  system: { w: 3, h: 3 },
});

/** Alte Sprungziele der Navigation → Fenster */
export const JUMP_TO_WIN = /** @type {Record<string,string>} */ ({ decks: 'decks', 'carts-panel': 'carts', 'work-panel': 'queue', 'live-panel': 'live' });

function load() {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (l && Array.isArray(l.order) && l.wins) return /** @type {Layout} */ (l);
  } catch {}
  return null;
}

/** @param {HTMLElement} dash */
export function mountLayout(dash) {
  const mq = matchMedia(DESKTOP);
  /** @type {Map<string, {el: HTMLElement, win: HTMLElement, title: string, home: {parent: Node, next: Node|null}}>} */
  const wins = new Map();
  /** @type {Layout} */
  let layout = load() ?? fresh();
  let active = false;
  let z = 50;
  const ws = h('div', { class: 'ws', id: 'ws' });

  function fresh() {
    return { order: Object.keys(DEFAULTS), wins: structuredClone(DEFAULTS), locked: false };
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {}
  }

  /** Fehlende/neue Fenster ergänzen, unbekannte entfernen */
  function normalize() {
    for (const id of wins.keys()) {
      if (!layout.order.includes(id)) layout.order.push(id);
      layout.wins[id] ??= { ...(DEFAULTS[id] ?? { w: 4, h: 5 }) };
    }
    layout.order = layout.order.filter((id) => wins.has(id));
  }

  // Fenster aus dem vorhandenen Markup aufbauen (einmalig)
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (dash.querySelectorAll('[data-win]'))) {
    const id = /** @type {string} */ (el.dataset.win);
    const title = el.dataset.title ?? id;
    const home = { parent: /** @type {Node} */ (el.parentNode), next: el.nextSibling };
    let win = el;
    let head = /** @type {HTMLElement|null} */ (el.querySelector(':scope > .panel-head'));
    if (!head) {
      // Element ohne eigenen Kopf (z. B. Decks) bekommt einen Fensterrahmen
      head = h('div', { class: 'panel-head' }, h('h2', {}, title));
      win = h('section', { class: 'panel win-frame' }, head);
    }
    const tools = h('span', { class: 'win-tools' },
      h('button', { class: 'win-btn', title: 'Abdocken / andocken', 'data-act': 'float' }, icon('grid', 14)),
      h('button', { class: 'win-btn', title: 'Ausblenden (über „Fenster“ wieder einblenden)', 'data-act': 'hide' }, '×'));
    const resize = h('div', { class: 'win-resize', title: 'Größe ändern' });
    wins.set(id, { el, win, title, home: { ...home } });
    win.dataset.id = id;
    Object.assign(win, { _head: head, _tools: tools, _resize: resize });
  }
  normalize();

  function attach() {
    if (active) return;
    active = true;
    dash.classList.add('ws-mode');
    dash.prepend(ws);
    for (const [id, w] of wins) {
      if (w.win !== w.el) w.win.append(w.el);
      const any = /** @type {any} */ (w.win);
      w.win.classList.add('win');
      any._head.classList.add('win-handle');
      any._head.append(any._tools);
      w.win.append(any._resize);
      ws.append(w.win);
      w.win.dataset.id = id;
    }
    render();
  }

  function detach() {
    if (!active) return;
    active = false;
    dash.classList.remove('ws-mode');
    for (const w of wins.values()) {
      const any = /** @type {any} */ (w.win);
      any._tools.remove();
      any._resize.remove();
      any._head.classList.remove('win-handle');
      w.win.classList.remove('win', 'floating');
      w.win.removeAttribute('style');
      w.home.parent.insertBefore(w.el, w.home.next && w.home.next.parentNode === w.home.parent ? w.home.next : null);
    }
    ws.remove();
  }

  function render() {
    if (!active) return;
    ws.classList.toggle('locked', !!layout.locked);
    layout.order.forEach((id, i) => {
      const w = wins.get(id);
      const c = layout.wins[id];
      if (!w || !c) return;
      const s = w.win.style;
      w.win.hidden = !!c.hidden;
      w.win.classList.toggle('floating', !!c.float);
      if (c.float) {
        const f = clampFloat(c.float);
        Object.assign(s, { position: 'fixed', left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px`, gridColumn: '', gridRow: '', order: '' });
      } else {
        Object.assign(s, { position: '', left: '', top: '', width: '', height: '', zIndex: '', gridColumn: `span ${Math.min(COLS, c.w)}`, gridRow: `span ${c.h}`, order: String(i) });
      }
    });
    onChange?.();
  }

  /** @param {{x:number,y:number,w:number,h:number}} f */
  function clampFloat(f) {
    const w = Math.max(220, Math.min(f.w, innerWidth - 20));
    const hh = Math.max(120, Math.min(f.h, innerHeight - 20));
    return { w, h: hh, x: Math.max(0, Math.min(f.x, innerWidth - 80)), y: Math.max(0, Math.min(f.y, innerHeight - 40)) };
  }

  const colWidth = () => (ws.clientWidth - GAP * (COLS - 1)) / COLS;

  // ---------- Interaktion ----------

  ws.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement|null} */ ((/** @type {HTMLElement} */ (e.target)).closest('.win-btn'));
    if (!btn) return;
    const id = /** @type {HTMLElement} */ (btn.closest('.win')).dataset.id ?? '';
    const c = layout.wins[id];
    if (btn.dataset.act === 'hide') c.hidden = true;
    if (btn.dataset.act === 'float') {
      if (c.float) c.float = null;
      else {
        const r = /** @type {HTMLElement} */ (wins.get(id)?.win).getBoundingClientRect();
        c.float = { x: r.left + 24, y: r.top + 24, w: r.width, h: r.height };
      }
    }
    save();
    render();
  });

  ws.addEventListener('pointerdown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const win = /** @type {HTMLElement|null} */ (t.closest('.win'));
    if (!win || e.button !== 0) return;
    if (win.classList.contains('floating')) win.style.zIndex = String(++z);
    if (layout.locked) return;
    const id = win.dataset.id ?? '';
    if (t.classList.contains('win-resize')) return startResize(e, win, id);
    // Ziehen nur über den Titel (nicht über Knöpfe/Eingaben im Kopf)
    if (t.closest('.win-handle') && !t.closest('button, input, select, label, a, .tabs')) startMove(e, win, id);
  });

  /** @param {PointerEvent} e @param {HTMLElement} win @param {string} id */
  function startMove(e, win, id) {
    e.preventDefault();
    const c = layout.wins[id];
    const sx = e.clientX;
    const sy = e.clientY;
    const r = win.getBoundingClientRect();
    /** @type {HTMLElement|null} */
    let target = null;
    let moved = false;
    win.classList.add('dragging');
    const move = (/** @type {PointerEvent} */ ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      if (c.float) {
        const f = clampFloat({ ...c.float, x: r.left + dx, y: r.top + dy });
        win.style.left = `${f.x}px`;
        win.style.top = `${f.y}px`;
        return;
      }
      win.style.transform = `translate(${dx}px, ${dy}px)`;
      win.style.pointerEvents = 'none';
      const over = /** @type {HTMLElement|null} */ (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ws > .win:not(.floating)') ?? null);
      if (target && target !== over) target.classList.remove('drop-before');
      target = over && over !== win ? over : null;
      target?.classList.add('drop-before');
    };
    const up = (/** @type {PointerEvent} */ ev) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      win.classList.remove('dragging');
      win.style.transform = '';
      win.style.pointerEvents = '';
      target?.classList.remove('drop-before');
      if (!moved) return;
      if (c.float) {
        c.float = clampFloat({ ...c.float, x: r.left + ev.clientX - sx, y: r.top + ev.clientY - sy });
      } else if (target) {
        const to = /** @type {string} */ (target.dataset.id);
        layout.order = layout.order.filter((x) => x !== id);
        layout.order.splice(layout.order.indexOf(to), 0, id);
      }
      save();
      render();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** @param {PointerEvent} e @param {HTMLElement} win @param {string} id */
  function startResize(e, win, id) {
    e.preventDefault();
    const c = layout.wins[id];
    const sx = e.clientX;
    const sy = e.clientY;
    const r = win.getBoundingClientRect();
    const col = colWidth();
    const move = (/** @type {PointerEvent} */ ev) => {
      const wpx = r.width + ev.clientX - sx;
      const hpx = r.height + ev.clientY - sy;
      if (c.float) {
        c.float = clampFloat({ ...c.float, w: wpx, h: hpx });
      } else {
        c.w = Math.max(2, Math.min(COLS, Math.round((wpx + GAP) / (col + GAP))));
        c.h = Math.max(2, Math.min(30, Math.round((hpx + GAP) / (ROW + GAP))));
      }
      render();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      save();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** @type {(() => void) | null} */
  let onChange = null;

  const apply = () => (mq.matches ? attach() : detach());
  mq.addEventListener('change', apply);
  addEventListener('resize', () => active && layout.order.some((id) => layout.wins[id]?.float) && render());
  apply();

  return {
    /** Fenster anzeigen, in Sicht bringen und kurz hervorheben */
    focus(/** @type {string} */ id) {
      const w = wins.get(id);
      if (!w) return;
      if (active && layout.wins[id]?.hidden) {
        layout.wins[id].hidden = false;
        save();
        render();
      }
      const el = active ? w.win : w.el;
      if (el.classList.contains('floating')) el.style.zIndex = String(++z);
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    },
    /** Liste für das Fenster-Menü */
    list: () => [...wins].map(([id, w]) => ({ id, title: w.title, hidden: !!layout.wins[id]?.hidden, float: !!layout.wins[id]?.float })),
    toggle(/** @type {string} */ id, /** @type {boolean} */ show) {
      layout.wins[id].hidden = !show;
      save();
      render();
    },
    get locked() {
      return !!layout.locked;
    },
    lock(/** @type {boolean} */ on) {
      layout.locked = on;
      save();
      render();
    },
    reset() {
      layout = fresh();
      normalize();
      save();
      render();
    },
    get active() {
      return active;
    },
    set onChange(/** @type {(() => void) | null} */ fn) {
      onChange = fn;
    },
  };
}
