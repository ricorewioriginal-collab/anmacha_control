# Mitmachen – eigene Features für AirDeck

AirDeck ist ein Hobbyprojekt. **Webentwicklerinnen und Webentwickler dürfen eigene Features einbauen** und als Pull Request einreichen oder für sich selbst nutzen. Es gilt der [Haftungsausschluss](HAFTUNGSAUSSCHLUSS.md).

## Schnellstart

```bash
git clone https://github.com/ricorewioriginal-collab/anmacha_control.git
cd anmacha_control
git checkout AirDeck-Radio-Automation-\&-Broadcast
npm ci
npm start           # Server + Studio auf http://127.0.0.1:8750 (Admin-Token steht in der Konsole)
npm run check       # Typprüfung (Server + Studio) und alle Tests
```

Voraussetzungen: Node.js ≥ 22.18, ffmpeg im PATH (für die Server-Automation). Docker geht auch, siehe [docs/DOCKER.md](docs/DOCKER.md).

## Aufbau

| Teil | Ort | Hinweise |
|---|---|---|
| Kern (Logik ohne I/O) | `src/core/` | Quellen-Priorität, Queue/Sendeuhr/Rotation, Sendeplan, PCM-Mixer, rein und gut testbar |
| Server-Kern | `src/server/` | `app.ts` (Sendekern: Sender-Laufzeit, Quellen, Relay, Ausgänge, Queue, Playout), `model.ts` (Typen), `http.ts` (REST + SSE), `playout.ts` (ffmpeg), Adapter wie `lautfm.ts`, `nextcloud.ts`, `ai/` |
| Dienste | `src/server/services/` | ein Modul je Fachgebiet (`stations`, `media`, `planning`, `recorder`, `auth`, `bridges`, `status`, `notifications`, `lautfm`, `nextcloud`, `ai`, `system`), erreichbar als `app.svc.<dienst>` – neue Funktionen gehören hierher, nicht in `app.ts` |
| Datenhaltung | `src/server/db/`, `src/server/repo/` | Datenbanken (SQLite, PostgreSQL, MySQL/MariaDB), Migrationen, Abbildung auf Tabellen – kein SQL außerhalb davon |
| Studio | `studio/` | Vanilla-JS-Module mit `// @ts-check`, ohne Build-Schritt; jede Ansicht ist ein Modul `mountXyz(root, ctx)` |
| Windows/Android | `scripts/build.mjs`, `packaging/windows/`, `apps/android/` | Node-SEA-Exe + Inno Setup, Capacitor |
| Tests | `test/*.test.ts` | `node:test`; externe Dienste werden mit lokalen Mock-Servern getestet |

Mehr dazu in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Wo man andocken kann

- **REST-API + Live-Ereignisse:** Alles, was das Studio kann, geht über `/api/v1/…` mit Token (Scopes pro Token). Live-Ereignisse kommen per SSE über `/api/v1/events`. Eigene Tools, Widgets oder Websites brauchen keinen Eingriff in den Kern.
- **Webhooks:** Signierte Ereignisse (Now Playing, OFF AIR, Stille, …), Header `X-AirDeck-Signature` = HMAC-SHA256.
- **Neue Studio-Ansicht:** Modul in `studio/js/` mit `mountXyz(root, ctx)` und `{ show, onEvent }`, einen Eintrag in der Seitenleiste (`studio/index.html`) und in `views` (`studio/js/app.js`). `studio/js/nextcloud.js` ist ein kompaktes Beispiel.
- **Neuer Dienst-Adapter:** eigene Datei in `src/server/`, Methoden in `AirDeckApp`, Routen in `http.ts`, Test mit Mock-Server (siehe `test/nextcloud.test.ts`).
- **KI-Anbieter:** `src/server/ai/providers.ts` (`chat`/`speak`/`listModels`).

## Regeln

1. **Nichts vortäuschen.** Keine Attrappen oder erfundenen Daten. Unfertiges wird als TODO dokumentiert.
2. **Kern bleibt maßgeblich.** Die Oberfläche steuert nur, der Zustand liegt im Server.
3. **Keine Geheimnisse im Repository.** Zugangsdaten landen im verschlüsselten Secret-Store (`app.secrets`), nie in JSON-Dateien, Logs oder Antworten.
4. **Sicherheit:** Eingaben prüfen, Pfade absichern (`isInside`, `cleanPath`), neue Routen mit passendem Scope oder `globalAdmin`.
5. **Ressourcen sparen:** keine unnötigen Abhängigkeiten, keine Dauer-Polls ohne Grund, Timer mit `unref()`.
6. **Tests:** Jede neue Funktion bekommt einen Test. `npm run check` muss grün sein.
7. **Sprache:** Oberfläche und Meldungen auf Deutsch. TypeScript nur mit „erasable syntax“ (keine Enums, keine Parameter-Properties), damit Node es direkt ausführen kann.
8. **Doku:** Nutzerseitige Änderungen gehören ins Handbuch (`studio/handbuch.html`) und bei Bedarf in `docs/`.

## Pull Requests

Kleine, abgeschlossene Änderungen mit kurzer Beschreibung: was, warum, wie getestet. Die CI baut Windows-Installer, portable Version und Android-APK und testet sie.
