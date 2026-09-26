// Sicherung/Wiederherstellung (docs/architecture/STORAGE.md "Sicherung"): datenbankneutraler Export
// (JSON-Lines je Tabelle + Schema-Version) als tar.gz, damit sich eine Sicherung auch in eine andere
// Datenbank einspielen lässt (z. B. SQLite -> PostgreSQL beim Umzug auf einen Server).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { AirDeckApp } from '../app.ts';
import { AppError } from '../model.ts';
import { DbDocStore } from '../repo/docs.ts';
import { SCHEMA_VERSION, TABLES, upsertSql } from '../db/schema.ts';
import { readTar, writeTar, type TarFile } from '../tar.ts';

const NAME_RE = /^airdeck-backup-[0-9TZ:.-]+\.tar\.gz$/;
const MAX_PARAMS = 900;

export interface BackupInfo {
  file: string;
  bytes: number;
  createdAt: string;
}

export class BackupService {
  private readonly app: AirDeckApp;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  private dir(): string {
    const d = this.app.paths.backups;
    mkdirSync(d, { recursive: true });
    return d;
  }

  private db(): DbDocStore {
    if (!(this.app.docs instanceof DbDocStore)) throw new AppError(409, 'no_database', 'Sicherung/Wiederherstellung braucht eine Datenbank (SQLite/PostgreSQL/MySQL), keinen reinen Dateispeicher');
    return this.app.docs;
  }

  list(): BackupInfo[] {
    const d = this.dir();
    return readdirSync(d)
      .filter((f) => NAME_RE.test(f))
      .map((f) => {
        const s = statSync(join(d, f));
        return { file: f, bytes: s.size, createdAt: s.mtime.toISOString() };
      })
      .sort((a, b) => b.file.localeCompare(a.file));
  }

  async create(): Promise<BackupInfo> {
    const store = this.db();
    await store.flush();
    const db = store.db;
    const files: TarFile[] = [];
    for (const name of TABLES.keys()) {
      const rows = await db.query(`SELECT * FROM ${name}`);
      files.push({ name: `tables/${name}.jsonl`, data: Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8') });
    }
    const secretsFile = join(this.app.dataDir, 'secrets.json');
    if (existsSync(secretsFile)) files.push({ name: 'secrets.json', data: readFileSync(secretsFile) });
    const sha256 = createHash('sha256');
    for (const f of files) sha256.update(f.name).update(f.data);
    const manifest = { tool: 'airdeck', schemaVersion: SCHEMA_VERSION, dialect: db.dialect, createdAt: new Date().toISOString(), tables: [...TABLES.keys()], sha256: sha256.digest('hex') };
    files.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 1), 'utf8') });
    const gz = gzipSync(writeTar(files));
    const file = `airdeck-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
    writeFileSync(join(this.dir(), file), gz, { mode: 0o600 });
    this.app.audit.write({ kind: 'backup', event: 'created', file, bytes: gz.length });
    return { file, bytes: gz.length, createdAt: new Date().toISOString() };
  }

  async restore(file: string): Promise<{ tables: Record<string, number>; restarting: boolean }> {
    const store = this.db();
    if (!NAME_RE.test(file)) throw new AppError(400, 'invalid_name', 'Ungültiger Dateiname');
    const path = join(this.dir(), file);
    if (!existsSync(path)) throw new AppError(404, 'not_found', 'Sicherung nicht gefunden');
    const entries = readTar(gunzipSync(readFileSync(path)));
    const manifestEntry = entries.find((e) => e.name === 'manifest.json');
    if (!manifestEntry) throw new AppError(400, 'invalid_backup', 'Kein gültiges Sicherungsarchiv (Manifest fehlt)');
    const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as { schemaVersion: number; sha256: string };
    if (manifest.schemaVersion > SCHEMA_VERSION) throw new AppError(409, 'schema_too_new', `Sicherung hat Schema ${manifest.schemaVersion}, dieses Programm kennt nur ${SCHEMA_VERSION} - bitte AirDeck aktualisieren`);
    const sha256 = createHash('sha256');
    for (const e of entries) if (e.name !== 'manifest.json') sha256.update(e.name).update(e.data);
    if (sha256.digest('hex') !== manifest.sha256) throw new AppError(400, 'checksum_mismatch', 'Prüfsumme stimmt nicht - Sicherung ist beschädigt oder wurde verändert');

    const db = store.db;
    const counts: Record<string, number> = {};
    await db.transaction(async (tx) => {
      for (const name of TABLES.keys()) {
        const entry = entries.find((e) => e.name === `tables/${name}.jsonl`);
        const rows = entry?.data.length ? entry.data.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
        const spec = TABLES.get(name)!;
        const cols = Object.keys(spec.columns);
        // Wiederherstellung ersetzt den Tabelleninhalt vollständig (definierter Zustand, kein Zusammenführen mit dem, was gerade da ist)
        await tx.exec(`DELETE FROM ${name}`);
        const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
        for (let i = 0; i < rows.length; i += per) {
          const chunk = rows.slice(i, i + per);
          // r[c] kommt unverändert aus SELECT * (die "data"-Spalte ist bereits der rohe, gespeicherte JSON-Text -
          // hier NICHT nochmal JSON.stringify(), sonst wird der Text beim nächsten Laden doppelt kodiert)
          await tx.exec(upsertSql(db.dialect, name, cols, spec.primaryKey, chunk.length), chunk.flatMap((r) => cols.map((c) => r[c] ?? null)));
        }
        counts[name] = rows.length;
      }
    });
    const secretsEntry = entries.find((e) => e.name === 'secrets.json');
    if (secretsEntry) writeFileSync(join(this.app.dataDir, 'secrets.json'), secretsEntry.data, { mode: 0o600 });
    this.app.audit.write({ kind: 'backup', event: 'restored', file, tables: counts });
    // Der laufende Prozess hält den alten Stand im Speicher (DbDocStore-Cache, rt().data je Sender) -
    // erst ein Neustart lädt wirklich aus der Datenbank neu (wie im Wiederherstellungs-Assistenten dokumentiert).
    const restarting = !!this.app.requestRestart;
    if (restarting) setTimeout(() => this.app.requestRestart?.(), 300).unref();
    return { tables: counts, restarting };
  }
}
