// AirDeck Server – Einstiegspunkt.
//   node src/server/main.ts               Server (Entwicklung, Node >= 22.18)
//   AirDeck.exe                           Windows-Programm: Server + Studio-Fenster (Desktop-Modus)
//   AirDeck.exe --headless                nur Server, z. B. für Autostart/24/7 ohne Fenster
//   … --new-admin-token                   neues Admin-Token ausgeben

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { format } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { API_VERSION, resolveConfig, writeDefaultConf } from './config.ts';
import { openDatabase, safeUrl } from './db/index.ts';
import type { DatabaseProvider } from './db/types.ts';
import { DbDocStore, importJsonFiles } from './repo/docs.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AirDeckApp } from './app.ts';
import { SecretStore } from './secrets.ts';
import { SyncManager } from './sync.ts';
import { createHttpServer } from './http.ts';

declare global {
  // wird im gebündelten Windows-/Desktop-Build per Banner gesetzt (scripts/build.mjs)
  var __AIRDECK_ROOT: string | undefined;
  var __AIRDECK_PACKAGED: boolean | undefined;
  var __AIRDECK_BUILD: string | undefined;
}

const argv = process.argv.slice(2);
const packaged = globalThis.__AIRDECK_PACKAGED === true;
const root = process.env.AIRDECK_ROOT ?? globalThis.__AIRDECK_ROOT ?? resolve(fileURLToPath(import.meta.url), '../../..');
const desktop = !argv.includes('--headless') && (argv.includes('--desktop') || packaged);
// Betriebsart, Port, Adresse und Pfade aus airdeck.conf (docs/architecture/STORAGE.md)
const config = resolveConfig({ env: process.env, root, packaged, desktop });
const { port, host } = config;
const dataDir = config.paths.data;
const localHost = host === '0.0.0.0' ? '127.0.0.1' : host;

/** Studio im App-Fenster öffnen (Edge/Chrome im App-Modus, sonst Standardbrowser). */
function openStudio(url: string): void {
  const detached = { detached: true, stdio: 'ignore' as const, windowsHide: true };
  if (process.platform === 'win32') {
    // '' wird von Node als "" übergeben = leerer Fenstertitel für "start"
    // Eigenes Profil: App-Fenster startet unabhängig vom normalen Edge, darf ohne Klick mithören (Autoplay)
    const profile = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AirDeck', 'browser');
    const edge = spawn('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--autoplay-policy=no-user-gesture-required'], detached);
    edge.on('exit', (code) => {
      if (code) spawn('cmd', ['/c', 'start', '', url], detached).unref();
    });
    edge.unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], detached).on('error', () => {}).unref();
  }
}

function portInUse(p: number, h: string): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer()
      .once('error', () => ok(true))
      .once('listening', () => s.close(() => ok(false)))
      .listen(p, h);
  });
}

/** Windows-Programm ohne Konsole: Ausgaben zusätzlich in data/logs/airdeck.log (mit einfacher Rotation). */
function logToFile(): string {
  const dir = config.paths.logs;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'airdeck.log');
  try {
    if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
  } catch {
    // noch keine Logdatei
  }
  const out = createWriteStream(file, { flags: 'a' });
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      out.write(`${new Date().toISOString()} ${level === 'log' ? '' : level.toUpperCase() + ' '}${format(...args)}\n`);
    };
  }
  return file;
}

/** Symbol im Infobereich (Taskleiste): Studio öffnen, Protokoll, Beenden – per PowerShell, ohne Zusatzprogramme. */
function startTray(logFile: string): void {
  const q = (s: string) => s.replace(/'/g, "''");
  const exe = process.execPath;
  const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$exe = '${q(exe)}'
$airdeckPid = ${process.pid}
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
$icon.Text = 'AirDeck läuft (Port ${port})'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Studio öffnen'); $open.add_Click({ Start-Process $exe })
$log = $menu.Items.Add('Protokoll anzeigen'); $log.add_Click({ Start-Process notepad.exe '${q(logFile)}' })
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('AirDeck beenden'); $quit.add_Click({ $icon.Text = 'AirDeck wird beendet …'; Start-Process $exe -ArgumentList '--stop' })
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process $exe })
$icon.Visible = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if (-not (Get-Process -Id $airdeckPid -ErrorAction SilentlyContinue)) { $icon.Visible = $false; $icon.Dispose(); [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', (err) => console.warn('Tray-Symbol nicht verfügbar:', err.message));
  p.unref();
}

/** Server-Datenbanken starten im Container oft später als AirDeck: bis zu 1 Minute erneut versuchen. */
async function connectDatabase(): Promise<DatabaseProvider> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await openDatabase(config.database);
    } catch (err) {
      const msg = (err as Error).message;
      // Schema neuer als das Programm oder falsche Einstellung: Warten hilft nicht
      if (config.database.provider === 'sqlite' || /Schema|fehlt die Verbindungsadresse/.test(msg) || attempt >= 20) {
        console.error(`Datenbank nicht verfügbar (${config.database.provider}): ${msg}`);
        process.exit(1);
      }
      console.warn(`Datenbank noch nicht erreichbar (Versuch ${attempt}): ${msg}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main(): Promise<void> {
  const logFile = packaged ? logToFile() : '';

  // Das Desktop-Token legt die laufende Instanz beim Start an; Hilfsaufrufe lesen es nur (ohne Datenbank)
  const secrets = new SecretStore(dataDir);
  const runningToken = () => secrets.get('desktop:token') ?? '';

  // AirDeck.exe --stop: laufende Instanz sauber beenden (Tray, Startmenü „AirDeck beenden“)
  if (argv.includes('--stop')) {
    const r = await fetch(`http://${localHost}:${port}/api/v1/system/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${runningToken()}` }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    console.log(r?.ok ? 'AirDeck wird beendet.' : 'Keine laufende AirDeck-Instanz gefunden.');
    process.exit(r?.ok ? 0 : 1);
  }

  // Zweiter Start im Desktop-Modus: nur Fenster öffnen, kein zweiter Server
  if (desktop && (await portInUse(port, host))) {
    openStudio(`http://${localHost}:${port}/#token=${runningToken()}`);
    return;
  }

  // Datenbank öffnen (Migrationen laufen dabei), bisherige JSON-Dateien einmalig übernehmen
  mkdirSync(dataDir, { recursive: true });
  const db = await connectDatabase();
  const docs = await DbDocStore.open(db);
  const imported = await importJsonFiles(dataDir, docs);
  if (imported.length) console.log(`Übernommen in die Datenbank: ${imported.join(', ')} (Dateien als *.imported aufbewahrt)`);

  // Optionaler Abgleich (MySQL/Firebase) vor dem Laden des Zustands; Fehler → lokaler Betrieb
  const sync = new SyncManager(dataDir, secrets, (event, data) => console.log(`[sync] ${event}`, data ?? ''));
  const local = docs.get<unknown>('airdeck', null);
  const decision = await sync.startup(local ? JSON.stringify(local, null, 1) : null);
  // geholter Stand liegt als airdeck.json vor → übernehmen
  if (decision === 'take_remote') await importJsonFiles(dataDir, docs);
  if (sync.config.backend !== 'local') {
    console.log(`Datenspeicher: ${sync.config.backend} – Abgleich: ${decision ?? 'nicht möglich'}${sync.status.lastError ? ` (${sync.status.lastError})` : ''}`);
  }
  if (writeDefaultConf(config)) console.log(`Grundeinstellungen angelegt: ${config.configFile}`);
  const app = new AirDeckApp(dataDir, { appRoot: root, secrets, sync, build: globalThis.__AIRDECK_BUILD ?? 'dev', packaged, headless: !desktop, config, docs });
  app.listenHost = host;
  app.listenPort = port;
  console.log(`AirDeck ${app.version} · Betriebsart: ${config.mode} · Konfiguration: ${config.configFile}`);
  console.log(`Datenbank: ${config.database.provider} (${safeUrl(config.database)})`);
  console.log(app.ffmpeg ? `ffmpeg: ${app.ffmpeg.version} (${app.ffmpeg.source})` : 'ffmpeg nicht gefunden – neuer Versuch im Hintergrund, bis dahin kein Server-Playout');

  if (argv.includes('--new-admin-token')) {
    const { token } = app.svc.auth.createToken({ name: 'admin (neu)', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
    console.log(`\n  Neues Admin-Token: ${token}\n`);
    process.exit(0);
  }
  // Eigenbetrieb (Server/Docker): erstes Administrator-Konto mit Einmal-Passwort anlegen
  if (config.mode !== 'local' && app.users.count === 0) {
    const pw = randomBytes(9).toString('base64url');
    await app.users.create({ username: 'admin', name: 'Administrator', password: `${pw}1`, roles: ['admin'], stationIds: ['*'], mustChangePassword: true });
    console.log('\n  Anmeldung im Studio – Benutzer: admin  Einmal-Passwort (bitte beim ersten Login ändern):');
    console.log(`  ${pw}1\n`);
  }
  if (!app.svc.auth.hasTokens() && !desktop) {
    const { token } = app.svc.auth.createToken({ name: 'admin', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
    console.log('\n  Admin-Token (wird nur jetzt angezeigt, sicher aufbewahren):');
    console.log(`  ${token}`);
    console.log(`\n  Studio öffnen: http://${localHost}:${port}/#token=${token}\n`);
  }

  // Gemeinsames Desktop-Token anlegen, damit ein zweiter Start (Studio öffnen, --stop, Tray) die laufende Instanz erreicht
  app.svc.auth.desktopToken();

  const server = createHttpServer(app, join(root, 'studio'));
  server.requestTimeout = 0; // Streams (Ingest, SSE, Listen) laufen dauerhaft
  server.headersTimeout = 15_000;
  // LAN-Erkennung (UDP 8751) – antwortet auch bei nur lokaler Freigabe, damit Clients „LAN aus“ melden können
  let discovery: { close(): void } | null = null;
  if (String(process.env.AIRDECK_DISCOVERY ?? '').toLowerCase() !== 'off') {
    const { startResponder } = await import('./discovery.ts');
    const { hostname } = await import('node:os');
    discovery = await startResponder(() => ({
      id: app.sync.instance, name: app.svc.stations.listStations({ id: 'discovery', tokenId: 'discovery', roles: ['admin'], stationIds: ['*'], scopes: ['*'] })[0]?.name ?? 'AirDeck',
      host: hostname(), version: app.version, api: API_VERSION, port, lan: host === '0.0.0.0' || host === '::',
    }), { log: (m) => console.warn(m) });
  }

  server.listen(port, host, () => {
    app.start();
    console.log(`AirDeck läuft auf http://${host}:${port}  (Daten: ${dataDir})`);
    if (desktop) openStudio(`http://${localHost}:${port}/#token=${app.svc.auth.desktopToken()}`);
    if (packaged && process.platform === 'win32' && !argv.includes('--no-tray')) startTray(logFile);
  });

  const stop = () => {
    console.log('AirDeck wird beendet …');
    discovery?.close();
    app.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
    // letzten Stand in die Datenbank schreiben, dann (falls eingerichtet) abgleichen
    const final = docs.flush().catch((err) => console.error('Letztes Speichern fehlgeschlagen:', (err as Error).message))
      .then(() => (sync.config.backend !== 'local' ? sync.pushNow(app.stateJson()).catch(() => {}) : undefined));
    void final.then(() => sync.close()).then(() => db.close()).finally(() => process.exit(0));
  };
  app.requestShutdown = stop;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
