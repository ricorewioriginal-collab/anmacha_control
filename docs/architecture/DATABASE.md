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

- Die Migrationen stehen im Programm (`src/server/db/schema.ts`), nicht in losen SQL-Dateien. Tabellen werden einmal beschrieben, daraus entsteht die DDL je Dialekt. Das Windows-Einzelprogramm braucht so keine zusätzlichen Dateien, und es gibt keine drei Fassungen derselben Migration.
- `meta.schema_version` hält den Stand. Ausgeführt wird beim Serverstart. Kennt das Programm ein neueres Schema nicht, startet es nicht und meldet „Bitte AirDeck aktualisieren“.
- Jede Migration läuft in einer Transaktion (SQLite, PostgreSQL). Bei MySQL/MariaDB ist DDL nicht transaktional. Die automatische Sicherung vor jeder Migration kommt mit Backup/Restore (ARCHITECTURE §9, Schritt 9).
- **Übernahme der bisherigen JSON-Daten:** Beim Start werden `airdeck.json`, `tokens.json`, `users.json`, `sessions.json`, `ai.json`, `ai-usage.json`, `update.json`, `nextcloud.json` und `bridge-keys.json` eingelesen und in `*.imported` umbenannt. Nichts wird gelöscht. Defekte Dateien werden gesichert (`*.corrupt-<zeit>`) und übersprungen.
- `network.json` und `airdeck.conf` bleiben Dateien: Sie werden gebraucht, bevor die Datenbank offen ist.

## Umsetzung (Stand)

| Baustein | Datei |
|---|---|
| Schnittstelle, SQLite, PostgreSQL, MySQL/MariaDB | `src/server/db/types.ts`, `sqlite.ts`, `postgres.ts`, `mysql.ts` |
| Schema, Migrationen, SQL-Hilfen (Upsert, Löschen je Dialekt) | `src/server/db/schema.ts` |
| Öffnen nach `airdeck.conf` / Umgebung | `src/server/db/index.ts` |
| Dokumente ↔ Tabellen, Schreiben nur geänderter Zeilen, Wiederholung bei Ausfall, JSON-Übernahme | `src/server/repo/docs.ts`, `mappings.ts` |

Der laufende Zustand liegt weiter im Speicher (der Core sendet auch ohne Datenbank weiter). Gespeichert wird entprellt: Je Tabelle werden nur neue, geänderte und gelöschte Zeilen geschrieben (Vergleich über Prüfsummen). Die Aufteilung von `app.ts` in Dienste mit eigenen Repositories ist Schritt 3.

Tabellen der ersten Fassung: `meta`, `stations`, `sources`, `outputs`, `media`, `playlists`, `playlist_items`, `queue_items`, `clock_templates`, `clock_events`, `program_plans`, `jobs`, `recording_plans`, `recordings`, `play_log`, `settings`, `users`, `sessions`, `api_tokens`, `bridge_keys`, `ai_usage`. Die Tabellen `devices`, `audit_log` und `sync_changes` kommen mit den Funktionen, die sie brauchen (Kopplung, Revisionsprotokoll in der Datenbank, Hybrid-Sync), und nicht vorher leer.

## Einrichtung

```ini
# airdeck.conf
[database]
provider = postgres          # sqlite (Standard) · postgres · mysql (auch MariaDB)
url = postgres://airdeck@localhost:5432/airdeck
```

Das Passwort gehört in die Umgebungsvariable `AIRDECK_DB_PASSWORD`, nicht in die Datei. Alternativ gehen `AIRDECK_DB` und `AIRDECK_DB_URL`. Server-Datenbanken, die beim Start noch nicht bereit sind (Container), werden bis zu einer Minute lang erneut versucht.

## Health

`GET /api/v1/database` liefert zum Beispiel: `{ provider: "postgres", engine: "PostgreSQL", version: "17.2", latencyMs: 3, schema: 1, ok: true, pending: 0 }`. Das Studio zeigt den Zustand unter System → Zustand.

Fällt die Datenbank aus:
- Der Core sendet mit dem Stand im Speicher weiter.
- Schreibende Aktionen antworten mit `503 database_unavailable` und einer klaren Meldung.
- Das Schreiben wird mit wachsendem Abstand (2 s bis 60 s) wiederholt, bis die Datenbank wieder antwortet. Beim Wechsel zwischen Ausfall und Normalbetrieb kommt ein `DATABASE_STATUS_CHANGED`-Ereignis.
- *Noch offen:* schreibende API-Aufrufe antworten heute trotz Ausfall normal (die Änderung liegt im Speicher und wird nachgeholt). Die Antwort `503 database_unavailable` kommt mit Schritt 3.

## Tests

- In der CI laufen dieselben Tests gegen **SQLite, PostgreSQL 17, MariaDB 11 und MySQL 8.4** (Service-Container, `test/db.test.ts`). Lokal geprüft zusätzlich mit PostgreSQL 16 und MariaDB 10.11.
- Kein Provider gilt als unterstützt, bevor er diese Tests besteht.
