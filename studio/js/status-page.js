// @ts-check
// Öffentliche Stream-Statusseite (ohne Login): liest /status/<sender>.json bzw. /status/lautfm/<name>.json.
(() => {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  /** @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node|string|null|undefined|false)} kids */
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) k.startsWith('on') ? el.addEventListener(k.slice(2), v) : el.setAttribute(k, String(v));
    for (const c of kids) if (c != null && c !== false) el.append(c);
    return el;
  };
  const params = new URLSearchParams(location.search);
  let current = params.get('lautfm') ? `lautfm/${params.get('lautfm')}` : params.get('station') ?? '';
  /** @type {any} */ let data = null;
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  const q = (/** @type {string} */ fmt) => `status/${current}.${fmt}`;

  async function init() {
    /** @type {{stations: {id: string, name: string, lautfm?: string}[]}} */
    const list = await fetch('status.json').then((r) => r.json()).catch(() => ({ stations: [] }));
    const sel = /** @type {HTMLSelectElement} */ ($('sel'));
    sel.replaceChildren(...list.stations.flatMap((s) => [
      h('option', { value: s.id }, `${s.name} (AirDeck)`),
      ...(s.lautfm ? [h('option', { value: `lautfm/${s.lautfm}` }, `${s.name} – laut.fm/${s.lautfm}`)] : []),
    ]));
    if (current && ![...sel.options].some((o) => o.value === current)) sel.append(h('option', { value: current }, current.replace('lautfm/', 'laut.fm/')));
    if (!current) current = sel.options[0]?.value ?? '';
    sel.value = current;
    sel.addEventListener('change', () => pick(sel.value));
    $('laut-go').addEventListener('click', () => {
      const n = /** @type {HTMLInputElement} */ ($('laut')).value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (n) {
        if (![...sel.options].some((o) => o.value === `lautfm/${n}`)) sel.append(h('option', { value: `lautfm/${n}` }, `laut.fm/${n}`));
        sel.value = `lautfm/${n}`;
        pick(`lautfm/${n}`);
      }
    });
    if (!current) return $('out').replaceChildren(h('div', { class: 'card muted' }, 'Kein öffentlicher Sender. Oben einen laut.fm-Sendernamen eingeben.'));
    load();
  }

  /** @param {string} v */
  function pick(v) {
    current = v;
    history.replaceState(null, '', v.startsWith('lautfm/') ? `?lautfm=${v.slice(7)}` : `?station=${v}`);
    load();
  }

  async function load() {
    clearTimeout(timer);
    try {
      const r = await fetch(q('json'), { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? `HTTP ${r.status}`);
      data = d;
      render();
      $('upd').textContent = `aktualisiert ${new Date().toLocaleTimeString('de-DE')}`;
    } catch (e) {
      $('out').replaceChildren(h('div', { class: 'card' }, `Nicht verfügbar: ${e instanceof Error ? e.message : e}`));
    }
    timer = setTimeout(load, 10_000);
  }

  /** @param {string} k @param {Node|string} v */
  const row = (k, v) => h('tr', {}, h('td', {}, k), h('td', {}, v));
  const time = (/** @type {string|null|undefined} */ iso) => (iso ? new Date(iso).toLocaleString('de-DE') : '–');

  function render() {
    const d = data;
    const srcs = d.icestats?.source ?? [];
    const out = [];
    if (!srcs.length) out.push(h('div', { class: 'card' }, h('div', { class: 'mount' }, h('h2', {}, d.name), h('span', { class: 'badge off' }, 'OFFLINE')), h('div', { class: 'muted' }, d.onair ? `Auf Sendung: ${d.onair.source} (Priorität ${d.onair.priority}), aber kein öffentlicher Ausgang verbunden.` : 'Gerade ist kein Mount aktiv.')));
    srcs.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      let mount = '';
      try { mount = new URL(s.listenurl).pathname; } catch {}
      // Fortschritt nur, wenn der Mount wirklich den gezeigten Titel spielt (nicht laut.fm-Eigenprogramm neben AirDeck)
      const now = i === 0 && (s.kind !== 'laut.fm' || d.kind === 'laut.fm') ? d.now : null;
      const prog = now?.ends_at ? h('div', { class: 'prog' }, h('i', { id: `pg${i}` })) : null;
      out.push(h('div', { class: 'card' },
        h('div', { class: 'mount' }, h('h2', {}, `Mount ${mount || '/'}`), h('span', { class: 'badge' }, '● ON AIR'), h('span', { class: 'badge kind' }, s.kind)),
        h('table', {},
          row('Stream-Titel', s.server_name ?? ''), row('Beschreibung', s.server_description || '–'), row('Content-Type', s.server_type || '–'),
          row(s.kind === 'laut.fm' ? 'Aktueller Titel seit' : 'Mount verbunden seit', time(s.stream_start_iso8601)),
          row('Bitrate', s.bitrate ? `${s.bitrate} kbit/s` : 'nicht öffentlich'),
          row('Hörer (aktuell)', s.listeners == null ? 'unbekannt' : String(s.listeners)),
          row('Genre', s.genre || '–'),
          row('Stream-URL', h('span', {}, h('a', { href: s.listenurl, target: '_blank', rel: 'noopener' }, s.listenurl), ' ', h('button', { class: 'lnk', onclick: () => navigator.clipboard?.writeText(s.listenurl) }, 'kopieren'))),
          row('Aktueller Titel', h('span', {}, h('b', {}, s.title || '–'), prog)),
          ...(now?.album ? [row('Album', now.album)] : []))));
    });
    if (d.onair) out.push(h('div', { class: 'card' }, h('b', {}, 'Aktive Quelle'), h('div', { class: 'muted' }, `${d.onair.source} · ${d.onair.type} · Priorität ${d.onair.priority}`)));
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    out.push(h('div', { class: 'card' }, h('b', {}, 'Adressen & Formate'), h('div', {},
      ...['m3u', 'xspf', 'xml', 'json'].map((f) => h('a', { class: 'lnk', href: q(f), target: '_blank' }, f === 'xml' ? 'Icecast-XML' : f.toUpperCase())),
      ...(d.links?.station_page ? [h('a', { class: 'lnk', href: d.links.station_page, target: '_blank', rel: 'noopener' }, 'laut.fm-Seite')] : [])),
      h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, `Öffentliche Schnittstelle: ${base}status/${current}.json|xml|m3u|xspf`)));
    const w = `${base}widget.html?${current.startsWith('lautfm/') ? `lautfm=${current.slice(7)}` : `station=${current}`}`;
    out.push(h('div', { class: 'card' }, h('b', {}, 'Player-Widget für die eigene Webseite'),
      h('div', { class: 'muted', style: 'font-size:13px' }, 'Optionen: theme=light|dark, accent=ff8800, history=0–10'),
      h('pre', {}, `<iframe src="${w}" width="100%" height="200" style="border:0;max-width:460px" allow="autoplay"></iframe>`),
      h('iframe', { src: w, style: 'border:0;width:100%;max-width:460px;height:200px', title: 'Player-Widget' })));
    if (d.last_songs?.length) out.push(h('div', { class: 'card' }, h('b', {}, 'Zuletzt gespielt'), h('table', {}, ...d.last_songs.map((/** @type {any} */ x) => row(x.started_at ? new Date(x.started_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '', x.artist ? `${x.artist} – ${x.title}` : x.title)))));
    const raw = h('pre', { hidden: true });
    out.push(h('div', { class: 'card' }, h('b', {}, 'Rohdaten (Icecast-XML) '), h('button', { class: 'lnk', onclick: async () => { raw.hidden = false; raw.textContent = await (await fetch(q('xml'))).text(); } }, 'anzeigen'), raw));
    $('out').replaceChildren(...out);
    tick();
  }

  function tick() {
    const n = data?.now;
    const el = document.getElementById('pg0');
    if (!el || !n?.started_at || !n?.ends_at) return;
    const a = Date.parse(n.started_at);
    const b = Date.parse(n.ends_at);
    el.style.width = `${Math.max(0, Math.min(100, ((Date.now() - a) / (b - a)) * 100))}%`;
    setTimeout(tick, 1000);
  }

  init();
})();
