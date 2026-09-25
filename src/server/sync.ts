// Optionale Datenhaltung/Sync: Der lokale Zustand (data/airdeck.json) bleibt maßgeblich (Local-First, offline-fähig).
// Zusätzlich kann er mit MySQL/MariaDB oder Firebase (Cloud Firestore) synchronisiert werden –
// z. B. um mehrere Studios/Standorte auf denselben Stand zu bringen. Musikdateien werden NICHT synchronisiert.

import { createHash, createSign, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeFileAtomic } from './store.ts';
import type { SecretStore } from './secrets.ts';
import { gunzipSync, gzipSync } from 'node:zlib';

export type BackendKind = 'local' | 'mysql' | 'firebase';

export interface StorageConfig {
  backend: BackendKind;
  mysql?: { host: string; port: number; user: string; database: string; passwordRef: string; ssl: boolean };
  firebase?: { projectId: string; credentialsRef: string; collection: string };
}

export interface RemoteDoc {
  updatedAt: number;
  instance: string;
  state: unknown;
}

export interface RemoteStore {
  readonly name: string;
  pull(): Promise<RemoteDoc | null>;
  push(doc: RemoteDoc): Promise<void>;
  test(): Promise<void>;
  close(): Promise<void>;
}

/** Inhaltlich gleiche Stände ergeben denselben Wert, egal in welcher Reihenfolge die Felder stehen
 *  (der Stand kommt jetzt aus der Datenbank und nicht mehr Byte für Byte aus airdeck.json). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}
export const hashState = (json: string): string => {
  let text = json;
  try {
    text = JSON.stringify(canonical(JSON.parse(json)));
  } catch {
    // kein JSON → Rohtext
  }
  return createHash('sha256').update(text).digest('hex');
};

// ---------------- MySQL / MariaDB ----------------

export class MysqlStore implements RemoteStore {
  readonly name = 'mysql';
  private readonly cfg: NonNullable<StorageConfig['mysql']>;
  private readonly password: string;
  private pool: import('mysql2/promise').Pool | null = null;

  constructor(cfg: NonNullable<StorageConfig['mysql']>, password: string) {
    this.cfg = cfg;
    this.password = password;
  }

  private async db(): Promise<import('mysql2/promise').Pool> {
    if (this.pool) return this.pool;
    const mysql = await import('mysql2/promise');
    this.pool = mysql.createPool({
      host: this.cfg.host, port: this.cfg.port, user: this.cfg.user, password: this.password, database: this.cfg.database,
      ssl: this.cfg.ssl ? {} : undefined, connectionLimit: 2, connectTimeout: 8000, enableKeepAlive: true,
    });
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS airdeck_state (id VARCHAR(64) PRIMARY KEY, updated_at BIGINT NOT NULL, instance VARCHAR(64) NOT NULL, doc LONGBLOB NOT NULL) ENGINE=InnoDB',
    );
    return this.pool;
  }

  async test(): Promise<void> {
    await (await this.db()).query('SELECT 1');
  }

  async pull(): Promise<RemoteDoc | null> {
    const [rows] = await (await this.db()).query('SELECT updated_at, instance, doc FROM airdeck_state WHERE id = ?', ['state']);
    const r = (rows as Array<{ updated_at: number | string; instance: string; doc: Buffer }>)[0];
    if (!r) return null;
    return { updatedAt: Number(r.updated_at), instance: r.instance, state: JSON.parse(gunzipSync(r.doc).toString('utf8')) };
  }

  async push(doc: RemoteDoc): Promise<void> {
    const blob = gzipSync(JSON.stringify(doc.state));
    await (await this.db()).query(
      'INSERT INTO airdeck_state (id, updated_at, instance, doc) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at), instance = VALUES(instance), doc = VALUES(doc)',
      ['state', doc.updatedAt, doc.instance, blob],
    );
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }
}

// ---------------- Firebase (Cloud Firestore, REST + Service Account) ----------------

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

export function parseServiceAccount(json: string): ServiceAccount {
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(json) as ServiceAccount;
  } catch {
    throw new Error('Service-Account-Datei ist kein gültiges JSON');
  }
  if (!sa.client_email || !sa.private_key) throw new Error('Service-Account ohne client_email/private_key');
  return sa;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class FirestoreStore implements RemoteStore {
  readonly name = 'firebase';
  private readonly cfg: NonNullable<StorageConfig['firebase']>;
  private readonly sa: ServiceAccount;
  private token: { value: string; exp: number } | null = null;
  /** Überschreibbar für Tests (Emulator/Mock) */
  private readonly apiBase: string;

  constructor(cfg: NonNullable<StorageConfig['firebase']>, credentialsJson: string, apiBase = 'https://firestore.googleapis.com/v1') {
    this.cfg = cfg;
    this.sa = parseServiceAccount(credentialsJson);
    this.apiBase = apiBase;
  }

  /** OAuth2 JWT-Bearer-Flow mit RS256 (ohne Zusatzbibliothek). */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const tokenUri = this.sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: this.sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: tokenUri, iat: now, exp: now + 3600 }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const jwt = `${header}.${claims}.${b64url(signer.sign(this.sa.private_key))}`;
    const r = await fetch(tokenUri, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }), signal: AbortSignal.timeout(10_000),
    });
    const d = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!r.ok || !d.access_token) throw new Error(`Firebase-Anmeldung fehlgeschlagen: ${d.error_description ?? r.status}`);
    this.token = { value: d.access_token, exp: Date.now() + (d.expires_in ?? 3600) * 1000 };
    return d.access_token;
  }

  private docUrl(): string {
    const project = encodeURIComponent(this.cfg.projectId || this.sa.project_id || '');
    return `${this.apiBase}/projects/${project}/databases/(default)/documents/${encodeURIComponent(this.cfg.collection || 'airdeck')}/state`;
  }

  private async req(method: string, body?: unknown): Promise<Response> {
    return fetch(this.docUrl(), {
      method, headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
  }

  async test(): Promise<void> {
    const r = await this.req('GET');
    if (!r.ok && r.status !== 404) throw new Error(`Firestore antwortete ${r.status}`);
  }

  async pull(): Promise<RemoteDoc | null> {
    const r = await this.req('GET');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Firestore antwortete ${r.status}`);
    const f = ((await r.json()) as { fields?: Record<string, { integerValue?: string; stringValue?: string; bytesValue?: string }> }).fields ?? {};
    if (!f.doc?.bytesValue) return null;
    return {
      updatedAt: Number(f.updatedAt?.integerValue ?? 0),
      instance: f.instance?.stringValue ?? '',
      state: JSON.parse(gunzipSync(Buffer.from(f.doc.bytesValue, 'base64')).toString('utf8')),
    };
  }

  async push(doc: RemoteDoc): Promise<void> {
    const bytes = gzipSync(JSON.stringify(doc.state));
    if (bytes.length > 950_000) throw new Error('Zustand zu groß für ein Firestore-Dokument (1 MB) – MySQL verwenden');
    const r = await this.req('PATCH', {
      fields: { updatedAt: { integerValue: String(doc.updatedAt) }, instance: { stringValue: doc.instance }, doc: { bytesValue: bytes.toString('base64') } },
    });
    if (!r.ok) throw new Error(`Firestore antwortete ${r.status}`);
  }

  async close(): Promise<void> {}
}

// ---------------- Konfliktregel ----------------

export interface SyncMeta {
  /** Hash des lokalen Zustands beim letzten erfolgreichen Sync */
  localHash?: string;
  /** updatedAt des Remote-Dokuments beim letzten Sync */
  remoteAt?: number;
}

export type SyncDecision = 'take_remote' | 'push_local' | 'conflict' | 'nothing';

/**
 * Entscheidung beim Start:
 * – erster Sync (keine Metadaten): Remote vorhanden → übernehmen (neuer Standort holt den gemeinsamen Stand),
 *   außer `firstSync = 'push'` (dieser PC soll den gemeinsamen Stand anlegen/überschreiben)
 * – nur Remote geändert → Remote übernehmen
 * – nur lokal geändert (oder Remote leer) → lokal hochladen
 * – beide geändert → Konflikt: lokaler Stand gewinnt, Remote-Stand wird als Datei gesichert
 */
export function decide(localHash: string | null, remote: RemoteDoc | null, meta: SyncMeta, firstSync: 'pull' | 'push' = 'pull'): SyncDecision {
  if (!remote) return localHash ? 'push_local' : 'nothing';
  if (!localHash) return 'take_remote';
  if (meta.localHash === undefined && meta.remoteAt === undefined) return firstSync === 'push' ? 'push_local' : 'take_remote';
  const remoteChanged = remote.updatedAt !== meta.remoteAt;
  const localChanged = localHash !== meta.localHash;
  if (remoteChanged && localChanged) return 'conflict';
  if (remoteChanged) return 'take_remote';
  if (localChanged) return 'push_local';
  return 'nothing';
}

// ---------------- Sync-Verwaltung ----------------


export interface SyncStatus {
  backend: BackendKind;
  lastDecision: SyncDecision | null;
  lastPushAt: number | null;
  lastError: string | null;
  conflictFile: string | null;
}

/** Einrichtungsdatei des Installers (einmalig, Klartext) → wird importiert und gelöscht. */
interface SetupFile {
  backend?: BackendKind;
  firstSync?: 'pull' | 'push';
  mysql?: { host?: string; port?: number | string; user?: string; password?: string; database?: string; ssl?: boolean | string };
  firebase?: { projectId?: string; credentialsFile?: string; credentialsJson?: string; collection?: string };
}

export class SyncManager {
  private readonly dataDir: string;
  private readonly secrets: SecretStore;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;
  private cfg: StorageConfig;
  private firstSync: 'pull' | 'push';
  private remote: RemoteStore | null = null;
  private timer: NodeJS.Timeout | null = null;
  readonly instance: string;
  readonly status: SyncStatus;
  /** Für Tests austauschbar */
  storeFactory: (cfg: StorageConfig) => RemoteStore | null = (cfg) => this.createStore(cfg);

  constructor(dataDir: string, secrets: SecretStore, log: (event: string, data?: Record<string, unknown>) => void = () => {}) {
    this.dataDir = dataDir;
    this.secrets = secrets;
    this.log = log;
    const saved = readJson<{ cfg?: StorageConfig; firstSync?: 'pull' | 'push' }>(join(dataDir, 'storage.json'), {});
    this.cfg = saved.cfg ?? { backend: 'local' };
    this.firstSync = saved.firstSync ?? 'pull';
    const idFile = join(dataDir, 'instance.id');
    if (!existsSync(idFile)) writeFileAtomic(idFile, randomBytes(8).toString('hex'));
    this.instance = readFileSync(idFile, 'utf8').trim();
    this.status = { backend: this.cfg.backend, lastDecision: null, lastPushAt: null, lastError: null, conflictFile: null };
  }

  get config(): StorageConfig {
    return this.cfg;
  }

  /** Öffentliche Sicht ohne Secrets. */
  view(): unknown {
    const c = this.cfg;
    return {
      backend: c.backend, firstSync: this.firstSync, instance: this.instance, status: this.status,
      mysql: c.mysql ? { host: c.mysql.host, port: c.mysql.port, user: c.mysql.user, database: c.mysql.database, ssl: c.mysql.ssl, hasPassword: this.secrets.has(c.mysql.passwordRef) } : null,
      firebase: c.firebase ? { projectId: c.firebase.projectId, collection: c.firebase.collection, hasCredentials: this.secrets.has(c.firebase.credentialsRef) } : null,
      note: 'Synchronisiert Sender, Quellen, Ausgänge, Bibliothek (Metadaten), Playlists und Planung. Musikdateien werden nicht übertragen.',
    };
  }

  /** Neue Konfiguration übernehmen (Secrets verschlüsselt ablegen) und optional Verbindung testen. */
  async configure(input: SetupFile, test = true): Promise<unknown> {
    const backend = input.backend ?? 'local';
    if (!['local', 'mysql', 'firebase'].includes(backend)) throw new Error('Unbekannter Speicher');
    const next: StorageConfig = { backend };
    if (backend === 'mysql') {
      const m = input.mysql ?? {};
      const prev = this.cfg.mysql;
      next.mysql = {
        host: String(m.host ?? prev?.host ?? '').trim(), port: Number(m.port ?? prev?.port ?? 3306), user: String(m.user ?? prev?.user ?? '').trim(),
        database: String(m.database ?? prev?.database ?? 'airdeck').trim(), passwordRef: 'storage:mysql', ssl: m.ssl === true || m.ssl === 'true' || (m.ssl === undefined && !!prev?.ssl),
      };
      if (!/^[\w.-]+$/.test(next.mysql.host) || !next.mysql.user || !/^[\w$]+$/.test(next.mysql.database)) throw new Error('MySQL: Host, Benutzer und Datenbankname prüfen');
      if (!Number.isInteger(next.mysql.port) || next.mysql.port < 1 || next.mysql.port > 65535) throw new Error('MySQL: ungültiger Port');
      if (typeof m.password === 'string' && m.password) this.secrets.set('storage:mysql', m.password);
    }
    if (backend === 'firebase') {
      const f = input.firebase ?? {};
      let json = f.credentialsJson;
      if (!json && f.credentialsFile) json = readFileSync(f.credentialsFile, 'utf8');
      if (json) {
        const sa = parseServiceAccount(json);
        this.secrets.set('storage:firebase', json);
        f.projectId = f.projectId || sa.project_id;
      }
      next.firebase = { projectId: String(f.projectId ?? this.cfg.firebase?.projectId ?? ''), credentialsRef: 'storage:firebase', collection: String(f.collection ?? this.cfg.firebase?.collection ?? 'airdeck') };
      if (!next.firebase.projectId) throw new Error('Firebase: Projekt-ID fehlt');
    }
    if (test && backend !== 'local') {
      const store = this.storeFactory(next);
      try {
        await store?.test();
      } finally {
        await store?.close();
      }
    }
    await this.remote?.close();
    this.remote = null;
    this.cfg = next;
    if (input.firstSync === 'pull' || input.firstSync === 'push') this.firstSync = input.firstSync;
    this.status.backend = backend;
    this.status.lastError = null;
    writeFileAtomic(join(this.dataDir, 'storage.json'), JSON.stringify({ cfg: this.cfg, firstSync: this.firstSync }, null, 1), 0o600);
    // neuer Speicher → erster Abgleich folgt beim nächsten Start bzw. mit „Jetzt synchronisieren“
    rmSync(join(this.dataDir, 'sync-meta.json'), { force: true });
    this.log('storage_configured', { backend });
    return this.view();
  }

  /** Vom Installer abgelegte Einrichtungsdatei importieren. */
  async importSetupFile(): Promise<boolean> {
    const file = join(this.dataDir, 'storage-setup.json');
    if (!existsSync(file)) return false;
    try {
      const setup = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as SetupFile;
      await this.configure(setup, false);
      this.log('storage_setup_imported', { backend: setup.backend });
    } catch (err) {
      this.status.lastError = `Einrichtung aus dem Installer fehlgeschlagen: ${(err as Error).message}`;
      this.log('storage_setup_failed', { message: (err as Error).message });
    } finally {
      rmSync(file, { force: true }); // Klartext-Zugangsdaten nie liegen lassen
    }
    return true;
  }

  private createStore(cfg: StorageConfig): RemoteStore | null {
    if (cfg.backend === 'mysql' && cfg.mysql) {
      const pw = this.secrets.get(cfg.mysql.passwordRef);
      if (pw === undefined) throw new Error('MySQL-Passwort fehlt');
      return new MysqlStore(cfg.mysql, pw);
    }
    if (cfg.backend === 'firebase' && cfg.firebase) {
      const json = this.secrets.get(cfg.firebase.credentialsRef);
      if (!json) throw new Error('Firebase-Zugangsdaten fehlen');
      return new FirestoreStore(cfg.firebase, json);
    }
    return null;
  }

  private store(): RemoteStore | null {
    if (this.cfg.backend === 'local') return null;
    this.remote ??= this.storeFactory(this.cfg);
    return this.remote;
  }

  /**
   * Abgleich beim Start (vor dem Laden des Zustands). Schreibt ggf. data/airdeck.json neu.
   * Fehler (z. B. Datenbank nicht erreichbar) blockieren den Start nie – AirDeck läuft dann lokal.
   */
  /** local: aktueller Stand aus der Datenbank; ohne Angabe wird data/airdeck.json gelesen (ältere Installationen) */
  async startup(localState?: string | null): Promise<SyncDecision | null> {
    await this.importSetupFile();
    const store = (() => {
      try {
        return this.store();
      } catch (err) {
        this.status.lastError = (err as Error).message;
        return null;
      }
    })();
    if (!store) return null;
    const stateFile = join(this.dataDir, 'airdeck.json');
    const metaFile = join(this.dataDir, 'sync-meta.json');
    const meta = readJson<SyncMeta>(metaFile, {});
    try {
      const local = localState !== undefined ? localState : existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;
      const localHash = local ? hashState(local) : null;
      const remote = await store.pull();
      const decision = decide(localHash, remote, meta, this.firstSync);
      this.status.lastDecision = decision;
      if (decision === 'take_remote' && remote) {
        const json = JSON.stringify(remote.state, null, 1);
        if (local) writeFileAtomic(join(this.dataDir, `airdeck.before-sync-${Date.now()}.json`), local);
        writeFileAtomic(stateFile, json);
        writeFileAtomic(metaFile, JSON.stringify({ localHash: hashState(json), remoteAt: remote.updatedAt }));
      } else if (decision === 'conflict' && remote) {
        const f = `airdeck.remote-conflict-${Date.now()}.json`;
        writeFileAtomic(join(this.dataDir, f), JSON.stringify(remote.state, null, 1));
        this.status.conflictFile = f;
        await this.pushNow(local!);
      } else if (decision === 'push_local' && local) {
        await this.pushNow(local);
      }
      this.log('sync_startup', { decision });
      return decision;
    } catch (err) {
      this.status.lastError = (err as Error).message;
      this.log('sync_failed', { phase: 'startup', message: (err as Error).message });
      return null;
    }
  }

  /** Nach jeder lokalen Speicherung aufrufen – lädt entprellt (5 s) hoch. */
  schedulePush(readState: () => string, delayMs = 5000): void {
    if (this.cfg.backend === 'local' || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pushNow(readState()).catch(() => {});
    }, delayMs);
    this.timer.unref();
  }

  async pushNow(json: string): Promise<void> {
    const store = this.store();
    if (!store) return;
    try {
      const updatedAt = Date.now();
      await store.push({ updatedAt, instance: this.instance, state: JSON.parse(json) });
      writeFileAtomic(join(this.dataDir, 'sync-meta.json'), JSON.stringify({ localHash: hashState(json), remoteAt: updatedAt }));
      this.status.lastPushAt = updatedAt;
      this.status.lastError = null;
    } catch (err) {
      this.status.lastError = (err as Error).message;
      this.log('sync_failed', { phase: 'push', message: (err as Error).message });
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.remote?.close();
    this.remote = null;
  }
}
