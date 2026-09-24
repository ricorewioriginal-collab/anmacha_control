// AirDeck Server – Einstiegspunkt.
//   node src/server/main.ts               Server (Entwicklung, Node >= 22.18)
//   AirDeck.exe                           Windows-Programm: Server + Studio-Fenster (Desktop-Modus)
//   AirDeck.exe --headless                nur Server, z. B. für Autostart/24/7 ohne Fenster
//   … --new-admin-token                   neues Admin-Token ausgeben

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AirDeckApp } from './app.ts';
import { createHttpServer } from './http.ts';

declare global {
  // wird im gebündelten Windows-/Desktop-Build per Banner gesetzt (scripts/build.mjs)
  var __AIRDECK_ROOT: string | undefined;
  var __AIRDECK_PACKAGED: boolean | undefined;
}

const argv = process.argv.slice(2);
const packaged = globalThis.__AIRDECK_PACKAGED === true;
const root = process.env.AIRDECK_ROOT ?? globalThis.__AIRDECK_ROOT ?? resolve(fileURLToPath(import.meta.url), '../../..');
const desktop = !argv.includes('--headless') && (argv.includes('--desktop') || packaged);
const host = process.env.AIRDECK_HOST ?? '127.0.0.1';
const port = Number(process.env.AIRDECK_PORT ?? 8750);
const localHost = host === '0.0.0.0' ? '127.0.0.1' : host;

function defaultDataDir(): string {
  if (!packaged) return join(root, 'data');
  // Installiertes Programm: Nutzerdaten gehören nicht in den Programmordner
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AirDeck', 'data');
  return join(homedir(), '.airdeck', 'data');
}
const dataDir = resolve(process.env.AIRDECK_DATA ?? defaultDataDir());

/** Studio im App-Fenster öffnen (Edge/Chrome im App-Modus, sonst Standardbrowser). */
function openStudio(url: string): void {
  const detached = { detached: true, stdio: 'ignore' as const, windowsHide: true };
  if (process.platform === 'win32') {
    // '' wird von Node als "" übergeben = leerer Fenstertitel für "start"
    const edge = spawn('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`], detached);
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

async function main(): Promise<void> {
  // Zweiter Start im Desktop-Modus: nur Fenster öffnen, kein zweiter Server
  if (desktop && (await portInUse(port, host))) {
    const probe = new AirDeckApp(dataDir, { appRoot: root, ffmpeg: null });
    openStudio(`http://${localHost}:${port}/#token=${probe.desktopToken()}`);
    return;
  }

  const app = new AirDeckApp(dataDir, { appRoot: root });
  console.log(app.ffmpeg ? `ffmpeg: ${app.ffmpeg.version}` : 'ffmpeg nicht gefunden – Server-Playout (24/7) deaktiviert');

  if (argv.includes('--new-admin-token')) {
    const { token } = app.createToken({ name: 'admin (neu)', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
    console.log(`\n  Neues Admin-Token: ${token}\n`);
    process.exit(0);
  }
  if (!app.hasTokens() && !desktop) {
    const { token } = app.createToken({ name: 'admin', scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
    console.log('\n  Admin-Token (wird nur jetzt angezeigt, sicher aufbewahren):');
    console.log(`  ${token}`);
    console.log(`\n  Studio öffnen: http://${localHost}:${port}/#token=${token}\n`);
  }

  const server = createHttpServer(app, join(root, 'studio'));
  server.requestTimeout = 0; // Streams (Ingest, SSE, Listen) laufen dauerhaft
  server.headersTimeout = 15_000;
  server.listen(port, host, () => {
    app.start();
    console.log(`AirDeck läuft auf http://${host}:${port}  (Daten: ${dataDir})`);
    if (desktop) openStudio(`http://${localHost}:${port}/#token=${app.desktopToken()}`);
  });

  const stop = () => {
    console.log('AirDeck wird beendet …');
    app.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
