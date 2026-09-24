# AirDeck

Unabhängige Radio-Automation für **Windows, Android und Self-Hosted-Server**.
AirDeck läuft ohne AnMaCha. AnMaCha und laut.fm sind höchstens optionale Adapter.

**Stand 0.1:** Core, Server und Studio-Oberfläche laufen. Die Roadmap steht in [`docs/CLAUDE_PROGRESS.md`](docs/CLAUDE_PROGRESS.md).

## Schnellstart

Voraussetzung: **Node.js ≥ 22.18**. Es gibt keinen Build-Schritt und keine Laufzeit-Abhängigkeiten.

```bash
npm install          # nur Dev-Tools (TypeScript-Prüfung)
npm start            # startet http://127.0.0.1:8750
```

Beim ersten Start zeigt die Konsole ein **Admin-Token** und einen fertigen Studio-Link an.
Das Token wird nur gehasht gespeichert. Ein neues Token erzeugst du mit `npm run token`.

| Variable | Standard | Bedeutung |
|---|---|---|
| `AIRDECK_PORT` | `8750` | HTTP-Port |
| `AIRDECK_HOST` | `127.0.0.1` | Bind-Adresse. `0.0.0.0` für Server-/Netzbetrieb, dann TLS-Reverse-Proxy davorsetzen |
| `AIRDECK_DATA` | `./data` | Daten, Medien, Audit-Log, verschlüsselte Secrets |
| `AIRDECK_SECRET_KEY` | *(auto)* | 64 Hex-Zeichen. Ohne diese Variable wird `data/.secret.key` (0600) erzeugt |

## Was schon funktioniert

- **Source Priority Engine**: positive Ganzzahl, kleinere Zahl = höhere Priorität. Übernahmen sind autorisiert und atomar. Anti-Flapping, Cooldown, Fallback-Kette, Operator- und Emergency-Override, Audit-Log, Wiederherstellung nach Neustart ohne konkurrierende aktive Quellen.
- **Live-/Relay-Kern**: Encoder verbinden sich Icecast-kompatibel per `PUT` oder `SOURCE` auf `/ingest/<sender>/<mount>` (Benutzer = Quellen-ID, Passwort pro Quelle). Nur die aktive Quelle wird weitergeleitet. Standby-Quellen bleiben verbunden, damit der Fallback sofort greift.
- **Broadcast-Adapter Icecast** (HTTP PUT, Icecast 2.4+) mit optionalem `?prio=<n>` für laut.fm-artige Server. Titel-Metadaten laufen über `/admin/metadata`, Reconnect mit Backoff, Auth-Fehler werden nicht endlos wiederholt. SHOUTcast ist ehrlich als *unsupported* markiert.
- **Studio (Browser/PWA)**: 4 Decks, Cardwall, Archiv mit Upload, Queue mit Backtiming, Drag & Drop (Archiv → Deck/Cart/Queue, Dateien → Archiv, Queue sortieren), Automation mit Crossfade nach Sendeuhr und Rotationsregeln, Ducking, Master-Limiter, RMS-/Peak-Meter, Stilleerkennung (löst Fallback aus) und Studio-Stream als Automation-Quelle. Tasten F1–F4 steuern die Decks.
- **REST API v1 + Server-Sent Events** mit Scopes laut `API_SCOPE_MATRIX`, RBAC pro Sender und Rate-Limit pro Token.
- **Multi-Sender**: Branding (Name, Slogan, Farben), Medien, Queue, Cardwall und Quellen sind pro Sender getrennt.

## Encoder anbinden (z. B. BUTT, Mixxx, Liquidsoap)

1. Im Studio unter *Quellen* die gewünschte Quelle öffnen (⋯) und ein Encoder-Passwort setzen.
2. Den Encoder so einstellen:
   - Typ: Icecast
   - Host/Port: AirDeck-Server
   - Mount: `/ingest/<sender-id>/live`
   - Benutzer: die Quellen-ID (steht nach dem Speichern in der Statuszeile)
3. Die Quelle mit der kleineren Zahl übernimmt automatisch, nach 2 s stabiler Verbindung (Anti-Flapping).

## Entwicklung

```bash
npm run check        # Typprüfung (Server + Studio) und alle Tests
npm test             # node:test, inkl. End-to-End-Relay-Test gegen einen Icecast-Mock
```

Struktur:

```text
src/core/     reine Domain-Logik (Source Priority, Automation) – plattformunabhängig
src/server/   HTTP/REST/SSE, Relay, Icecast-Adapter, Persistenz, Secrets
studio/       Studio-Oberfläche (Vanilla JS + Web Audio, als PWA installierbar)
test/         Tests (node:test)
docs/         Architektur, Fortschritt, Übergabe-Unterlagen
```
