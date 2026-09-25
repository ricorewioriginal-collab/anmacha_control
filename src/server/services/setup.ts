// Setup-Assistent (docs/architecture/INSTALLATION.md): erster Start ohne Kommandozeile und ohne Konfigurationsdateien.
// Jeder Schritt ist überspringbar und später änderbar. Schritte, die erst nach einem Neustart greifen
// (Betriebsart, Datenbank, Netzwerk, Pfade), werden in airdeck.conf geschrieben und als „Neustart nötig“ gemeldet.

import { accessSync, constants, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AirDeckApp } from '../app.ts';
import { AppError, type Principal } from '../model.ts';
import { MODES, updateConf } from '../config.ts';
import { PROVIDERS, openDatabase, safeUrl, type Provider } from '../db/index.ts';
import { DbDocStore } from '../repo/docs.ts';

export const SETUP_STEPS = ['welcome', 'mode', 'database', 'storage', 'admin', 'network', 'station', 'stream', 'audio', 'automation', 'ai', 'finish'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

interface SetupState {
  completedAt?: string;
  disclaimerAcceptedAt?: string;
  steps?: Partial<Record<SetupStep, 'done' | 'skipped'>>;
  /** Änderungen, die erst nach einem Neustart gelten */
  restart?: string[];
}

type Fetch = typeof fetch;

export class SetupService {
  private readonly app: AirDeckApp;
  fetchFn: Fetch = fetch;

  constructor(app: AirDeckApp) {
    this.app = app;
  }

  private state(): SetupState {
    return { ...this.app.docs.get<SetupState>('setup', {}) };
  }

  private save(s: SetupState): void {
    this.app.docs.set('setup', s);
  }

  /** Frische Installation: noch nichts eingerichtet (bestehende Installationen werden nicht gestört). */
  isFresh(): boolean {
    // das beim ersten Serverstart angelegte Admin-Konto mit Einmal-Passwort zählt nicht als „eingerichtet“
    if (this.app.users.list().some((u) => !u.mustChangePassword)) return false;
    if (this.app.outputs.size > 0 || this.app.stations.size > 1) return false;
    for (const rt of this.app.stations.values()) if (rt.data.library.length) return false;
    return true;
  }

  status(): unknown {
    const s = this.state();
    const cfg = this.app.config;
    const station = [...this.app.stations.values()][0]?.station;
    const po = station ? (this.app.playoutView(station.id) as { config: { autostart: boolean; emergencyFolder?: string } }) : null;
    const lan = this.app.listenHost === '0.0.0.0' || this.app.listenHost === '::';
    return {
      required: !s.completedAt && this.isFresh(),
      completed: !!s.completedAt,
      steps: s.steps ?? {},
      order: SETUP_STEPS,
      restart: s.restart ?? [],
      canRestart: !!this.app.requestRestart,
      current: {
        mode: this.app.mode,
        database: cfg ? { provider: cfg.database.provider, url: safeUrl(cfg.database) } : { provider: 'sqlite', url: '' },
        paths: this.app.paths,
        users: this.app.users.count,
        network: { port: this.app.listenPort, lan },
        station: station ? { id: station.id, name: station.name, slogan: station.slogan, genre: station.genre ?? '' } : null,
        outputs: this.app.outputs.size,
        ffmpeg: this.app.ffmpeg ? { version: this.app.ffmpeg.version, mp3: this.app.ffmpeg.encoders.mp3 } : null,
        automation: po ? { autostart: po.config.autostart, emergencyFolder: po.config.emergencyFolder ?? '', running: this.app.playouts.has(station!.id) } : null,
        linkedFolders: station ? this.app.svc.media.linkedFolders(station.id) : [],
        disclaimerAccepted: !!s.disclaimerAcceptedAt,
      },
    };
  }

  private mark(step: SetupStep, how: 'done' | 'skipped', restart?: string): void {
    const s = this.state();
    s.steps = { ...s.steps, [step]: how };
    if (restart) s.restart = [...new Set([...(s.restart ?? []), restart])];
    this.save(s);
  }

  private conf(patch: Record<string, string | number | null>): void {
    const file = this.app.config?.configFile;
    if (!file) throw new AppError(409, 'no_config', 'Keine Konfigurationsdatei (Test-/Hilfsinstanz)');
    updateConf(file, patch);
  }

  /** Einen Schritt anwenden. skip = true überspringt ihn. */
  async apply(p: Principal, step: string, input: Record<string, any>): Promise<unknown> {
    if (!(SETUP_STEPS as readonly string[]).includes(step)) throw new AppError(404, 'not_found', 'Unbekannter Schritt');
    const st = step as SetupStep;
    if (input.skip === true) {
      this.mark(st, 'skipped');
      return this.status();
    }
    const station = [...this.app.stations.values()][0]?.station;
    switch (st) {
      case 'welcome': {
        if (input.accept !== true) throw new AppError(400, 'disclaimer', 'Bitte den Haftungsausschluss bestätigen');
        const s = this.state();
        s.disclaimerAcceptedAt = new Date().toISOString();
        this.save(s);
        this.mark(st, 'done');
        break;
      }
      case 'mode': {
        const mode = String(input.mode ?? '').toLowerCase();
        if (!(MODES as readonly string[]).includes(mode)) throw new AppError(400, 'invalid_mode', 'Betriebsart: local, server oder hybrid');
        this.conf({ mode });
        this.mark(st, 'done', mode !== this.app.mode ? 'mode' : undefined);
        break;
      }
      case 'database':
        await this.applyDatabase(input);
        break;
      case 'storage': {
        if (typeof input.media === 'string' && input.media.trim()) {
          const media = input.media.trim();
          if (!isAbsolute(media)) throw new AppError(400, 'invalid_path', 'Vollständigen Pfad für den Medienordner angeben');
          try {
            mkdirSync(media, { recursive: true });
            accessSync(media, constants.W_OK);
          } catch {
            throw new AppError(400, 'not_writable', 'Medienordner lässt sich nicht anlegen oder beschreiben');
          }
          if (resolve(media) !== resolve(this.app.paths.media)) {
            this.conf({ 'paths.media': resolve(media) });
            this.mark(st, 'done', 'paths');
          }
        }
        if (typeof input.link === 'string' && input.link.trim() && station) await this.app.svc.media.linkFolder(station.id, { path: input.link, category: input.category });
        this.mark(st, 'done');
        break;
      }
      case 'admin': {
        if (this.app.users.count > 0) throw new AppError(409, 'exists', 'Es gibt bereits Benutzerkonten – weitere unter „Benutzer & Rollen“');
        const { AuthError } = await import('../users.ts');
        try {
          await this.app.users.create({ username: String(input.username ?? 'admin'), name: String(input.name ?? 'Administrator'), password: String(input.password ?? ''), roles: ['admin'], stationIds: ['*'] });
        } catch (err) {
          if (err instanceof AuthError) throw new AppError(err.status, 'invalid', err.message);
          throw err;
        }
        this.app.audit.write({ kind: 'setup', event: 'admin_created', actor: p.id });
        this.mark(st, 'done');
        break;
      }
      case 'network': {
        const port = Number(input.port ?? this.app.listenPort);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AppError(400, 'invalid_port', 'Port zwischen 1024 und 65535');
        const lan = input.access === 'lan';
        this.conf({ 'network.port': port, 'network.bind': lan ? 'lan' : 'local' });
        this.app.svc.system.setNetwork(lan);
        const running = this.app.listenHost === '0.0.0.0' || this.app.listenHost === '::';
        this.mark(st, 'done', port !== this.app.listenPort || lan !== running ? 'network' : undefined);
        break;
      }
      case 'station': {
        if (!station) throw new AppError(409, 'no_station', 'Kein Sender vorhanden');
        this.app.svc.stations.updateStation(station.id, { name: input.name, slogan: input.slogan, genre: input.genre });
        this.mark(st, 'done');
        break;
      }
      case 'stream': {
        if (!station) throw new AppError(409, 'no_station', 'Kein Sender vorhanden');
        this.app.saveOutput(p, station.id, null, {
          name: input.name || (input.type === 'shoutcast' ? 'SHOUTcast' : 'Icecast'), type: input.type === 'shoutcast' ? 'shoutcast' : 'icecast',
          host: input.host, port: Number(input.port) || 8000, mount: input.mount || '/stream', username: input.username || 'source', password: input.password, tls: input.tls === true,
        });
        this.mark(st, 'done');
        break;
      }
      case 'audio':
        // Mithören, CUE und Mikrofon sind Geräteeinstellungen am Client (MULTI_PLATFORM.md) – hier nur als erledigt merken
        this.mark(st, 'done');
        break;
      case 'automation': {
        if (!station) throw new AppError(409, 'no_station', 'Kein Sender vorhanden');
        this.app.savePlayoutConfig(station.id, { autostart: input.autostart !== false, emergencyFolder: typeof input.emergencyFolder === 'string' ? input.emergencyFolder : undefined });
        if (input.start === true && !this.app.playouts.has(station.id)) {
          if (!this.app.ffmpeg) throw new AppError(501, 'unsupported', 'ffmpeg fehlt – die Automation kann nicht starten');
          this.app.startPlayout(p, station.id, { autostart: input.autostart !== false });
        }
        this.mark(st, 'done');
        break;
      }
      case 'ai': {
        if (input.kind === 'local') {
          // Ollama auf diesem Rechner erkennen und als Text-Provider eintragen (ohne Schlüssel, ohne Kosten)
          const base = String(input.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
          const r = await this.fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
          if (!r?.ok) throw new AppError(502, 'not_found', `Kein Ollama unter ${base} gefunden – später unter „KI“ einrichten`);
          const models = ((await r.json().catch(() => ({}))) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
          const view = this.app.ai.view() as { providers: { id: string }[] };
          if (!view.providers.some((x) => x.id === 'ollama')) {
            this.app.ai.update({ providers: [...view.providers, { id: 'ollama', name: 'Ollama (lokal)', role: 'text', kind: 'openai_compat', baseUrl: `${base}/v1`, enabled: true }] });
          }
          this.mark(st, 'done');
          return { ...(this.status() as object), ollamaModels: models };
        }
        this.mark(st, 'done');
        break;
      }
      case 'finish': {
        const s = this.state();
        s.completedAt = new Date().toISOString();
        this.save(s);
        this.app.audit.write({ kind: 'setup', event: 'completed', actor: p.id, restart: s.restart ?? [] });
        break;
      }
    }
    return this.status();
  }

  /**
   * Datenbank wählen: Verbindung testen, den bisherigen Stand in die neue Datenbank übernehmen, airdeck.conf
   * schreiben. Das Passwort landet verschlüsselt im Secret-Store (nicht in der Datei). Aktiv nach dem Neustart.
   */
  private async applyDatabase(input: Record<string, any>): Promise<void> {
    const provider = String(input.provider ?? 'sqlite').toLowerCase() as Provider;
    if (!(PROVIDERS as readonly string[]).includes(provider)) throw new AppError(400, 'invalid_provider', 'Datenbank: sqlite, postgres oder mysql');
    if (provider === 'sqlite') {
      this.conf({ 'database.provider': 'sqlite', 'database.url': null });
      this.app.secrets.delete('db:password');
      this.mark('database', 'done', this.app.config?.database.provider !== 'sqlite' ? 'database' : undefined);
      return;
    }
    const url = String(input.url ?? '').trim();
    if (!/^(postgres|postgresql|mysql|mariadb):\/\//i.test(url)) throw new AppError(400, 'invalid_url', 'Verbindungsadresse, z. B. postgres://airdeck@localhost:5432/airdeck');
    const password = typeof input.password === 'string' && input.password ? input.password : undefined;
    let db;
    try {
      db = await openDatabase({ provider, url: url.replace(/^mariadb:/i, 'mysql:').replace(/^postgresql:/i, 'postgres:'), password });
    } catch (err) {
      throw new AppError(502, 'db_unreachable', `Datenbank nicht erreichbar: ${(err as Error).message}`);
    }
    let copied = 0;
    try {
      if (input.copy !== false) {
        // bisherigen Stand übernehmen, damit nach dem Neustart nichts fehlt
        this.app.persistNow();
        const target = await DbDocStore.open(db);
        const from = this.app.docs;
        for (const n of from.names()) {
          const v = from instanceof DbDocStore ? from.snapshot(n) : from.get(n, undefined);
          if (v === undefined) continue;
          target.set(n, v);
          copied++;
        }
        await target.flush();
      }
    } finally {
      await db.close();
    }
    if (password) this.app.secrets.set('db:password', password);
    this.conf({ 'database.provider': provider, 'database.url': url });
    this.app.audit.write({ kind: 'setup', event: 'database', provider, copied });
    this.mark('database', 'done', 'database');
  }
}
