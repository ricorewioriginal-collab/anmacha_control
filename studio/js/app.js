// @ts-check
// AirDeck Studio – Oberfläche: 4 Decks, Cardwall, Archiv, Queue, Quellen, Ausgänge, Automation.
// Sämtlicher Nutzerinhalt wird per textContent gesetzt (kein innerHTML) → kein XSS.

import { Api, ApiError, readToken, saveToken } from './api.js';
import { AudioEngine, DECKS, SilenceDetector } from './audio.js';

const CATEGORY_LABEL = /** @type {Record<string,string>} */ ({
  music: 'Musik', jingle: 'Jingle', sweeper: 'Sweeper', station_id: 'Station ID', drop: 'Drop', news: 'News',
  ad: 'Werbung', voice_track: 'Voice Track', tts: 'TTS', bed: 'Bed',
});
const SOURCE_TYPES = /** @type {Record<string,string>} */ ({
  live_studio: 'Live Studio', remote_studio: 'Remote Studio', mobile: 'Android/Mobil', automation: 'Automation',
  backup_automation: 'Backup Automation', emergency: 'Emergency', relay: 'Relay', url_stream: 'URL Stream',
});
const STATE_LABEL = /** @type {Record<string,string>} */ ({
  disconnected: 'getrennt', connecting: 'verbindet', standby: 'standby', takeover_pending: 'wartet', taking_over: 'übernimmt',
  active: 'on air', blocked: 'gesperrt', failed: 'ausgefallen', fallback: 'fallback',
});
const DUCK_CATEGORIES = new Set(['voice_track', 'tts', 'news', 'ad']);
const AUTO_DECKS = ['A', 'B'];
const DEFAULT_MIX_MS = 3000;

/** Überblendzeit: explizites Segue, sonst 3 s für Musik; Jingles & Co. laufen aus. @param {any} m @param {number} durMs */
function mixMs(m, durMs) {
  const base = m?.segueMs ?? (m?.category === 'music' ? DEFAULT_MIX_MS : 0);
  return Math.min(base, durMs > 0 ? durMs / 2 : base);
}
const MIME = { MEDIA: 'application/x-airdeck-media', QUEUE: 'application/x-airdeck-queue' };

/** @type {Api} */
let api;
/** @type {AudioEngine|null} */
let audio = null;
const S = {
  /** @type {any[]} */ stations: [],
  /** @type {any} */ station: null,
  /** @type {any[]} */ library: [],
  /** @type {Map<string, any>} */ libById: new Map(),
  /** @type {any} */ queue: { items: [], autoFill: true, totalMs: 0 },
  /** @type {any[]} */ carts: [],
  /** @type {any[]} */ sources: [],
  /** @type {any[]} */ outputs: [],
  /** @type {any} */ nowPlaying: null,
  cartGroup: 'Alle',
  auto: false,
  streaming: false,
  busyNext: false,
  /** @type {string|null} */ lastAutoDeck: null,
};
const silence = new SilenceDetector(-50, 10_000);

// ---------- DOM-Helfer ----------

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node|string|null|undefined|false)} children
 */
function h(tag, attrs = {}, ...children) {
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
function fmt(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** @param {number} at */
function clockTime(at) {
  return new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** @param {string} msg @param {boolean} [err] */
function status(msg, err = false) {
  const el = $('status-text');
  el.textContent = `${new Date().toLocaleTimeString('de-DE')} · ${msg}`;
  el.classList.toggle('err', err);
}

/** @param {() => Promise<any>} fn */
async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    status(e instanceof Error ? e.message : String(e), true);
    return undefined;
  }
}

const sid = () => encodeURIComponent(S.station.id);
const url = (/** @type {string} */ p) => `/stations/${sid()}${p}`;
const mediaTitle = (/** @type {any} */ m) => (m ? (m.artist ? `${m.artist} – ${m.title}` : m.title) : '–');

// ---------- Dialoge ----------

/**
 * @param {string} title
 * @param {Array<{name:string,label:string,type?:string,value?:any,options?:Array<[string,string]>,hint?:string,required?:boolean}>} fields
 * @param {string} [submitLabel]
 * @returns {Promise<Record<string, any>|null>}
 */
function formDialog(title, fields, submitLabel = 'Speichern') {
  const dlg = /** @type {HTMLDialogElement} */ ($('dialog'));
  const form = /** @type {HTMLFormElement} */ ($('dialog-form'));
  form.replaceChildren(h('h3', {}, title));
  for (const f of fields) {
    const id = `f-${f.name}`;
    /** @type {HTMLElement} */
    let input;
    if (f.options) {
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
        const el = /** @type {HTMLInputElement} */ (form.elements.namedItem(f.name));
        out[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
      }
      resolve(out);
    };
    dlg.returnValue = '';
    dlg.showModal();
  });
}

// ---------- Start ----------

async function boot() {
  const token = readToken();
  if (!token) return askToken();
  api = new Api(token);
  try {
    await api.get('/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return askToken('Token ungültig.');
    status('Server nicht erreichbar – neuer Versuch in 3 s', true);
    setTimeout(boot, 3000);
    return;
  }
  S.stations = await api.get('/stations');
  const saved = localStorage.getItem('airdeck.station');
  S.station = S.stations.find((s) => s.id === saved) ?? S.stations[0];
  if (!S.station) return status('Kein Sender verfügbar', true);
  renderStationSelect();
  buildDecks();
  bindStatic();
  await loadStation();
  setInterval(tick, 200);
  setInterval(clock, 1000);
  clock();
}

/** @param {string} [msg] */
async function askToken(msg) {
  const v = await formDialog('AirDeck anmelden', [
    { name: 'token', label: 'API-Token', type: 'password', required: true, hint: msg ?? 'Das Token wird beim ersten Serverstart in der Konsole angezeigt.' },
  ], 'Anmelden');
  if (!v?.token) return;
  saveToken(v.token.trim());
  location.reload();
}

/** @type {EventSource|null} */
let es = null;

async function loadStation() {
  localStorage.setItem('airdeck.station', S.station.id);
  applyBranding();
  const [library, queue, carts, sources, outputs, np] = await Promise.all([
    api.get(url('/media')), api.get(url('/queue')), api.get(url('/cardwall')),
    api.get(url('/sources')), api.get(url('/outputs')), api.get(url('/now-playing')),
  ]);
  setLibrary(library);
  S.queue = queue;
  S.carts = carts;
  S.sources = sources;
  S.outputs = outputs;
  S.nowPlaying = np;
  renderAll();
  es?.close();
  es = api.events(S.station.id, onEvent, (ok) => $('conn').classList.toggle('ok', ok));
}

/** @param {any[]} list */
function setLibrary(list) {
  S.library = list;
  S.libById = new Map(list.map((m) => [m.id, m]));
  probeDurations();
}

let probing = false;
/** Ermittelt fehlende Laufzeiten über Audio-Metadaten, ein Titel nach dem anderen. */
async function probeDurations() {
  if (probing) return;
  probing = true;
  try {
    for (const m of S.library.filter((x) => x.durationMs == null)) {
      const ms = await new Promise((resolve) => {
        const el = new Audio();
        el.preload = 'metadata';
        const done = (/** @type {number|null} */ v) => { el.removeAttribute('src'); el.load(); resolve(v); };
        el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null);
        el.onerror = () => done(null);
        setTimeout(() => done(null), 10_000);
        el.src = api.mediaUrl(S.station.id, m.id);
      });
      if (ms && ms > 0) {
        m.durationMs = ms;
        await run(() => api.patch(url(`/media/${encodeURIComponent(m.id)}`), { durationMs: ms }));
      }
    }
  } finally {
    probing = false;
  }
}

/** @param {string} type @param {any} data */
function onEvent(type, data) {
  switch (type) {
    case 'sources.changed':
      // Server liefert Engine-Sicht; Relay-/Passwortinfos einmal nachladen
      run(async () => { S.sources = await api.get(url('/sources')); renderSources(); });
      break;
    case 'queue.changed': S.queue = data; renderQueue(); renderNowPlaying(); break;
    case 'now_playing.changed': S.nowPlaying = { ...S.nowPlaying, ...data }; renderNowPlaying(); break;
    case 'library.changed': run(async () => { setLibrary(await api.get(url('/media'))); renderLibrary(); renderCarts(); }); break;
    case 'cardwall.changed': S.carts = data; renderCarts(); break;
    case 'cardwall.triggered': playCart(data); break; // Fernauslösung (z. B. Android/API)
    case 'stream.state_changed': {
      const o = S.outputs.find((x) => x.id === data.id);
      if (o) { o.state = data; renderOutputs(); }
      break;
    }
    case 'station.changed': S.station = data; applyBranding(); renderStationSelect(); break;
    case 'source.takeover_completed': status(`Übernahme: ${sourceName(data.sourceId)} ist auf Sendung (Priority ${data.data?.priority ?? '?'})`); break;
    case 'source.takeover_rejected': status(`Übernahme abgelehnt: ${data.data?.reason ?? ''}`, true); break;
    case 'source.off_air': status('OFF AIR – keine Fallback-Quelle verfügbar', true); break;
    case 'source.source_failed': status(`Quelle ausgefallen: ${sourceName(data.sourceId)} (${data.data?.reason ?? ''})`, true); break;
  }
}

/** @param {string} id */
const sourceName = (id) => S.sources.find((s) => s.id === id)?.name ?? id;

function applyBranding() {
  const r = document.documentElement.style;
  r.setProperty('--primary', S.station.primaryColor);
  r.setProperty('--accent', S.station.accentColor);
  $('station-slogan').textContent = S.station.slogan || S.station.name;
  document.title = `${S.station.name} · AirDeck Studio`;
}

function renderStationSelect() {
  const sel = /** @type {HTMLSelectElement} */ ($('station-select'));
  sel.replaceChildren(...S.stations.map((s) => h('option', { value: s.id, selected: s.id === S.station.id }, s.id === S.station.id ? S.station.name : s.name)));
}

function renderAll() {
  renderLibrary();
  renderQueue();
  renderCarts();
  renderSources();
  renderOutputs();
  renderNowPlaying();
  /** @type {HTMLInputElement} */ ($('chk-autofill')).checked = !!S.queue.autoFill;
}

// ---------- Audio ----------

function ensureAudio() {
  if (!audio) {
    audio = new AudioEngine();
    for (const id of DECKS) audio.decks[id].onEnded = (d) => onDeckEnded(d.id);
  }
  return audio;
}

/** @param {string} deckId @param {any} media */
function loadDeck(deckId, media) {
  const a = ensureAudio();
  const d = a.decks[deckId];
  d.load(media, api.mediaUrl(S.station.id, media.id));
  // Dauer beim ersten Laden ermitteln und im Archiv speichern
  if (media.durationMs == null) {
    d.el.addEventListener('loadedmetadata', () => {
      const ms = Math.round(d.el.duration * 1000);
      if (Number.isFinite(ms) && ms > 0) run(() => api.patch(url(`/media/${encodeURIComponent(media.id)}`), { durationMs: ms }));
    }, { once: true });
  }
  run(() => api.put(url(`/decks/${deckId}`), { mediaId: media.id, status: 'cued' }));
  renderDeck(deckId);
}

/** @param {string} deckId */
async function playDeck(deckId) {
  const d = ensureAudio().decks[deckId];
  if (!d.media) return;
  try {
    await d.play();
  } catch (e) {
    status(`Deck ${deckId}: Wiedergabe fehlgeschlagen (${e instanceof Error ? e.message : e})`, true);
    return;
  }
  run(() => api.put(url(`/decks/${deckId}`), { status: 'playing' }));
  run(() => api.post(url('/now-playing'), { mediaId: d.media.id, deck: deckId }));
  renderDeck(deckId);
}

/** @param {string} deckId */
function onDeckEnded(deckId) {
  run(() => api.put(url(`/decks/${deckId}`), { status: 'cued' }));
  renderDeck(deckId);
  if (S.auto && !AUTO_DECKS.some((id) => audio?.decks[id].playing)) autoNext();
}

/** Automation: nächsten Titel laden und mit Crossfade starten. */
async function autoNext() {
  if (S.busyNext) return;
  S.busyNext = true;
  try {
    const a = ensureAudio();
    const current = AUTO_DECKS.find((id) => a.decks[id].playing);
    const target = current ? AUTO_DECKS.find((id) => id !== current) : AUTO_DECKS.find((id) => id !== S.lastAutoDeck) ?? 'A';
    const res = await api.post(url('/queue/next'));
    if (!res?.media) {
      status('Automation: Queue und Sendeuhr liefern keinen Titel', true);
      return;
    }
    loadDeck(/** @type {string} */ (target), res.media);
    await playDeck(/** @type {string} */ (target));
    S.lastAutoDeck = target ?? null;
    if (current) {
      const old = a.decks[current];
      old.fadeOut(Math.max(0.05, Math.min(mixMs(old.media, old.durationMs), old.remainingMs)) / 1000);
    }
  } catch (e) {
    status(`Automation: ${e instanceof Error ? e.message : e}`, true);
  } finally {
    S.busyNext = false;
  }
}

/** @param {any} cart */
async function playCart(cart) {
  const m = cart.mediaId ? S.libById.get(cart.mediaId) : null;
  if (!m) return;
  const a = ensureAudio();
  const duck = /** @type {HTMLInputElement} */ ($('chk-duck')).checked || DUCK_CATEGORIES.has(m.category);
  const btn = document.querySelector(`[data-cart="${CSS.escape(cart.id)}"]`);
  try {
    const el = await a.playCart(api.mediaUrl(S.station.id, m.id), duck);
    btn?.classList.add('playing');
    el.addEventListener('ended', () => btn?.classList.remove('playing'), { once: true });
  } catch (e) {
    status(`Cart: ${e instanceof Error ? e.message : e}`, true);
  }
}

// ---------- Streaming (Studio als Automation-Quelle) ----------

function automationSource() {
  return S.sources.find((s) => s.type === 'automation' && s.target === '/live') ?? S.sources.find((s) => s.type === 'automation');
}

async function toggleStream() {
  const btn = $('btn-stream');
  if (S.streaming) {
    audio?.stopStream();
    S.streaming = false;
    btn.setAttribute('aria-pressed', 'false');
    const src = automationSource();
    if (src) await run(() => api.post(url(`/sources/${encodeURIComponent(src.id)}/release`)));
    status('Studio-Stream beendet');
    return;
  }
  const src = automationSource();
  if (!src) return status('Keine Automation-Quelle konfiguriert', true);
  const a = ensureAudio();
  await a.resume();
  try {
    a.startStream(async (blob, first, type) => {
      await api.req('POST', url(`/sources/${encodeURIComponent(src.id)}/chunks${first ? '?start=1' : ''}`), blob, { 'Content-Type': type });
    });
  } catch (e) {
    return status(e instanceof Error ? e.message : String(e), true);
  }
  S.streaming = true;
  btn.setAttribute('aria-pressed', 'true');
  status(`Studio-Stream aktiv als „${src.name}“ (Priority ${src.priority})`);
}

// ---------- Render: Decks ----------

/** @type {Record<string, Record<string, HTMLElement>>} */
const deckEls = {};

function buildDecks() {
  const root = $('decks');
  for (const id of DECKS) {
    const els = {
      title: h('div', { class: 'deck-title' }),
      artist: h('div', { class: 'deck-artist' }),
      status: h('span', { class: 'deck-status' }, 'leer'),
      elapsed: h('span', { class: 'muted' }, '0:00'),
      remain: h('span', { class: 'deck-remain' }, '--:--'),
      bar: h('i'),
      meter: h('i'),
      play: h('button', { class: 'deck-btn play', title: 'Play/Pause', 'aria-pressed': 'false', onclick: () => togglePlay(id) }, '▶'),
    };
    const progress = h('div', { class: 'progress', title: 'Klicken zum Springen', onclick: (/** @type {MouseEvent} */ e) => seek(id, e) }, els.bar);
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '1', 'aria-label': `Deck ${id} Lautstärke`, oninput: (/** @type {Event} */ e) => ensureAudio().decks[id].setVolume(Number(/** @type {HTMLInputElement} */ (e.target).value)) });
    const card = h('div', { class: 'deck', 'data-status': 'empty' },
      h('div', { class: 'deck-head' }, h('span', { class: 'deck-id' }, `Deck ${id}`), els.status),
      els.title, els.artist,
      h('div', { class: 'deck-time' }, els.elapsed, els.remain),
      progress,
      h('div', { class: 'mini-meter' }, els.meter),
      h('div', { class: 'deck-ctrl' },
        els.play,
        h('button', { class: 'deck-btn', title: 'Stop', onclick: () => { ensureAudio().decks[id].stop(); run(() => api.put(url(`/decks/${id}`), { status: 'cued' })); renderDeck(id); } }, '■'),
        h('button', { class: 'deck-btn', title: 'Nächster Titel aus Queue laden', onclick: () => loadFromQueue(id) }, '⭳'),
        h('button', { class: 'deck-btn', title: 'Auswerfen', onclick: () => { ensureAudio().decks[id].eject(); run(() => api.put(url(`/decks/${id}`), { mediaId: null, status: 'empty' })); renderDeck(id); } }, '⏏'),
        vol),
    );
    dropTarget(card, (dt) => {
      const mid = dt.getData(MIME.MEDIA);
      const m = mid && S.libById.get(mid);
      if (m) loadDeck(id, m);
    });
    els.card = card;
    deckEls[id] = els;
    root.append(card);
  }
}

/** @param {string} id */
async function togglePlay(id) {
  const d = ensureAudio().decks[id];
  if (d.playing) {
    d.pause();
    run(() => api.put(url(`/decks/${id}`), { status: 'paused' }));
    renderDeck(id);
  } else await playDeck(id);
}

/** @param {string} id */
async function loadFromQueue(id) {
  const res = await run(() => api.post(url('/queue/next')));
  if (res?.media) loadDeck(id, res.media);
  else if (res) status('Queue ist leer', true);
}

/** @param {string} id @param {MouseEvent} e */
function seek(id, e) {
  const d = audio?.decks[id];
  if (!d?.media || !d.durationMs) return;
  const rect = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
  d.el.currentTime = (((e.clientX - rect.left) / rect.width) * d.durationMs) / 1000;
}

/** @param {any} d */
function deckStatus(d) {
  if (!d?.media) return 'empty';
  if (d.playing) return 'playing';
  return !d.el.ended && d.positionMs > (d.media.cueInMs ?? 0) + 50 ? 'paused' : 'cued';
}

/** @param {string} id */
function renderDeck(id) {
  const els = deckEls[id];
  const d = audio?.decks[id];
  const m = d?.media;
  const st = deckStatus(d);
  els.card.dataset.status = st;
  els.status.textContent = { empty: 'leer', playing: 'on air', paused: 'pause', cued: 'bereit' }[st] ?? st;
  els.title.textContent = m?.title ?? '–';
  els.artist.textContent = m ? `${m.artist || CATEGORY_LABEL[m.category] || ''}` : '';
  els.play.setAttribute('aria-pressed', String(st === 'playing'));
  els.play.textContent = st === 'playing' ? '❚❚' : '▶';
}

// ---------- Render: Cardwall ----------

function renderCarts() {
  const groups = ['Alle', ...new Set(S.carts.map((c) => c.group))];
  $('cart-groups').replaceChildren(...groups.map((g) => h('button', {
    'aria-pressed': String(g === S.cartGroup), onclick: () => { S.cartGroup = g; renderCarts(); },
  }, g)));
  const list = S.carts.filter((c) => S.cartGroup === 'Alle' || c.group === S.cartGroup);
  $('carts').replaceChildren(...list.map((c) => {
    const m = c.mediaId ? S.libById.get(c.mediaId) : null;
    const el = h('div', {
      class: `cart${m ? '' : ' empty'}`, style: m ? `--c:${c.color}` : '', role: 'button', tabindex: '0', 'data-cart': c.id,
      draggable: m ? 'true' : null,
      title: m ? `${mediaTitle(m)} (${fmt(m.durationMs)})` : 'Titel hierher ziehen',
      onclick: () => (m ? playCart(c) : undefined),
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playCart(c); } },
      ondragstart: (/** @type {DragEvent} */ e) => m && e.dataTransfer?.setData(MIME.MEDIA, m.id),
    },
      h('span', { class: 'cart-label' }, c.label),
      h('span', { class: 'cart-sub' }, m ? `${m.title} · ${fmt(m.durationMs)}` : 'leer'),
      h('button', { class: 'cart-edit', title: 'Cart bearbeiten', onclick: (/** @type {Event} */ e) => { e.stopPropagation(); editCart(c); } }, '⋯'),
    );
    dropTarget(el, (dt) => {
      const mid = dt.getData(MIME.MEDIA);
      if (mid) run(() => api.patch(url(`/cardwall/${encodeURIComponent(c.id)}`), { mediaId: mid, label: S.libById.get(mid)?.title?.slice(0, 40) ?? c.label }));
    });
    return el;
  }));
}

/** @param {any} c */
async function editCart(c) {
  const v = await formDialog(`Cart bearbeiten`, [
    { name: 'label', label: 'Beschriftung', value: c.label },
    { name: 'group', label: 'Gruppe', value: c.group },
    { name: 'color', label: 'Farbe', type: 'color', value: c.color },
    { name: 'clear', label: 'Titel entfernen', type: 'checkbox', value: false },
  ]);
  if (!v) return;
  await run(() => api.patch(url(`/cardwall/${encodeURIComponent(c.id)}`), { label: v.label, group: v.group, color: v.color, ...(v.clear ? { mediaId: null } : {}) }));
}

// ---------- Render: Archiv ----------

function renderLibrary() {
  const q = /** @type {HTMLInputElement} */ ($('lib-search')).value.trim().toLowerCase();
  const cat = /** @type {HTMLSelectElement} */ ($('lib-cat')).value;
  const list = S.library
    .filter((m) => (!cat || m.category === cat) && (!q || `${m.title} ${m.artist}`.toLowerCase().includes(q)))
    .slice(0, 500);
  $('lib-empty').hidden = S.library.length > 0;
  $('lib-body').replaceChildren(...list.map((m) => h('tr', {
    draggable: 'true',
    ondragstart: (/** @type {DragEvent} */ e) => e.dataTransfer?.setData(MIME.MEDIA, m.id),
    ondblclick: () => run(() => api.post(url('/queue'), { mediaId: m.id })),
    title: 'Doppelklick: in Queue · Ziehen: auf Deck, Cart oder Queue',
  },
    h('td', {}, m.title), h('td', {}, m.artist), h('td', {}, h('span', { class: 'tag' }, CATEGORY_LABEL[m.category] ?? m.category)),
    h('td', { class: 'num' }, fmt(m.durationMs)),
    h('td', { class: 'act' },
      h('button', { title: 'In Queue', onclick: () => run(() => api.post(url('/queue'), { mediaId: m.id })) }, '＋'),
      h('button', { title: 'Bearbeiten', onclick: () => editMedia(m) }, '✎'),
      h('button', { title: 'Löschen', onclick: () => confirm(`„${m.title}“ löschen?`) && run(() => api.del(url(`/media/${encodeURIComponent(m.id)}`))) }, '✕')),
  )));
}

/** @param {any} m */
async function editMedia(m) {
  const v = await formDialog('Titel bearbeiten', [
    { name: 'title', label: 'Titel', value: m.title },
    { name: 'artist', label: 'Interpret', value: m.artist },
    { name: 'category', label: 'Kategorie', value: m.category, options: Object.entries(CATEGORY_LABEL) },
    { name: 'cueInMs', label: 'Cue-In (ms)', type: 'number', value: m.cueInMs ?? '' },
    { name: 'segueMs', label: 'Überblendung vor Ende (ms)', type: 'number', value: m.segueMs ?? '', hint: `Standard: ${DEFAULT_MIX_MS} ms` },
    { name: 'gainDb', label: 'Gain (dB)', type: 'number', value: m.gainDb ?? '' },
  ]);
  if (v) await run(() => api.patch(url(`/media/${encodeURIComponent(m.id)}`), v));
}

/** @param {FileList|File[]} files */
async function upload(files) {
  const cat = /** @type {HTMLSelectElement} */ ($('lib-cat')).value || 'music';
  let ok = 0;
  for (const f of files) {
    status(`Upload: ${f.name} …`);
    const r = await run(() => api.req('PUT', url(`/media?name=${encodeURIComponent(f.name)}&category=${cat}`), f, { 'Content-Type': 'application/octet-stream' }));
    if (r) ok++;
  }
  status(`${ok} von ${files.length} Datei(en) hochgeladen`, ok < files.length);
}

// ---------- Render: Queue ----------

function renderQueue() {
  const items = S.queue.items ?? [];
  $('queue-empty').hidden = items.length > 0;
  $('queue-total').textContent = items.length ? `${items.length} · ${fmt(S.queue.totalMs)}` : '';
  $('queue-body').replaceChildren(...items.map((/** @type {any} */ q, /** @type {number} */ i) => {
    const row = h('tr', {
      draggable: 'true',
      ondragstart: (/** @type {DragEvent} */ e) => e.dataTransfer?.setData(MIME.QUEUE, q.uid),
    },
      h('td', { class: 'num muted' }, q.known === false ? '~' + clockTime(q.startsAt) : clockTime(q.startsAt)),
      h('td', {}, mediaTitle(q.media), ' ', q.origin === 'clock' ? h('span', { class: 'tag' }, 'Uhr') : null),
      h('td', { class: 'num' }, fmt(q.media?.durationMs)),
      h('td', { class: 'act' }, h('button', { title: 'Entfernen', onclick: () => run(() => api.del(url(`/queue/${encodeURIComponent(q.uid)}`))) }, '✕')),
    );
    dropTarget(row, (dt) => queueDrop(dt, i), true);
    return row;
  }));
}

/** @param {DataTransfer} dt @param {number} index */
function queueDrop(dt, index) {
  const uid = dt.getData(MIME.QUEUE);
  const mid = dt.getData(MIME.MEDIA);
  if (uid) run(() => api.post(url(`/queue/${encodeURIComponent(uid)}/move`), { index }));
  else if (mid) run(() => api.post(url('/queue'), { mediaId: mid, index }));
}

// ---------- Render: Quellen / Ausgänge / Now Playing ----------

function renderSources() {
  const active = S.sources.find((s) => s.state === 'active' && s.target === '/live') ?? S.sources.find((s) => s.state === 'active');
  const onair = $('onair');
  onair.dataset.state = !active ? 'off' : ['live_studio', 'remote_studio', 'mobile'].includes(active.type) ? 'live' : 'on';
  $('onair-text').textContent = active ? `${active.type === 'automation' ? 'AUTO' : 'LIVE'} • PRIORITY ${active.priority} · ${active.name}` : 'OFF AIR';

  $('sources').replaceChildren(...S.sources.map((s) => h('li', { class: `src${s.state === 'active' ? ' active' : ''}` },
    h('span', { class: 'prio', title: 'Priorität (kleiner = wichtiger)' }, `P${s.priority}`),
    h('span', { class: 'src-name' }, s.name, ' ', h('span', { class: `pill ${s.state}` }, STATE_LABEL[s.state] ?? s.state)),
    h('span', { class: 'src-actions' },
      ['standby', 'takeover_pending'].includes(s.state) ? h('button', { class: 'btn small', title: 'Übernehmen', onclick: () => takeover(s) }, 'Übern.') : null,
      s.state === 'active' ? h('button', { class: 'btn small', title: 'Freigeben', onclick: () => run(() => api.post(url(`/sources/${encodeURIComponent(s.id)}/release`))) }, 'Freig.') : null,
      h('button', { class: 'btn small', title: 'Bearbeiten', onclick: () => editSource(s) }, '⋯')),
    h('span', { class: 'src-meta' }, `${SOURCE_TYPES[s.type] ?? s.type} · ${s.target}${s.hasPassword ? '' : ' · kein Passwort'}${s.takeoverPolicy !== 'auto' ? ` · ${s.takeoverPolicy}` : ''}`),
  )));
}

/** @param {any} s */
async function takeover(s) {
  const r = await run(() => api.post(url(`/sources/${encodeURIComponent(s.id)}/takeover`), {}));
  if (r === undefined && confirm('Übernahme nach Prioritätsregeln abgelehnt. Als Operator-Override erzwingen?')) {
    await run(() => api.post(url(`/sources/${encodeURIComponent(s.id)}/takeover`), { force: true }));
  }
}

/** @param {any} [s] */
async function editSource(s) {
  const isNew = !s;
  const v = await formDialog(isNew ? 'Quelle anlegen' : `Quelle: ${s.name}`, [
    { name: 'name', label: 'Name', value: s?.name ?? '', required: true },
    { name: 'type', label: 'Typ', value: s?.type ?? 'remote_studio', options: Object.entries(SOURCE_TYPES) },
    { name: 'priority', label: 'Priorität', type: 'number', value: s?.priority ?? 5, required: true, hint: 'Positive Ganzzahl – 1 ist die höchste Priorität' },
    { name: 'target', label: 'Target / Mountpoint', value: s?.target ?? '/live' },
    { name: 'takeoverPolicy', label: 'Übernahme', value: s?.takeoverPolicy ?? 'auto', options: [['auto', 'automatisch'], ['manual', 'nur manuell'], ['never', 'nie']] },
    { name: 'password', label: 'Encoder-Passwort (neu setzen)', type: 'password', value: '', hint: 'Mind. 8 Zeichen. Encoder: PUT/SOURCE auf /ingest/<sender>/<mount>, Benutzer = Quellen-ID' },
    ...(isNew ? [] : [{ name: 'blocked', label: 'Gesperrt', type: 'checkbox', value: !!s.blocked }, { name: 'remove', label: 'Quelle löschen', type: 'checkbox', value: false }]),
  ]);
  if (!v) return;
  if (v.remove) return run(() => api.del(url(`/sources/${encodeURIComponent(s.id)}`)));
  const body = { name: v.name, type: v.type, priority: v.priority, target: v.target, takeoverPolicy: v.takeoverPolicy, ...(isNew ? {} : { blocked: v.blocked }) };
  const saved = await run(() => (isNew ? api.post(url('/sources'), body) : api.patch(url(`/sources/${encodeURIComponent(s.id)}`), body)));
  if (saved && v.password) await run(() => api.post(url(`/sources/${encodeURIComponent(saved.id)}/password`), { password: v.password }));
  if (saved) status(`Quelle gespeichert. Encoder-Benutzer: ${saved.id}`);
}

function renderOutputs() {
  $('outputs').replaceChildren(...(S.outputs.length ? S.outputs.map((o) => h('li', { class: 'out' },
    h('span', { class: `pill ${o.state?.status ?? 'idle'}` }, o.state?.status ?? 'idle'),
    h('span', { class: 'out-name' }, o.name),
    h('button', { class: 'btn small', onclick: () => editOutput(o) }, '⋯'),
    h('span', { class: 'out-meta' },
      `${o.type} · ${o.host}:${o.port}${o.mount}${o.priority ? `?prio=${o.priority}` : ''}` +
      (o.state?.error ? ` · ${o.state.error}` : o.state?.bytesSent ? ` · ${(o.state.bytesSent / 1048576).toFixed(1)} MB` : '')),
  )) : [h('li', { class: 'muted' }, 'Kein Ausgang – ＋ für Icecast/laut.fm')]));
}

/** @param {any} [o] */
async function editOutput(o) {
  const isNew = !o;
  const v = await formDialog(isNew ? 'Ausgang anlegen' : `Ausgang: ${o.name}`, [
    { name: 'name', label: 'Name', value: o?.name ?? 'Hauptstream', required: true },
    { name: 'type', label: 'Typ', value: o?.type ?? 'icecast', options: [['icecast', 'Icecast (HTTP PUT)'], ['shoutcast', 'SHOUTcast (noch nicht unterstützt)']] },
    { name: 'host', label: 'Host', value: o?.host ?? '', required: true },
    { name: 'port', label: 'Port', type: 'number', value: o?.port ?? 8000 },
    { name: 'mount', label: 'Mountpoint', value: o?.mount ?? '/stream' },
    { name: 'username', label: 'Benutzer', value: o?.username ?? 'source' },
    { name: 'password', label: isNew ? 'Passwort' : 'Passwort (leer = unverändert)', type: 'password', value: '' },
    { name: 'priority', label: 'Priority-Parameter (optional)', type: 'number', value: o?.priority ?? '', hint: 'Hängt ?prio=<n> an den Mountpoint an (z. B. laut.fm). Leer = aus.' },
    { name: 'tls', label: 'TLS (https)', type: 'checkbox', value: !!o?.tls },
    { name: 'enabled', label: 'Aktiv', type: 'checkbox', value: o?.enabled ?? true },
    ...(isNew ? [] : [{ name: 'remove', label: 'Ausgang löschen', type: 'checkbox', value: false }]),
  ]);
  if (!v) return;
  if (v.remove) {
    await run(() => api.del(url(`/outputs/${encodeURIComponent(o.id)}`)));
  } else {
    /** @type {Record<string, any>} */
    const body = { ...v, priority: v.priority ?? null };
    delete body.remove;
    if (!body.password) delete body.password;
    await run(() => (isNew ? api.post(url('/outputs'), body) : api.patch(url(`/outputs/${encodeURIComponent(o.id)}`), body)));
  }
  S.outputs = (await run(() => api.get(url('/outputs')))) ?? S.outputs;
  renderOutputs();
}

function renderNowPlaying() {
  const m = S.nowPlaying?.media;
  $('np-title').textContent = m?.title ?? '–';
  $('np-artist').textContent = m?.artist ?? '';
  const next = S.queue.items?.[0]?.media;
  $('np-next').textContent = next ? mediaTitle(next) : '–';
}

// ---------- Drag & Drop ----------

/** @param {HTMLElement} el @param {(dt: DataTransfer) => void} onDrop @param {boolean} [row] */
function dropTarget(el, onDrop, row = false) {
  const cls = row ? 'drop-before' : 'drop';
  el.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (types.includes(MIME.MEDIA) || types.includes(MIME.QUEUE)) {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add(cls);
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove(cls));
  el.addEventListener('drop', (e) => {
    el.classList.remove(cls);
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(e.dataTransfer);
  });
}

// ---------- Statische Bindungen ----------

function bindStatic() {
  const cat = /** @type {HTMLSelectElement} */ ($('lib-cat'));
  cat.replaceChildren(h('option', { value: '' }, 'Alle'), ...Object.entries(CATEGORY_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  $('lib-search').addEventListener('input', renderLibrary);
  cat.addEventListener('change', renderLibrary);
  $('lib-upload').addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (input.files?.length) upload([...input.files]).finally(() => (input.value = ''));
  });
  const libDrop = $('lib-drop');
  libDrop.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); libDrop.classList.add('drop'); }
  });
  libDrop.addEventListener('dragleave', () => libDrop.classList.remove('drop'));
  libDrop.addEventListener('drop', (e) => {
    libDrop.classList.remove('drop');
    if (e.dataTransfer?.files.length) { e.preventDefault(); upload([...e.dataTransfer.files]); }
  });
  dropTarget($('queue-drop'), (dt) => queueDrop(dt, S.queue.items?.length ?? 0));

  $('btn-fill').addEventListener('click', () => run(() => api.post(url('/queue/fill'))));
  $('btn-clear').addEventListener('click', () => confirm('Queue leeren?') && run(() => api.post(url('/queue/clear'))));
  $('chk-autofill').addEventListener('change', (e) => run(() => api.patch(url('/automation'), { autoFill: /** @type {HTMLInputElement} */ (e.target).checked })));
  $('btn-auto').addEventListener('click', async () => {
    S.auto = !S.auto;
    $('btn-auto').setAttribute('aria-pressed', String(S.auto));
    status(S.auto ? 'Automation EIN' : 'Automation AUS');
    if (S.auto) {
      await ensureAudio().resume();
      if (!AUTO_DECKS.some((id) => audio?.decks[id].playing)) autoNext();
    }
  });
  $('btn-stream').addEventListener('click', toggleStream);
  $('btn-add-source').addEventListener('click', () => editSource());
  $('btn-add-output').addEventListener('click', () => editOutput());
  $('btn-station').addEventListener('click', editStation);
  $('station-select').addEventListener('change', async (e) => {
    const id = /** @type {HTMLSelectElement} */ (e.target).value;
    S.station = S.stations.find((s) => s.id === id);
    await run(loadStation);
  });

  // Tastatur: F1–F4 Deck Play/Pause, Leertaste = Automation weiter
  document.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('input, select, textarea, dialog')) return;
    const f = /^F([1-4])$/.exec(e.key);
    if (f) { e.preventDefault(); togglePlay(DECKS[Number(f[1]) - 1]); }
  });
}

async function editStation() {
  const s = S.station;
  const v = await formDialog('Sender / Branding', [
    { name: 'name', label: 'Sendername', value: s.name, required: true },
    { name: 'slogan', label: 'Slogan', value: s.slogan },
    { name: 'primaryColor', label: 'Primärfarbe', type: 'color', value: s.primaryColor },
    { name: 'accentColor', label: 'Akzentfarbe', type: 'color', value: s.accentColor },
  ]);
  if (v) await run(() => api.patch(`/stations/${sid()}`, v));
}

// ---------- Laufzeit-Schleife ----------

/** @param {HTMLElement} el @param {number} db */
function meter(el, db) {
  el.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
}

function tick() {
  if (!audio) return;
  for (const id of DECKS) {
    const d = audio.decks[id];
    const els = deckEls[id];
    if (!d.media) continue;
    const dur = d.durationMs;
    const rem = d.remainingMs;
    els.elapsed.textContent = fmt(d.positionMs);
    els.remain.textContent = `-${fmt(rem)}`;
    els.remain.classList.toggle('warn', d.playing && rem < 20_000 && rem >= 10_000);
    els.remain.classList.toggle('end', d.playing && rem < 10_000);
    els.bar.style.width = dur ? `${Math.min(100, (d.positionMs / dur) * 100)}%` : '0';
    meter(els.meter, d.playing ? d.level().rmsDb : -90);
    if (els.card.dataset.status !== deckStatus(d)) renderDeck(id);

    // Automation: Überblendpunkt erreicht → nächster Titel
    if (S.auto && AUTO_DECKS.includes(id) && d.playing && dur > 0 && !d.segueFired) {
      if (rem <= mixMs(d.media, dur)) {
        d.segueFired = true;
        autoNext();
      }
    }
  }
  const lv = audio.masterLevel();
  meter($('m-rms'), lv.rmsDb);
  meter($('m-peak'), lv.peakDb);
  $('m-rms-v').textContent = lv.rmsDb <= -90 ? '-∞' : lv.rmsDb.toFixed(1);
  $('m-peak-v').textContent = lv.peakDb <= -90 ? '-∞' : lv.peakDb.toFixed(1);
  const gr = audio.reductionDb;
  $('m-gr').style.width = `${Math.min(100, (-gr / 20) * 100)}%`;
  $('m-gr-v').textContent = gr.toFixed(1);

  // Stilleerkennung nur relevant, wenn Automation oder Stream läuft
  if (S.auto || S.streaming) {
    const ev = silence.feed(lv.rmsDb, Date.now());
    if (ev === 'silence') onSilence();
    if (ev === 'recovered') onRecovered();
  }
}

function onSilence() {
  $('silence').hidden = false;
  status('Stille erkannt!', true);
  const src = automationSource();
  if (S.streaming && src) run(() => api.post(url(`/sources/${encodeURIComponent(src.id)}/health`), { healthy: false, reason: 'silence' }));
  if (S.auto) autoNext(); // Notfall: nächsten Titel starten
}

function onRecovered() {
  $('silence').hidden = true;
  status('Audio wieder da');
  const src = automationSource();
  if (S.streaming && src) run(() => api.post(url(`/sources/${encodeURIComponent(src.id)}/health`), { healthy: true }));
}

function clock() {
  const now = new Date();
  $('clock-time').textContent = now.toLocaleTimeString('de-DE');
  $('clock-date').textContent = now.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

boot().catch((e) => status(e instanceof Error ? e.message : String(e), true));
