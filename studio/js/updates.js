// @ts-check
// Update-Funktion im Studio: Windows installiert über den AirDeck-Server, Android lädt die neue APK.
import { isNativeApp } from './api.js';
import { $, formDialog, run, status } from './ui.js';

/** @typedef {import('./api.js').Api} Api */

/** Build der ausgelieferten Oberfläche (build.json wird beim Paketieren geschrieben). */
async function clientBuild() {
  try {
    const r = await fetch('build.json', { cache: 'no-store' });
    return r.ok ? /** @type {{build:string,platform:string}} */ (await r.json()) : null;
  } catch {
    return null;
  }
}

/** @param {string} current @param {string|null} latest */
const newer = (current, latest) => !!latest && current !== 'dev' && !latest.startsWith(current) && !current.startsWith(latest);

/** @param {Api} api */
export function mountUpdates(api) {
  /** @type {any} */
  let info = null;
  /** @type {{build:string,platform:string}|null} */
  let client = null;
  const android = isNativeApp();

  const available = () => {
    if (!info?.latest) return false;
    // Android-App: eigener Build zählt; sonst der Build des Servers/Windows-Programms
    return android ? newer(client?.build ?? 'dev', info.latest) : info.available;
  };

  async function check(force = false) {
    client ??= await clientBuild();
    try {
      info = await api.get(`/update${force ? '?force=1' : ''}`);
    } catch {
      info = null;
    }
    $('update-badge').hidden = !available();
    return info;
  }

  async function openDialog() {
    const i = await run(() => check(true));
    if (!i) return;
    /** @type {any} */
    let cfg = null;
    try {
      cfg = await api.get('/update/settings');
    } catch {}
    const cur = android ? client?.build ?? 'dev' : i.current;
    const state = i.error ? `Fehler: ${i.error}` : available() ? `Neue Version ${i.latest} verfügbar` : `Aktuell (${cur})`;
    /** @type {Parameters<typeof formDialog>[1]} */
    const fields = [
      { name: 'info', label: 'Status', type: 'info', value: `Installiert: ${cur} · Neueste: ${i.latest ?? '–'}${i.publishedAt ? ` (${new Date(i.publishedAt).toLocaleString('de-DE')})` : ''}`, hint: state },
    ];
    if (cfg) {
      fields.push(
        { name: 'repo', label: 'Update-Quelle (GitHub besitzer/name)', value: cfg.repo },
        { name: 'tag', label: 'Release-Kanal (Tag)', value: cfg.tag },
        { name: 'manifestUrl', label: 'Eigene Update-Adresse (JSON, optional)', value: cfg.manifestUrl, hint: 'Leer = GitHub-Release' },
        { name: 'token', label: `Zugriffstoken für privates Repository${cfg.hasToken ? ' (leer = unverändert, "-" = löschen)' : ''}`, value: '', hint: 'GitHub → Settings → Developer settings → Fine-grained token, nur „Contents: Read“', type: 'password' },
        { name: 'autoCheck', label: 'Beim Start automatisch prüfen', value: cfg.autoCheck, type: 'checkbox' },
      );
    }
    const action = available() ? (android ? 'Neue APK laden & installieren' : cfg?.canInstall ? 'Jetzt installieren' : 'Speichern') : 'Speichern';
    const v = await formDialog('Updates', fields, action);
    if (!v) return;
    if (cfg) {
      const body = { repo: v.repo, tag: v.tag, manifestUrl: v.manifestUrl, autoCheck: v.autoCheck, ...(v.token ? { token: v.token === '-' ? '' : v.token } : {}) };
      if (!(await run(() => api.put('/update/settings', body)))) return;
      await check(true);
    }
    if (!available()) return status(info?.error ? `Update-Prüfung: ${info.error}` : 'AirDeck ist aktuell');
    if (android) {
      // APK kommt über den verbundenen AirDeck-Server (Token bleibt dort) und wird vom System-Installer geöffnet
      const url = `${api.base}/api/v1/update/apk?token=${encodeURIComponent(api.token)}`;
      window.open(url, '_system');
      status('APK wird geladen – danach „Installieren“ bestätigen (einmalig „Unbekannte Apps installieren“ erlauben)');
    } else if (cfg?.canInstall) {
      if (!confirm(`Update ${info.latest} jetzt installieren? AirDeck wird kurz beendet und startet danach neu. Laufende Sendungen werden unterbrochen.`)) return;
      const r = await run(() => api.post('/update/install'));
      if (r) status(`Update ${r.to} wird installiert – AirDeck startet gleich neu …`);
    } else {
      status(`Neue Version ${info.latest}: bitte Setup bzw. Server-Paket manuell aktualisieren (Download im Release „${cfg?.tag ?? 'nightly'}“)`);
    }
  }

  $('btn-update').addEventListener('click', openDialog);
  // Automatisch prüfen: kurz nach dem Start und danach alle 6 Stunden (spart Ressourcen, Server cached 10 min)
  setTimeout(async () => {
    let auto = true;
    try {
      auto = (await api.get('/update/settings')).autoCheck;
    } catch {}
    if (!auto) return;
    await check();
    if (available()) status(`Update verfügbar: ${info.latest} – unter „Updates“ installieren`);
    setInterval(check, 6 * 3600_000);
  }, 8000);
}
