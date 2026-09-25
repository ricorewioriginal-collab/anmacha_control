# Datenbank

## Grundsatz

Der Core und die Dienste sprechen **nur** mit Repositories. Die Repositories nutzen einen `DatabaseProvider`. Kein Modul außerhalb der Datenbankschicht schreibt SQL. Clients greifen **nie** direkt auf die Datenbank zu, sondern immer über API → Server → Datenbank.

```
Dienste (stations, media, playout, planning, auth …)
        │  StationRepo · MediaRepo · QueueRepo · PlanRepo · UserRepo · SessionRepo · SettingsRepo · AuditRepo
        ▼
DatabaseProvider  (query, exec, transaction, migrate, health)
   ├── SqliteProvider      node:sqlite (in Node 22 eingebaut, kein natives Zusatzmodul)
   ├── PostgresProvider    pg (reines JavaScript)
   └── MysqlProvider       mysql2 (MariaDB und MySQL)
```

## Schnittstelle

```ts
interface DatabaseProvider {
  readonly dialect: 'sqlite' | 'postgres' | 'mysql';
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  transaction<T>(fn: (tx: DatabaseProvider) => Promise<T>): Promise<T>;
  migrate(): Promise<{ from: number; to: number }>;
  health(): Promise<{ ok: boolean; engine: string; version: string; latencyMs: number; error?: string }>;
  close(): Promise<void>;
}
```

Die Dialektunterschiede sind klein und liegen in einer Hilfsschicht:
- **Platzhalter:** `?` bzw. `$n`.
- **Upsert:** `ON CONFLICT` bzw. `ON DUPLICATE KEY`.
- **Zeitstempel:** als ISO-Text bzw. Millisekunden (`BIGINT`).
- **JSON-Spalten:** als `TEXT` gespeichert und in der Anwendung geprüft. Damit gibt es keine Abhängigkeit von JSON-Funktionen einzelner Datenbanken.

## Standard je Betriebsart

| Betriebsart | Standard | Alternativen |
|---|---|---|
| Local / Desktop | **SQLite** (Datei im Datenverzeichnis) | – |
| Self-Hosted | **PostgreSQL** | SQLite (kleine Installationen), MariaDB, MySQL |
| Hybrid | lokal SQLite, zentral PostgreSQL | |

**Firebird** wird nicht unterstützt, Begründung in [AUDIT.md](AUDIT.md) §9.

## Schema (erste Fassung)

| Tabelle | Inhalt |
|---|---|
| `meta` | Schema-Version, Installations-ID |
| `stations` | Sender, Branding, Betriebsdaten (`broadcast_on`), öffentlicher Status |
| `sources`, `outputs` | Quellen und Ausgänge. Passwörter nur als Verweis auf den Secret-Store |
| `media` | Metadaten, relativer Dateipfad, Lautheit, Cue-Punkte, Herkunft (`source`) |
| `playlists`, `playlist_items` | |
| `queue_items` | Queue je Sender mit Position und Herkunft |
| `clock_templates`, `clock_events`, `program_plans`, `jobs`, `recording_plans`, `recordings` | Planung und Mitschnitte |
| `play_log` | Sendeverlauf (für Rotation, Statistik, Status) |
| `users`, `sessions`, `api_tokens`, `devices` | Anmeldung. Nur Hashes |
| `settings` | Schlüssel/Wert je Bereich (KI, Nextcloud, Bridge, Integrationen, laut.fm-Zuordnung) |
| `bridge_keys` | externe Schlüssel → Sender (Bridge-API) |
| `ai_usage` | KI-Verbrauch |
| `audit_log` | Revisionsprotokoll (zusätzlich rotierende Datei) |
| `sync_changes` | Änderungsprotokoll für den Hybrid-Sync |

## Migrationen

- Dateien `migrations/NNN_name.<dialekt>.sql`, zum Beispiel `001_initial`, `002_media_loudness` usw.
- `meta.schema_version` hält den Stand. Ausgeführt wird beim Serverstart oder mit `airdeck migrate`.
- **Vor jeder Migration** entsteht automatisch eine Sicherung (siehe [STORAGE](STORAGE.md)). Schlägt die Migration fehl, wird die Transaktion zurückgerollt. Wo das nicht geht (DDL bei MySQL), wird die Sicherung wiederhergestellt.
- **Übernahme der bisherigen JSON-Daten:** Migration `000_import_json` liest `airdeck.json`, `tokens.json`, `users.json` usw. einmalig ein und benennt die Dateien in `*.imported` um. Nichts wird gelöscht.

## Health

`GET /api/v1/database` liefert zum Beispiel: `{ engine: "PostgreSQL", version: "17.2", database: "airdeck", latencyMs: 3, schema: 7, ok: true }`. Das Studio zeigt die Werte unter Administration → Datenbank.

Fällt die Datenbank aus:
- Der Core sendet mit dem Stand im Speicher weiter.
- Schreibende Aktionen antworten mit `503 database_unavailable` und einer klaren Meldung.
- Die Verbindung wird mit Backoff neu aufgebaut, dazu kommt ein `DATABASE_STATUS_CHANGED`-Ereignis.

## Tests

- In der CI laufen dieselben Repository-Tests gegen **SQLite, PostgreSQL, MariaDB und MySQL** (Service-Container).
- Kein Provider gilt als unterstützt, bevor er diese Tests besteht.
