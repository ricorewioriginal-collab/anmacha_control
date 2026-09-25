// Abbildung der Programmdokumente auf Tabellenzeilen (docs/architecture/DATABASE.md „Schema“).
// Jede Zeile trägt Schlüssel, Sortier-/Suchspalten und den vollständigen Datensatz in `data`.

import type { Row } from '../db/types.ts';

export type RowSet = Map<string, Row[]>;

export interface DocMapping {
  toRows(value: unknown): RowSet;
  /** undefined = Dokument existiert (noch) nicht */
  fromRows(rows: RowSet): unknown;
}

type Obj = Record<string, any>;
const byPos = (a: Row, b: Row) => Number(a.position) - Number(b.position);

/** Stabile, eindeutige Schlüssel – doppelte oder fehlende IDs dürfen keine Zeilen überschreiben */
function keyed<T>(list: T[] | undefined, key: (x: T, i: number) => unknown): { k: string; x: T; i: number }[] {
  const seen = new Set<string>();
  return (list ?? []).map((x, i) => {
    let k = String(key(x, i) ?? `#${i}`);
    if (seen.has(k)) k = `${k}#${i}`;
    seen.add(k);
    return { k, x, i };
  });
}

/** Felder eines Senders, die eigene Tabellen haben; alles Übrige liegt in `settings` (scope station:<id>) */
const LISTS: Record<string, string> = { clockEvents: 'clock_events', plans: 'program_plans', jobs: 'jobs', recPlans: 'recording_plans', recordings: 'recordings' };
const OWN = new Set(['library', 'queue', 'clock', 'playlists', 'playLog', ...Object.keys(LISTS)]);
const STATION_TABLES = ['media', 'queue_items', 'clock_templates', 'playlists', 'playlist_items', 'play_log', ...Object.values(LISTS)];

const airdeck: DocMapping = {
  toRows(value) {
    const st = value as Obj;
    const out: RowSet = new Map([['stations', []], ['sources', []], ['outputs', []], ['settings', []], ...STATION_TABLES.map((t) => [t, []] as [string, Row[]])]);
    const push = (t: string, r: Row) => out.get(t)!.push(r);
    (st.stations as Obj[]).forEach((s, i) => push('stations', { id: s.id, name: s.name ?? null, position: i, data: s }));
    for (const t of ['sources', 'outputs']) for (const { k, x, i } of keyed(st[t] as Obj[], (x) => x.id)) push(t, { station_id: x.stationId, id: k, position: i, data: x });
    for (const [sid, d] of Object.entries((st.data ?? {}) as Record<string, Obj>)) {
      for (const { k, x, i } of keyed(d.library as Obj[], (m) => m.id)) {
        push('media', { station_id: sid, id: k, position: i, title: x.title ?? null, artist: x.artist ?? null, category: x.category ?? null, file: x.file ?? null, duration_ms: x.durationMs ?? null, added_at: x.addedAt ?? null, data: x });
      }
      for (const { k, x, i } of keyed(d.queue as Obj[], (q) => q.uid)) push('queue_items', { station_id: sid, id: k, position: i, media_id: x.mediaId, origin: x.origin ?? null, added_at: x.addedAt ?? null, data: x });
      if (d.clock) push('clock_templates', { station_id: sid, id: 'default', position: 0, data: d.clock });
      for (const { k, x, i } of keyed(d.playlists as Obj[], (p) => p.id)) {
        const { items, ...rest } = x;
        push('playlists', { station_id: sid, id: k, position: i, data: rest });
        (items as string[] ?? []).forEach((mediaId, j) => push('playlist_items', { station_id: sid, playlist_id: k, position: j, media_id: mediaId }));
      }
      for (const { k, x, i } of keyed(d.playLog as Obj[], (e) => `${e.at}:${e.mediaId}`)) push('play_log', { station_id: sid, id: k, position: i, at: x.at, media_id: x.mediaId, data: x });
      for (const [field, table] of Object.entries(LISTS)) for (const { k, x, i } of keyed(d[field] as Obj[], (e) => e.id)) push(table, { station_id: sid, id: k, position: i, data: x });
      for (const [name, v] of Object.entries(d)) if (!OWN.has(name) && v !== undefined) push('settings', { scope: `station:${sid}`, name, data: v });
    }
    return out;
  },
  fromRows(rows) {
    const stations = [...(rows.get('stations') ?? [])].sort(byPos);
    if (!stations.length) return undefined;
    const of = (t: string, sid: string) => (rows.get(t) ?? []).filter((r) => r.station_id === sid).sort(byPos);
    const data: Record<string, Obj> = {};
    for (const s of stations) {
      const sid = String(s.id);
      const d: Obj = { library: of('media', sid).map((r) => r.data), queue: of('queue_items', sid).map((r) => r.data) };
      const clock = of('clock_templates', sid)[0];
      if (clock) d.clock = clock.data;
      for (const r of rows.get('settings') ?? []) if (r.scope === `station:${sid}`) d[String(r.name)] = r.data;
      const pl = of('playlists', sid);
      if (pl.length) {
        const items = of('playlist_items', sid);
        d.playlists = pl.map((r) => ({ ...(r.data as Obj), items: items.filter((it) => it.playlist_id === r.id).map((it) => it.media_id) }));
      }
      const log = of('play_log', sid);
      if (log.length) d.playLog = log.map((r) => r.data);
      for (const [field, table] of Object.entries(LISTS)) {
        const list = of(table, sid);
        if (list.length) d[field] = list.map((r) => r.data);
      }
      data[sid] = d;
    }
    return {
      version: 1,
      stations: stations.map((r) => r.data),
      sources: [...(rows.get('sources') ?? [])].sort(byPos).map((r) => r.data),
      outputs: [...(rows.get('outputs') ?? [])].sort(byPos).map((r) => r.data),
      data,
    };
  },
};

/** Liste von Objekten ↔ eine Tabelle (Reihenfolge bleibt über die Einfügefolge unwichtig) */
function list(table: string, cols: (x: Obj) => Row, order?: (a: Obj, b: Obj) => number): DocMapping {
  return {
    toRows: (v) => new Map([[table, (v as Obj[]).map((x) => ({ ...cols(x), data: x }))]]),
    fromRows: (rows) => {
      const r = rows.get(table) ?? [];
      if (!r.length) return undefined;
      const out = r.map((x) => x.data as Obj);
      return order ? out.sort(order) : out;
    },
  };
}

const MAPPINGS: Record<string, DocMapping> = {
  airdeck,
  tokens: list('api_tokens', (t) => ({ id: t.id, hash: t.hash }), (a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
  users: list('users', (u) => ({ id: u.id, username: u.username }), (a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))),
  sessions: list('sessions', (s) => ({ id: s.hash, user_id: s.userId, expires_at: s.expiresAt })),
  'bridge-keys': {
    toRows: (v) => new Map([['bridge_keys', Object.entries(v as Record<string, string>).map(([id, sid]) => ({ id, station_id: sid }))]]),
    fromRows: (rows) => {
      const r = rows.get('bridge_keys') ?? [];
      return r.length ? Object.fromEntries(r.map((x) => [x.id, x.station_id])) : undefined;
    },
  },
  'ai-usage': {
    toRows: (v) => new Map([['ai_usage', [{ id: 'state', data: v }]]]),
    fromRows: (rows) => rows.get('ai_usage')?.find((r) => r.id === 'state')?.data,
  },
};

/** Alles andere (Einstellungen: ai, nextcloud, update …) liegt als eine Zeile in `settings` (scope global). */
export function mappingFor(name: string): DocMapping {
  return MAPPINGS[name] ?? {
    toRows: (v) => new Map([['settings', [{ scope: 'global', name, data: v }]]]),
    fromRows: (rows) => rows.get('settings')?.find((r) => r.scope === 'global' && r.name === name)?.data,
  };
}
