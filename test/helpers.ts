import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AirDeckApp } from '../src/server/app.ts';

/** Alles, was im Datenordner liegt (Datenbank samt WAL, JSON, Logs) als Text – für „nie im Klartext“-Prüfungen. */
export function storedText(app: AirDeckApp): string {
  app.docs.flushSync();
  return readdirSync(app.dataDir)
    .filter((f) => statSync(join(app.dataDir, f)).isFile())
    .map((f) => readFileSync(join(app.dataDir, f)).toString('latin1'))
    .join('\n');
}
