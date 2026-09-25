# Netzwerk und Serververbindung

## Ports

| Port | Zweck | Standard |
|---|---|---|
| 8750/TCP | API, Studio, Live-Ereignisse, Icecast-kompatibler Ingest, Status/Widget | nur `127.0.0.1` (Local), LAN oder alle (Server) |
| 8751/UDP | LAN-Erkennung (nur Antwort auf Anfrage, keine Dauer-Sendung) | nur wenn LAN-Zugriff aktiv |
| 443 | HTTPS über Caddy (Self-Hosted mit Domain) | optional |

## Health und Version

`GET /api/v1/health` ist öffentlich und liefert nur Unkritisches:

```json
{ "status": "ok", "name": "AirDeck", "version": "1.0.0", "api": "1.0",
  "server": "ok", "database": "ok", "storage": "ok", "audio": "ok", "encoder": "ok", "stream": "connected", "ai": "ready" }
```

Details liefern angemeldet `GET /api/v1/system`, `/database`, `/audio`, `/encoder`, `/stream` und `/ai`.

**Kompatibilität:** Client und Server vergleichen die API-Hauptversion. Weicht sie ab, meldet der Client „AirDeck Server benötigt ein Update“ bzw. „Diese App benötigt ein Update“ statt eines technischen Fehlers.

## Server hinzufügen (Client)

```
[Dieser Computer]  ──► http://127.0.0.1:8750/api/v1/health  (automatisch beim Start)
[Im Netzwerk suchen] ─► UDP-Broadcast 8751 „AIRDECK?“ → Antworten mit Name, Adresse, Version
[QR-Code / Kopplungscode] ─► vom Server erzeugt, 5 Minuten gültig
[Manuell] ─► Host, Port, HTTPS
```

Der Verbindungstest läuft in Schritten, und jeder Schritt meldet ein eigenes Ergebnis:

1. Adresse auflösbar
2. Port erreichbar
3. TLS gültig (bei HTTPS)
4. `/api/v1/health` antwortet als AirDeck
5. Version kompatibel
6. Anmeldung (Benutzer/Passwort oder Kopplungscode) → Geräte-Token
7. Rechte/Sender abgerufen → **Verbunden**

„Verbunden“ erscheint erst nach Schritt 7. Serverprofile (Name, Adresse, Gerät-Token, zuletzt verbunden) werden gespeichert, das Token im sicheren Speicher der Plattform.

Hinweise, die der Client gezielt gibt, statt „Server nicht erreichbar“:
- Auf dem Handy `localhost`/`127.0.0.1` eingegeben: „Das ist das Handy selbst. Gib die Adresse des PCs ein oder nutze ‚Im Netzwerk suchen‘.“
- Port erreichbar, aber AirDeck nur lokal freigegeben: Der Server beantwortet die Erkennung und meldet „LAN-Zugriff ist aus – am PC unter Administration → Netzwerk einschalten“.
- Anmeldung abgelehnt, Server hat keine Benutzer: Diesen Fall gibt es nach dem Umbau nicht mehr, weil jede Installation im Setup ein Admin-Konto bekommt (behebt AUDIT 5.1).

## Lokaler Client ↔ lokaler Server

Das Desktop-Studio verbindet sich über `127.0.0.1` und nicht über die LAN-Adresse. Die Anmeldung erfolgt automatisch mit einem Maschinen-Token, das nur von `127.0.0.1` angenommen wird und im Datenverzeichnis des Dienstes liegt. IPC über Named Pipes/Unix-Sockets bringt gegenüber Loopback-HTTP keinen Vorteil und wird nicht eingeführt.

## HTTPS

- **Self-Hosted:** Caddy als Reverse Proxy mit automatischem Zertifikat. Die Vorlage erzeugt der Setup-Assistent aus Domain und E-Mail.
- **LAN:** HTTP ist zulässig, wenn ausdrücklich „nur lokales Netz“ gewählt ist.
- AirDeck selbst terminiert kein TLS. Das bleibt die Aufgabe des Proxys, der dafür gebaut ist.

## Stand der Umsetzung

| Baustein | Stand |
|---|---|
| Health mit Version und API-Version | umgesetzt (`/api/v1/health`) |
| LAN-Erkennung UDP 8751 (`AIRDECK?1` → Name, Version, API, Port, LAN an/aus) | umgesetzt (`src/server/discovery.ts`). Abschaltbar mit `AIRDECK_DISCOVERY=off`. Suche vom Desktop-Studio über `GET /api/v1/discover`. In der App kommt die Suche mit dem nativen Modul (Schritt 8), weil eine WebView kein UDP senden kann |
| Kopplungscode (6 Ziffern, 5 min, einmalig, Rolle und Sender wählbar, Sperre nach 8 Fehlversuchen je Adresse für 10 min) | umgesetzt: `POST /api/v1/pairing`, öffentlich `POST /api/v1/pair` |
| Geräte-Token, einzeln widerrufbar, „zuletzt gesehen“ | umgesetzt: `GET /api/v1/devices`, `DELETE /api/v1/devices/<id>` |
| Verbindungstest in Stufen mit Hinweisen, Versionsprüfung, Serverprofile | umgesetzt (`studio/js/connect.js`, Dialog „Mit AirDeck verbinden“, „Server wechseln“) |
| QR-Code | folgt mit dem nativen Kamera-Scanner der App (Schritt 8) |
| Token im Android Keystore | folgt mit Schritt 8, bis dahin Speicher der WebView |

