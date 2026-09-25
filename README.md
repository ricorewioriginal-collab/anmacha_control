# AirDeck – Radio-Automation & Live-Broadcast

<p>
  <img src="assets/icons/airdeck-gesamt.png" width="96" alt="AirDeck">
  <img src="assets/icons/airdeck-windows.png" width="96" alt="AirDeck Windows">
  <img src="assets/icons/airdeck-android.png" width="96" alt="AirDeck Android">
  <img src="assets/icons/airdeck-server.png" width="96" alt="AirDeck Server">
</p>

**Powered by AnMaCha Radioproduktion & RicoReWi – für Broadcast, Automation, Live und laut.fm.**

AirDeck ist eine eigenständige Sendesoftware für Webradio. Sie bietet Automation rund um die Uhr, Live-Sendungen mit Quellen-Priorität, Sendeplan, Recorder, laut.fm-Verwaltung, Klangoptimierung und auf Wunsch einen komplett KI-moderierten Sender. AirDeck läuft als **Windows-Programm**, als **Server/Docker** oder gesteuert per **Android-App**. Einen eigenen Server brauchst du nicht.

## ⬇️ Download

| | Datei | Hinweis |
|---|---|---|
| 🪟 **Windows-Installer** | [**AirDeck-Setup.exe**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest/download/AirDeck-Setup.exe) | Installation ohne Adminrechte. Deutsch/English, mit Audio-Engine (ffmpeg/LAME) und Android-APK |
| 🪟 **Windows portable** | [**AirDeck-Windows-Portable.zip**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest/download/AirDeck-Windows-Portable.zip) | Ohne Installation: entpacken, `AirDeck.exe` starten |
| 🤖 **Android-App** | [**AirDeck-Android.apk**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest/download/AirDeck-Android.apk) | Handy-Sender (ohne Server) oder Touch-Studio mit MIC LIVE und Mithören. Die APK gibt es auch direkt aus AirDeck unter `http://<PC>:8750/download/AirDeck-Android.apk` |
| 🐧 **Linux-Server** | [**AirDeck-Linux.deb**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest/download/AirDeck-Linux.deb) | `sudo apt install ./AirDeck-Linux.deb` (Debian/Ubuntu, x86_64) – läuft als systemd-Dienst `airdeck-server` |
| 🐳 **Server (Docker)** | `docker compose up -d` | siehe [docs/DOCKER.md](docs/DOCKER.md) |

Alle Dateien stehen auf der Seite [**Releases → neuestes Release**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest). Sie werden nach jeder Änderung automatisch gebaut und getestet. Solange das Repository privat ist, funktionieren die Links nur für angemeldete Mitglieder.
Windows kann bei nicht signierten Dateien warnen: „Weitere Informationen“ → „Trotzdem ausführen“ (Details in [docs/INSTALLATION.md](docs/INSTALLATION.md)).

## 🚀 Live-Demo ausprobieren

**[airdeck-demo.ricorewi-radio.de](https://airdeck-demo.ricorewi-radio.de)** – Studio direkt im Browser, ohne Installation.

⚠️ Reine Testinstanz: setzt sich **automatisch alle 10 Minuten komplett zurück** (alle Daten weg), läuft ohne Audio-Engine – keine echte 24/7-Sendung möglich. Bitte nichts Echtes hier ablegen.

## 📸 Vorschau

Alle Screenshots zeigen den Sender **„AirDeck-FM“** mit Beispiel-Titeln – reine Testdaten, kein echter Sender.

| Studio (Windows/Browser) | Handy-Sender (Android) | Hörerbereich (Browser) |
|---|---|---|
| [![Studio](docs/screenshots/studio-desktop.png)](docs/screenshots/studio-desktop.png) | [![Handy-Sender](docs/screenshots/handy-sender.png)](docs/screenshots/handy-sender.png) | [![Hörerbereich](docs/screenshots/hoerer-browser.png)](docs/screenshots/hoerer-browser.png) |
| Decks, Cardwall, Queue, Stream/Encoder und Schnelltrigger auf einen Blick | Live senden vom Handy – Mikrofon, Musik und Pegel, ganz ohne AirDeck-Server | Musikwunsch, Grüße und Voting direkt aus dem Browser der Hörer |

## Funktionen

**Studio & Sendebetrieb**
- Dashboard mit frei anordenbaren Fenstern (verschieben, Größe ändern, abdocken). Dazu vier Decks mit CUE/Vorhören, Cardwall, Schnelltrigger, Queue mit Backtiming, Bibliothek mit Ordnern und Drag & Drop (auch Dateien aus dem Explorer).
- **Server-Automation 24/7** ohne offenes Fenster: Crossfade, Carts mit Ducking, Mikrofon/Line-In, Stille-Erkennung, Notfall-Ordner, Autostart.
- **Source Priority Engine:** Live-Studio, Remote, Android, Automation und Relays mit Priorität, Übernahme, Fallback und Anti-Flapping.
- **Sendeplan & Events:** Programmpläne, Stundenuhr, Einzel-Jobs, Aufnahmepläne. Dazu ein **Recorder** mit Replays.
- **Klang:** Lautheitsangleich pro Titel (EBU R128), Klangprofile, 10-Band-EQ, Multiband, AGC und Limiter. **LAME-MP3** (CBR/VBR), AAC, Opus.
- **Ausgänge:** Icecast, SHOUTcast v1/v2, **laut.fm** (Zugang automatisch aus dem Radioadmin), optional über **Liquidsoap**.
- **Audio-Routing:** Sendesignal und Vorhören getrennt auf Windows-Ausgabegeräte legbar.

**laut.fm**
- Kompletter Radioadmin: Playlists, Titel, **Tags**, **Automations-Algorithmen** (16 Vorlagen), Sendeplan, Statistik, **Werbe-Trigger-Log**, Benutzer, Station, Live-Zugang.
- Anmeldung per Radioadmin-Token (callback/Origin wie von laut.fm vorgegeben). Dazu die öffentliche laut.fm-API vollständig nach Spezifikation.

**Status, Web & Anbindungen**
- **Stream-Status** für alle Sendewege, so wie Icecast ihn liefert: JSON, XML, M3U und XSPF. Für laut.fm-Sender baut AirDeck die Werte nach. Dazu kommen eine öffentliche Statusseite und ein einbettbares **Player-Widget**.
- **Brücke zu bestehenden Systemen:** AzuraCast, Icecast, SAM, mAirList, RadioDJ oder ein Web-Relay lassen sich als Relay-Quelle und Status-Spiegel einbinden. Die **Bridge-API** vergibt stabile Schlüssel, damit nichts doppelt angelegt wird ([docs/BRIDGE.md](docs/BRIDGE.md)).
- **Hörer-Interaktion:** Musikwunsch aus der Bibliothek, Grüße, Song-Voting mit Hörer-Charts und Sprachnachrichten ans Studio. Alles landet in einem Posteingang, die Hörerseite ist einbettbar und hat Schutz vor Missbrauch.
- **Nextcloud-Brücke:** Medien aus der Cloud übernehmen, Mitschnitte hochladen.
- REST-API mit Live-Ereignissen (SSE), signierte Webhooks, Telegram-Alarme, Now-Playing-Export.

**KI-Automation** ([docs/AI.md](docs/AI.md))
- Eigene API-Keys oder lokale Modelle. Text: OpenAI, Anthropic, Gemini, Ollama/LM Studio. Sprache: OpenAI TTS, ElevenLabs, Kokoro, Piper offline.
- Moderation alle n Titel, Nachrichten zur vollen Stunde aus eigenen Quellen und KI-Musikplanung. Freigabe-Modus, Kostenkontrolle mit Budgets und Protokoll.

**Betrieb & Sicherheit**
- **Benutzerverwaltung** mit Login und Logout sowie Rollen: Administrator, Sendeleitung, Redaktion, Moderation, Ansicht. Die Rollen lassen sich pro Sender zuweisen.
- Mehrere Sender mit eigenem Logo. Datenspeicher lokal oder mit Sync zu MySQL/MariaDB bzw. Firebase. Zugangsdaten liegen verschlüsselt (AES-256-GCM).
- **Windows-Programm** `AirDeck.exe` mit eigenem Fenster, Tray-Symbol und Audio-Engine im Hintergrund (Fenster zu, Sendung läuft weiter). **Updates** per Klick. Handbuch im Programm.
- **Android-App** mit eigenem **Handy-Sender**: Mikrofon und Musik vom Handy direkt zu laut.fm oder Icecast, ohne Server und auch bei ausgeschaltetem Bildschirm. Alternativ Fernbedienung für das Studio am PC.

## Schnellstart

**Windows:** Installer starten, fertig. Das Studio öffnet sich, AirDeck läuft danach im Hintergrund. Das Symbol im Infobereich bietet Studio öffnen, Protokoll und Beenden.

**Android:** Im Studio am PC unter **Android-App** „Im Netzwerk erreichbar“ einschalten. Dann die APK auf dem Handy laden und mit Adresse und Kopplungscode verbinden ([Anleitung](docs/INSTALLATION.md#android)).

**Server:**
```bash
docker compose up -d
docker compose logs airdeck      # Einmal-Passwort für „admin“ und Admin-Token
```
Ohne Docker geht es mit Node.js ≥ 22.18 und ffmpeg: `npm install && npm start`. Danach läuft das Studio unter `http://127.0.0.1:8750`.

| Variable | Standard | Bedeutung |
|---|---|---|
| `AIRDECK_PORT` | `8750` | HTTP-Port |
| `AIRDECK_HOST` | `127.0.0.1` | Bind-Adresse. `0.0.0.0` für Netz/Server, im Internet nur hinter HTTPS |
| `AIRDECK_DATA` | `./data` | Daten, Medien, Protokolle, verschlüsselte Zugangsdaten |
| `AIRDECK_SECRET_KEY` | *(auto)* | 64 Hex-Zeichen. Sonst wird `data/.secret.key` erzeugt |
| `AIRDECK_FFMPEG` | *(auto)* | Pfad zu ffmpeg |

## Dokumentation

| Thema | Datei |
|---|---|
| Handbuch (auch im Programm) | [studio/handbuch.html](studio/handbuch.html) |
| Installation Windows/Android | [docs/INSTALLATION.md](docs/INSTALLATION.md) |
| Docker/Server | [docs/DOCKER.md](docs/DOCKER.md) |
| Streaming, Klang, Liquidsoap | [docs/STREAMING.md](docs/STREAMING.md) |
| Brücke & Bridge-API | [docs/BRIDGE.md](docs/BRIDGE.md) |
| KI-Automation | [docs/AI.md](docs/AI.md) |
| Architektur | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Funktionsabgleich | [docs/FEATURE_PARITY.md](docs/FEATURE_PARITY.md) |
| Fortschritt | [AIRDECK_PROGRESS.md](AIRDECK_PROGRESS.md) |

## Mitmachen

Webentwicklerinnen und Webentwickler dürfen eigene Features einbauen. Aufbau, Regeln und Andockpunkte stehen in [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm run check        # Typprüfung (Server + Studio) und alle Tests
```

## Haftungsausschluss

AirDeck ist ein **privates Hobbyprojekt** und wird ohne Gewähr bereitgestellt. Die Nutzung erfolgt auf eigene Verantwortung, siehe [HAFTUNGSAUSSCHLUSS.md](HAFTUNGSAUSSCHLUSS.md).
