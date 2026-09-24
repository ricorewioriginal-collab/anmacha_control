// HTTP-Schicht: REST API v1, Server-Sent Events, Medien, Relay-Ingest, Studio-Dateien.
// Ohne Framework (node:http), um Ressourcen und Abhängigkeiten minimal zu halten.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createReadStream, createWriteStream, existsSync, statSync, rmSync } from 'node:fs';
import path, { extname, join, normalize, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AirDeckApp, AppError, canSee, newId, type Principal } from './app.ts';
import { MEDIA_CATEGORIES, parseFileName, type MediaCategory } from '../core/automation.ts';
import { OUTPUT_CAPABILITIES } from './icecast.ts';
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
  add('GET', '/api/v1/me', null, (c) => ({ id: c.p.id, roles: c.p.roles, scopes: c.p.scopes, stationIds: c.p.stationIds }));
  add('GET', '/api/v1/capabilities', null, () => ({ outputs: OUTPUT_CAPABILITIES, mediaTypes: Object.keys(AUDIO_EXT), categories: MEDIA_CATEGORIES }));
  add('GET', '/api/v1/audit', 'audit:read', (c) => app.audit.tail(Math.min(Number(c.url.searchParams.get('limit') ?? 100), 500)));
  add('GET', '/api/v1/tokens', 'tokens:write', () => app.listTokens());
  add('POST', '/api/v1/tokens', 'tokens:write', async (c) => {
    const b = await c.body();
    return app.createToken({ name: String(b.name ?? ''), scopes: arr(b.scopes), roles: arr(b.roles), stationIds: arr(b.stationIds) });
  });
  add('DELETE', '/api/v1/tokens/:id', 'tokens:write', (c) => app.revokeToken(c.params.id!));

  // --- Sender / Branding ---
  add('GET', '/api/v1/stations', 'branding:read', (c) => app.listStations(c.p));
  add('POST', '/api/v1/stations', 'stations:write', async (c) => {
    const b = await c.body();
    if (!c.p.stationIds.includes('*')) throw new AppError(403, 'forbidden', 'Nur globale Admins legen Sender an');
    return app.createStation({ id: String(b.id ?? ''), name: String(b.name ?? ''), slogan: str(b.slogan), primaryColor: str(b.primaryColor), accentColor: str(b.accentColor) }, b.withDefaultSources !== false);
  });
  add('GET', '/api/v1/stations/:sid', 'branding:read', (c) => app.station(sid(c)));
  add('PATCH', '/api/v1/stations/:sid', 'stations:write', async (c) => app.updateStation(sid(c), await c.body()));

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

  // --- Medien ---
  add('GET', '/api/v1/stations/:sid/media', 'media:read', (c) => app.library(sid(c)));
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
    return app.addMedia(s, { id, title: meta.title || name, artist: meta.artist, category, file, durationMs: null, addedAt: Date.now(), folder, originalName: name.replace(/^.*[\\/]/, '') });
  });
  add('PATCH', '/api/v1/stations/:sid/media/:id', 'media:write', async (c) => app.updateMedia(sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/media/:id', 'media:write', (c) => app.removeMedia(sid(c), c.params.id!));
  add('GET', '/api/v1/stations/:sid/media/:id/file', 'media:read', (c) => {
    const s = sid(c);
    const m = app.media(s, c.params.id!);
    if (m.url) {
      c.res.writeHead(302, { Location: m.url });
      c.res.end();
      return STREAMED;
    }
    sendFile(c.req, c.res, app.mediaPath(s, m), AUDIO_EXT[extname(m.file)] ?? 'application/octet-stream');
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
  add('POST', '/api/v1/stations/:sid/now-playing', 'automation:write', async (c) => {
    const b = await c.body();
    return app.setNowPlaying(sid(c), String(b.mediaId ?? ''), String(b.deck ?? 'A') as never);
  });
  add('GET', '/api/v1/stations/:sid/decks', 'automation:read', (c) => app.decks(sid(c)));
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
  add('GET', '/api/v1/system', null, () => app.system());
  add('POST', '/api/v1/stations/:sid/quick/:category', 'cardwall:trigger', async (c) => app.quickTrigger(sid(c), c.params.category!, str((await c.body()).mode)));
  add('GET', '/api/v1/stations/:sid/media/:id/cover', 'media:read', async (c) => {
    const file = await app.cover(sid(c), c.params.id!);
    if (!file) throw new AppError(404, 'no_cover', 'Kein Cover');
    c.res.setHeader('Cache-Control', 'private, max-age=86400');
    sendFile(c.req, c.res, file, 'image/jpeg');
    return STREAMED;
  });
  add('GET', '/api/v1/audio-devices', 'automation:read', () => app.inputDevices());
  add('POST', '/api/v1/stations/:sid/queue/shuffle', 'queue:write', (c) => app.shuffleQueue(sid(c)));
  add('POST', '/api/v1/stations/:sid/playout/skip', 'automation:write', (c) => app.skipPlayout(sid(c)));

  // --- Ordner, URL-Streams, M3U, Titelanzeige, Verlauf ---
  add('GET', '/api/v1/stations/:sid/folders', 'media:read', (c) => app.folders(sid(c)));
  add('POST', '/api/v1/stations/:sid/media/url', 'media:write', async (c) => app.addUrlMedia(sid(c), (await c.body()) as never));
  add('POST', '/api/v1/stations/:sid/queue/fill-from', 'queue:write', async (c) => ({ added: app.queueFillFrom(sid(c), (await c.body()) as never) }));
  add('GET', '/api/v1/stations/:sid/queue.m3u', 'queue:read', (c) => {
    const text = app.exportQueueM3U(sid(c));
    c.res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Content-Disposition': 'attachment; filename="airdeck-queue.m3u"' });
    c.res.end(text);
    return STREAMED;
  });
  add('POST', '/api/v1/stations/:sid/m3u/import', 'queue:write', async (c) => {
    const b = await c.body();
    return app.importM3U(sid(c), String(b.text ?? ''), { playlistName: typeof b.playlistName === 'string' && b.playlistName ? b.playlistName : undefined });
  });
  add('POST', '/api/v1/stations/:sid/metadata', 'automation:write', async (c) => {
    const b = await c.body();
    app.sendMetadata(sid(c), String(b.artist ?? ''), String(b.title ?? ''));
  });
  add('GET', '/api/v1/stations/:sid/history', 'now_playing:read', (c) => app.history(sid(c), Number(c.url.searchParams.get('limit') ?? 200)));

  // --- Playlists ---
  add('GET', '/api/v1/stations/:sid/playlists', 'queue:read', (c) => app.playlists(sid(c)));
  add('POST', '/api/v1/stations/:sid/playlists', 'queue:write', async (c) => {
    const b = await c.body();
    return b.fromQueue === true ? app.saveQueueAsPlaylist(sid(c), String(b.name ?? 'Playlist')) : app.savePlaylist(sid(c), null, b);
  });
  add('PATCH', '/api/v1/stations/:sid/playlists/:id', 'queue:write', async (c) => app.savePlaylist(sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/playlists/:id', 'queue:write', (c) => app.deletePlaylist(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/playlists/:id/play', 'automation:write', (c) => app.playPlaylist(sid(c), c.params.id!));

  // --- Planung: Zeitplan, Stunden-Uhr, Sendeplan ---
  add('GET', '/api/v1/stations/:sid/planning', 'schedule:read', (c) => app.planning(sid(c)));
  add('POST', '/api/v1/stations/:sid/jobs', 'automation:write', async (c) => app.saveJob(sid(c), await c.body()));
  add('DELETE', '/api/v1/stations/:sid/jobs/:id', 'automation:write', (c) => app.deleteJob(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/clock-events', 'automation:write', async (c) => app.saveClockEvent(sid(c), null, await c.body()));
  add('PATCH', '/api/v1/stations/:sid/clock-events/:id', 'automation:write', async (c) => app.saveClockEvent(sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/clock-events/:id', 'automation:write', (c) => app.deleteClockEvent(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/clock-events/:id/fire', 'automation:write', (c) => app.fireClockEvent(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/plans', 'automation:write', async (c) => app.savePlan(sid(c), null, await c.body()));
  add('PATCH', '/api/v1/stations/:sid/plans/:id', 'automation:write', async (c) => app.savePlan(sid(c), c.params.id!, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/plans/:id', 'automation:write', (c) => app.deletePlan(sid(c), c.params.id!));

  // --- Recorder / Replays ---
  add('GET', '/api/v1/stations/:sid/recordings', 'automation:read', (c) => app.recordings(sid(c)));
  add('POST', '/api/v1/stations/:sid/recorder/start', 'automation:write', async (c) => app.startRecording(sid(c), str((await c.body()).label)));
  add('POST', '/api/v1/stations/:sid/recorder/stop', 'automation:write', (c) => app.stopRecording(sid(c)));
  add('GET', '/api/v1/stations/:sid/recordings/:id/file', 'automation:read', (c) => {
    const { path, rec } = app.recordingFile(sid(c), c.params.id!);
    c.res.setHeader('Content-Disposition', `attachment; filename="${rec.label.replace(/[^\w .()-]/g, '_')}.${rec.file.split('.').pop()}"`);
    sendFile(c.req, c.res, path, rec.contentType || 'application/octet-stream');
    return STREAMED;
  });
  add('DELETE', '/api/v1/stations/:sid/recordings/:id', 'automation:write', (c) => app.deleteRecording(sid(c), c.params.id!));
  add('POST', '/api/v1/stations/:sid/rec-plans', 'automation:write', async (c) => app.saveRecPlan(sid(c), null, await c.body()));
  add('DELETE', '/api/v1/stations/:sid/rec-plans/:id', 'automation:write', (c) => app.deleteRecPlan(sid(c), c.params.id!));

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
  add('GET', '/api/v1/update', 'automation:read', (c) => app.checkUpdate(c.url.searchParams.get('force') === '1'));
  add('GET', '/api/v1/update/settings', null, (c) => (globalAdmin(c), app.updateSettingsView()));
  add('PUT', '/api/v1/update/settings', null, async (c) => (globalAdmin(c), app.setUpdateSettings(await c.body())));
  add('POST', '/api/v1/update/install', null, (c) => {
    globalAdmin(c);
    return app.installUpdate(() => {
      app.shutdown();
      process.exit(0);
    });
  });
  // APK für die Android-App über diesen AirDeck laden (funktioniert auch bei privatem Repository)
  add('GET', '/api/v1/update/apk', 'automation:read', async (c) => {
    const info = (await app.checkUpdate()) as { assets: { apk?: import('./update.ts').UpdateAsset }; error?: string };
    if (!info.assets.apk) throw new AppError(404, 'no_apk', info.error ?? 'Keine APK im Release');
    const r = await app.updater.open(info.assets.apk, app.secrets.get('update:token'));
    c.res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="AirDeck-Android.apk"', ...(info.assets.apk.size ? { 'Content-Length': info.assets.apk.size } : {}) });
    await pipeline(Readable.fromWeb(r.body as never), c.res);
    return STREAMED;
  });

  // --- Benachrichtigungen / Webhooks / Now-Playing-Export ---
  add('GET', '/api/v1/stations/:sid/integrations', 'stations:write', (c) => app.integrations(sid(c)));
  add('PUT', '/api/v1/stations/:sid/integrations', 'stations:write', async (c) => app.setIntegrations(c.p, sid(c), await c.body()));
  add('POST', '/api/v1/stations/:sid/integrations/test', 'stations:write', (c) => app.testIntegrations(sid(c)));

  // --- laut.fm ---
  add('GET', '/api/v1/stations/:sid/lautfm', 'lautfm:read', (c) => app.lautfmConfig(sid(c)));
  add('PUT', '/api/v1/stations/:sid/lautfm', 'lautfm:write', async (c) => app.setLautfmConfig(c.p, sid(c), await c.body()));
  add('POST', '/api/v1/stations/:sid/lautfm/live-output', 'outputs:write', async (c) => {
    const b = await c.body();
    const prio = b.priority === undefined || b.priority === null || b.priority === '' ? undefined : Number(b.priority);
    return app.lautfmCreateOutput(c.p, sid(c), prio);
  });

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
    if (req.method === 'OPTIONS') {
      res.writeHead(cors ? 204 : 403);
      return void res.end();
    }

    if (path.startsWith('/ingest/')) return handleIngest(app, req, res, path);
    if (path === '/api/v1/health') return json(res, 200, { ok: true, name: 'AirDeck', version: '0.4.0' });

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
        const cfg = app.lautfmConfig(station);
        if (!allowedRadioadminPath(ra![2]!, cfg.stationId)) return json(res, 403, { error: 'forbidden_path', message: 'Pfad nicht erlaubt oder laut.fm-Station nicht gewählt' });
        const token = app.lautfmToken(station);
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
    if (route.scope && !AirDeckApp.hasScope(p, route.scope)) return json(res, 403, { error: 'insufficient_scope', scope: route.scope });
    if (!route.re.source.includes('chunks') && !allow(p.tokenId)) return json(res, 429, { error: 'rate_limited' });

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
  return app.authenticate(token);
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
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; media-src 'self' blob:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
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
