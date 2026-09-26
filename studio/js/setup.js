// @ts-check
// Setup-Assistent (docs/architecture/INSTALLATION.md): 12 Schritte, jeder überspringbar und später änderbar.

import { $, h, status } from './ui.js';

/**
 * @typedef {{ name: string, label: string, type?: string, value?: any, options?: [string, string][], hint?: string }} Field
 * @typedef {{ id: string, title: string, intro: string, fields: (s: any) => Field[], auto?: (s: any) => boolean }} Step
 */

const MODE_TEXT = /** @type {[string, string][]} */ ([
  ['local', 'Local – alles auf diesem PC (Standard für das Desktop-Programm)'],
  ['server', 'Self-Hosted – Server/Docker, Zugriff per Browser und App'],
  ['hybrid', 'Hybrid – lokal senden, zusätzlich mit einem Server abgleichen'],
]);

/** @type {Step[]} */
const STEPS = [
  {
    id: 'welcome', title: 'Willkommen bei AirDeck',
    intro: 'In wenigen Schritten ist dein Sender eingerichtet. Jeder Schritt lässt sich überspringen und später unter „Einstellungen“ ändern.',
    fields: () => [
      { name: 'info', label: 'Hinweis', type: 'info', value: 'AirDeck ist ein Hobbyprojekt (powered by AnMaCha Radioproduktion & RicoReWi). Nutzung auf eigene Verantwortung, ohne Gewähr – siehe Haftungsausschluss im Handbuch. Für GEMA/GVL und andere Rechte ist der Sender selbst verantwortlich.' },
      { name: 'accept', label: 'Haftungsausschluss gelesen und akzeptiert', type: 'checkbox', value: false },
    ],
  },
  {
    id: 'mode', title: 'Betriebsart', intro: 'Wo läuft AirDeck?',
    fields: (s) => [{ name: 'mode', label: 'Betriebsart', value: s.current.mode, options: MODE_TEXT, hint: 'Änderung wirkt nach einem Neustart' }],
  },
  {
    id: 'database', title: 'Datenbank', intro: 'Für einen PC reicht SQLite (nichts zu installieren). Für Server mit mehreren Personen empfiehlt sich PostgreSQL.',
    fields: (s) => [
      { name: 'provider', label: 'Datenbank', value: s.current.database.provider, options: [['sqlite', 'SQLite (Standard, Datei im Datenordner)'], ['postgres', 'PostgreSQL'], ['mysql', 'MariaDB / MySQL']] },
      { name: 'url', label: 'Verbindungsadresse (nur PostgreSQL/MariaDB/MySQL)', value: s.current.database.provider === 'sqlite' ? '' : s.current.database.url.replace('***@', '@'), hint: 'z. B. postgres://airdeck@localhost:5432/airdeck' },
      { name: 'password', label: 'Passwort der Datenbank', type: 'password', value: '', hint: 'Wird verschlüsselt gespeichert, nicht in der Konfigurationsdatei' },
      { name: 'copy', label: 'Bisherige Daten in die neue Datenbank übernehmen', type: 'checkbox', value: true },
    ],
  },
  {
    id: 'storage', title: 'Speicher & Musik', intro: 'Wohin kommen hochgeladene Titel – und gibt es schon eine Musiksammlung?',
    fields: (s) => [
      { name: 'media', label: 'Medienordner', value: s.current.paths.media, hint: 'Änderung wirkt nach einem Neustart' },
      { name: 'link', label: 'Vorhandenen Musikordner einbinden (optional)', value: '', hint: 'Vollständiger Pfad, z. B. D:\\Musik. Titel bleiben dort, AirDeck indiziert und überwacht den Ordner – nichts wird kopiert oder gelöscht.' },
      { name: 'category', label: 'Kategorie der eingebundenen Titel', value: 'music', options: [['music', 'Musik'], ['jingle', 'Jingles'], ['bed', 'Betten'], ['ad', 'Werbung']] },
    ],
  },
  {
    id: 'admin', title: 'Administrator-Konto', intro: 'Mit diesem Konto meldest du dich im Browser oder von einem anderen PC an. Handys koppelst du später per Code.',
    auto: (s) => s.current.users > 0,
    fields: () => [
      { name: 'username', label: 'Benutzername', value: 'admin' },
      { name: 'password', label: 'Passwort (mind. 10 Zeichen, Buchstaben und Ziffer oder Sonderzeichen)', type: 'password', value: '' },
      { name: 'repeat', label: 'Passwort wiederholen', type: 'password', value: '' },
    ],
  },
  {
    id: 'network', title: 'Netzwerk', intro: 'Wer darf AirDeck erreichen?',
    fields: (s) => [
      { name: 'access', label: 'Zugriff', value: s.current.network.lan ? 'lan' : 'local', options: [['local', 'Nur dieser PC'], ['lan', 'Im Netzwerk (Handy-App, andere PCs)']], hint: 'Für das Internet AirDeck hinter HTTPS (Reverse Proxy, z. B. Caddy) betreiben' },
      { name: 'port', label: 'Port', type: 'number', value: s.current.network.port },
    ],
  },
  {
    id: 'station', title: 'Dein Sender', intro: 'Name und Beschreibung erscheinen im Studio, auf der Statusseite und in der Titelanzeige.',
    fields: (s) => [
      { name: 'name', label: 'Sendername', value: s.current.station?.name ?? '' },
      { name: 'slogan', label: 'Slogan', value: s.current.station?.slogan ?? '' },
      { name: 'genre', label: 'Genre', value: s.current.station?.genre ?? '' },
    ],
  },
  {
    id: 'stream', title: 'Stream', intro: 'Wohin sendet AirDeck? Für laut.fm nach dem Assistenten unter „laut.fm“ verbinden – der Live-Zugang wird dann automatisch übernommen.',
    auto: (s) => s.current.outputs > 0,
    fields: () => [
      { name: 'type', label: 'Ziel', value: 'icecast', options: [['icecast', 'Icecast (z. B. eigener Server, AzuraCast)'], ['shoutcast', 'SHOUTcast']] },
      { name: 'host', label: 'Server', value: '' },
      { name: 'port', label: 'Port', type: 'number', value: 8000 },
      { name: 'mount', label: 'Mountpoint', value: '/stream' },
      { name: 'username', label: 'Benutzer', value: 'source' },
      { name: 'password', label: 'Passwort', type: 'password', value: '' },
    ],
  },
  {
    id: 'audio', title: 'Audio', intro: 'Mithören, Vorhören (CUE) und Mikrofon stellst du an diesem Gerät ein – am PC wie in der App.',
    fields: () => [{ name: 'open', label: 'Jetzt „Audio & Geräte“ öffnen', type: 'checkbox', value: true }],
  },
  {
    id: 'automation', title: 'Automation', intro: 'Die Automation spielt Queue, Sendeuhr und Sendeplan – rund um die Uhr, auch ohne geöffnetes Fenster.',
    fields: (s) => [
      { name: 'autostart', label: 'Nach einem Neustart automatisch wieder senden', type: 'checkbox', value: s.current.automation?.autostart ?? true },
      { name: 'emergencyFolder', label: 'Notfall-Ordner (spielt, wenn nichts anderes geplant ist)', value: s.current.automation?.emergencyFolder ?? '' },
      { name: 'start', label: s.current.ffmpeg ? 'Automation jetzt starten' : 'Automation jetzt starten (ffmpeg fehlt – nicht möglich)', type: 'checkbox', value: false },
    ],
  },
  {
    id: 'ai', title: 'KI (optional)', intro: 'Moderationen, Nachrichten und Musikplanung per KI – mit eigenen Schlüsseln oder lokal ohne Kosten.',
    fields: () => [
      { name: 'kind', label: 'KI', value: 'none', options: [['none', 'Keine (später einrichten)'], ['local', 'Lokal: Ollama auf diesem Rechner suchen'], ['cloud', 'Cloud-Anbieter (Schlüssel unter „KI“ eintragen)']] },
      { name: 'ollamaUrl', label: 'Ollama-Adresse', value: 'http://127.0.0.1:11434' },
    ],
  },
  {
    id: 'finish', title: 'Fertig', intro: '',
    fields: (s) => [
      { name: 'summary', label: 'Zusammenfassung', type: 'info', value: summary(s) },
      ...(s.restart.length ? [{ name: 'restart', label: s.canRestart ? 'AirDeck jetzt neu starten (nötig für die Änderungen)' : 'Bitte AirDeck neu starten, damit alle Änderungen gelten', type: s.canRestart ? 'checkbox' : 'info', value: s.canRestart ? true : '' }] : []),
    ],
  },
];

const RESTART_LABEL = /** @type {Record<string, string>} */ ({ mode: 'Betriebsart', database: 'Datenbank', network: 'Netzwerk', paths: 'Medienordner' });

function summary(/** @type {any} */ s) {
  const c = s.current;
  const done = Object.entries(s.steps).filter(([, v]) => v === 'done').length;
  return [
    `Sender: ${c.station?.name ?? '–'}`, `Betriebsart: ${c.mode}`, `Datenbank: ${c.database.provider}`,
    `Ausgänge: ${c.outputs}`, `Eingebundene Ordner: ${c.linkedFolders.length}`, `Schritte erledigt: ${done} von ${STEPS.length - 1}`,
    s.restart.length ? `Nach Neustart aktiv: ${s.restart.map((/** @type {string} */ r) => RESTART_LABEL[r] ?? r).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
}

/** Felder rendern (dieselben Typen wie formDialog) */
function renderField(/** @type {Field} */ f) {
  const id = `sw-${f.name}`;
  /** @type {HTMLElement} */
  let input;
  if (f.type === 'info') input = h('output', { id, class: 'info' }, String(f.value ?? ''));
  else if (f.options) input = h('select', { id, name: f.name }, ...f.options.map(([v, l]) => h('option', { value: v, selected: String(f.value) === v }, l)));
  else if (f.type === 'checkbox') input = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
  else input = h('input', { id, name: f.name, type: f.type ?? 'text', value: f.value ?? '', autocomplete: 'off' });
  return h('div', { class: 'field' }, h('label', { for: id }, f.label), input, f.hint ? h('small', {}, f.hint) : null);
}

/**
 * Assistent öffnen.
 * @param {{ api: any, onAudio: () => Promise<void>, onDone: () => void }} ctx
 */
export async function runSetup(ctx) {
  let s = await ctx.api.get('/setup');
  const dlg = /** @type {HTMLDialogElement} */ ($('dialog'));
  const form = /** @type {HTMLFormElement} */ ($('dialog-form'));
  let i = 0;

  const values = () => {
    /** @type {Record<string, any>} */
    const out = {};
    for (const el of /** @type {any} */ (form.elements)) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
    }
    return out;
  };

  const render = (/** @type {string} */ error = '') => {
    const step = STEPS[i];
    form.onsubmit = (e) => e.preventDefault();
    form.replaceChildren(
      h('div', { class: 'wizard-head' }, h('small', { class: 'muted' }, `Einrichtung · Schritt ${i + 1} von ${STEPS.length}`), h('h3', {}, step.title)),
      h('div', { class: 'wizard-bar' }, h('i', { style: `width:${Math.round(((i + 1) / STEPS.length) * 100)}%` })),
      step.intro ? h('p', { class: 'muted' }, step.intro) : null,
      ...(step.auto?.(s) ? [h('p', {}, '✔ Bereits eingerichtet – dieser Schritt kann übersprungen werden.')] : []),
      ...step.fields(s).map(renderField),
      error ? h('p', { class: 'wizard-error', role: 'alert' }, error) : null,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Später'),
        i > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => { i--; render(); } }, 'Zurück') : null,
        step.id !== 'finish' && step.id !== 'welcome' ? h('button', { class: 'btn', type: 'button', onclick: () => void next(true) }, 'Überspringen') : null,
        h('button', { class: 'btn primary', type: 'button', onclick: () => void next(false) }, step.id === 'finish' ? 'Abschließen' : 'Weiter')),
    );
  };

  const close = () => {
    dlg.close();
    form.onsubmit = null;
    ctx.onDone();
  };

  const next = async (/** @type {boolean} */ skip) => {
    const step = STEPS[i];
    const v = values();
    try {
      if (skip || step.auto?.(s)) {
        s = await ctx.api.put(`/setup/${step.id}`, { skip: true });
      } else if (step.id === 'admin' && v.password !== v.repeat) {
        return render('Die Passwörter stimmen nicht überein');
      } else if (step.id === 'stream' && !String(v.host ?? '').trim()) {
        s = await ctx.api.put(`/setup/${step.id}`, { skip: true });
      } else if (step.id === 'audio') {
        s = await ctx.api.put('/setup/audio', {});
        if (v.open) {
          dlg.close();
          await ctx.onAudio();
          dlg.showModal();
        }
      } else if (step.id === 'ai' && v.kind === 'none') {
        s = await ctx.api.put('/setup/ai', { skip: true });
      } else {
        render('');
        s = await ctx.api.put(`/setup/${step.id}`, v);
        if (step.id === 'ai' && s.ollamaModels) status(`Ollama gefunden: ${s.ollamaModels.length} Modelle – Auswahl unter „KI“`);
      }
    } catch (e) {
      return render(e instanceof Error ? e.message : String(e));
    }
    if (step.id === 'finish') {
      dlg.close();
      form.onsubmit = null;
      if (v.restart && s.canRestart) {
        status('AirDeck wird neu gestartet …');
        await ctx.api.post('/system/restart').catch(() => {});
        setTimeout(() => location.reload(), 6000);
        return;
      }
      status('Einrichtung abgeschlossen');
      ctx.onDone();
      return;
    }
    i++;
    render();
  };

  render();
  dlg.returnValue = '';
  if (!dlg.open) dlg.showModal();
}
