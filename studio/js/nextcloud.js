// @ts-check
// Nextcloud-Brücke: Medien in der eigenen Cloud durchsuchen und in die Bibliothek übernehmen.
import { formDialog, h, run, status } from './ui.js';

const CATS = /** @type {[string,string][]} */ ([['music', 'Musik'], ['jingle', 'Jingle'], ['station_id', 'Station ID'], ['sweeper', 'Sweeper'], ['drop', 'Drop'], ['news', 'News'], ['ad', 'Werbung'], ['bed', 'Bett'], ['voice_track', 'Voice Track']]);

/** @typedef {{ api: import('./api.js').Api, url: (p: string) => string }} Ctx */

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountNextcloud(root, ctx) {
  let path = '/';
  /** @type {any} */ let cfg = null;
  const selected = new Set();

  /** @param {string} title @param {...(Node|string|null|false)} body */
  const card = (title, ...body) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title)), ...body);

  async function show() {
    cfg = await ctx.api.get('/nextcloud').catch(() => null);
    render();
  }

  function head() {
    return h('div', { class: 'lf-head' },
      h('div', { class: 'lf-title' }, h('strong', {}, 'Nextcloud'), h('span', { class: 'muted' }, cfg?.url ? ` · ${cfg.user} @ ${cfg.url.replace(/^https?:\/\//, '')}${cfg.root !== '/' ? cfg.root : ''}` : ' · nicht verbunden')),
      h('button', { class: 'btn small', onclick: configure }, cfg?.url ? 'Verbindung …' : 'Verbinden …'));
  }

  async function render() {
    if (!cfg?.url) {
      root.replaceChildren(head(), card('Nextcloud verbinden',
        h('p', {}, 'Greife auf Musik, Jingles und Beiträge in deiner Nextcloud zu und übernimm sie per Fingertipp in die AirDeck-Bibliothek. Mitschnitte kannst du im Recorder direkt in die Cloud hochladen.'),
        h('ol', {},
          h('li', {}, 'In der Nextcloud: Einstellungen → Sicherheit → „Neues App-Passwort erstellen“ (Name z. B. AirDeck).'),
          h('li', {}, 'Hier Adresse, Benutzername und App-Passwort eintragen, optional einen Startordner wie /Radio.')),
        h('button', { class: 'btn primary', onclick: configure }, 'Verbinden …')));
      return;
    }
    root.replaceChildren(head(), h('div', { class: 'empty' }, 'Lade …'));
    const r = await run(() => ctx.api.get(`/nextcloud/list?path=${encodeURIComponent(path)}`));
    if (!r) return root.replaceChildren(head(), card('Fehler', h('p', {}, 'Ordner konnte nicht geladen werden – Verbindung prüfen.'), h('button', { class: 'btn', onclick: () => { path = '/'; render(); } }, 'Zum Startordner')));
    const parts = path.split('/').filter(Boolean);
    const crumbs = h('div', { class: 'nc-crumbs' },
      h('button', { class: 'btn small', onclick: () => go('/') }, '☁ Start'),
      ...parts.map((p, i) => h('button', { class: 'btn small', onclick: () => go('/' + parts.slice(0, i + 1).join('/')) }, p)));
    const cat = /** @type {HTMLSelectElement} */ (h('select', {}, ...CATS.map(([v, l]) => h('option', { value: v }, l))));
    const count = h('span', { class: 'muted' });
    const updateCount = () => (count.textContent = selected.size ? `${selected.size} ausgewählt` : 'Tippe Dateien oder Ordner an');
    updateCount();
    const rows = r.entries.map((/** @type {any} */ e) => {
      const chk = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: selected.has(e.path), disabled: !e.dir && !e.audio, onchange: () => { chk.checked ? selected.add(e.path) : selected.delete(e.path); updateCount(); } }));
      return h('li', { class: `nc-row${e.dir ? ' dir' : ''}${!e.dir && !e.audio ? ' off' : ''}` },
        h('label', { class: 'nc-chk' }, chk),
        h('button', { class: 'nc-name', disabled: !e.dir && !e.audio, onclick: () => (e.dir ? go(e.path) : (chk.checked = !chk.checked, chk.dispatchEvent(new Event('change')))) },
          h('span', { class: 'nc-ico' }, e.dir ? '📁' : e.audio ? '🎵' : '·'), h('span', {}, e.name)),
        h('span', { class: 'muted num' }, e.dir ? '' : `${(e.size / 1048576).toFixed(1)} MB`));
    });
    root.replaceChildren(head(), card(path === '/' ? 'Startordner' : parts.at(-1) ?? '',
      crumbs,
      rows.length ? h('ul', { class: 'nc-list' }, ...rows) : h('div', { class: 'empty' }, 'Ordner ist leer.'),
      h('div', { class: 'nc-bar' }, count, h('span', { class: 'muted' }, 'als'), cat,
        h('button', { class: 'btn primary', onclick: () => importSel(cat.value) }, 'In die Bibliothek übernehmen'))));
  }

  /** @param {string} p */
  function go(p) {
    path = p;
    render();
  }

  /** @param {string} category */
  async function importSel(category) {
    if (!selected.size) return status('Erst Dateien oder Ordner auswählen', true);
    status(`Übernehme ${selected.size} Auswahl(en) aus der Nextcloud …`);
    const r = await run(() => ctx.api.post(ctx.url('/nextcloud/import'), { paths: [...selected], category }));
    if (!r) return;
    selected.clear();
    status(`${r.imported} Datei(en) übernommen${r.skipped ? `, ${r.skipped} schon vorhanden` : ''}${r.errors.length ? ` · Fehler: ${r.errors[0]}` : ''}`, r.errors.length > 0);
    render();
  }

  async function configure() {
    const v = await formDialog('Nextcloud-Verbindung', [
      { name: 'url', label: 'Nextcloud-Adresse', value: cfg?.url ?? 'https://', required: true },
      { name: 'user', label: 'Benutzername', value: cfg?.user ?? '', required: true },
      { name: 'password', label: cfg?.hasPassword ? 'App-Passwort (leer = unverändert)' : 'App-Passwort', type: 'password', value: '', hint: 'Nextcloud → Einstellungen → Sicherheit → App-Passwort. Wird verschlüsselt gespeichert.' },
      { name: 'root', label: 'Startordner', value: cfg?.root ?? '/', hint: 'z. B. /Radio – nur dieser Ordner ist sichtbar' },
      ...(cfg?.url ? [{ name: 'remove', label: 'Verbindung entfernen', type: 'checkbox', value: false }] : []),
    ], 'Speichern & testen');
    if (!v) return;
    const saved = await run(() => ctx.api.put('/nextcloud', v.remove ? { remove: true } : v));
    if (!saved) return;
    cfg = saved.url ? saved : null;
    path = '/';
    if (cfg) {
      const ok = await ctx.api.get('/nextcloud/list?path=/').then(() => true).catch((/** @type {Error} */ e) => (status(`Verbindung gespeichert, aber: ${e.message}`, true), false));
      if (ok) status('Nextcloud verbunden');
    }
    render();
  }

  return { show: () => run(show) };
}
