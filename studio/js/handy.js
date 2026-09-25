// @ts-check
// Handy-Sender: Oberfläche für die Engine in der Android-App (Plugin „AirDeckEngine“).
// Sendet Mikrofon und Musik vom Handy direkt an Icecast/laut.fm – ohne AirDeck-Server.
(() => {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  /** @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node|string|null|undefined|false)} kids */
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked') /** @type {any} */ (el)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids) if (c != null && c !== false) el.append(c);
    return el;
  };
  const cap = /** @type {any} */ (window).Capacitor;
  /** @type {any} */
  const E = cap?.isNativePlatform?.() ? (cap.registerPlugin ? cap.registerPlugin('AirDeckEngine') : cap.Plugins?.AirDeckEngine) : null;
  const MODE_KEY = 'airdeck.mobileMode';

  const fmt = (/** @type {number} */ ms) => {
    if (!(ms >= 0)) return '--:--';
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(hh ? 2 : 1, '0');
    return `${hh ? `${hh}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
  };
  const pct = (/** @type {number} */ db) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;

  /** @type {any} */ let cfg = null;
  /** @type {any} */ let st = null;
  let listKey = '';
  const els = /** @type {Record<string, HTMLElement>} */ ({});

  /** @param {string} text */
  function error(text) {
    els.err.hidden = !text;
    els.err.textContent = text;
  }

  /** @param {() => Promise<any>} fn */
  async function run(fn) {
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'running' in r) render(r);
      error('');
      return r;
    } catch (e) {
      error(/** @type {any} */ (e)?.message ?? String(e));
      return null;
    }
  }

  function build() {
    const meter = (/** @type {string} */ key, /** @type {string} */ label) => {
      els[`${key}Bar`] = h('i');
      els[`${key}Val`] = h('span', {}, '-∞');
      return h('div', {}, h('div', { class: 'lvl' }, h('span', {}, label), els[`${key}Val`]), h('div', { class: 'meter' }, els[`${key}Bar`]));
    };
    els.air = h('button', { class: 'big', onclick: toggleAir }, 'Live gehen');
    els.mic = h('button', { class: 'big mic', 'aria-pressed': 'false', onclick: () => run(() => E.setMic({ on: !st?.micOn })) }, '🎙 Mikro');
    els.info = h('div', { class: 'muted' }, 'Nicht auf Sendung');
    els.err = h('div', { class: 'msg', hidden: true });
    els.list = h('ul');
    els.now = h('div', { class: 'muted' }, 'Kein Titel läuft');
    els.prog = h('i');
    els.autoNext = h('input', { type: 'checkbox', checked: true, onchange: () => run(() => E.setAutoNext({ on: /** @type {HTMLInputElement} */ (els.autoNext).checked })) });
    els.monitor = h('input', { type: 'checkbox', onchange: () => run(() => E.setMonitor({ on: /** @type {HTMLInputElement} */ (els.monitor).checked })) });
    const slider = (/** @type {string} */ key, /** @type {string} */ label, /** @type {number} */ min, /** @type {number} */ max, /** @type {number} */ value) => {
      const out = h('span', {}, `${value} dB`);
      const input = /** @type {HTMLInputElement} */ (h('input', { type: 'range', min, max, step: 1, value }));
      input.addEventListener('input', () => (out.textContent = `${input.value} dB`));
      input.addEventListener('change', () => run(() => E.setLevels({ [key]: Number(input.value) })));
      return h('div', {}, h('div', { class: 'lvl' }, h('span', {}, label), out), input);
    };

    $('main').replaceChildren(
      h('section', { class: 'card' },
        h('h2', {}, 'Sendung'),
        h('div', { class: 'row' }, els.air, els.mic),
        h('div', { style: 'margin-top:10px' }, els.info),
        meter('master', 'Summe'), meter('mic', 'Mikrofon'), meter('music', 'Musik'),
        els.err),
      h('section', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { style: 'margin:0;flex:1' }, 'Musik vom Handy'),
          h('button', { class: 'btn primary', onclick: () => run(() => E.pickTracks()) }, '＋ Titel'),
          h('button', { class: 'btn', onclick: () => run(() => E.stopTrack()) }, '■ Stopp')),
        els.now, h('div', { class: 'prog' }, els.prog),
        h('label', { class: 'check' }, els.autoNext, 'Danach automatisch den nächsten Titel spielen'),
        els.list),
      h('section', { class: 'card' },
        h('h2', {}, 'Pegel'),
        slider('micDb', 'Mikrofon', -20, 20, cfg.micDb ?? 0),
        slider('musicDb', 'Musik', -30, 6, cfg.musicDb ?? 0),
        slider('duckDb', 'Musik unter dem Mikrofon', -30, 0, cfg.duckDb ?? -10),
        h('label', { class: 'check' }, els.monitor, 'Mithören (nur mit Kopfhörer – sonst Rückkopplung)')),
      settingsCard(),
    );
    /** @type {HTMLInputElement} */ (els.monitor).checked = !!cfg.monitor;
  }

  function settingsCard() {
    const f = /** @type {Record<string, HTMLInputElement|HTMLSelectElement>} */ ({});
    const field = (/** @type {string} */ name, /** @type {string} */ label, /** @type {any} */ attrs) => {
      f[name] = /** @type {any} */ (h('input', { name, ...attrs }));
      return h('div', {}, h('label', {}, label), f[name]);
    };
    f.bitrate = /** @type {HTMLSelectElement} */ (h('select', {}, ...[64, 96, 128, 160, 192, 256, 320].map((b) => h('option', { value: b, selected: b === cfg.bitrate }, `${b} kbit/s MP3`))));
    f.tls = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: !!cfg.tls }));
    const box = h('details', { class: 'card', open: !cfg.host || !cfg.hasPassword },
      h('summary', {}, 'Sender-Zugang (Icecast / laut.fm)'),
      h('p', { class: 'muted' }, 'Die Live-Zugangsdaten stehen bei laut.fm im Radioadmin unter „Live“, bei Icecast/AzuraCast in den Streamer-Einstellungen. Das Passwort bleibt nur in der App (privater App-Speicher) und wird nie angezeigt.'),
      h('div', { class: 'grid' }, field('host', 'Server', { value: cfg.host, placeholder: 'stream.example.org', autocapitalize: 'off' }), field('port', 'Port', { value: cfg.port, inputmode: 'numeric' })),
      field('mount', 'Mountpoint', { value: cfg.mount, autocapitalize: 'off' }),
      h('div', { class: 'grid' }, field('user', 'Benutzer', { value: cfg.user, autocapitalize: 'off' }), h('div', {}, h('label', {}, 'Qualität'), f.bitrate)),
      field('password', cfg.hasPassword ? 'Passwort (leer = unverändert)' : 'Passwort', { type: 'password', value: '' }),
      field('name', 'Sendername', { value: cfg.name }),
      h('label', { class: 'check' }, f.tls, 'Verschlüsselt (HTTPS/TLS)'),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const r = await run(() => E.saveConfig({
            host: f.host.value.trim(), port: Number(f.port.value), mount: f.mount.value.trim(), user: f.user.value.trim(),
            password: f.password.value, name: f.name.value.trim(), bitrate: Number(f.bitrate.value), tls: /** @type {HTMLInputElement} */ (f.tls).checked,
          }));
          if (r) {
            cfg = r;
            f.password.value = '';
            box.removeAttribute('open');
          }
        },
      }, 'Speichern'));
    return box;
  }

  async function toggleAir() {
    if (st?.running) {
      if (!confirm('Sendung beenden?')) return;
      await run(() => E.stop());
      return;
    }
    if (!cfg.host || !cfg.hasPassword) return error('Bitte zuerst unten den Sender-Zugang eintragen und speichern.');
    await run(() => E.start());
  }

  /** @param {any} s */
  function render(s) {
    st = s;
    const pill = $('state');
    const on = s.running && s.state === 'connected';
    pill.className = `pill ${on ? 'on' : s.state === 'error' ? 'bad' : s.running ? 'wait' : ''}`;
    pill.textContent = !s.running ? 'AUS' : on ? 'ON AIR' : s.state === 'error' ? 'FEHLER' : 'VERBINDET …';
    els.air.textContent = s.running ? 'Sendung beenden' : 'Live gehen';
    els.air.className = `big${s.running ? ' stop' : ''}`;
    els.mic.setAttribute('aria-pressed', String(!!s.micOn));
    /** @type {HTMLButtonElement} */ (els.mic).disabled = !s.running || !s.micAvailable;
    els.mic.textContent = s.micOn ? '🎙 Mikro AN' : '🎙 Mikro';
    els.info.textContent = !s.running ? 'Nicht auf Sendung'
      : `${on ? 'Auf Sendung' : s.state === 'error' ? `Neuer Versuch … ${s.error ?? ''}` : 'Verbinde mit dem Sender …'} · ${fmt(Date.now() - s.startedAt)} · ${(s.bytesSent / 1048576).toFixed(1)} MB${s.dropped ? ` · ${Math.round(s.dropped / 1024)} kB verworfen (Netz zu langsam)` : ''}`;
    for (const [k, db] of [['master', s.masterDb], ['mic', s.micDb], ['music', s.musicDb]]) {
      els[`${k}Bar`].style.width = s.running ? pct(db) : '0';
      els[`${k}Val`].textContent = s.running && db > -90 ? `${db.toFixed(1)} dB` : '-∞';
    }
    if (s.error && !s.running) error(s.error);
    // Titelliste nur neu aufbauen, wenn sie sich geändert hat
    const key = `${s.current}|${s.playlist.map((/** @type {any} */ t) => t.title).join('\n')}`;
    if (key !== listKey) {
      listKey = key;
      els.list.replaceChildren(...(s.playlist.length ? s.playlist.map((/** @type {any} */ t, /** @type {number} */ i) => h('li', { class: i === s.current ? 'cur' : '' },
        h('button', { class: 'btn', disabled: !s.running, onclick: () => run(() => E.play({ index: i })) }, i === s.current ? '▶︎ läuft' : '▶︎'),
        h('span', {}, t.title),
        h('button', { class: 'x', title: 'Entfernen', onclick: () => run(() => E.removeTrack({ index: i })) }, '×')))
        : [h('li', { class: 'muted' }, 'Noch keine Titel – mit „＋ Titel“ vom Handy hinzufügen.')]));
    }
    const cur = s.current >= 0 ? s.playlist[s.current] : null;
    els.now.textContent = cur ? `${cur.title} · ${fmt(s.positionMs)} / ${fmt(s.durationMs)}` : 'Kein Titel läuft';
    els.prog.style.width = cur && s.durationMs > 0 ? `${Math.min(100, (s.positionMs / s.durationMs) * 100)}%` : '0';
    /** @type {HTMLInputElement} */ (els.autoNext).checked = !!s.autoNext;
  }

  async function poll() {
    if (!document.hidden) {
      try {
        render(await E.status());
      } catch {
        // Plugin kurz nicht erreichbar (z. B. beim Zurückkehren aus dem Dateidialog)
      }
    }
    setTimeout(poll, st?.running ? 250 : 1000);
  }

  async function start() {
    $('to-server').addEventListener('click', () => {
      try { localStorage.setItem(MODE_KEY, 'server'); } catch {}
    });
    if (!E) {
      $('main').replaceChildren(h('div', { class: 'card' }, 'Der Handy-Sender ist Teil der AirDeck-App für Android. Im Browser gibt es ihn nicht – dort sendet das Studio über den AirDeck-Server.'));
      return;
    }
    try { localStorage.setItem(MODE_KEY, 'handy'); } catch {}
    cfg = await E.getConfig();
    build();
    render(await E.status());
    poll();
  }

  void start();
})();
