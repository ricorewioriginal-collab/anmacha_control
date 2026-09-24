# Brücke zu bestehenden Systemen

AirDeck muss nichts ersetzen. Läuft schon ein Sender, zum Beispiel AzuraCast mit Icecast, SAM Broadcaster, mAirList, RadioDJ, eine eigene Automation oder ein reines Web-Relay, dann verbindet sich AirDeck damit. **Sender werden dabei nie doppelt angelegt.** Jede Anbindung und jeder externe Schlüssel ist fest einem AirDeck-Sender zugeordnet, und jede Synchronisierung lässt sich beliebig oft wiederholen.

## 1. Anbindungen im Studio (ohne Programmierung)

**Anbindungen → ＋ Anbindung**

| System | Adresse | Sender/Mount | Was passiert |
|---|---|---|---|
| AzuraCast | `https://radio.example` | Kurzname oder ID (`azuratest_radio`) | Titel, Hörer, Live-DJ und Verlauf aus `/api/nowplaying/<sender>`. Der API-Key ist nur für nicht öffentliche Sender nötig |
| Icecast | `http://server:8000` | Mount (`/live`) | Titel, Hörer und Bitrate aus `status-json.xsl` |
| Stream-Adresse | vollständige Stream-URL | – | Nur Relay, etwa für SAM, mAirList oder RadioDJ, die per Encoder auf einen Server senden |

- **Relay übernehmen:** Der vorhandene Stream wird als Quelle vom Typ `url_stream` mit eigener Priorität in die Source Priority Engine eingehängt.
  - Priorität 5 macht ihn zum Hauptprogramm vor der AirDeck-Automation (10).
  - Priorität 20 macht ihn zum Notfallprogramm dahinter.
  - Live-Quellen (1–3) übernehmen wie gewohnt. AirDeck verteilt dann an alle eigenen Ausgänge und Aufnahmen.
  - Bricht der fremde Stream ab, verbindet AirDeck selbst neu: 2 s Pause, bis 30 s ansteigend. Solange übernimmt die nächste Quelle nach Priorität.
- **Status spiegeln:** Die Daten erscheinen in der Statusseite, im Player-Widget, im Stream-Status-JSON/XML und in AirDeck. Abgefragt wird höchstens alle 15 Sekunden.
- Speichern ist idempotent. Priorität oder Adresse ändern verändert die bestehende Relay-Quelle und legt keine neue an.

REST-Entsprechung (Scope `sources:read`/`sources:write`):

```
GET    /api/v1/stations/{sid}/bridges
POST   /api/v1/stations/{sid}/bridges          { kind, name, url, station?, apiKey?, mirror, pull, pullUrl?, priority }
PATCH  /api/v1/stations/{sid}/bridges/{id}     (nur geänderte Felder)
DELETE /api/v1/stations/{sid}/bridges/{id}
```

## 2. Bridge-API für Entwickler

Für eigene Skripte, Plugins oder Synchronisierungsdienste gibt es ein Token mit dem Scope **`bridge:write`**. Zum Anlegen neuer Sender braucht es einen globalen Zugriff (`stationIds: ["*"]`). Das Token erzeugst du einmalig:

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" -H "Content-Type: application/json" \
  -d '{"name":"sync-azuracast","scopes":["bridge:write"],"roles":[],"stationIds":["*"]}' \
  https://airdeck.example/api/v1/tokens
```

### Sender über einen externen Schlüssel (idempotent)

```
PUT /api/v1/bridge/stations/{key}
{ "name": "Mein Radio", "slogan": "…", "genre": "Pop", "primaryColor": "#19c3e6", "withDefaultSources": true }
→ { "station": { "id": "…", … }, "created": true|false }
```

- `{key}` ist dein stabiler Schlüssel. Er darf aus Buchstaben, Ziffern und `: . _ -` bestehen, höchstens 120 Zeichen. Empfohlen ist `system:host:id`, zum Beispiel `azuracast:radio.example:azuratest_radio` oder `mairlist:studio1`.
- Der erste Aufruf legt den Sender an, jeder weitere aktualisiert **denselben** Sender. Die Zuordnung liegt in `data/bridge-keys.json`.
- `GET /api/v1/bridge/mappings` liefert alle Zuordnungen, soweit das Token sie sehen darf.

### Now Playing melden

Für Systeme, deren Programm AirDeck nicht selbst mischt, etwa wenn SAM, mAirList oder RadioDJ direkt auf einen Icecast senden:

```
POST /api/v1/bridge/stations/{key}/now-playing
{ "artist": "Kygo", "title": "Firestone", "album": "Cloud Nine", "durationMs": 213000,
  "startedAt": "2026-09-24T20:00:00Z", "listeners": 42, "listenUrls": ["https://stream.example/live"] }
```

Die Meldung wirkt so:
- Der Titel geht als Titelanzeige an die AirDeck-Ausgänge des Senders.
- Das Live-Ereignis `now_playing.external` wird ausgelöst.
- Titel, Verlauf (die letzten 10) und Stream-Adressen erscheinen auf der Statusseite, im Widget und in `/status/<sender>.json|xml`.

Kann die Software nur einfache Adressen aufrufen, geht es auch per **GET**. Die Werte stehen dann in der URL, das Token hängt als `token=` dran:

```
GET /api/v1/bridge/stations/{key}/now-playing?token=<bridge-token>&artist=Kygo&title=Firestone&duration=213
```

`duration` gibt Sekunden an, `durationMs` Millisekunden.

Titelwechsel meldest du so aus gängiger Software (jeweils mit der GET-Adresse und den Platzhaltern der Software für Interpret, Titel und Dauer):
- **mAirList:** Logging → „HTTP GET/POST“ bzw. Skript bei `OnPlayerStart`.
- **RadioDJ:** Plugin „Now Playing Info“ → Web-Export (HTTP POST).
- **SAM Broadcaster:** PAL-Skript mit `WebToStr`/HTTP-POST bei Titelwechsel.
- **AzuraCast:** Web-Hook „Generic Web Hook“ auf ein kleines Übersetzungsskript. Einfacher ist die Status-Spiegelung aus Abschnitt 1.

### Beispiel: AzuraCast-Sender einmalig übernehmen und laufend spiegeln

```bash
KEY="azuracast:radio.example:azuratest_radio"
curl -X PUT -H "Authorization: Bearer $BRIDGE" -H "Content-Type: application/json" \
  -d '{"name":"AzuraTest Radio","genre":"Pop"}' "https://airdeck.example/api/v1/bridge/stations/$KEY"
# → Sender-ID merken (z. B. azuracast-radio-example-azuratest-radio) und dort die Anbindung anlegen:
curl -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"kind":"azuracast","name":"AzuraCast","url":"https://radio.example","station":"azuratest_radio","mirror":true,"pull":true,"priority":20}' \
  https://airdeck.example/api/v1/stations/<sender-id>/bridges
```

Beide Aufrufe lassen sich beliebig wiederholen. Es entsteht weder ein zweiter Sender noch eine zweite Relay-Quelle.

## 3. Umgekehrt: AirDeck in bestehende Systeme einspeisen

- **Als Live-DJ in AzuraCast:** In AzuraCast einen Streamer/DJ anlegen. In AirDeck einen Icecast-Ausgang auf den DJ-Port der Station einrichten (meist 8005, Mount `/`, Benutzer und Passwort des DJ-Kontos). AzuraCast schaltet dann automatisch auf AirDeck.
- **Auf einen bestehenden Icecast:** Einen Ausgang mit eigenem Mount anlegen. Mit `?prio=` geht das auch bei laut.fm-artigen Servern.
- **Über Liquidsoap:** siehe [STREAMING.md](STREAMING.md).
