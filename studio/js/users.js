// @ts-check
// Benutzer & Rollen (nur Administratoren): Konten anlegen, Rollen und Sender zuordnen, sperren, Passwort zurücksetzen.
import { clockTime, formDialog, h, run, status } from './ui.js';

/** @typedef {{ api: import('./api.js').Api, stations: () => any[], me: () => any }} Ctx */

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountUsers(root, ctx) {
  /** @type {any[]} */ let roles = [];

  async function show() {
    const d = await ctx.api.get('/users');
    roles = d.roles;
    const label = (/** @type {string} */ r) => roles.find((x) => x.id === r)?.label ?? r;
    const stationName = (/** @type {string} */ id) => (id === '*' ? 'alle Sender' : ctx.stations().find((s) => s.id === id)?.name ?? id);
    root.replaceChildren(
      h('div', { class: 'lf-head' }, h('div', { class: 'lf-title' }, h('strong', {}, 'Benutzer & Rollen'), h('span', { class: 'muted' }, ` · ${d.users.length} Konten`)),
        h('button', { class: 'btn small primary', onclick: () => edit(null) }, '＋ Benutzer')),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Rollen')),
        ...roles.map((r) => h('div', { class: 'kv' }, h('span', {}, h('b', {}, r.label)), h('span', { class: 'muted small' }, r.scopes.includes('*') ? 'alle Rechte, Benutzer, Einstellungen' : r.scopes.filter((/** @type {string} */ s) => s.endsWith(':write') || s.endsWith(':trigger')).map((/** @type {string} */ s) => s.split(':')[0]).join(', ') || 'nur lesen'))),
        h('p', { class: 'muted' }, 'laut.fm-Sender melden sich automatisch über das Radioadmin-Token an. Für die App und Integrationen gibt es zusätzlich Verbindungslinks bzw. API-Tokens.')),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Konten')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Benutzer'), h('th', {}, 'Rollen'), h('th', {}, 'Sender'), h('th', {}, 'Letzte Anmeldung'), h('th', {}))),
          h('tbody', {}, ...d.users.map((/** @type {any} */ u) => h('tr', {},
            h('td', {}, h('b', {}, u.name), h('div', { class: 'muted small' }, `@${u.username}${u.disabled ? ' · gesperrt' : ''}${u.mustChangePassword ? ' · Passwort muss geändert werden' : ''}`)),
            h('td', {}, u.roles.map(label).join(', ')),
            h('td', {}, u.stationIds.map(stationName).join(', ')),
            h('td', { class: 'num muted' }, u.lastLoginAt ? `${new Date(u.lastLoginAt).toLocaleDateString('de-DE')} ${clockTime(Date.parse(u.lastLoginAt))}` : '–'),
            h('td', { class: 'act' }, h('button', { class: 'btn small', onclick: () => edit(u) }, 'Bearbeiten')))))))),
    );
  }

  /** @param {any} u */
  async function edit(u) {
    const stations = ctx.stations();
    const all = !u || u.stationIds.includes('*');
    const v = await formDialog(u ? `Benutzer: ${u.name}` : 'Neuer Benutzer', [
      ...(u ? [] : [{ name: 'username', label: 'Benutzername (Anmeldename)', value: '', required: true, hint: 'a–z, 0–9, Punkt, Minus, Unterstrich' }]),
      { name: 'name', label: 'Anzeigename', value: u?.name ?? '' },
      ...roles.map((r) => ({ name: `role_${r.id}`, label: `Rolle: ${r.label}`, type: 'checkbox', value: u ? u.roles.includes(r.id) : r.id === 'dj' })),
      { name: 'allStations', label: 'Zugriff auf alle Sender', type: 'checkbox', value: all },
      ...stations.map((s) => ({ name: `st_${s.id}`, label: `Sender: ${s.name}`, type: 'checkbox', value: !all && u?.stationIds.includes(s.id) })),
      { name: 'password', label: u ? 'Neues Passwort (leer = unverändert)' : 'Einmal-Passwort', type: 'password', value: '', required: !u, hint: 'Mind. 10 Zeichen. Bei der ersten Anmeldung wird ein eigenes Passwort verlangt.' },
      ...(u ? [
        { name: 'disabled', label: 'Konto sperren (beendet alle Sitzungen)', type: 'checkbox', value: !!u.disabled },
        ...(u.id !== ctx.me()?.user?.id ? [{ name: 'remove', label: 'Benutzer löschen', type: 'checkbox', value: false }] : []),
      ] : []),
    ], u ? 'Speichern' : 'Anlegen');
    if (!v) return;
    if (v.remove) {
      if (!confirm(`Benutzer „${u.name}“ endgültig löschen?`)) return;
      await run(() => ctx.api.del(`/users/${u.id}`));
      return run(show);
    }
    const body = {
      name: v.name,
      roles: roles.filter((r) => v[`role_${r.id}`]).map((r) => r.id),
      stationIds: v.allStations ? ['*'] : stations.filter((s) => v[`st_${s.id}`]).map((s) => s.id),
      ...(v.password ? { password: v.password, mustChangePassword: true } : {}),
      ...(u ? { disabled: v.disabled } : { username: v.username }),
    };
    if (!body.stationIds.length) return status('Mindestens einen Sender oder „alle Sender“ wählen', true);
    const r = await run(() => (u ? ctx.api.patch(`/users/${u.id}`, body) : ctx.api.post('/users', body)));
    if (r) status(u ? 'Benutzer gespeichert' : `Benutzer „${r.username}“ angelegt – Anmeldung mit dem Einmal-Passwort`);
    run(show);
  }

  return { show: () => run(show) };
}
