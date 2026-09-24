// @ts-check
// AirDeck Studio – Oberfläche: 4 Decks, Cardwall, Archiv, Queue, Quellen, Ausgänge, Automation.
// Sämtlicher Nutzerinhalt wird per textContent gesetzt (kein innerHTML) → kein XSS.

import { Api, ApiError, isNativeApp, readToken, saveServer, saveToken, serverBase } from './api.js';
import { AudioEngine, DECKS, SilenceDetector, openMic, recordStream } from './audio.js';
import { $, clockTime, download, fmt, formDialog, h, mediaTitle, run, status } from './ui.js';
import { mountPlanning, mountRecorder } from './planning.js';
import { mountLautfm } from './lautfm.js';

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
  /** @type {any} */ playout: null,
  /** @type {{ rec: MediaRecorder, stream: MediaStream, sourceId: string }|null} */ mic: null,
  /** @type {HTMLAudioElement|null} */ listen: null,
};
const serverMode = () => !!S.playout?.status?.running;
const AUDIO_FILE = /\.(mp3|ogg|opus|wav|flac|m4a|aac|webm)$/i;
/** @type {Record<string, { show: () => any, onEvent?: (t: string, d: any) => void }>} */
let views = {};
let currentView = 'studio';
const silence = new SilenceDetector(-50, 10_000);

const sid = () => encodeURIComponent(S.station.id);
const url = (/** @type {string} */ p) => `/stations/${sid()}${p}`;

// ---------- Start ----------

async function boot() {
  const token = readToken();
  if (!token || (isNativeApp() && !serverBase())) return askToken();
  api = new Api(token);
  try {
    await api.get('/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return askToken('Token ungültig.');
    status('Server nicht erreichbar – neuer Versuch in 3 s', true);
    if (isNativeApp()) {
      $('status-text').append(' ', h('button', { class: 'btn small', onclick: () => askToken('Server nicht erreichbar – Adresse prüfen.') }, 'Server ändern'));
    }
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
  const needServer = isNativeApp() || !!serverBase();
  const v = await formDialog('Mit AirDeck verbinden', [
    ...(needServer ? [{ name: 'server', label: 'Server-Adresse', value: serverBase() || 'http://192.168.', required: true, hint: 'z. B. http://192.168.1.20:8750 (AirDeck auf dem PC/Server, AIRDECK_HOST=0.0.0.0)' }] : []),
    { name: 'token', label: 'API-Token', type: 'password', required: true, hint: msg ?? 'Das Token wird beim ersten Serverstart in der Konsole angezeigt.' },
  ], 'Verbinden');
  if (!v?.token) return;
  if (needServer) saveServer(v.server);
  saveToken(v.token.trim());
  location.reload();
}

/** @type {EventSource|null} */
let es = null;

async function loadStation() {
  localStorage.setItem('airdeck.station', S.station.id);
  applyBranding();
  const [library, queue, carts, sources, outputs, np, playout] = await Promise.all([
    api.get(url('/media')), api.get(url('/queue')), api.get(url('/cardwall')),
    api.get(url('/sources')), api.get(url('/outputs')), api.get(url('/now-playing')), api.get(url('/playout')),
  ]);
  S.playout = playout;
  setLibrary(library);
  S.queue = queue;
  S.carts = carts;
  S.sources = sources;
  S.outputs = outputs;
  S.nowPlaying = np;
  renderAll();
  es?.close();
  es = api.events(S.station.id, onEvent, (ok) => $('conn').classList.toggle('ok', ok));
  const ctx = { api, url, library: () => S.library, folders: () => api.get(url('/folders')) };
  views = {
    planning: mountPlanning($('view-planning'), ctx),
    recorder: mountRecorder($('view-recorder'), ctx),
    lautfm: mountLautfm($('view-lautfm'), ctx),
  };
  if (currentView !== 'studio') views[currentView]?.show();
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
  for (const v of Object.values(views)) v.onEvent?.(type, data);
  switch (type) {
    case 'automation.command':
      // Zeitplan/Uhr im Browser-Modus (ohne Server-Playout) ausführen
      if (serverMode()) break;
      if (data.action === 'next') {
        if (S.auto) autoNext();
        else status('Zeitplan: nächster Titel liegt oben in der Queue (Automation ist aus)');
      } else if (data.action === 'fx' && S.libById.get(data.mediaId)) {
        playCart({ id: '_fx', mediaId: data.mediaId });
      }
      break;
    case 'schedule.fired': status(`Zeitplan: ${data.label ?? data.kind} (${data.origin})`); break;
    case 'metadata.sent': status(`Titelanzeige gesendet: ${data.artist ? data.artist + ' – ' : ''}${data.title}`); break;
    case 'sources.changed':
      // Server liefert Engine-Sicht; Relay-/Passwortinfos einmal nachladen
      run(async () => { S.sources = await api.get(url('/sources')); renderSources(); });
      break;
    case 'queue.changed': S.queue = data; renderQueue(); renderNowPlaying(); break;
    case 'now_playing.changed': S.nowPlaying = { ...S.nowPlaying, ...data }; renderNowPlaying(); break;
    case 'library.changed': run(async () => { setLibrary(await api.get(url('/media'))); renderLibrary(); renderCarts(); }); break;
    case 'cardwall.changed': S.carts = data; renderCarts(); break;
    case 'cardwall.triggered': if (!data.server) playCart(data); break; // Fernauslösung ohne Server-Playout: lokal spielen
    case 'playout.state': if (S.playout) { S.playout.status = data; renderPlayout(); } break;
    case 'playout.log':
      if (['encoder_crashed', 'silence_detected', 'decode_failed', 'autostart_failed'].includes(data.event)) status(`Server-Playout: ${data.event}${data.mediaId ? ` (${data.mediaId})` : ''}`, true);
      if (['playout_started', 'playout_stopped'].includes(data.event)) run(async () => { S.playout = await api.get(url('/playout')); renderPlayout(); });
      break;
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
  renderPlayout();
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

// ---------- Server-Playout ----------

function renderPlayout() {
  const p = S.playout;
  const st = p?.status;
  const pill = $('po-state');
  const state = !p?.supported ? 'unsupported' : st?.running ? (st.encoder === 'restarting' ? 'restarting' : 'running') : 'stopped';
  pill.className = `pill ${state}`;
  pill.textContent = { unsupported: 'kein ffmpeg', running: st?.silent ? 'stille!' : 'sendet', restarting: 'encoder…', stopped: 'aus' }[state];
  $('po-title').textContent = st?.current ? mediaTitle(st.current) : p?.supported ? '–' : 'ffmpeg auf dem Server installieren';
  $('po-meta').textContent = st?.running
    ? `${fmt(st.current?.positionMs)} / ${fmt(st.current?.durationMs)} · ${st.format.toUpperCase()} ${st.bitrateKbps} kbit/s${p.config.autostart ? ' · Autostart' : ''}`
    : p?.config ? `${p.config.format.toUpperCase()} ${p.config.bitrateKbps} kbit/s · Überblendung ${p.config.crossfadeMs / 1000}s` : '';
  /** @type {HTMLButtonElement} */ ($('po-start')).disabled = !p?.supported || !!st?.running;
  /** @type {HTMLButtonElement} */ ($('po-stop')).disabled = !st?.running;
  /** @type {HTMLButtonElement} */ ($('po-skip')).disabled = !st?.running;
  $('btn-auto').toggleAttribute('disabled', !!st?.running && !S.auto);
}

async function editPlayout() {
  const c = S.playout?.config ?? {};
  const enc = S.playout?.ffmpeg?.encoders ?? { mp3: true, opus: true };
  const v = await formDialog('Server-Automation 24/7', [
    { name: 'format', label: 'Format', value: c.format ?? 'mp3', options: [['mp3', `MP3${enc.mp3 ? '' : ' (nicht verfügbar)'}`], ['opus', `Ogg/Opus${enc.opus ? '' : ' (nicht verfügbar)'}`]] },
    { name: 'bitrateKbps', label: 'Bitrate (kbit/s)', type: 'number', value: c.bitrateKbps ?? 128 },
    { name: 'crossfadeMs', label: 'Überblendung Musik (ms)', type: 'number', value: c.crossfadeMs ?? 3000 },
    { name: 'duckDb', label: 'Ducking bei Carts (dB)', type: 'number', value: c.duckDb ?? -10 },
    { name: 'silenceMs', label: 'Stille-Alarm nach (ms)', type: 'number', value: c.silenceMs ?? 10000 },
    { name: 'sourceId', label: 'Sendet als Quelle', value: c.sourceId ?? '', options: [['', 'Automation (Standard)'], ...S.sources.map((s) => /** @type {[string,string]} */ ([s.id, `P${s.priority} · ${s.name}`]))] },
    { name: 'autostart', label: 'Nach Neustart automatisch senden', type: 'checkbox', value: c.autostart ?? true },
  ]);
  if (!v) return;
  const saved = await run(() => api.patch(url('/playout'), v));
  if (!saved) return;
  S.playout = saved;
  // Laufendes Playout mit neuen Einstellungen neu starten (kurzer Fallback auf nächste Quelle)
  if (serverMode() && confirm('Playout jetzt mit neuen Einstellungen neu starten?')) {
    await run(() => api.post(url('/playout/stop')));
    S.playout = (await run(() => api.post(url('/playout/start'), { autostart: v.autostart }))) ?? S.playout;
  }
  renderPlayout();
}

// ---------- Mikrofon live / Mithören ----------

async function toggleMic() {
  const btn = $('btn-mic');
  if (S.mic) {
    S.mic.rec.stop();
    for (const t of S.mic.stream.getTracks()) t.stop();
    const id = S.mic.sourceId;
    S.mic = null;
    btn.setAttribute('aria-pressed', 'false');
    await run(() => api.post(url(`/sources/${encodeURIComponent(id)}/release`)));
    return status('Mikrofon-Sendung beendet – Automation übernimmt wieder');
  }
  const live = S.sources.filter((s) => ['mobile', 'live_studio', 'remote_studio'].includes(s.type));
  if (!live.length) return status('Keine Live-Quelle konfiguriert', true);
  const preferred = live.find((s) => s.type === (isNativeApp() ? 'mobile' : 'live_studio')) ?? live[0];
  const v = await formDialog('Mikrofon live senden', [
    { name: 'sourceId', label: 'Als Quelle', value: preferred.id, options: live.map((s) => /** @type {[string,string]} */ ([s.id, `P${s.priority} · ${s.name}`])) },
  ], 'ON AIR');
  if (!v) return;
  let stream;
  try {
    stream = await openMic();
  } catch (e) {
    return status(`Mikrofon nicht verfügbar: ${e instanceof Error ? e.message : e}`, true);
  }
  const sourceId = v.sourceId;
  try {
    const rec = recordStream(stream, async (blob, first, type) => {
      await api.req('POST', url(`/sources/${encodeURIComponent(sourceId)}/chunks${first ? '?start=1' : ''}`), blob, { 'Content-Type': type });
    });
    S.mic = { rec, stream, sourceId };
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    return status(e instanceof Error ? e.message : String(e), true);
  }
  btn.setAttribute('aria-pressed', 'true');
  status(`Mikrofon sendet als „${sourceName(sourceId)}“ – Übernahme nach Priorität (Anti-Flapping 2 s)`);
}

function toggleListen() {
  const btn = $('btn-listen');
  if (S.listen) {
    S.listen.pause();
    S.listen.removeAttribute('src');
    S.listen = null;
    btn.setAttribute('aria-pressed', 'false');
    return;
  }
  const el = new Audio(api.listenUrl(S.station.id, '/live'));
  el.play().catch(() => status('Mithören nicht möglich – ist eine Quelle auf Sendung?', true));
  el.addEventListener('error', () => { status('Mithör-Stream beendet (Quellenwechsel?) – erneut klicken', true); btn.setAttribute('aria-pressed', 'false'); S.listen = null; }, { once: true });
  S.listen = el;
  btn.setAttribute('aria-pressed', 'true');
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
      onclick: () => (m ? fireCart(c) : undefined),
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fireCart(c); } },
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

/** Im Server-Modus spielt das Server-Playout den Cart (geht auf Sendung), sonst der Browser. @param {any} c */
function fireCart(c) {
  if (serverMode()) run(() => api.post(url(`/cardwall/${encodeURIComponent(c.id)}/trigger`)));
  else playCart(c);
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
  const folderSel = /** @type {HTMLSelectElement} */ ($('lib-folder'));
  const folders = [...new Set(S.library.map((m) => m.folder ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const cur = folderSel.value;
  folderSel.replaceChildren(h('option', { value: '' }, 'Alle Ordner'), ...folders.map((f) => h('option', { value: f, selected: f === cur }, f)));
  const folder = folderSel.value;
  const list = S.library
    .filter((m) => (!cat || m.category === cat) && (!folder || (m.folder ?? '') === folder) && (!q || `${m.title} ${m.artist} ${m.folder ?? ''}`.toLowerCase().includes(q)))
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
    { name: 'folder', label: 'Ordner', value: m.folder ?? '' },
    { name: 'cueInMs', label: 'Cue-In (ms)', type: 'number', value: m.cueInMs ?? '' },
    { name: 'segueMs', label: 'Überblendung vor Ende (ms)', type: 'number', value: m.segueMs ?? '', hint: `Standard: ${DEFAULT_MIX_MS} ms` },
    { name: 'gainDb', label: 'Gain (dB)', type: 'number', value: m.gainDb ?? '' },
  ]);
  if (v) await run(() => api.patch(url(`/media/${encodeURIComponent(m.id)}`), v));
}

/** @param {FileList|File[]} files */
async function upload(files) {
  const cat = /** @type {HTMLSelectElement} */ ($('lib-cat')).value || 'music';
  const selFolder = /** @type {HTMLSelectElement} */ ($('lib-folder')).value;
  files = [...files].filter((f) => AUDIO_FILE.test(f.name));
  if (!files.length) return status('Keine Audiodateien gefunden', true);
  let ok = 0;
  for (const f of files) {
    status(`Upload: ${f.name} …`);
    // Ordner-Upload: erster Pfadteil wird zum Ordner in der Bibliothek
    const rel = /** @type {any} */ (f).webkitRelativePath || '';
    const folder = rel.includes('/') ? rel.split('/').slice(0, -1).join(' / ') : selFolder;
    const r = await run(() => api.req('PUT', url(`/media?name=${encodeURIComponent(f.name)}&category=${cat}&folder=${encodeURIComponent(folder)}`), f, { 'Content-Type': 'application/octet-stream' }));
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
  $('lib-folder').addEventListener('change', renderLibrary);
  $('lib-upload-dir').addEventListener('change', (e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    if (input.files?.length) upload([...input.files]).finally(() => (input.value = ''));
  });
  $('btn-add-url').addEventListener('click', async () => {
    const v = await formDialog('URL / Stream hinzufügen', [
      { name: 'url', label: 'URL (http/https)', required: true },
      { name: 'title', label: 'Titel' },
      { name: 'durationMin', label: 'Dauer in Minuten (leer = bis weitergeschaltet wird)', type: 'number', value: '' },
      { name: 'folder', label: 'Ordner', value: /** @type {HTMLSelectElement} */ ($('lib-folder')).value },
    ], 'Hinzufügen');
    if (v) run(() => api.post(url('/media/url'), { url: v.url, title: v.title, folder: v.folder, durationMs: v.durationMin ? v.durationMin * 60000 : undefined }));
  });
  $('btn-fill-from').addEventListener('click', async () => {
    const folders = /** @type {string[]} */ (await run(() => api.get(url('/folders')))) ?? [];
    const v = await formDialog('Warteschlange füllen', [
      { name: 'src', label: 'Aus', value: folders[0] ? `f:${folders[0]}` : 'c:music', options: [...folders.map((f) => /** @type {[string,string]} */ ([`f:${f}`, `Ordner: ${f}`])), ...Object.entries(CATEGORY_LABEL).map(([k, l]) => /** @type {[string,string]} */ ([`c:${k}`, `Kategorie: ${l}`]))] },
      { name: 'count', label: 'Anzahl Titel', type: 'number', value: 10 },
    ], 'Füllen');
    if (!v) return;
    const body = v.src.startsWith('f:') ? { folder: v.src.slice(2), count: v.count } : { category: v.src.slice(2), count: v.count };
    const r = await run(() => api.post(url('/queue/fill-from'), body));
    if (r) status(`${r.added} Titel zur Warteschlange hinzugefügt`);
  });
  $('btn-m3u').addEventListener('click', async () => {
    const blob = await run(() => api.blob(url('/queue.m3u')));
    if (blob) download(blob, 'airdeck-queue.m3u');
  });
  $('btn-meta').addEventListener('click', async () => {
    const m = S.nowPlaying?.media;
    const v = await formDialog('Titelanzeige senden', [
      { name: 'artist', label: 'Interpret', value: m?.artist ?? '' },
      { name: 'title', label: 'Titel', value: m?.title ?? '', required: true },
    ], 'Senden');
    if (v) run(() => api.post(url('/metadata'), v));
  });
  $('view-tabs').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (b?.dataset.view) showView(b.dataset.view);
  });
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
    if (!S.auto && serverMode()) return status('Server-Playout (24/7) läuft – Browser-Automation ist dann aus', true);
    S.auto = !S.auto;
    $('btn-auto').setAttribute('aria-pressed', String(S.auto));
    status(S.auto ? 'Automation EIN' : 'Automation AUS');
    if (S.auto) {
      await ensureAudio().resume();
      if (!AUTO_DECKS.some((id) => audio?.decks[id].playing)) autoNext();
    }
  });
  $('btn-stream').addEventListener('click', toggleStream);
  $('btn-mic').addEventListener('click', toggleMic);
  $('btn-listen').addEventListener('click', toggleListen);
  $('po-start').addEventListener('click', () => {
    if (S.auto) { S.auto = false; $('btn-auto').setAttribute('aria-pressed', 'false'); }
    if (S.streaming) toggleStream();
    run(async () => { S.playout = await api.post(url('/playout/start'), {}); renderPlayout(); });
  });
  $('po-stop').addEventListener('click', () => confirm('Server-Playout stoppen? Der Sender fällt auf die nächste Quelle zurück.') && run(async () => { S.playout = await api.post(url('/playout/stop')); renderPlayout(); }));
  $('po-skip').addEventListener('click', () => run(() => api.post(url('/playout/skip'))));
  $('po-settings').addEventListener('click', editPlayout);
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

/** @param {string} name */
function showView(name) {
  currentView = name;
  for (const b of document.querySelectorAll('#view-tabs button')) b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.view === name));
  for (const id of ['studio', 'planning', 'recorder', 'lautfm']) $(`view-${id}`).hidden = id !== name;
  if (name !== 'studio') views[name]?.show();
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
