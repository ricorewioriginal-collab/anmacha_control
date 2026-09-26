# AirDeck – Radio-Automation & Live-Broadcast

<p>
  <img src="https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/assets/icons/airdeck-gesamt.png" width="96" alt="AirDeck">
  <img src="https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/assets/icons/airdeck-windows.png" width="96" alt="AirDeck Windows">
  <img src="https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/assets/icons/airdeck-android.png" width="96" alt="AirDeck Android">
  <img src="https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/assets/icons/airdeck-server.png" width="96" alt="AirDeck Server">
</p>

[![Build](https://github.com/ricorewioriginal-collab/anmacha_control/actions/workflows/build.yml/badge.svg)](https://github.com/ricorewioriginal-collab/anmacha_control/actions/workflows/build.yml)
![Tests](https://img.shields.io/badge/tests-182%20%C2%B7%20176%20gr%C3%BCn%20%C2%B7%206%20%C3%BCbersprungen-brightgreen)
![Version](https://img.shields.io/badge/version-0.4.0-blue)
![Plattformen](https://img.shields.io/badge/Windows%20%7C%20Android%20%7C%20Linux%20%7C%20Docker-eigenst%C3%A4ndig-2f8cff)
![arm64](https://img.shields.io/badge/Docker-amd64%20%7C%20arm64%20(Raspberry%20Pi)-2496ed)

**Ein Projekt von RicoReWi / RicoReWi Music & Media – für Broadcast, Automation, Live und laut.fm.**

AirDeck ist eine eigenständige Sendesoftware für Webradio: Automation rund um die Uhr, Live-Sendungen mit Quellen-Priorität und Failover, Sendeplan, Playlist- und Medienverwaltung, Recorder, laut.fm-Verwaltung, Klangoptimierung, Hörer-Interaktion und auf Wunsch ein komplett KI-moderierter Sender. AirDeck läuft als **Windows-Programm**, als **Server/Docker** (auch auf Raspberry Pi/arm64) oder gesteuert per **Android-App** – ohne fremden Cloud-Dienst, ohne Zwang zu einem eigenen Server.

<p align="center">
  <a href="https://airdeck-demo.ricorewi-radio.de"><strong>🚀 Jetzt live ausprobieren → airdeck-demo.ricorewi-radio.de</strong></a><br>
  Login: <code>demo</code> / <code>airdeck-demo</code> · direkt im Browser, keine Installation
</p>

## 🚦 Status: was läuft, was noch nicht

Diese Tabelle wird laufend nach echten Tests aktualisiert (kein Feature gilt als „fertig“, ohne real getestet zu sein). Ausführlicher Verlauf: [AIRDECK_PROGRESS.md](AIRDECK_PROGRESS.md).

| Bereich | Status | Kurz |
|---|---|---|
| **Kernbetrieb** (Server-Automation 24/7, Source-Priority, Crossfade, Ausgänge, REST-API) | ✅ läuft | Grundfunktionen, mit echtem ffmpeg/Icecast getestet |
| **Oberfläche & Workflow** (Dashboard, Medienverwaltung, Nextcloud-Anbindung, Playlistverwaltung, Live Studio, In-App-Handbuch) | ✅ läuft | Eigene Arbeitsbereiche statt Einzelfunktionen, mit Playwright gegen echte Server getestet |
| **Crossfade-Audioqualität** | ✅ läuft | Musik↔Musik/Jingle, Voice-Track→Musik, externer Stream↔Musik und Live-Quelle↔Automation je per echtem Audio-Dekodier-Test bestätigt |
| **Failover-Ketten** (Quellen-Priorität) | ✅ läuft | Mehrstufige Fallback-Ketten (`fallbackSourceId`) werden vollständig durchlaufen statt nur einen Schritt, inklusive Ringschutz gegen Fehlkonfiguration |
| **Playlist-Shuffle** | ✅ läuft | Eigener Shuffle-Modus je Playlist (Interpreten-Trennung, „Jetzt neu mischen“) |
| **Medien-Integrität** | ✅ läuft | Fehlende Dateien, Duplikate, Relink für die gesamte Bibliothek |
| **Backup/Restore** | ✅ läuft | Echter Ende-zu-Ende-Test: Sichern → Daten löschen → Wiederherstellen → Zustand vergleichen |
| **Intelligente Rotation, Clock-Templates, Preflight, Hard/Soft-Timing** | ✅ läuft | Interpreten-/Genre-Trennung, Sendeuhr-Vorlagen, Preflight-Prüfung, feste Zeitmarken im Sendeplan |
| **AirDeckCast** (eigene Streaming-/Verteilschicht, HLS, alternative Profile, Teststream, Failover) | ✅ läuft | Ein Programmbus speist mehrere Encoder-Ausgänge gleichzeitig, inkl. HLS direkt vom Server |
| **Geräte-Pairing, LAN-Discovery, Connect-Schicht** | ✅ läuft | Kopplungscode, echter scanbarer QR-Code, **Kamera-Scan direkt in App/Browser** (kein natives Plugin), Geräteliste mit Widerruf, LAN-Discovery |
| **Docker-Paketierung** | ✅ läuft | Läuft nachweislich auch auf **arm64/Raspberry Pi** (echter QEMU-Build+Start in CI, nicht nur amd64) |
| **Erweiterungen/Marktplatz, Team-Chat, Bug-Report-Backend, Statistik, Audit** | ⬜ offen | Noch nicht begonnen |
| **Long-Run-/Release-Härtung** (Watchdog, Crash Recovery, 24h/48h-Test, RC1) | ⬜ offen | Noch nicht begonnen |

**Legende:** ✅ läuft (real getestet) · 🟡 teilweise (Grundfunktion da, Lücken bekannt) · ⬜ offen (noch nicht umgesetzt). „Ein UI-Button gilt nicht als Funktion, ein grüner Build beweist nicht den Workflow“ – jeder Status hier stützt sich auf echte Tests, nicht auf bloßen Code.

## ⬇️ Download

| | Datei | Hinweis |
|---|---|---|
| 🪟 **Windows-Installer** | [**AirDeck-Setup.exe**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest/download/AirDeck-Setup.exe) | Installation ohne Adminrechte. Deutsch/English, mit Audio-Engine (ffmpeg/LAME) und Android-APK |
| 🪟 **Windows portable** | [**AirDeck-Windows-Portable.zip**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest/download/AirDeck-Windows-Portable.zip) | Ohne Installation: entpacken, `AirDeck.exe` starten |
| 🤖 **Android-App** | [**AirDeck-Android.apk**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest/download/AirDeck-Android.apk) | Handy-Sender (ohne Server) oder Touch-Studio mit MIC LIVE, Kamera-QR-Kopplung und Mithören |
| 🐧 **Linux-Server** | [**AirDeck-Linux.deb**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest/download/AirDeck-Linux.deb) | `sudo apt install ./AirDeck-Linux.deb` (Debian/Ubuntu, x86_64) – läuft als systemd-Dienst `airdeck-server` |
| 🐳 **Server (Docker)** | `docker compose up -d` | amd64 **und arm64** (Raspberry Pi 4/5) – siehe [docs/DOCKER.md](docs/DOCKER.md) |

Alle Dateien stehen auf der Seite [**Releases → neuestes Release**](https://github.com/ricorewioriginal-collab/anmacha_control/releases/latest). Sie werden nach jeder Änderung automatisch gebaut und getestet. Solange das Repository privat ist, funktionieren die Links nur für angemeldete Mitglieder.
Windows kann bei nicht signierten Dateien warnen: „Weitere Informationen“ → „Trotzdem ausführen“ (Details in [docs/INSTALLATION.md](docs/INSTALLATION.md)).

## 🚀 Live-Demo ausprobieren

**[airdeck-demo.ricorewi-radio.de](https://airdeck-demo.ricorewi-radio.de)** – Studio direkt im Browser, ohne Installation.
Login: Benutzername `demo`, Passwort `airdeck-demo`

⚠️ Reine Testinstanz: setzt sich **automatisch alle 10 Minuten komplett zurück** (alle Daten weg), läuft ohne Audio-Engine – keine echte 24/7-Sendung möglich. Bitte nichts Echtes hier ablegen.

## 📸 Vorschau – jeder Arbeitsbereich, jedes Bedienfeld

Alle Screenshots zeigen den Beispielsender **„AirDeck-FM“** mit Testdaten (kein echter Sender). Jedes Bild ist einzeln verlinkt und öffnet in voller Auflösung – anklicken zum Vergrößern.

<p align="center">
  <img src="https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/slideshow.gif" alt="AirDeck Slideshow: Dashboard, Studio, Decks, Quellen, Sendeplan, Medienverwaltung, KI-Automation, Hörer, Benutzer, Handbuch" width="820">
</p>

### Die Arbeitsbereiche

| Dashboard (Senderübersicht) | Studio-Arbeitsbereich (Gesamtansicht) | Sendeplan & Events |
|---|---|---|
| [![Dashboard](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-dashboard.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-dashboard.png) | [![Studio](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-studio.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-studio.png) | [![Sendeplan](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-planning.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-planning.png) |
| Alle Sender auf einen Blick: Titel, Status, Modus, Schnellzugriff | Decks, Cardwall, Queue, Stream/Encoder, Quellen, Automation, Pegel – frei anordenbar | Zeitplan, Stunden-Uhr, Rotation & Regeln, Uhr-Vorlage, Preflight, Sendeplan-Raster |

| Medienverwaltung | Playlistverwaltung | Recorder |
|---|---|---|
| [![Medienverwaltung](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-mediathek.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-mediathek.png) | [![Playlistverwaltung](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-playlists.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-playlists.png) | [![Recorder](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-recorder.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-recorder.png) |
| Bibliothek, Upload, Ordner-Import, Lautheit, Integritätsprüfung | Manuell/Shuffle, Titel verwalten, Farbe & Modus je Playlist | Mitschnitt starten, automatische Zeitfenster, Replays |

| KI-Automation | Anbindungen (Bridge zu bestehenden Systemen) | Hörer-Interaktion |
|---|---|---|
| [![KI-Automation](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-ai.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-ai.png) | [![Anbindungen](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-bridges.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-bridges.png) | [![Hörer](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-listeners.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-listeners.png) |
| Director-Status, Moderation/Musikplanung, Freigaben, Protokoll | AzuraCast/Icecast/SAM/mAirList/RadioDJ als Relay & Status-Spiegel | Posteingang (Wunsch, Gruß, Votes), Hörerseiten-Link zum Einbetten |

| Nextcloud-Medien | Benutzer & Rollen | Handbuch (im Programm) |
|---|---|---|
| [![Nextcloud](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-nextcloud.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-nextcloud.png) | [![Benutzer & Rollen](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-users.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-users.png) | [![Handbuch](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-handbuch.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/view-handbuch.png) |
| Cloud-Ordner durchsuchen, Medien übernehmen, Mitschnitte hochladen | Rollenmatrix, Konten mit Sender-Zuordnung, letzte Anmeldung | Volltextsuche, gleiche Seitenleiste/Kopfzeile wie das restliche Programm |

### Jedes einzelne Bedienfeld im Studio-Arbeitsbereich

| Decks (4× CUE/Vorhören) | Cardwall | Now Playing |
|---|---|---|
| [![Decks](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-decks.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-decks.png) | [![Cardwall](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-carts.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-carts.png) | [![Now Playing](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-np.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-np.png) |

| Playlist / Archiv | Queue (mit Backtiming) | Schnelltrigger |
|---|---|---|
| [![Playlist/Archiv](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-lib.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-lib.png) | [![Queue](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-queue.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-queue.png) | [![Schnelltrigger](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-quick.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-quick.png) |

| Live-Voice (Mikrofon/PTT) | Stream & Encoder | Server-Automation 24/7 |
|---|---|---|
| [![Live-Voice](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-live.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-live.png) | [![Stream & Encoder](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-stream.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-stream.png) | [![Server-Automation](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-playout.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-playout.png) |

| Lautstärke / Processing | VU / Pegel | Quellen · Priorität |
|---|---|---|
| [![Processing](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-processing.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-processing.png) | [![VU/Pegel](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-meters.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-meters.png) | [![Quellen · Priorität](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-sources.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-sources.png) |

| System | | |
|---|---|---|
| [![System](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-system.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/panel-system.png) | Alle Fenster lassen sich frei verschieben, in der Größe ändern und abdocken (**Fenster & Layout**). | |

### Mobil & Hörerseite

| Handy-Sender (Android) | Hörerbereich (Browser) |
|---|---|
| [![Handy-Sender](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/handy-sender.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/handy-sender.png) | [![Hörerbereich](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/hoerer-browser.png)](https://raw.githubusercontent.com/ricorewioriginal-collab/anmacha_control/AirDeck-Radio-Automation-%26-Broadcast/docs/screenshots/hoerer-browser.png) |
| Live senden vom Handy – Mikrofon, Musik und Pegel, ganz ohne AirDeck-Server | Musikwunsch, Grüße und Voting direkt aus dem Browser der Hörer |

## Funktionen

**Studio & Sendebetrieb**
- **Dashboard** als Sender-/Netzwerkübersicht (Karten je Sender: Logo, Status, aktueller Titel, Modus) – die eigentliche Arbeitsfläche liegt eine Ansicht weiter unter **Live Studio**, mit frei anordenbaren Fenstern (verschieben, Größe ändern, abdocken).
- **Medienverwaltung** als eigener Arbeitsbereich: Suche/Filter/Sortierung über die ganze Bibliothek, Mehrfach-Upload, Ordner-Import, Metadaten-Editor, Lautheit (LUFS) je Titel, Integritätsprüfung (fehlende Dateien, Duplikate, Relink), direktes Senden an Deck/Queue/Playlist/Cardwall. **Nextcloud** ist als Quellen-Reiter direkt eingebettet, nicht isoliert daneben.
- **Playlistverwaltung** als eigener Arbeitsbereich: anlegen/umbenennen/duplizieren, Titel hinzufügen/entfernen/verschieben, Modus **Manuell** oder **Shuffle** (Interpreten-Trennung, „Jetzt neu mischen“).
- Vier Decks mit CUE/Vorhören, Cardwall (Jingles/Sweeper/Station-IDs/Drops/News/Werbung, per Ducking automatisch abgesenkt), Schnelltrigger, Queue mit Backtiming, Drag & Drop (auch Dateien direkt aus dem Explorer).
- **Server-Automation 24/7** ohne offenes Fenster: Crossfade, Carts mit Ducking, Mikrofon/Line-In, Stille-Erkennung, Notfall-Ordner, Autostart.
- **Source Priority Engine:** Live-Studio, Remote, Android, Automation und Relays mit Priorität, Übernahme, Anti-Flapping und **mehrstufigen Failover-Ketten** (fällt bis zur ersten wirklich erreichbaren Quelle durch, mit Ringschutz gegen Fehlkonfiguration).
- **Sendeplan & Events:** Programmpläne, Stundenuhr, Uhr-Vorlage (Kategorien-Takt), Preflight-Prüfung, Einzel-Jobs, Aufnahmepläne. Dazu ein **Recorder** mit Replays.
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
- Mehrere Sender mit eigenem Logo. Datenspeicher lokal oder mit Sync zu MySQL/MariaDB/PostgreSQL bzw. Firebase. Zugangsdaten liegen verschlüsselt (AES-256-GCM).
- **Geräte-Pairing:** Kopplungscode (mit/ohne Benutzerkonto), echter scanbarer QR-Code, **Kamera-Scan direkt in der App/im Browser** (kein natives Plugin nötig), Geräteliste mit Widerruf, LAN-Discovery.
- **Windows-Programm** `AirDeck.exe` mit eigenem Fenster, Tray-Symbol und Audio-Engine im Hintergrund (Fenster zu, Sendung läuft weiter). **Updates** per Klick. Handbuch als echte Ansicht im Programm (gleiche Seitenleiste/Kopfzeile, mit Volltextsuche), nicht als externe Seite.
- **Android-App** mit eigenem **Handy-Sender**: Mikrofon und Musik vom Handy direkt zu laut.fm oder Icecast, ohne Server und auch bei ausgeschaltetem Bildschirm. Alternativ Fernbedienung für das Studio am PC.
- **Docker/Server:** amd64 und **arm64 (Raspberry Pi 4/5)**, beide in echter CI gebaut und gestartet – kein bloßes Versprechen in der Doku.

## Schnellstart

**Windows:** Installer starten, fertig. Das Studio öffnet sich, AirDeck läuft danach im Hintergrund. Das Symbol im Infobereich bietet Studio öffnen, Protokoll und Beenden.

**Android:** Im Studio am PC unter **Android-App** „Im Netzwerk erreichbar“ einschalten. Dann die APK auf dem Handy laden und mit Adresse und Kopplungscode verbinden – per Eingabe, per QR-Code oder direkt mit der Handy-Kamera scannen ([Anleitung](docs/INSTALLATION.md#android)).

**Server:**
```bash
docker compose up -d
docker compose logs airdeck      # Einmal-Passwort für „admin“ und Admin-Token
```
Läuft auch auf einem Raspberry Pi 4/5 (arm64) – ohne Docker geht es mit Node.js ≥ 22.18 und ffmpeg: `npm install && npm start`. Danach läuft das Studio unter `http://127.0.0.1:8750`.

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
| Handbuch (Inhalt; im Programm als eigene Ansicht eingebettet) | [studio/handbuch.html](studio/handbuch.html) |
| Installation Windows/Android | [docs/INSTALLATION.md](docs/INSTALLATION.md) |
| Docker/Server (amd64 + arm64) | [docs/DOCKER.md](docs/DOCKER.md) |
| Streaming, Klang, Liquidsoap | [docs/STREAMING.md](docs/STREAMING.md) |
| Brücke & Bridge-API | [docs/BRIDGE.md](docs/BRIDGE.md) |
| KI-Automation | [docs/AI.md](docs/AI.md) |
| Architektur | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Funktionsabgleich | [docs/FEATURE_PARITY.md](docs/FEATURE_PARITY.md) |
| Fortschritt | [AIRDECK_PROGRESS.md](AIRDECK_PROGRESS.md) |
| Beta-Qualifikation (Status, offene Punkte) | [BETA_READINESS.md](BETA_READINESS.md) · [P4_REMAINING.md](P4_REMAINING.md) |

## Mitmachen

Webentwicklerinnen und Webentwickler dürfen eigene Features einbauen. Aufbau, Regeln und Andockpunkte stehen in [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm run check        # Typprüfung (Server + Studio) und alle Tests (aktuell 182, davon 176 grün, 6 übersprungen ohne z. B. echte MySQL/ffmpeg-Umgebung - in CI mit echten DB-Containern alle 182 grün)
```

## Haftungsausschluss

AirDeck ist ein **privates Hobbyprojekt** und wird ohne Gewähr bereitgestellt. Die Nutzung erfolgt auf eigene Verantwortung, siehe [HAFTUNGSAUSSCHLUSS.md](HAFTUNGSAUSSCHLUSS.md).
