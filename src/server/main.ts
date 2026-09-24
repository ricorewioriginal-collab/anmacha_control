// AirDeck Server – Einstiegspunkt.
// Start: node src/server/main.ts   (Node >= 22.18, keine Build-Schritte nötig)

import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AirDeckApp } from './app.ts';
import { createHttpServer } from './http.ts';

const root = resolve(fileURLToPath(import.meta.url), '../../..');
const dataDir = resolve(process.env.AIRDECK_DATA ?? join(root, 'data'));
const host = process.env.AIRDECK_HOST ?? '127.0.0.1';
const port = Number(process.env.AIRDECK_PORT ?? 8750);

const app = new AirDeckApp(dataDir);

function printToken(label: string): void {
  const { token } = app.createToken({ name: label, scopes: ['*'], roles: ['admin'], stationIds: ['*'] });
  console.log('\n  Admin-Token (wird nur jetzt angezeigt, sicher aufbewahren):');
  console.log(`  ${token}`);
  console.log(`\n  Studio öffnen: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/#token=${token}\n`);
}

if (process.argv.includes('--new-admin-token')) {
  printToken('admin (neu)');
  process.exit(0);
}
if (!app.hasTokens()) printToken('admin');

const server = createHttpServer(app, join(root, 'studio'));
server.requestTimeout = 0; // Streams (Ingest, SSE, Listen) laufen dauerhaft
server.headersTimeout = 15_000;
server.listen(port, host, () => {
  app.start();
  console.log(`AirDeck läuft auf http://${host}:${port}  (Daten: ${dataDir})`);
});

const stop = () => {
  console.log('AirDeck wird beendet …');
  app.shutdown();
  server.close();
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
