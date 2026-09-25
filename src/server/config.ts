// Konfigurations- und Pfadmodell (docs/architecture/STORAGE.md, ARCHITECTURE.md §2).
// Eine Datei airdeck.conf (Schlüssel = Wert, Abschnitte in [eckigen Klammern]) beschreibt Betriebsart,
// Netzwerk und Pfade. Umgebungsvariablen haben Vorrang, fehlende Werte fallen auf die bisherigen
// Standardorte zurück – bestehende Installationen laufen unverändert weiter.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type Mode = 'local' | 'server' | 'hybrid';
export const MODES: readonly Mode[] = ['local', 'server', 'hybrid'];
/** API-Hauptversion: Client und Server vergleichen sie (NETWORK.md „Kompatibilität“) */
export const API_VERSION = '1.0';

export interface AirDeckConfig {
  mode: Mode;
  port: number;
  host: string;
  /** Datei, aus der gelesen wurde (bzw. die beim ersten Start angelegt wird) */
  configFile: string;
  /** true = systemweite Installation (Dienst/Paket), false = Benutzer-/Portable-Installation */
  system: boolean;
  paths: { config: string; data: string; media: string; logs: string; backups: string };
}

export interface ResolveInput {
  env: NodeJS.ProcessEnv;
  root: string;
  packaged: boolean;
  desktop: boolean;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
}

/** INI-artig: `# Kommentar`, `[abschnitt]`, `schluessel = wert` → { 'abschnitt.schluessel': 'wert' } */
export function parseConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = '';
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[([\w.-]+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[section ? `${section}.${key}` : key] = value;
  }
  return out;
}

/** Bisheriger Datenordner (vor airdeck.conf) – bleibt Standard für Benutzerinstallationen. */
export function legacyDataDir(root: string, packaged: boolean, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (!packaged) return join(root, 'data');
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'AirDeck', 'data');
  return join(home, '.airdeck', 'data');
}

/** Systemweite Orte (Dienst/Paket). Nur verwendet, wenn dort eine airdeck.conf liegt. */
function systemLayout(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): AirDeckConfig['paths'] {
  if (platform === 'win32') {
    const base = join(env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData', 'AirDeck');
    return { config: join(base, 'config'), data: join(base, 'data'), media: join(base, 'media'), logs: join(base, 'logs'), backups: join(base, 'backups') };
  }
  return { config: '/etc/airdeck', data: '/var/lib/airdeck', media: '/var/lib/airdeck/media', logs: '/var/log/airdeck', backups: '/var/lib/airdeck/backups' };
}

export function resolveConfig(input: ResolveInput): AirDeckConfig {
  const { env, root, packaged, desktop } = input;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const exists = input.exists ?? existsSync;
  const read = input.read ?? ((p: string) => readFileSync(p, 'utf8'));

  const sys = systemLayout(platform, env);
  const sysFile = join(sys.config, 'airdeck.conf');
  // Reihenfolge: ausdrücklich angegeben → systemweite Installation → bisheriger Datenordner
  const legacyData = resolve(env.AIRDECK_DATA ?? legacyDataDir(root, packaged, platform, env, home));
  let configFile: string;
  let system = false;
  if (env.AIRDECK_CONFIG) configFile = resolve(env.AIRDECK_CONFIG);
  else if (!env.AIRDECK_DATA && exists(sysFile)) {
    configFile = sysFile;
    system = true;
  } else configFile = join(legacyData, 'config', 'airdeck.conf');

  let conf: Record<string, string> = {};
  try {
    if (exists(configFile)) conf = parseConf(read(configFile));
  } catch {
    // unlesbar → Standardwerte; der Health-Check meldet den Speicherzustand
  }
  const confDir = dirname(configFile);
  const pathOf = (v: string | undefined) => (v ? (isAbsolute(v) ? v : resolve(confDir, v)) : undefined);

  const data = resolve(env.AIRDECK_DATA ?? pathOf(conf['paths.data']) ?? (system ? sys.data : legacyData));
  const paths = {
    config: confDir,
    data,
    // Medien lagen bisher unter <daten>/media – das bleibt der Standard außerhalb systemweiter Installationen
    media: resolve(env.AIRDECK_MEDIA ?? pathOf(conf['paths.media']) ?? (system ? sys.media : join(data, 'media'))),
    logs: resolve(env.AIRDECK_LOGS ?? pathOf(conf['paths.logs']) ?? (system ? sys.logs : join(data, 'logs'))),
    backups: resolve(pathOf(conf['paths.backups']) ?? (system ? sys.backups : join(data, 'backups'))),
  };

  const modeRaw = String(env.AIRDECK_MODE ?? conf.mode ?? conf['airdeck.mode'] ?? '').toLowerCase();
  // Ohne Angabe wie bisher: Desktop-Programm = Local, ohne Fenster (Dienst/Docker) = Server
  const mode: Mode = (MODES as readonly string[]).includes(modeRaw) ? (modeRaw as Mode) : desktop ? 'local' : 'server';

  const portRaw = Number(env.AIRDECK_PORT ?? conf['network.port'] ?? 8750);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 8750;

  // bind = local | lan | <Adresse>; ohne Angabe gilt die LAN-Einstellung aus dem Studio (network.json)
  const bind = String(conf['network.bind'] ?? '').toLowerCase();
  let host = env.AIRDECK_HOST;
  if (!host) {
    if (bind === 'lan' || bind === 'all') host = '0.0.0.0';
    else if (bind === 'local' || bind === '') host = bind === '' && readLan(join(data, 'network.json'), exists, read) ? '0.0.0.0' : '127.0.0.1';
    else host = bind;
  }
  return { mode, port, host, configFile, system, paths };
}

function readLan(file: string, exists: (p: string) => boolean, read: (p: string) => string): boolean {
  try {
    return exists(file) && (JSON.parse(read(file).replace(/^\uFEFF/, '')) as { lan?: boolean }).lan === true;
  } catch {
    return false;
  }
}

/** Legt beim ersten Start eine kommentierte airdeck.conf an (nur wenn keine existiert). */
export function writeDefaultConf(cfg: AirDeckConfig): boolean {
  if (existsSync(cfg.configFile)) return false;
  try {
    mkdirSync(dirname(cfg.configFile), { recursive: true });
    writeFileSync(cfg.configFile, [
      '# AirDeck – Grundeinstellungen. Änderungen wirken nach einem Neustart.',
      '# Umgebungsvariablen (AIRDECK_MODE, AIRDECK_PORT, AIRDECK_HOST, AIRDECK_DATA, AIRDECK_MEDIA) haben Vorrang.',
      '',
      '# local = alles auf diesem PC · server = Self-Hosted · hybrid = lokal senden, mit Server abgleichen',
      '# Ohne Angabe: Programm mit Fenster = local, ohne Fenster (Dienst, Docker, --headless) = server',
      '# mode = local',
      '',
      '[network]',
      `port = ${cfg.port}`,
      '# local = nur dieser PC · lan = im Netzwerk erreichbar · oder eine feste Adresse',
      '# (leer lassen = Einstellung im Studio unter „Netzwerk“)',
      '# bind = local',
      '',
      '[paths]',
      '# Relative Pfade gelten ab diesem Ordner.',
      `# data = ${cfg.paths.data}`,
      `# media = ${cfg.paths.media}`,
      `# logs = ${cfg.paths.logs}`,
      `# backups = ${cfg.paths.backups}`,
      '',
    ].join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Programmversion: im Build eingebettet, in der Entwicklung aus package.json. */
export function appVersion(root: string): string {
  if (globalThis.__AIRDECK_VERSION) return globalThis.__AIRDECK_VERSION;
  try {
    return String((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

declare global {
  // wird im gebündelten Build per Banner gesetzt (scripts/build.mjs)
  var __AIRDECK_VERSION: string | undefined;
}
