// HTTP-Schicht: REST API v1, Server-Sent Events, Medien, Relay-Ingest, Studio-Dateien.
// Ohne Framework (node:http), um Ressourcen und Abhängigkeiten minimal zu halten.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createReadStream, createWriteStream, existsSync, statSync, rmSync } from 'node:fs';
import path, { extname, join, normalize, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AirDeckApp, AppError, canSee, newId, type Principal } from './app.ts';
import { AiError } from './ai/providers.ts';
import { AuthError, ROLES, ROLE_LABEL, ROLE_SCOPES } from './users.ts';
import { MEDIA_CATEGORIES, parseFileName, type MediaCategory } from '../core/automation.ts';
import { OUTPUT_CAPABILITIES } from './icecast.ts';
import { DSP_PRESETS } from './playout.ts';
import { toIcecastXml, toM3u, toXspf, type StreamStatus } from './status.ts';
import { MAX_VOICE_BYTES } from './services/listeners.ts';
import { PUBLIC_API, RADIOADMIN, allowedPublicPath, allowedRadioadminPath, forward } from './lautfm.ts';

type Params = Record<string, string>;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Params;
  p: Principal;
  body: () => Promise<Record<string, unknown>>;
}
type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  scope: string | null;
  handler: Handler;
}

const AUDIO_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm',
};
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const MAX_UPLOAD = 300 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const MAX_CHUNK = 2 * 1024 * 1024;

/**
 * Erlaubte Fremd-Origins (Android-App, eigene Frontends). Standard: Capacitor-WebView.
 * Erweiterbar über AIRDECK_CORS_ORIGINS (kommagetrennt).
 */
const CORS_ORIGINS = new Set([
  'https://localhost', 'http://localhost', 'capacitor://localhost',
  ...String(process.env.AIRDECK_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
]);

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin || !CORS_ORIGINS.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

/**
 * Bedienung im laufenden Sendebetrieb – bleibt auch bei ausgefallener Datenbank möglich
 * (die Änderungen liegen im Speicher und werden nachgeschrieben, sobald die Datenbank wieder antwortet).
 */
export const ON_AIR_OPS = new RegExp('^/api/v1/(?:' + [
  'stations/[^/]+/sources/[^/]+/(?:chunks|health|release|takeover)',
  'stations/[^/]+/playout/(?:mic|skip|start|stop)',
  'stations/[^/]+/(?:mode|onair)',
  'stations/[^/]+/(?:decks/[^/]+(?:/[a-z]+)?|now-playing|metadata)',
  'stations/[^/]+/queue(?:/.*)?',
  'stations/[^/]+/(?:cardwall/[^/]+/trigger|quick/[^/]+)',
  'stations/[^/]+/(?:playlists/[^/]+/play|clock-events/[^/]+/fire)',
  'stations/[^/]+/recorder/(?:start|stop)',
  'stations/[^/]+/ai/pending/[^/]+/(?:approve|reject)',
  'bridge/stations/[^/]+/now-playing',
  'auth/logout',
  'system/shutdown',
].join('|') + ')$');

export function createHttpServer(app: AirDeckApp, studioDir: string): Server {
  const routes: Route[] = [];
  const add = (method: string, path: string, scope: string | null, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, scope, handler });
  };
  const sid = (c: Ctx) => {
    if (!canSee(c.p, c.params.sid!)) throw new AppError(403, 'forbidden', 'Kein Zugriff auf diesen Sender');
    return c.params.sid!;
  };

  // --- System ---
  add('GET', '/api/v1/me', null, (c) => ({ id: c.p.id, roles: c.p.roles, scopes: c.p.scopes, stationIds: c.p.stationIds, user: c.p.user ?? null }));

  // --- Benutzer & Anmeldung ---
  const authCall = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthError) throw new AppError(err.status, 'auth', err.message);
      throw err;
    }
  };
  add('POST', '/api/v1/auth/logout', null, (c) => {
    const tok = /^Bearer (.+)$/i.exec(String(c.req.headers.authorization ?? ''))?.[1];
    if (tok && c.p.user) app.users.logout(tok);
    app.audit.write({ kind: 'auth', event: 'logout', actor: c.p.id });
  });
  add('POST', '/api/v1/auth/password', null, async (c) => {
    if (!c.p.user) throw new AppError(400, 'no_user', 'Passwort ändern geht nur mit Benutzeranmeldung');
    const b = await c.body();
    const u = app.users.get(c.p.user.id)!;
    const { verifyPassword } = await import('./users.ts');
    if (!(await verifyPassword(String(b.current ?? ''), u.passwordHash))) throw new AppError(403, 'wrong_password', 'Aktuelles Passwort stimmt nicht');
    await authCall(() => app.users.update(u.id, { password: String(b.next ?? ''), mustChangePassword: false }));
    app.audit.write({ kind: 'auth', event: 'password_changed', actor: u.id });
    // alle Sitzungen wurden beendet – neu anmelden
    return authCall(() => app.users.login(u.username, String(b.next ?? ''), 'password-change'));
  });
  add('GET', '/api/v1/users', null, (c) => (globalAdmin(c), { users: app.users.list(), roles: ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r], scopes: ROLE_SCOPES[r] })) }));
  add('POST', '/api/v1/users', null, async (c) => {
    globalAdmin(c);
    const b = await c.body();
    const u = await authCall(() => app.users.create({ username: String(b.username ?? ''), name: str(b.name), password: String(b.password ?? ''), roles: b.roles, stationIds: b.stationIds, mustChangePassword: b.mustChangePassword !== false }));
    app.audit.write({ kind: 'auth', event: 'user_created', actor: c.p.id, user: u.id, roles: u.roles });
    return u;
  });
  add('PATCH', '/api/v1/users/:id', null, async (c) => {
    globalAdmin(c);
    const u = await authCall(async () => app.users.update(c.params.id!, await c.body()));
    app.audit.write({ kind: 'auth', event: 'user_updated', actor: c.p.id, user: u.id, roles: u.roles, disabled: !!u.disabled });
    return u;
  });
  add('DELETE', '/api/v1/users/:id', null, (c) => {
    globalAdmin(c);
    if (c.p.user?.id === c.params.id) throw new AppError(409, 'self', 'Das eigene Konto kann nicht gelöscht werden');
    return authCall(() => {
      app.users.remove(c.params.id!);
      app.audit.write({ kind: 'auth', event: 'user_deleted', actor: c.p.id, user: c.params.id });
    });
  });
  add('GET', '/api/v1/capabilities', null, () => ({ outputs: OUTPUT_CAPABILITIES, mediaTypes: Object.keys(AUDIO_EXT), categories: MEDIA_CATEGORIES }));
  add('GET', '/api/v1/audit', 'audit:read', (c) => app.audit.tail(Math.min(Number(c.url.searchParams.get('limit') ?? 100), 500)));
  add('GET', '/api/v1/tokens', 'tokens:write', () => app.svc.auth.listTokens());
  add('POST', '/api/v1/tokens', 'tokens:write', async (c) => {
    const b = await c.body();
    return app.svc.auth.createToken({ name: String(b.name ?? ''), scopes: arr(b.scopes), roles: arr(b.roles), stationIds: arr(b.stationIds) });
  });
  add('DELETE', '/api/v1/tokens/:id', 'tokens:write', (c) => app.svc.auth.revokeToken(c.params.id!));

  // --- Sender / Branding ---
  add('GET', '/api/v1/stations', 'branding:read', (c) => app.svc.stations.listStations(c.p));
  add('POST', '/api/v1/stations', 'stations:write', async (c) => {
    const b = await c.body();
    if (!c.p.stationIds.includes('*')) throw new AppError(403, 'forbidden', 'Nur globale Admins legen Sender an');
    return app.svc.stations.createStation({ id: String(b.id ?? ''), name: String(b.name ?? ''), slogan: str(b.slogan), primaryColor: str(b.primaryColor), accentColor: str(b.accentColor) }, b.withDefaultSources !== false);
  });
  add('GET', '/api/v1/stations/:sid', 'branding:read', (c) => app.svc.stations.station(sid(c)));
  add('PATCH', '/api/v1/stations/:sid', 'stations:write', async (c) => app.svc.stations.updateStation(sid(c), await c.body()));
  add('DELETE', '/api/v1/stations/:sid', 'stations:write', (c) => {
    if (!c.p.stationIds.includes('*')) throw new AppError(403, 'forbidden', 'Nur globale Admins löschen Sender');
    app.svc.stations.deleteStation(c.p, sid(c));
  });
  add('PUT', '/api/v1/stations/:sid/logo', 'stations:write', async (c) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const d of c.req) {
      size += (d as Buffer).length;
      if (size > 2 * 1024 * 1024) throw new AppError(413, 'too_large', 'Logo höchstens 2 MB');
      chunks.push(d as Buffer);
    }
    return app.svc.stations.setStationLogo(sid(c), String(c.req.headers['content-type'] ?? ''), Buffer.concat(chunks));
  });
  add('DELETE', '/api/v1/stations/:sid/logo', 'stations:write', (c) => app.svc.stations.removeStationLogo(sid(c)));

  // --- Quellen / Source Priority ---
  add('GET', '/api/v1/stations/:sid/sources', 'sources:read', (c) => app.listSources(sid(c)));
  add('POST', '/api/v1/stations/:sid/sources', 'sources:write', async (c) => app.addSource(c.p, sid(c), (await c.body()) as never));
  add('PATCH', '/api/v1/stations/:sid/sources/:id', 'sources:write', async (c) => app.updateSource(c.p, sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/sources/:id', 'sources:write', (c) => app.removeSource(c.p, sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/sources/:id/password', 'sources:write', async (c) => app.setSourcePassword(c.p, sid(c), c.params.id!, String((await c.body()).password ?? '')));
  add('POST', '/api/v1/stations/:sid/sources/:id/takeover', 'sources:write', async (c) => app.takeover(c.p, sid(c), c.params.id!, (await c.body()).force === true));
  add('POST', '/api/v1/stations/:sid/sources/:id/release', 'sources:write', (c) => app.release(c.p, sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/sources/:id/health', 'sources:write', async (c) => {
    const b = await c.body();
    app.reportHealth(sid(c), c.params.id!, b.healthy === true, str(b.reason));
  });
  add('POST', '/api/v1/stations/:sid/sources/:id/chunks', 'sources:write', async (c) => {
    const chunk = await readRaw(c.req, MAX_CHUNK);
    const type = String(c.req.headers['content-type'] ?? 'audio/webm').split(';')[0]!.trim();
    if (!/^audio\/[a-z0-9.+-]+$/i.test(type)) throw new AppError(400, 'invalid_type', 'Ungültiger Content-Type');
    app.studioChunk(c.p, sid(c), c.params.id!, type, chunk, c.url.searchParams.get('start') === '1');
  });

  // --- Ausgänge (Broadcast Adapter) ---
  add('GET', '/api/v1/stations/:sid/outputs', 'outputs:read', (c) => app.listOutputs(sid(c)));
  add('POST', '/api/v1/stations/:sid/outputs', 'outputs:write', async (c) => app.saveOutput(c.p, sid(c), null, await c.body()));
  add('PATCH', '/api/v1/stations/:sid/outputs/:id', 'outputs:write', async (c) => app.saveOutput(c.p, sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/outputs/:id', 'outputs:write', (c) => app.removeOutput(c.p, sid(c), c.params.id!));

  // --- AirDeckCast: Zusatz-Stream-Profile (ein Programmbus, mehrere Encoder-Ausgänge) ---
  add('GET', '/api/v1/stations/:sid/stream-profiles', 'outputs:read', (c) => app.listStreamProfiles(sid(c)));
  add('POST', '/api/v1/stations/:sid/stream-profiles', 'outputs:write', async (c) => app.saveStreamProfile(c.p, sid(c), null, await c.body()));
  add('PATCH', '/api/v1/stations/:sid/stream-profiles/:id', 'outputs:write', async (c) => app.saveStreamProfile(c.p, sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/stream-profiles/:id', 'outputs:write', (c) => app.removeStreamProfile(c.p, sid(c), c.params.id!));

  // --- Medien ---
  add('GET', '/api/v1/stations/:sid/media', 'media:read', (c) => app.svc.media.library(sid(c)));
  add('PUT', '/api/v1/stations/:sid/media', 'media:write', async (c) => {
    const s = sid(c);
    const name = String(c.url.searchParams.get('name') ?? '').slice(0, 200);
    const ext = extname(name).toLowerCase();
    if (!AUDIO_EXT[ext]) throw new AppError(415, 'unsupported_media', `Dateityp nicht unterstützt (${Object.keys(AUDIO_EXT).join(', ')})`);
    const catParam = c.url.searchParams.get('category') ?? 'music';
    const category = (MEDIA_CATEGORIES as readonly string[]).includes(catParam) ? (catParam as MediaCategory) : 'music';
    const id = newId('m');
    const file = `${id}${ext}`;
    const target = join(app.mediaDir, s, file);
    const len = Number(c.req.headers['content-length'] ?? 0);
    if (len > MAX_UPLOAD) throw new AppError(413, 'too_large', 'Datei zu groß');
    let size = 0;
    c.req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_UPLOAD) c.req.destroy(new Error('too_large'));
    });
    try {
      await pipeline(c.req, createWriteStream(target, { mode: 0o644 }));
    } catch {
      rmSync(target, { force: true });
      throw new AppError(413, 'upload_failed', 'Upload abgebrochen oder zu groß');
    }
    const meta = parseFileName(name);
    const folder = (c.url.searchParams.get('folder') ?? '').trim().slice(0, 80) || undefined;
    return app.svc.media.addMedia(s, { id, title: meta.title || name, artist: meta.artist, category, file, durationMs: null, addedAt: Date.now(), folder, originalName: name.replace(/^.*[\\/]/, '') });
  });
  add('PATCH', '/api/v1/stations/:sid/media/:id', 'media:write', async (c) => app.svc.media.updateMedia(sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/media/:id', 'media:write', (c) => app.svc.media.removeMedia(sid(c), c.params.id!));
  add('GET', '/api/v1/stations/:sid/media/:id/file', 'media:read', (c) => {
    const s = sid(c);
    const m = app.svc.media.media(s, c.params.id!);
    if (m.url) {
      c.res.writeHead(302, { Location: m.url });
      c.res.end();
      return STREAMED;
    }
    sendFile(c.req, c.res, app.svc.media.mediaPath(s, m), AUDIO_EXT[extname(m.file)] ?? 'application/octet-stream');
    return STREAMED;
  });

  // --- Queue / Automation / Decks ---
  add('GET', '/api/v1/stations/:sid/queue', 'queue:read', (c) => app.queueView(sid(c), Number(c.url.searchParams.get('remainingMs') ?? 0)));
  add('POST', '/api/v1/stations/:sid/queue', 'queue:write', async (c) => {
    const b = await c.body();
    app.queueAdd(sid(c), String(b.mediaId ?? ''), typeof b.index === 'number' ? b.index : undefined);
  });
  add('POST', '/api/v1/stations/:sid/queue/next', 'queue:write', (c) => ({ media: app.queueNext(sid(c)) }));
  add('POST', '/api/v1/stations/:sid/queue/fill', 'queue:write', (c) => app.queueFill(sid(c)));
  add('POST', '/api/v1/stations/:sid/queue/clear', 'queue:write', (c) => app.queueClear(sid(c)));
  add('POST', '/api/v1/stations/:sid/queue/:uid/move', 'queue:write', async (c) => app.queueMove(sid(c), c.params.uid!, Number((await c.body()).index)));
  add('DELETE', '/api/v1/stations/:sid/queue/:uid', 'queue:write', (c) => app.queueRemove(sid(c), c.params.uid!));
  add('GET', '/api/v1/stations/:sid/automation', 'automation:read', (c) => app.automationView(sid(c)));
  add('PATCH', '/api/v1/stations/:sid/automation', 'automation:write', async (c) => app.setAutomation(sid(c), (await c.body()) as never));
  add('GET', '/api/v1/stations/:sid/now-playing', 'now_playing:read', (c) => app.nowPlaying(sid(c)));
  // Wer automatisiert diesen Sender tatsächlich (AirDeck-Server-Playout oder laut.fm über den
  // Radioadmin)? Das Studio zeigt bei laut.fm den echten aktuellen Titel statt leerer Decks.
  add('GET', '/api/v1/stations/:sid/automation-source', 'now_playing:read', (c) => app.svc.status.automationSource(sid(c)));
  add('POST', '/api/v1/stations/:sid/now-playing', 'automation:write', async (c) => {
    const b = await c.body();
    return app.setNowPlaying(sid(c), String(b.mediaId ?? ''), String(b.deck ?? 'A') as never);
  });
  add('GET', '/api/v1/stations/:sid/decks', 'automation:read', (c) => app.decks(sid(c)));
  add('POST', '/api/v1/stations/:sid/decks/:deck/:action', 'automation:write', async (c) => app.deckAction(c.p, sid(c), c.params.deck!, c.params.action!, await c.body()));
  add('PUT', '/api/v1/stations/:sid/decks/:deck', 'automation:write', async (c) => app.setDeck(sid(c), c.params.deck!, (await c.body()) as never));

  // --- Server-Playout (24/7) ---
  add('GET', '/api/v1/stations/:sid/playout', 'automation:read', (c) => app.playoutView(sid(c)));
  add('PATCH', '/api/v1/stations/:sid/playout', 'automation:write', async (c) => {
    app.savePlayoutConfig(sid(c), (await c.body()) as never);
    return app.playoutView(sid(c));
  });
  add('POST', '/api/v1/stations/:sid/playout/start', 'automation:write', async (c) => app.startPlayout(c.p, sid(c), (await c.body()) as never));
  add('POST', '/api/v1/stations/:sid/playout/stop', 'automation:write', (c) => app.stopPlayout(c.p, sid(c)));
  add('POST', '/api/v1/stations/:sid/playout/mic', 'automation:write', async (c) => app.setMic(sid(c), (await c.body()).on === true));
  // Zustandsberichte (angemeldet): Laufzeit, Abhängigkeiten, Datenbank, Audio, Encoder, Stream, KI
  add('GET', '/api/v1/system', null, () => ({ ...(app.svc.system.system() as object), ...app.health.system() }));
  add('GET', '/api/v1/database', null, () => app.databaseReport());
  add('GET', '/api/v1/audio', null, () => app.health.audio());
  add('GET', '/api/v1/encoder', null, (c) => app.health.encoder((s) => canSee(c.p, s)));
  add('GET', '/api/v1/stream', null, (c) => app.health.stream((s) => canSee(c.p, s)));
  add('GET', '/api/v1/ai', 'ai:read', () => app.health.ai());
  add('POST', '/api/v1/stations/:sid/quick/:category', 'cardwall:trigger', async (c) => app.quickTrigger(sid(c), c.params.category!, str((await c.body()).mode)));
  add('GET', '/api/v1/stations/:sid/media/:id/cover', 'media:read', async (c) => {
    const file = await app.svc.media.cover(sid(c), c.params.id!);
    if (!file) throw new AppError(404, 'no_cover', 'Kein Cover');
    c.res.setHeader('Cache-Control', 'private, max-age=86400');
    sendFile(c.req, c.res, file, 'image/jpeg');
    return STREAMED;
  });
  add('GET', '/api/v1/audio-devices', 'automation:read', () => app.inputDevices());
  add('POST', '/api/v1/stations/:sid/queue/shuffle', 'queue:write', (c) => app.shuffleQueue(sid(c)));
  add('POST', '/api/v1/stations/:sid/playout/skip', 'automation:write', (c) => app.skipPlayout(sid(c)));
  // Mode-Manager: AUTO/MANUAL setzt der Operator; LIVE/EMERGENCY ergeben sich aus dem Sendezustand
  add('GET', '/api/v1/stations/:sid/mode', 'automation:read', (c) => app.modeView(sid(c)));
  add('PUT', '/api/v1/stations/:sid/mode', 'automation:write', async (c) => app.setBaseMode(c.p, sid(c), String((await c.body()).mode ?? '')));
  add('POST', '/api/v1/stations/:sid/onair', 'automation:write', async (c) => app.playNow(c.p, sid(c), String((await c.body()).mediaId ?? '')));

  // --- Ordner, URL-Streams, M3U, Titelanzeige, Verlauf ---
  add('GET', '/api/v1/stations/:sid/folders', 'media:read', (c) => app.svc.media.folders(sid(c)));
  add('GET', '/api/v1/stations/:sid/media/integrity', 'media:read', (c) => app.svc.media.integrityCheck(sid(c)));
  add('POST', '/api/v1/stations/:sid/media/:id/relink', 'media:write', async (c) => app.svc.media.relinkMedia(sid(c), c.params.id!, String((await c.body()).file ?? '')));
  add('POST', '/api/v1/stations/:sid/media/url', 'media:write', async (c) => app.svc.media.addUrlMedia(sid(c), (await c.body()) as never));
  add('POST', '/api/v1/stations/:sid/queue/fill-from', 'queue:write', async (c) => ({ added: app.queueFillFrom(sid(c), (await c.body()) as never) }));
  add('GET', '/api/v1/stations/:sid/queue.m3u', 'queue:read', (c) => {
    const text = app.svc.media.exportQueueM3U(sid(c));
    c.res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Content-Disposition': 'attachment; filename="airdeck-queue.m3u"' });
    c.res.end(text);
    return STREAMED;
  });
  add('POST', '/api/v1/stations/:sid/m3u/import', 'queue:write', async (c) => {
    const b = await c.body();
    return app.svc.media.importM3U(sid(c), String(b.text ?? ''), { playlistName: typeof b.playlistName === 'string' && b.playlistName ? b.playlistName : undefined });
  });
  add('POST', '/api/v1/stations/:sid/metadata', 'automation:write', async (c) => {
    const b = await c.body();
    app.sendMetadata(sid(c), String(b.artist ?? ''), String(b.title ?? ''));
  });
  add('GET', '/api/v1/stations/:sid/history', 'now_playing:read', (c) => app.history(sid(c), Number(c.url.searchParams.get('limit') ?? 200)));

  // --- Playlists ---
  add('GET', '/api/v1/stations/:sid/playlists', 'queue:read', (c) => app.svc.planning.playlists(sid(c)));
  add('POST', '/api/v1/stations/:sid/playlists', 'queue:write', async (c) => {
    const b = await c.body();
    return b.fromQueue === true ? app.svc.planning.saveQueueAsPlaylist(sid(c), String(b.name ?? 'Playlist')) : app.svc.planning.savePlaylist(sid(c), null, b);
  });
  add('PATCH', '/api/v1/stations/:sid/playlists/:id', 'queue:write', async (c) => app.svc.planning.savePlaylist(sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/playlists/:id', 'queue:write', (c) => app.svc.planning.deletePlaylist(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/playlists/:id/play', 'automation:write', (c) => app.svc.planning.playPlaylist(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/playlists/:id/shuffle', 'queue:write', (c) => app.svc.planning.reshufflePlaylist(sid(c), c.params.id!));

  // --- Planung: Zeitplan, Stunden-Uhr, Sendeplan ---
  add('GET', '/api/v1/stations/:sid/planning', 'schedule:read', (c) => app.svc.planning.planning(sid(c)));
  add('GET', '/api/v1/stations/:sid/preflight', 'schedule:read', (c) => app.svc.planning.preflight(sid(c)));
  add('POST', '/api/v1/stations/:sid/jobs', 'automation:write', async (c) => app.svc.planning.saveJob(sid(c), await c.body()));
  add('DELETE', '/api/v1/stations/:sid/jobs/:id', 'automation:write', (c) => app.svc.planning.deleteJob(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/clock-events', 'automation:write', async (c) => app.svc.planning.saveClockEvent(sid(c), null, await c.body()));
  add('PATCH', '/api/v1/stations/:sid/clock-events/:id', 'automation:write', async (c) => app.svc.planning.saveClockEvent(sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/clock-events/:id', 'automation:write', (c) => app.svc.planning.deleteClockEvent(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/clock-events/:id/fire', 'automation:write', (c) => app.svc.planning.fireClockEvent(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/plans', 'automation:write', async (c) => app.svc.planning.savePlan(sid(c), null, await c.body()));
  add('PATCH', '/api/v1/stations/:sid/plans/:id', 'automation:write', async (c) => app.svc.planning.savePlan(sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/plans/:id', 'automation:write', (c) => app.svc.planning.deletePlan(sid(c), c.params.id!));

  // --- Recorder / Replays ---
  add('GET', '/api/v1/stations/:sid/recordings', 'automation:read', (c) => app.svc.recorder.recordings(sid(c)));
  add('POST', '/api/v1/stations/:sid/recorder/start', 'automation:write', async (c) => app.svc.recorder.startRecording(sid(c), str((await c.body()).label)));
  add('POST', '/api/v1/stations/:sid/recorder/stop', 'automation:write', (c) => app.svc.recorder.stopRecording(sid(c)));
  add('GET', '/api/v1/stations/:sid/recordings/:id/file', 'automation:read', (c) => {
    const { path, rec } = app.svc.recorder.recordingFile(sid(c), c.params.id!);
    c.res.setHeader('Content-Disposition', `attachment; filename="${rec.label.replace(/[^\w .()-]/g, '_')}.${rec.file.split('.').pop()}"`);
    sendFile(c.req, c.res, path, rec.contentType || 'application/octet-stream');
    return STREAMED;
  });
  add('DELETE', '/api/v1/stations/:sid/recordings/:id', 'automation:write', (c) => app.svc.recorder.deleteRecording(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/rec-plans', 'automation:write', async (c) => app.svc.recorder.saveRecPlan(sid(c), null, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/rec-plans/:id', 'automation:write', (c) => app.svc.recorder.deleteRecPlan(sid(c), c.params.id!));

  // --- Datenspeicher / Sync (MySQL, Firebase) – nur globale Admins ---
  const globalAdmin = (c: Ctx) => {
    if (!c.p.stationIds.includes('*') || !c.p.roles.includes('admin')) throw new AppError(403, 'forbidden', 'Nur für Administratoren');
  };
  add('GET', '/api/v1/storage', null, (c) => (globalAdmin(c), app.sync.view()));
  add('PUT', '/api/v1/storage', null, async (c) => {
    globalAdmin(c);
    try {
      return await app.sync.configure((await c.body()) as never, true);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(400, 'storage_error', (err as Error).message);
    }
  });
  add('POST', '/api/v1/storage/sync', null, async (c) => {
    globalAdmin(c);
    app.persistNow();
    try {
      await app.sync.pushNow(app.stateJson());
    } catch (err) {
      throw new AppError(502, 'sync_failed', (err as Error).message);
    }
    return app.sync.view();
  });

  // --- Updates ---
  add('GET', '/api/v1/update', 'automation:read', (c) => app.svc.system.checkUpdate(c.url.searchParams.get('force') === '1'));
  add('GET', '/api/v1/update/settings', null, (c) => (globalAdmin(c), app.svc.system.updateSettingsView()));
  add('PUT', '/api/v1/update/settings', null, async (c) => (globalAdmin(c), app.svc.system.setUpdateSettings(await c.body())));
  add('POST', '/api/v1/update/install', null, (c) => {
    globalAdmin(c);
    return app.svc.system.installUpdate(() => {
      app.shutdown();
      process.exit(0);
    });
  });
  // APK für die Android-App über diesen AirDeck laden (funktioniert auch bei privatem Repository)
  add('GET', '/api/v1/update/apk', 'automation:read', async (c) => {
    const info = (await app.svc.system.checkUpdate()) as { assets: { apk?: import('./update.ts').UpdateAsset }; error?: string };
    if (!info.assets.apk) throw new AppError(404, 'no_apk', info.error ?? 'Keine APK im Release');
    const r = await app.updater.open(info.assets.apk, app.secrets.get('update:token'));
    c.res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="AirDeck-Android.apk"', ...(info.assets.apk.size ? { 'Content-Length': info.assets.apk.size } : {}) });
    await pipeline(Readable.fromWeb(r.body as never), c.res);
    return STREAMED;
  });

  // --- Brücke zu bestehenden Systemen (AzuraCast, Icecast, Streams) ---
  add('GET', '/api/v1/stations/:sid/bridges', 'sources:read', (c) => app.svc.bridges.bridges(sid(c)));
  add('POST', '/api/v1/stations/:sid/bridges', 'sources:write', async (c) => app.svc.bridges.saveBridge(c.p, sid(c), null, await c.body()));
  add('PATCH', '/api/v1/stations/:sid/bridges/:id', 'sources:write', async (c) => app.svc.bridges.saveBridge(c.p, sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/bridges/:id', 'sources:write', (c) => app.svc.bridges.saveBridge(c.p, sid(c), c.params.id!, { remove: true }));

  // --- Bridge-API für Entwickler: externe Schlüssel, idempotent ---
  const bridgeKey = (c: Ctx) => decodeURIComponent(c.params.key!);
  add('GET', '/api/v1/bridge/mappings', 'bridge:write', (c) => {
    const all = app.svc.bridges.bridgeMappings();
    return Object.fromEntries(Object.entries(all).filter(([, s]) => canSee(c.p, s)));
  });
  add('PUT', '/api/v1/bridge/stations/:key', 'bridge:write', async (c) => {
    const key = bridgeKey(c);
    const known = app.svc.bridges.bridgeMappings()[key];
    if (known ? !canSee(c.p, known) : !c.p.stationIds.includes('*')) throw new AppError(403, 'forbidden', known ? 'Kein Zugriff auf diesen Sender' : 'Nur globale Tokens legen Sender an');
    return app.svc.bridges.bridgeUpsertStation(key, await c.body());
  });
  add('POST', '/api/v1/bridge/stations/:key/now-playing', 'bridge:write', async (c) => {
    const key = bridgeKey(c);
    if (!canSee(c.p, app.svc.bridges.bridgeStation(key))) throw new AppError(403, 'forbidden', 'Kein Zugriff auf diesen Sender');
    return app.svc.bridges.bridgeNowPlaying(key, await c.body());
  });
  // Für Sendesoftware, die nur einfache HTTP-GET-Aufrufe kann (SAM, mAirList, RadioDJ): Parameter in der URL, Token als ?token=
  add('GET', '/api/v1/bridge/stations/:key/now-playing', 'bridge:write', (c) => {
    const key = bridgeKey(c);
    if (!canSee(c.p, app.svc.bridges.bridgeStation(key))) throw new AppError(403, 'forbidden', 'Kein Zugriff auf diesen Sender');
    const q = c.url.searchParams;
    const n = (k: string) => (q.get(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
    const dur = n('durationMs') ?? (n('duration') !== undefined ? n('duration')! * 1000 : undefined);
    return app.svc.bridges.bridgeNowPlaying(key, { artist: q.get('artist') ?? '', title: q.get('title') ?? '', album: q.get('album') ?? undefined, durationMs: dur, listeners: n('listeners'), startedAt: q.get('startedAt') ?? undefined });
  });

  // --- Liquidsoap-Skript (ohne Passwörter) ---
  add('GET', '/api/v1/stations/:sid/liquidsoap', 'outputs:read', (c) => {
    const q = c.url.searchParams;
    const r = app.svc.system.liquidsoap(sid(c), { port: q.get('port') ? Number(q.get('port')) : undefined, mount: q.get('mount') ?? undefined, processing: q.get('processing') !== '0' });
    if (q.get('format') === 'json') return r;
    c.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="airdeck-${sid(c)}.liq"` });
    c.res.end(r.script);
    return STREAMED;
  });

  // --- Lautheitsanalyse & Klangprofile ---
  add('GET', '/api/v1/dsp/presets', 'automation:read', () => DSP_PRESETS);
  add('GET', '/api/v1/stations/:sid/media/loudness', 'media:read', (c) => app.svc.media.loudnessStatus(sid(c)));
  add('POST', '/api/v1/stations/:sid/media/loudness', 'media:write', async (c) => app.svc.media.analyzeLibrary(sid(c), (await c.body()).force === true));

  // --- Nextcloud-Brücke ---
  add('GET', '/api/v1/nextcloud', null, (c) => (globalAdmin(c), app.svc.nextcloud.nextcloudConfig()));
  add('PUT', '/api/v1/nextcloud', null, async (c) => (globalAdmin(c), app.svc.nextcloud.setNextcloud(await c.body())));
  add('GET', '/api/v1/nextcloud/list', 'media:read', (c) => app.svc.nextcloud.nextcloudList(c.url.searchParams.get('path') ?? '/'));
  add('POST', '/api/v1/stations/:sid/nextcloud/import', 'media:write', async (c) => {
    const b = await c.body();
    return app.svc.nextcloud.nextcloudImport(sid(c), Array.isArray(b.paths) ? b.paths.map(String) : [], { category: str(b.category), folder: str(b.folder) });
  });
  add('POST', '/api/v1/stations/:sid/recordings/:id/nextcloud', 'media:write', async (c) => app.svc.nextcloud.nextcloudUploadRecording(sid(c), c.params.id!, String((await c.body()).dir ?? '')));

  // --- Programm beenden (Windows-Hintergrundprozess, Tray, „AirDeck beenden“) ---
  add('POST', '/api/v1/system/shutdown', null, (c) => {
    globalAdmin(c);
    if (!app.requestShutdown) throw new AppError(501, 'unsupported', 'Beenden ist hier nicht möglich');
    setTimeout(() => app.requestShutdown?.(), 300).unref();
    return { stopping: true };
  });

  // --- Android-App / Netzwerk ---
  add('GET', '/api/v1/app/connect', null, (c) => (globalAdmin(c), app.svc.system.appConnect()));
  // Geräte koppeln und verwalten
  add('POST', '/api/v1/pairing', 'tokens:write', async (c) => {
    const b = await c.body();
    return { ...app.svc.devices.createPairing(c.p, { role: b.role as string, stationIds: b.stationIds }), ...(app.svc.system.appConnect() as object) };
  });
  add('GET', '/api/v1/devices', 'tokens:write', () => app.svc.devices.list());
  // Hörer-Posteingang und Einstellungen
  add('GET', '/api/v1/stations/:sid/inbox', 'queue:read', (c) => app.svc.listeners.inbox(sid(c)));
  add('POST', '/api/v1/stations/:sid/inbox/:id/:action', 'queue:write', (c) => app.svc.listeners.action(c.p, sid(c), c.params.id!, c.params.action!));
  add('GET', '/api/v1/stations/:sid/inbox/:id/audio', 'queue:read', (c) => {
    const f = app.svc.listeners.voiceFile(sid(c), c.params.id!);
    sendFile(c.req, c.res, f.path, f.type);
    return STREAMED;
  });
  add('GET', '/api/v1/stations/:sid/listener', 'queue:read', (c) => app.svc.listeners.config(sid(c)));
  add('PUT', '/api/v1/stations/:sid/listener', 'stations:write', async (c) => app.svc.listeners.setConfig(c.p, sid(c), await c.body()));
  // Setup-Assistent (nur Administration)
  add('GET', '/api/v1/setup', null, (c) => (globalAdmin(c), app.svc.setup.status()));
  add('PUT', '/api/v1/setup/:step', null, async (c) => (globalAdmin(c), app.svc.setup.apply(c.p, c.params.step!, await c.body())));
  add('POST', '/api/v1/system/restart', null, (c) => {
    globalAdmin(c);
    if (!app.requestRestart) throw new AppError(501, 'unsupported', 'Neustart ist hier nicht möglich – bitte AirDeck von Hand neu starten');
    app.audit.write({ kind: 'system', event: 'restart', actor: c.p.id });
    setTimeout(() => app.requestRestart?.(), 300).unref();
    return { restarting: true };
  });
  // LAN-Erkennung vom Browser aus anstoßen (der Browser selbst kann kein UDP - der Server sucht stellvertretend
  // in seinem eigenen Netz. Nützlich z. B. auf einem Docker-/Server-Host, um weitere AirDeck-Instanzen im
  // selben Netz zum Wechseln/Koppeln zu finden, s. "Server wechseln").
  add('GET', '/api/v1/discover', null, async (c) => {
    globalAdmin(c);
    const { discover } = await import('./discovery.ts');
    return { found: await discover() };
  });
  // Sicherung/Wiederherstellung (nur Administration - betrifft die gesamte Installation, nicht nur einen Sender)
  add('GET', '/api/v1/backup', null, (c) => (globalAdmin(c), app.svc.backup.list()));
  add('POST', '/api/v1/backup', null, (c) => (globalAdmin(c), app.svc.backup.create()));
  add('POST', '/api/v1/backup/:file/restore', null, (c) => (globalAdmin(c), app.svc.backup.restore(c.params.file!)));
  // Eingebundene Musikordner (Serverpfade – nur Administration)
  add('GET', '/api/v1/stations/:sid/folders/linked', 'media:read', (c) => app.svc.media.linkedFolders(sid(c)));
  add('POST', '/api/v1/stations/:sid/folders/linked', null, async (c) => (globalAdmin(c), app.svc.media.linkFolder(sid(c), await c.body())));
  add('POST', '/api/v1/stations/:sid/folders/linked/scan', null, async (c) => {
    globalAdmin(c);
    const path = String((await c.body()).path ?? '');
    const f = app.svc.media.linkedFolders(sid(c)).find((x) => x.path === path);
    if (!f) throw new AppError(404, 'not_found', 'Ordner ist nicht eingebunden');
    return app.svc.media.scanFolder(sid(c), f);
  });
  add('DELETE', '/api/v1/stations/:sid/folders/linked', null, async (c) => (globalAdmin(c), app.svc.media.unlinkFolder(sid(c), String((await c.body()).path ?? ''))));
  add('DELETE', '/api/v1/devices/:id', 'tokens:write', (c) => app.svc.devices.revoke(c.p, c.params.id!));
  // andere AirDeck-Server im Netz finden (für „Server hinzufügen“ auf dem Desktop)
  add('GET', '/api/v1/discover', null, async () => {
    const { discover } = await import('./discovery.ts');
    return (await discover()).filter((f) => f.id !== app.sync.instance);
  });
  add('PUT', '/api/v1/app/network', null, async (c) => (globalAdmin(c), app.svc.system.setNetwork((await c.body()).lan === true)));

  // --- KI-Automation ---
  const aiErr = (err: unknown) => (err instanceof AppError ? err : new AppError(err instanceof AiError && err.code === 'not_found' ? 404 : err instanceof AiError && ['invalid', 'unknown_provider'].includes(err.code) ? 400 : 502, 'ai_error', (err as Error).message));
  const aiCall = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw aiErr(err);
    }
  };
  add('GET', '/api/v1/ai/settings', null, (c) => (globalAdmin(c), app.ai.view()));
  add('PUT', '/api/v1/ai/settings', null, async (c) => {
    globalAdmin(c);
    const b = await c.body();
    return aiCall(() => app.ai.update(b));
  });
  add('GET', '/api/v1/ai/usage', null, (c) => (globalAdmin(c), app.ai.usageView()));
  add('GET', '/api/v1/ai/providers/:id/models', null, (c) => (globalAdmin(c), aiCall(() => app.ai.models(c.params.id!))));
  add('GET', '/api/v1/ai/providers/:id/voices', null, (c) => (globalAdmin(c), aiCall(() => app.ai.voices(c.params.id!))));
  add('GET', '/api/v1/stations/:sid/ai', 'ai:read', (c) => ({ config: app.svc.ai.aiConfig(sid(c)), state: app.director.view(sid(c)) }));
  add('PUT', '/api/v1/stations/:sid/ai', 'ai:write', async (c) => app.svc.ai.setAiConfig(c.p, sid(c), await c.body()));
  add('POST', '/api/v1/stations/:sid/ai/moderation', 'ai:write', async (c) => {
    const kind = (await c.body()).kind === 'news' ? 'news' : 'break';
    const r = await app.director.produce(sid(c), kind);
    if (!r) throw new AppError(502, 'ai_failed', (app.director.view(sid(c)) as { log: { detail: string }[] }).log[0]?.detail ?? 'KI-Moderation fehlgeschlagen oder läuft bereits');
    return r;
  });
  add('POST', '/api/v1/stations/:sid/ai/music', 'ai:write', async (c) => ({ added: await app.director.maintainMusic(sid(c), true) }));
  add('POST', '/api/v1/stations/:sid/ai/pending/:id/approve', 'ai:write', (c) => aiCall(() => app.director.approve(sid(c), c.params.id!)));
  add('POST', '/api/v1/stations/:sid/ai/pending/:id/reject', 'ai:write', (c) => aiCall(() => app.director.reject(sid(c), c.params.id!)));
  add('POST', '/api/v1/stations/:sid/ai/text', 'ai:write', async (c) => {
    const b = await c.body();
    return app.svc.ai.aiText(sid(c), String(b.prompt ?? ''), typeof b.system === 'string' ? b.system : undefined);
  });
  add('POST', '/api/v1/stations/:sid/ai/speech', 'ai:write', async (c) => app.svc.ai.aiSpeech(sid(c), await c.body()));

  // --- Benachrichtigungen / Webhooks / Now-Playing-Export ---
  add('GET', '/api/v1/stations/:sid/integrations', 'stations:write', (c) => app.svc.notifications.integrations(sid(c)));
  add('PUT', '/api/v1/stations/:sid/integrations', 'stations:write', async (c) => app.svc.notifications.setIntegrations(c.p, sid(c), await c.body()));
  add('POST', '/api/v1/stations/:sid/integrations/test', 'stations:write', (c) => app.svc.notifications.testIntegrations(sid(c)));

  // --- laut.fm ---
  add('GET', '/api/v1/stations/:sid/lautfm', 'lautfm:read', (c) => app.svc.lautfm.lautfmConfig(sid(c)));
  add('PUT', '/api/v1/stations/:sid/lautfm', 'lautfm:write', async (c) => app.svc.lautfm.setLautfmConfig(c.p, sid(c), await c.body()));
  add('POST', '/api/v1/stations/:sid/lautfm/connect', 'lautfm:write', async (c) => app.svc.lautfm.connect(c.p, sid(c), await c.body()));
  add('POST', '/api/v1/stations/:sid/lautfm/check', 'lautfm:read', (c) => app.svc.lautfm.check(sid(c)));
  add('POST', '/api/v1/stations/:sid/lautfm/live-output', 'outputs:write', async (c) => {
    const b = await c.body();
    const prio = b.priority === undefined || b.priority === null || b.priority === '' ? undefined : Number(b.priority);
    return app.svc.lautfm.lautfmCreateOutput(c.p, sid(c), prio);
  });
  // Eigener Sender (keine laut.fm-Identität) zusätzlich live auf laut.fm senden: eigenes Token je Aufruf,
  // unabhängig von einer eventuellen „laut.fm“-Verbindung dieses Senders (siehe Ausgänge im Studio).
  add('POST', '/api/v1/stations/:sid/lautfm/relay-output', 'outputs:write', async (c) => app.svc.lautfm.connectRelayOutput(c.p, sid(c), await c.body()));

  // --- Cardwall ---
  add('GET', '/api/v1/stations/:sid/cardwall', 'cardwall:read', (c) => app.cardwall(sid(c)));
  add('PATCH', '/api/v1/stations/:sid/cardwall/:slot', 'automation:write', async (c) => app.updateCart(sid(c), c.params.slot!, await c.body()));
  add('POST', '/api/v1/stations/:sid/cardwall/:slot/trigger', 'cardwall:trigger', (c) => app.triggerCart(sid(c), c.params.slot!));

  // --- Echtzeit-Events (SSE) ---
  add('GET', '/api/v1/events', null, (c) => {
    const filter = c.url.searchParams.get('station');
    if (filter && !canSee(c.p, filter)) throw new AppError(403, 'forbidden', 'Kein Zugriff');
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    c.res.write('retry: 2000\n\n');
    const unsub = app.subscribe((e) => {
      if (e.stationId && (!canSee(c.p, e.stationId) || (filter && e.stationId !== filter))) return;
      if (c.res.writableLength > 1024 * 1024) return; // langsamer Client: Events verwerfen statt Speicher zu fressen
      c.res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
    });
    const ping = setInterval(() => c.res.write(': ping\n\n'), 20_000);
    c.req.on('close', () => {
      unsub();
      clearInterval(ping);
    });
    return STREAMED;
  });

  // --- Rate Limit pro Token (Token Bucket) ---
  const buckets = new Map<string, { tokens: number; at: number }>();
  const allow = (key: string) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: 120, at: now };
    b.tokens = Math.min(120, b.tokens + ((now - b.at) / 1000) * 40);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    setSecurityHeaders(res);
    const cors = applyCors(req, res);
    // Hörerbereich beantwortet seine Vorabanfrage (CORS) selbst – er ist absichtlich von überall erreichbar
    if (req.method === 'OPTIONS' && !path.startsWith('/api/v1/public/')) {
      res.writeHead(cors ? 204 : 403);
      return void res.end();
    }

    if (path.startsWith('/ingest/')) return handleIngest(app, req, res, path);
    // öffentlich, ohne Details (NETWORK.md); `ok` bleibt für ältere Clients erhalten
    if (path === '/api/v1/health') {
      res.setHeader('Cache-Control', 'no-store');
      const h = app.health.summary();
      return json(res, h.status === 'error' ? 503 : 200, { ok: h.status !== 'error', ...h });
    }
    // Anmeldung (öffentlich): Benutzername + Passwort → Sitzungs-Token; Sperre nach Fehlversuchen im UserStore
    // pairing: Geräte können sich immer per Kopplungscode verbinden (auch ohne Benutzerkonten, z. B. Desktop)
    if (path === '/api/v1/auth/status' && req.method === 'GET') return json(res, 200, { users: app.users.count > 0, pairing: true });
    // Kopplungscode einlösen (öffentlich; Sperre nach wiederholten Fehlversuchen je Adresse)
    if (path === '/api/v1/pair' && req.method === 'POST') {
      try {
        const b = JSON.parse((await readRaw(req, 4 * 1024)).toString('utf8') || '{}') as { code?: string; name?: string; platform?: string };
        return json(res, 200, app.svc.devices.redeem(String(b.code ?? ''), b, String(req.socket.remoteAddress ?? '')));
      } catch (err) {
        if (err instanceof AppError) return json(res, err.status, { error: err.code, message: err.message });
        return json(res, 400, { error: 'invalid', message: 'Ungültige Anfrage' });
      }
    }
    if (path === '/api/v1/auth/login' && req.method === 'POST') {
      try {
        const b = JSON.parse((await readRaw(req, 16 * 1024)).toString('utf8') || '{}') as { username?: string; password?: string };
        const ip = String(req.socket.remoteAddress ?? '');
        const r = await app.users.login(String(b.username ?? ''), String(b.password ?? ''), ip);
        app.audit.write({ kind: 'auth', event: 'login', actor: r.user.id, ip });
        return json(res, 200, r);
      } catch (err) {
        if (err instanceof AuthError) {
          app.audit.write({ kind: 'auth', event: 'login_failed', ip: String(req.socket.remoteAddress ?? ''), status: err.status });
          return json(res, err.status, { error: 'auth', message: err.message });
        }
        return json(res, 400, { error: 'invalid', message: 'Ungültige Anfrage' });
      }
    }
    // Hörerbereich (öffentlich, je Sender einzeln freizuschalten): Info, Suche, Wunsch, Gruß, Stimme, Charts, Sprachnachricht
    const lp = /^\/api\/v1\/public\/stations\/([a-z0-9-]{1,40})\/listener(?:\/(search|request|message|vote|charts|voice))?$/.exec(path);
    if (lp) {
      // von der Senderseite einbettbar: jede Herkunft, aber ohne Anmeldedaten
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      const [, lsid, action] = lp;
      const ip = String(req.socket.remoteAddress ?? '');
      const L = app.svc.listeners;
      try {
        if (req.method === 'GET' && !action) return json(res, 200, L.publicInfo(lsid!));
        if (req.method === 'GET' && action === 'search') return json(res, 200, L.search(lsid!, url.searchParams.get('q') ?? '', ip));
        if (req.method === 'GET' && action === 'charts') return json(res, 200, L.publicCharts(lsid!));
        if (req.method === 'POST' && action === 'voice') {
          // zu große Uploads sofort ablehnen, bevor Daten gelesen werden (sauberes 413 statt Verbindungsabbruch)
          if (Number(req.headers['content-length'] ?? 0) > MAX_VOICE_BYTES) {
            res.setHeader('Connection', 'close');
            return json(res, 413, { error: 'too_large', message: 'Sprachnachricht zu groß' });
          }
          const data = await readRaw(req, MAX_VOICE_BYTES + 1);
          return json(res, 200, L.voice(lsid!, ip, String(req.headers['content-type'] ?? ''), data, { name: url.searchParams.get('name'), text: url.searchParams.get('text') }));
        }
        if (req.method === 'POST' && (action === 'request' || action === 'message' || action === 'vote')) {
          const b = JSON.parse((await readRaw(req, 8 * 1024)).toString('utf8') || '{}') as Record<string, unknown>;
          return json(res, 200, action === 'request' ? L.request(lsid!, ip, b) : action === 'message' ? L.message(lsid!, ip, b) : L.vote(lsid!, ip, b));
        }
        return json(res, 405, { error: 'method_not_allowed' });
      } catch (err) {
        if (err instanceof AppError) return json(res, err.status, { error: err.code, message: err.message });
        if (err instanceof SyntaxError) return json(res, 400, { error: 'invalid_json', message: 'Ungültige Anfrage' });
        const e = err as { status?: number; message?: string };
        return json(res, e.status === 413 ? 413 : 400, { error: 'invalid', message: e.status === 413 ? 'Zu groß' : 'Ungültige Anfrage' });
      }
    }
    // Öffentlicher Stream-Status (wie Icecast): /status.json, /status/<sender>.<fmt>, /status/lautfm/<name>.<fmt>
    const st = /^\/status(?:\.json|\/(lautfm\/)?([a-z0-9_-]{1,60})\.(json|xml|m3u|xspf))$/.exec(path);
    if (st && req.method === 'GET') {
      const pub = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
      if (!st[2]) {
        res.writeHead(200, { ...pub, 'Content-Type': 'application/json; charset=utf-8' });
        return void res.end(JSON.stringify({ stations: app.svc.status.publicStations() }));
      }
      try {
        const data: StreamStatus = st[1] ? await app.svc.status.lautfmPublicStatus(st[2]) : await app.svc.status.streamStatus(st[2], String(req.headers.host ?? 'localhost'));
        const fmt = st[3];
        const [type, body] = fmt === 'xml' ? ['application/xml; charset=utf-8', toIcecastXml(data)]
          : fmt === 'm3u' ? ['audio/x-mpegurl; charset=utf-8', toM3u(data)]
          : fmt === 'xspf' ? ['application/xspf+xml; charset=utf-8', toXspf(data)]
          : ['application/json; charset=utf-8', JSON.stringify(data)];
        res.writeHead(200, { ...pub, 'Content-Type': type, ...(fmt === 'm3u' || fmt === 'xspf' ? { 'Content-Disposition': `inline; filename="${st[2]}.${fmt}"` } : {}) });
        return void res.end(body);
      } catch (err) {
        res.writeHead(err instanceof AppError ? err.status : 502, { ...pub, 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ status: 'error', message: (err as Error).message }));
      }
    }
    // Offizielle Android-App: mitgelieferte APK (Windows-Paket) oder aus dem Release – öffentlich, damit das Handy sie direkt laden kann
    if (path === '/download/AirDeck-Android.apk' && req.method === 'GET') {
      const local = app.svc.system.localApk();
      if (local) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="AirDeck-Android.apk"', 'Content-Length': statSync(local).size });
        return void createReadStream(local).pipe(res);
      }
      try {
        const info = (await app.svc.system.checkUpdate()) as { assets: { apk?: import('./update.ts').UpdateAsset }; error?: string };
        if (!info.assets.apk) return json(res, 404, { error: 'no_apk', message: info.error ?? 'Keine APK verfügbar' });
        const r = await app.updater.open(info.assets.apk, app.secrets.get('update:token'));
        res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="AirDeck-Android.apk"', ...(info.assets.apk.size ? { 'Content-Length': info.assets.apk.size } : {}) });
        return void Readable.fromWeb(r.body as never).pipe(res);
      } catch (err) {
        return json(res, 502, { error: 'apk_unavailable', message: (err as Error).message });
      }
    }
    // Senderlogo ist Branding und öffentlich (Studio, Widgets, Android-App)
    const logo = /^\/api\/v1\/stations\/([a-z0-9-]{1,40})\/logo$/.exec(path);
    if (logo && req.method === 'GET') {
      const l = app.svc.stations.stationLogo(logo[1]!);
      if (!l) return json(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': l.type, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      return void createReadStream(l.path).pipe(res);
    }

    if (path.startsWith('/listen/')) {
      const p = auth(app, req, url);
      if (!p || !AirDeckApp.hasScope(p, 'stream:read')) return json(res, 401, { error: 'unauthorized' });
      const [, , station, ...rest] = path.split('/');
      if (!station || !canSee(p, station)) return json(res, 403, { error: 'forbidden' });
      try {
        if (!app.addListener(station, '/' + rest.join('/'), res)) json(res, 404, { error: 'off_air', message: 'Keine aktive Quelle' });
      } catch (err) {
        sendError(res, err);
      }
      return;
    }

    // AirDeckCast: HLS-Playlist + -Segmente, direkt vom AirDeck-Server ausgeliefert (kein externer Icecast nötig)
    if (path.startsWith('/hls/')) {
      const p = auth(app, req, url);
      if (!p || !AirDeckApp.hasScope(p, 'stream:read')) return json(res, 401, { error: 'unauthorized' });
      const [, , station, file] = path.split('/');
      if (!station || !canSee(p, station)) return json(res, 403, { error: 'forbidden' });
      if (!file || !/^[a-zA-Z0-9_.-]+$/.test(file)) return json(res, 404, { error: 'not_found' });
      const base = resolve(join(app.hlsDir, station));
      const full = resolve(base, file);
      if (!isInside(base, full)) return json(res, 403, { error: 'forbidden' });
      if (!existsSync(full) || !statSync(full).isFile()) return json(res, 404, { error: 'not_found' });
      const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return void createReadStream(full).pipe(res);
    }

    if (!path.startsWith('/api/')) return serveStatic(req, res, studioDir, path);

    // laut.fm-Weiterleitung (Radioadmin mit gespeichertem Token bzw. öffentliche API)
    const ra = /^\/api\/v1\/stations\/([^/]+)\/lautfm\/ra(\/.*)$/.exec(path);
    const pub = /^\/api\/v1\/lautfm\/public(\/.*)$/.exec(path);
    if (ra || pub) {
      const p = auth(app, req, url);
      if (!p) return json(res, 401, { error: 'unauthorized' });
      if (!allow(p.tokenId)) return json(res, 429, { error: 'rate_limited' });
      if (pub) {
        if (req.method !== 'GET' || !allowedPublicPath(pub[1]!)) return json(res, 403, { error: 'forbidden_path' });
        return forward(req, res, PUBLIC_API + pub[1] + url.search, undefined, 15_000);
      }
      const station = decodeURIComponent(ra![1]!);
      const scope = req.method === 'GET' ? 'lautfm:read' : 'lautfm:write';
      if (!AirDeckApp.hasScope(p, scope)) return json(res, 403, { error: 'insufficient_scope', scope });
      if (!canSee(p, station)) return json(res, 403, { error: 'forbidden' });
      try {
        const cfg = app.svc.lautfm.lautfmConfig(station);
        if (!allowedRadioadminPath(ra![2]!, cfg.stationId)) return json(res, 403, { error: 'forbidden_path', message: 'Pfad nicht erlaubt oder laut.fm-Station nicht gewählt' });
        const token = app.svc.lautfm.lautfmToken(station);
        if (!token) return json(res, 409, { error: 'no_token', message: 'Kein laut.fm-Radioadmin-Token hinterlegt' });
        return forward(req, res, RADIOADMIN + ra![2] + url.search, token, 300_000, cfg.origin);
      } catch (err) {
        return sendError(res, err);
      }
    }

    const route = routes.find((r) => r.method === req.method && r.re.test(path));
    if (!route) {
      const exists = routes.some((r) => r.re.test(path));
      return json(res, exists ? 405 : 404, { error: exists ? 'method_not_allowed' : 'not_found' });
    }
    const p = auth(app, req, url);
    if (!p) return json(res, 401, { error: 'unauthorized', message: 'Gültiges API-Token erforderlich' });
    // Erst neues Passwort setzen (Erstanmeldung/Zurücksetzen) – vorher nur Passwort ändern, Abmelden, /me
    if (p.user?.mustChangePassword && !['/api/v1/auth/password', '/api/v1/auth/logout', '/api/v1/me'].includes(path)) {
      return json(res, 403, { error: 'password_change_required', message: 'Bitte zuerst ein eigenes Passwort festlegen' });
    }
    if (route.scope && !AirDeckApp.hasScope(p, route.scope)) return json(res, 403, { error: 'insufficient_scope', scope: route.scope });
    if (!route.re.source.includes('chunks') && !allow(p.tokenId)) return json(res, 429, { error: 'rate_limited' });
    // Datenbank ausgefallen: Sendebetrieb läuft aus dem Speicher weiter, Konfigurationsänderungen werden abgelehnt
    if (req.method !== 'GET' && req.method !== 'HEAD' && app.docs.status().state === 'error' && !ON_AIR_OPS.test(path)) {
      res.setHeader('Retry-After', '15');
      return json(res, 503, { error: 'database_unavailable', message: `Datenbank nicht erreichbar – Änderungen an der Konfiguration sind gerade nicht möglich. Der Sendebetrieb läuft weiter. (${app.docs.status().lastError ?? ''})` });
    }

    const m = route.re.exec(path)!;
    const params: Params = {};
    route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    const body = async () => {
      const raw = await readRaw(req, MAX_JSON);
      if (raw.length === 0) return {};
      try {
        const v = JSON.parse(raw.toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        return v as Record<string, unknown>;
      } catch {
        throw new AppError(400, 'invalid_json', 'Body muss ein JSON-Objekt sein');
      }
    };
    try {
      const out = await route.handler({ req, res, url, params, p, body });
      if (out === STREAMED) return;
      if (out === undefined) {
        res.writeHead(204);
        res.end();
      } else json(res, 200, out);
    } catch (err) {
      sendError(res, err);
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });
}

// ---------- Relay-Ingest (Icecast-kompatibel: PUT oder SOURCE) ----------

function handleIngest(app: AirDeckApp, req: IncomingMessage, res: ServerResponse, path: string): void {
  if (req.method !== 'PUT' && req.method !== 'SOURCE') return json(res, 405, { error: 'method_not_allowed' });
  const [, , station, ...rest] = path.split('/');
  const mount = '/' + rest.join('/');
  const basic = /^Basic (.+)$/i.exec(String(req.headers.authorization ?? ''));
  const [user, ...passParts] = basic ? Buffer.from(basic[1]!, 'base64').toString('utf8').split(':') : [];
  let src;
  try {
    src = station && user !== undefined ? app.authenticateIngest(station, mount, user, passParts.join(':')) : null;
  } catch (err) {
    return sendError(res, err);
  }
  if (!src) {
    app.audit.write({ kind: 'ingest', event: 'auth_failed', station, mount });
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="AirDeck"' });
    return void res.end();
  }
  const contentType = String(req.headers['content-type'] ?? 'audio/mpeg').split(';')[0]!.trim();
  try {
    app.ingestOpen(src, contentType);
  } catch (err) {
    return sendError(res, err);
  }
  app.audit.write({ kind: 'ingest', event: 'connected', sourceId: src.id, contentType });
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.flushHeaders();
  req.on('data', (chunk: Buffer) => app.ingestData(src, chunk));
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    app.ingestClose(src);
    if (!res.writableEnded) res.end();
  };
  req.on('end', done);
  req.on('close', done);
  req.on('error', done);
}

// ---------- Hilfsfunktionen ----------

const STREAMED = Symbol('streamed');

function auth(app: AirDeckApp, req: IncomingMessage, url: URL): Principal | null {
  const h = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''));
  // Query-Token nur für GET (EventSource, <audio>), damit Tokens nicht in schreibenden Requests landen.
  const token = h?.[1] ?? (req.method === 'GET' ? url.searchParams.get('token') ?? undefined : undefined);
  return app.svc.auth.authenticate(token);
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) return json(res, err.status, { error: err.code, message: err.message });
  console.error('[http]', err);
  json(res, 500, { error: 'internal', message: 'Interner Fehler' });
}

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > limit) {
        fail(new AppError(413, 'too_large', 'Anfrage zu groß'));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, type: string): void {
  if (!existsSync(file)) return json(res, 404, { error: 'not_found' });
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
  createReadStream(file).pipe(res);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, path: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
  const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
  const base = resolve(root);
  const file = resolve(base, normalize(rel));
  if (!isInside(base, file)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'not_found' });
  // Öffentliche Seiten: Statusseite und Player-Widget dürfen fremde Streams abspielen, das Widget auch eingebettet werden
  const publicPage = rel === 'status.html' || rel === 'widget.html' || rel === 'hoerer.html';
  // Widget und Hörerseite dürfen auf der Senderseite eingebettet werden
  const embeddable = rel === 'widget.html' || rel === 'hoerer.html';
  if (embeddable) res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    publicPage
      ? `default-src 'self'; media-src 'self' http: https: blob:; img-src 'self' data: http: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors ${embeddable ? '*' : "'self'"}`
      : "default-src 'self'; media-src 'self' blob:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  );
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

/**
 * Liegt `file` innerhalb von `base`? Plattformunabhängig (Windows nutzt "\\" als Trenner).
 * @param p Pfadmodul (für Tests: path.win32 / path.posix)
 */
export function isInside(base: string, file: string, p: typeof path = path): boolean {
  const rel = p.relative(base, file);
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
