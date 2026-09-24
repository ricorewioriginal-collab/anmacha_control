// @ts-check
// Anbindungen an bestehende Systeme: AzuraCast, Icecast, beliebige Streams (SAM, mAirList, RadioDJ, eigene Automation).
import { formDialog, h, run, status } from './ui.js';

const KIND = /** @type {Record<string,string>} */ ({ azuracast: 'AzuraCast', icecast: 'Icecast-Server', stream: 'Stream-Adresse (Relay)' });

/** @typedef {{ api: import('./api.js').Api, url: (p: string) => string }} Ctx */

/** @param {HTMLElement} root @param {Ctx} ctx */
export function mountBridges(root, ctx) {
  /** @param {string} title @param {...(Node|string|null|false)} body */
  const card = (title, ...body) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title)), ...body);
  /** @param {string} k @param {any} v */
  const kv = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'muted' }, k), h('span', {}, v === null || v === undefined || v === '' ? '–' : String(v)));

  async function show() {
    const list = /** @type {any[]} */ (await ctx.api.get(ctx.url('/bridges')));
    root.replaceChildren(
      h('div', { class: 'lf-head' }, h('div', { class: 'lf-title' }, h('strong', {}, 'Anbindungen'), h('span', { class: 'muted' }, ' · bestehende Systeme verbinden')),
        h('button', { class: 'btn small primary', onclick: () => edit(null) }, '＋ Anbindung')),
      card('So funktioniert die Brücke',
        h('p', {}, 'Deine bestehende Technik läuft weiter, zum Beispiel AzuraCast mit Icecast, SAM Broadcaster, mAirList, RadioDJ oder ein reines Web-Relay. AirDeck verbindet sich damit, statt alles neu aufzubauen:'),
        h('ul', {},
          h('li', {}, h('b', {}, 'Relay übernehmen: '), 'Der vorhandene Stream wird zur AirDeck-Quelle mit eigener Priorität. Priorität 5 macht ihn zum Hauptprogramm vor der AirDeck-Automation (10), 20 zum Notfall-Programm dahinter. Live-Sendungen (1–3) übernehmen wie gewohnt.'),
          h('li', {}, h('b', {}, 'Status spiegeln: '), 'Titel, Hörer und Verlauf aus AzuraCast oder Icecast erscheinen in AirDeck, auf der Statusseite, im Widget und in den Webhooks.'),
          h('li', {}, h('b', {}, 'Für Entwickler: '), 'Die Bridge-API ordnet externe Schlüssel fest einem Sender zu. Wiederholte Synchronisierungen legen nichts doppelt an. Details in docs/BRIDGE.md.'))),
      ...(list.length ? list.map((b) => card(`${b.name} · ${KIND[b.kind] ?? b.kind}`,
        kv('Adresse', b.url + (b.station ? ` · ${b.station}` : '')),
        kv('Relay', b.pull ? `aktiv, Priorität ${b.priority}${b.relay ? ` · ${({ streaming: 'empfängt', connecting: 'verbindet …', retrying: 'neuer Versuch', stopped: 'gestoppt' })[b.relay.state] ?? b.relay.state}${b.relay.error ? ` (${b.relay.error})` : ''} · ${(b.relay.bytes / 1048576).toFixed(1)} MB` : ''}` : 'aus'),
        kv('Status-Spiegel', b.mirror ? (b.status?.error ? `Fehler: ${b.status.error}` : b.status?.data ? `${b.status.data.now ? `${b.status.data.now.artist} – ${b.status.data.now.title}` : 'kein Titel'} · ${b.status.data.listeners ?? '?'} Hörer${b.status.data.live?.active ? ` · LIVE: ${b.status.data.live.streamer ?? ''}` : ''}` : 'wird abgefragt …') : 'aus'),
        h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => edit(b) }, 'Bearbeiten'),
          h('button', { class: 'btn small danger', onclick: () => confirm(`Anbindung „${b.name}“ entfernen? Die Relay-Quelle wird ebenfalls entfernt.`) && run(async () => { await ctx.api.del(ctx.url(`/bridges/${b.id}`)); show(); }) }, 'Entfernen'))))
        : [h('div', { class: 'empty' }, 'Noch keine Anbindung.')]),
    );
  }

  /** @param {any} b */
  async function edit(b) {
    const v = await formDialog(b ? `Anbindung: ${b.name}` : 'Neue Anbindung', [
      { name: 'kind', label: 'System', value: b?.kind ?? 'azuracast', options: Object.entries(KIND).map(([k, l]) => /** @type {[string,string]} */ ([k, l])) },
      { name: 'name', label: 'Name', value: b?.name ?? '', required: true },
      { name: 'url', label: 'Adresse', value: b?.url ?? 'https://', required: true, hint: 'AzuraCast: https://radio.example · Icecast: http://server:8000 · Stream: vollständige Stream-URL (auch SAM/mAirList/RadioDJ-Encoder-Ausgang)' },
      { name: 'station', label: 'AzuraCast: Sender-Kurzname/ID · Icecast: Mount', value: b?.station ?? '', hint: 'z. B. azuratest_radio bzw. /live' },
      { name: 'apiKey', label: `AzuraCast-API-Key (optional${b?.hasKey ? ', leer = unverändert, "-" = löschen' : ''})`, type: 'password', value: '', hint: 'Nur für nicht öffentliche Sender nötig – AzuraCast → Mein Konto → API-Schlüssel' },
      { name: 'mirror', label: 'Status spiegeln (Titel, Hörer, Verlauf)', type: 'checkbox', value: b?.mirror ?? true },
      { name: 'pull', label: 'Stream als AirDeck-Quelle übernehmen (Relay)', type: 'checkbox', value: b?.pull ?? false },
      { name: 'pullUrl', label: 'Stream-Adresse fürs Relay (optional, sonst aus dem Status)', value: b?.pullUrl ?? '' },
      { name: 'priority', label: 'Priorität der Relay-Quelle (kleiner = wichtiger)', type: 'number', value: b?.priority ?? 20, hint: '5 = Hauptprogramm vor der AirDeck-Automation, 20 = Notfall dahinter' },
    ], 'Speichern & verbinden');
    if (!v) return;
    const body = { ...v, ...(v.apiKey ? { apiKey: v.apiKey === '-' ? '' : v.apiKey } : { apiKey: undefined }) };
    const r = await run(() => (b ? ctx.api.patch(ctx.url(`/bridges/${b.id}`), body) : ctx.api.post(ctx.url('/bridges'), body)));
    if (r) status(`Anbindung „${r.name}“ gespeichert`);
    setTimeout(() => run(show), 1500);
  }

  return { show: () => run(show) };
}
