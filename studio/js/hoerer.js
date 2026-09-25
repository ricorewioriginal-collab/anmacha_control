// @ts-check
// Öffentlicher Hörerbereich: Musikwunsch, Grüße, Song-Voting, Sprachnachricht ans Studio.
// Aufruf: hoerer.html?s=<sender> – auch auf der Senderseite einbettbar (iframe).
(() => {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  /** @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node|string|null|undefined|false)} kids */
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') /** @type {any} */ (el).value = v;
      else el.setAttribute(k, String(v));
    }
    for (const c of kids) if (c != null && c !== false) el.append(c);
    return el;
  };
  const sid = new URLSearchParams(location.search).get('s') ?? new URLSearchParams(location.search).get('station') ?? 'main';
  const base = `api/v1/public/stations/${encodeURIComponent(sid)}/listener`;
  /** @type {any} */ let info = null;

  /** @param {string} path @param {any} [body] */
  async function call(path, body) {
    const r = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message ?? `Fehler ${r.status}`);
    return d;
  }

  /** @param {HTMLElement} box @param {string} text @param {boolean} ok */
  const say = (box, text, ok) => box.replaceChildren(h('div', { class: `msg ${ok ? 'ok' : 'bad'}`, role: 'status' }, text));

  /** Suchfeld mit Ergebnisliste; onPick(Titel) bzw. eigene Zeilen-Aktionen */
  function searchBox(/** @type {(t: any, li: HTMLElement) => (Node|null)[]} */ row) {
    const list = h('ul', { class: 'list' });
    let timer = 0;
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'search', placeholder: 'Interpret oder Titel suchen …', autocomplete: 'off', oninput: () => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) return list.replaceChildren();
        try {
          const res = await call(`/search?q=${encodeURIComponent(q)}`);
          list.replaceChildren(...(res.length ? res.map((/** @type {any} */ t) => { const li = h('li'); li.append(h('span', {}, t.artist ? `${t.artist} – ${t.title}` : t.title), ...row(t, li).filter(Boolean)); return li; }) : [h('li', { class: 'muted' }, 'Nichts gefunden')]));
        } catch (e) {
          list.replaceChildren(h('li', { class: 'muted' }, /** @type {Error} */ (e).message));
        }
      }, 250);
    } }));
    return { input, list };
  }

  function requestView() {
    /** @type {any} */ let picked = null;
    const out = h('div');
    const name = h('input', { maxlength: 40, placeholder: 'optional' });
    const text = h('textarea', { maxlength: 300, placeholder: 'Gruß oder Anlass (optional)' });
    const s = searchBox((t, li) => [h('button', { class: 'btn ghost', style: 'margin:0', onclick: () => {
      picked = t;
      for (const x of s.list.children) x.classList.remove('sel');
      li.classList.add('sel');
      send.disabled = false;
    } }, 'Wählen')]);
    const send = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', disabled: true, onclick: async () => {
      try {
        await call('/request', { mediaId: picked.id, name: /** @type {HTMLInputElement} */ (name).value, text: /** @type {HTMLTextAreaElement} */ (text).value });
        say(out, `Danke! Dein Wunsch „${picked.title}“ ist im Studio angekommen.`, true);
        send.disabled = true;
      } catch (e) { say(out, /** @type {Error} */ (e).message, false); }
    } }, 'Wunsch senden'));
    return h('div', { class: 'card' }, h('strong', {}, 'Musikwunsch'), h('div', { class: 'muted' }, 'Such dir einen Titel aus dem Programm aus.'),
      h('label', {}, 'Titel'), s.input, s.list, h('label', {}, 'Dein Name'), name, h('label', {}, 'Nachricht'), text, send, out);
  }

  function messageView() {
    const out = h('div');
    const name = h('input', { maxlength: 40, placeholder: 'optional' });
    const text = h('textarea', { maxlength: 500, placeholder: 'Was möchtest du loswerden?' });
    return h('div', { class: 'card' }, h('strong', {}, 'Grüße & Nachrichten'), h('label', {}, 'Dein Name'), name, h('label', {}, 'Nachricht'), text,
      h('button', { class: 'btn', onclick: async () => {
        try {
          await call('/message', { name: /** @type {HTMLInputElement} */ (name).value, text: /** @type {HTMLTextAreaElement} */ (text).value });
          say(out, 'Danke, deine Nachricht ist im Studio angekommen!', true);
          /** @type {HTMLTextAreaElement} */ (text).value = '';
        } catch (e) { say(out, /** @type {Error} */ (e).message, false); }
      } }, 'Senden'), out);
  }

  function votingView() {
    const out = h('div');
    const charts = h('ol');
    const load = async () => {
      try {
        const c = await call('/charts');
        charts.replaceChildren(...(c.length ? c.map((/** @type {any} */ t) => h('li', {}, `${t.artist ? `${t.artist} – ` : ''}${t.title} `, h('span', { class: 'pill' }, `${t.score > 0 ? '+' : ''}${t.score}`))) : [h('li', { class: 'muted' }, 'Noch keine Stimmen')]));
      } catch { /* Charts optional */ }
    };
    const vote = async (/** @type {any} */ t, /** @type {boolean} */ up) => {
      try {
        await call('/vote', { mediaId: t.id, up });
        say(out, `Danke für deine Stimme für „${t.title}“!`, true);
        load();
      } catch (e) { say(out, /** @type {Error} */ (e).message, false); }
    };
    const s = searchBox((t) => [h('button', { class: 'btn ghost', style: 'margin:0', title: 'Gefällt mir', onclick: () => vote(t, true) }, '👍'), h('button', { class: 'btn ghost', style: 'margin:0', title: 'Gefällt mir nicht', onclick: () => vote(t, false) }, '👎')]);
    load();
    return h('div', {}, h('div', { class: 'card' }, h('strong', {}, 'Song-Voting'), h('label', {}, 'Titel suchen und abstimmen'), s.input, s.list, out),
      h('div', { class: 'card' }, h('strong', {}, 'Hörer-Charts'), charts));
  }

  function voiceView() {
    const out = h('div');
    const name = h('input', { maxlength: 40, placeholder: 'optional' });
    const text = h('input', { maxlength: 300, placeholder: 'z. B. Musikwunsch dazu (optional)' });
    const state = h('span', { class: 'muted' }, 'Bis zu 2 Minuten');
    const player = /** @type {HTMLAudioElement} */ (h('audio', { controls: true, hidden: true, style: 'width:100%;margin-top:10px' }));
    /** @type {MediaRecorder|null} */ let rec = null;
    /** @type {Blob|null} */ let blob = null;
    /** @type {number} */ let stopTimer = 0;
    const recBtn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', onclick: async () => {
      if (rec) return rec.stop();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
        rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined);
        /** @type {Blob[]} */ const parts = [];
        rec.ondataavailable = (e) => parts.push(e.data);
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          clearTimeout(stopTimer);
          blob = new Blob(parts, { type: rec?.mimeType || 'audio/webm' });
          rec = null;
          player.src = URL.createObjectURL(blob);
          player.hidden = false;
          state.replaceChildren('Aufnahme fertig – anhören und senden');
          recBtn.textContent = 'Neu aufnehmen';
          send.disabled = false;
        };
        rec.start();
        stopTimer = window.setTimeout(() => rec?.stop(), 120_000);
        state.replaceChildren(h('span', { class: 'dot' }), ' Aufnahme läuft …');
        recBtn.textContent = 'Stopp';
        send.disabled = true;
      } catch {
        say(out, 'Kein Zugriff auf das Mikrofon – bitte im Browser erlauben.', false);
      }
    } }, 'Aufnahme starten'));
    const send = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', disabled: true, onclick: async () => {
      if (!blob) return;
      send.disabled = true;
      try {
        const q = new URLSearchParams({ name: /** @type {HTMLInputElement} */ (name).value, text: /** @type {HTMLInputElement} */ (text).value });
        const r = await fetch(`${base}/voice?${q}`, { method: 'POST', headers: { 'Content-Type': blob.type.split(';')[0] }, body: blob });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message ?? `Fehler ${r.status}`);
        say(out, 'Danke! Deine Sprachnachricht ist im Studio angekommen.', true);
        blob = null;
      } catch (e) {
        say(out, /** @type {Error} */ (e).message, false);
        send.disabled = false;
      }
    } }, 'Senden'));
    return h('div', { class: 'card' }, h('strong', {}, 'Sprachnachricht ans Studio'), h('div', { class: 'rec' }, recBtn, state), player,
      h('label', {}, 'Dein Name'), name, h('label', {}, 'Nachricht dazu'), text, send, out);
  }

  const VIEWS = /** @type {[string, string, () => HTMLElement][]} */ ([
    ['requests', '🎵 Musikwunsch', requestView], ['messages', '💬 Grüße', messageView], ['voting', '👍 Voting', votingView], ['voice', '🎙 Sprachnachricht', voiceView],
  ]);

  function show(/** @type {string} */ key) {
    for (const b of $('tabs').children) b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.k === key));
    const v = VIEWS.find(([k]) => k === key);
    if (v) $('main').replaceChildren(v[2]());
  }

  async function init() {
    try {
      info = await call('');
    } catch (e) {
      $('main').replaceChildren(h('div', { class: 'card' }, /** @type {Error} */ (e).message));
      return;
    }
    document.title = `${info.station.name} · Hörerbereich`;
    $('name').textContent = info.station.name;
    $('welcome').textContent = info.welcome || info.station.slogan || '';
    if (info.station.logo) /** @type {HTMLImageElement} */ ($('logo')).src = info.station.logo;
    const on = VIEWS.filter(([k]) => info[k]);
    $('tabs').replaceChildren(...on.map(([k, label]) => h('button', { 'data-k': k, 'aria-pressed': 'false', onclick: () => show(k) }, label)));
    if (on.length === 1) $('tabs').hidden = true;
    show(on[0][0]);
  }

  init();
})();
