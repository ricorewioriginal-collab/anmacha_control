// @ts-check
// Verbindung zu einem AirDeck-Server (docs/architecture/NETWORK.md „Server hinzufügen“):
// Verbindungstest in Stufen – jede Stufe meldet ein eigenes Ergebnis mit einem gezielten Hinweis –,
// Kopplung per Code, Versionsprüfung und gespeicherte Serverprofile.

/** API-Hauptversion, die dieser Client spricht */
export const CLIENT_API_MAJOR = 1;
const PROFILES_KEY = 'airdeck.profiles';

/**
 * @typedef {{ id: string, label: string, ok: boolean, detail?: string, hint?: string }} Step
 * @typedef {{ base: string, name: string, token: string, lastConnected: string }} Profile
 */

/** Adresse vereinheitlichen: http:// ergänzen, Standardport 8750, ohne Schrägstrich am Ende. */
export function normalizeServer(/** @type {string} */ input) {
  let s = String(input ?? '').trim();
  if (!s) return { url: '', error: 'Keine Adresse angegeben' };
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { url: '', error: 'Adresse ist ungültig (Beispiel: 192.168.1.20 oder http://radio.example.org)' };
  }
  if (u.protocol === 'http:' && !u.port && !/\.[a-z]{2,}$/i.test(u.hostname)) u.port = '8750';
  return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`, error: null, host: u.hostname };
}

const isLoopback = (/** @type {string} */ h) => /^(localhost|127\.|::1$|\[::1\]$|0\.0\.0\.0$)/i.test(h);

/** fetch mit Zeitgrenze */
async function timed(/** @type {string} */ url, /** @type {RequestInit} */ init = {}, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Verbindungstest. „Verbunden“ erst, wenn alle Stufen bestanden sind.
 * @param {string} address
 * @param {{ code?: string, username?: string, password?: string, token?: string }} auth
 * @param {{ native: boolean, deviceName?: string, onStep?: (s: Step) => void }} opts
 * @returns {Promise<{ ok: boolean, steps: Step[], base: string, token?: string, serverName?: string }>}
 */
export async function testConnection(address, auth, opts) {
  /** @type {Step[]} */
  const steps = [];
  const push = (/** @type {Step} */ s) => { steps.push(s); opts.onStep?.(s); return s.ok; };
  const done = (/** @type {string} */ base, /** @type {any} */ extra = {}) => ({ ok: steps.every((s) => s.ok), steps, base, ...extra });

  // 1 Adresse
  const n = address.trim() === '' && !opts.native ? { url: '', error: null, host: location.hostname } : normalizeServer(address);
  if (n.error) return push({ id: 'address', label: 'Adresse', ok: false, detail: n.error }), done('');
  if (opts.native && n.host && isLoopback(n.host)) {
    push({ id: 'address', label: 'Adresse', ok: false, detail: `${n.host} ist das Handy selbst`, hint: 'Gib die Adresse des PCs ein (z. B. 192.168.1.20). Am PC steht sie unter „Android-App“.' });
    return done(n.url);
  }
  push({ id: 'address', label: 'Adresse', ok: true, detail: n.url || location.origin });
  const base = n.url;

  // 2 Erreichbarkeit (bei HTTPS schließt das ein gültiges Zertifikat ein)
  let health;
  try {
    const r = await timed(`${base}/api/v1/health`);
    health = await r.json().catch(() => null);
    push({ id: 'reach', label: 'Server erreichbar', ok: true });
  } catch {
    push({
      id: 'reach', label: 'Server erreichbar', ok: false, detail: 'Keine Antwort',
      hint: base.startsWith('https:')
        ? 'Prüfe Adresse und Zertifikat (HTTPS über den Reverse Proxy).'
        : 'Prüfe: gleiches WLAN? Am PC in AirDeck „Android-App → Im Netzwerk erreichbar“ eingeschaltet und AirDeck neu gestartet? Windows-Firewall-Freigabe bestätigt?',
    });
    return done(base);
  }

  // 3 Ist das AirDeck?
  if (!health || health.name !== 'AirDeck') {
    push({ id: 'airdeck', label: 'AirDeck erkannt', ok: false, detail: 'Unter dieser Adresse antwortet kein AirDeck', hint: 'Port prüfen (Standard 8750).' });
    return done(base);
  }
  push({ id: 'airdeck', label: 'AirDeck erkannt', ok: true, detail: `Version ${health.version ?? '?'}` });

  // 4 Version
  const major = Number(String(health.api ?? '0').split('.')[0]);
  if (!health.api || major < CLIENT_API_MAJOR) {
    push({ id: 'version', label: 'Version passt', ok: false, detail: 'AirDeck Server benötigt ein Update', hint: 'Den PC/Server auf die aktuelle AirDeck-Version aktualisieren.' });
    return done(base);
  }
  if (major > CLIENT_API_MAJOR) {
    push({ id: 'version', label: 'Version passt', ok: false, detail: 'Diese App benötigt ein Update', hint: 'Die aktuelle App direkt vom Server laden: …/download/AirDeck-Android.apk' });
    return done(base);
  }
  push({ id: 'version', label: 'Version passt', ok: true, detail: `API ${health.api}` });

  // 5 Anmeldung
  let token = String(auth.token ?? '').trim();
  const post = (/** @type {string} */ p, /** @type {any} */ body) => timed(`${base}/api/v1${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    if (auth.code) {
      const r = await post('/pair', { code: auth.code, name: opts.deviceName ?? 'Gerät', platform: opts.native ? 'android' : 'web' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return push({ id: 'login', label: 'Anmeldung', ok: false, detail: d.message ?? `Fehler ${r.status}`, hint: 'Am PC unter „Android-App → Gerät koppeln“ einen neuen Code erzeugen.' }), done(base);
      token = d.token;
    } else if (auth.username || auth.password) {
      const r = await post('/auth/login', { username: auth.username, password: auth.password });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const st = await timed(`${base}/api/v1/auth/status`).then((x) => x.json()).catch(() => ({}));
        const hint = st.users === false ? 'Auf diesem AirDeck gibt es keine Benutzerkonten – mit Kopplungscode verbinden (am PC: „Android-App → Gerät koppeln“).' : undefined;
        return push({ id: 'login', label: 'Anmeldung', ok: false, detail: d.message ?? `Fehler ${r.status}`, hint }), done(base);
      }
      token = d.token;
    }
    if (!token) return push({ id: 'login', label: 'Anmeldung', ok: false, detail: 'Kopplungscode, Benutzername/Passwort oder Verbindungslink angeben' }), done(base);
    push({ id: 'login', label: 'Anmeldung', ok: true });
  } catch {
    push({ id: 'login', label: 'Anmeldung', ok: false, detail: 'Verbindung während der Anmeldung abgebrochen' });
    return done(base);
  }

  // 6 Rechte und Sender
  try {
    const hdr = { headers: { Authorization: `Bearer ${token}` } };
    const me = await timed(`${base}/api/v1/me`, hdr);
    if (!me.ok) return push({ id: 'rights', label: 'Rechte', ok: false, detail: me.status === 401 ? 'Zugang ungültig oder widerrufen' : `Fehler ${me.status}` }), done(base);
    const stations = await timed(`${base}/api/v1/stations`, hdr).then((r) => (r.ok ? r.json() : []));
    if (!Array.isArray(stations) || !stations.length) return push({ id: 'rights', label: 'Rechte', ok: false, detail: 'Kein Sender freigegeben', hint: 'Beim Koppeln bzw. in der Benutzerverwaltung einen Sender zuweisen.' }), done(base);
    push({ id: 'rights', label: 'Rechte', ok: true, detail: `${stations.length} Sender` });
    return done(base, { token, serverName: stations[0]?.name ?? 'AirDeck' });
  } catch {
    push({ id: 'rights', label: 'Rechte', ok: false, detail: 'Abfrage fehlgeschlagen' });
    return done(base);
  }
}

// ---------- Serverprofile ----------

/** @returns {Profile[]} */
export function loadProfiles() {
  try {
    const v = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((p) => p && typeof p.base === 'string') : [];
  } catch {
    return [];
  }
}

/** @param {Profile} p */
export function saveProfile(p) {
  const list = loadProfiles().filter((x) => x.base !== p.base);
  list.unshift(p);
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {}
}

export function removeProfile(/** @type {string} */ base) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(loadProfiles().filter((x) => x.base !== base)));
  } catch {}
}

/** Kurzer Gerätename für die Geräteliste am Server */
export function deviceName(/** @type {boolean} */ native) {
  const ua = navigator.userAgent;
  const model = /Android [\d.]+; ([^;)]+)/.exec(ua)?.[1]?.trim();
  if (native) return model ? `AirDeck-App (${model})` : 'AirDeck-App';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  return `Browser (${os})`;
}
