# Funktionsabgleich: AnMaCha-Dashboard → AirDeck

Quellen: `index.html` und `sam.html` (eigene Server-Automation, „AnMaCha Broadcaster – Live-Automation“),
`automation.html` (laut.fm Radioadmin), `ki-tools.html` (KI Tools) und `radioadmin-api-spec`.
AirDeck bildet diese Funktionen **ohne PHP-Server** lokal ab: `AirDeck.exe` bzw. `npm start`.

Legende: ✅ vorhanden · 🟡 teilweise · ⏳ geplant

## Server-Automation (index.html / sam.html)

| Funktion | Status | In AirDeck |
|---|---|---|
| Decks A/B (Auto-DJ, Crossfade), C/D manuell | ✅ | 4 Decks, Automation, Server-Playout 24/7 |
| Cue-Marke, Loop, Tempo, ±10 s | 🟡 | Cue-In/Segue pro Titel, Springen per Klick. Loop/Tempo ⏳ |
| Bibliothek mit Ordnern, Titel-/Ordner-Upload, Drag & Drop | ✅ | Ordner, Ordner-Upload, Drag & Drop |
| Titeldaten bearbeiten (F2), Löschen | ✅ | ✎ im Archiv |
| Warteschlange: füllen aus Ordner/Kategorie, leeren, verschieben | ✅ | „Aus Ordner …“, Drag & Drop |
| M3U importieren/exportieren | ✅ | Planung → Playlists, Queue → M3U |
| URL/Stream zur Warteschlange | ✅ | „＋ URL“, auch im Zeitplan |
| Rotation & AutoDJ | ✅ | Sendeuhr + Rotationsregeln |
| Zeitplan (einmalig/stündlich/täglich/Mo–Fr/wöchentlich; Crossfade oder über Musik) | ✅ | Planung → Zeitplan |
| Uhr (Minuten-Events pro Stunde/Tag) | ✅ | Planung → Stunden-Uhr |
| Programm: Playlists & Sendeplan (Zeitfenster → Playlist) | ✅ | Planung → Sendeplan |
| Sound FX / Jingles / Pads | ✅ | Cardwall (12 Carts, Gruppen, Ducking) |
| Sprecher/Mikrofon, Live übernehmen, zurück zur Automatik | ✅ | MIC LIVE, Source Priority, Freigeben |
| Mithören & Audio-Routing | 🟡 | 🎧 Mithören. Ausgabegerät-Wahl/PFL auf zweites Gerät ⏳ |
| Encoder / Sender, Zusatz-Streams (Simulcast), Stream-Status | ✅ | Ausgänge (mehrere Icecast/laut.fm, ?prio=) |
| Recorder / Replays, zeitgesteuerte Aufnahme | ✅ | Recorder |
| Titelanzeige senden | ✅ | „Titelanzeige senden …“ |
| Verlauf / Sendungs-Rückblick | 🟡 | Planung → Verlauf (CSV). Rückblick-Auswertung ⏳ |
| Voicetrack (über Musik sprechen, speichern) | ⏳ | nächster Schritt |
| Einstellungen: Notfall-Programm, Sound-Prozessor | 🟡 | Notfall-Auswahl, Limiter. Volle DSP-Kette ⏳ |
| Nachrichten & Wetter, Werbe-Trigger (laut.fm) | ⏳ | nur über reale laut.fm-Schnittstellen |
| Studiomail (Hörernachrichten), Prep-Feeds (RSS) | ⏳ | |
| HLS-Stream (m3u8) | ⏳ | |
| Cloud-Kachel (Team-Dateien) | ⏳ | Cloud-Adapter (WebDAV/S3/NAS) laut Spezifikation |

## laut.fm Radioadmin (automation.html)

| Funktion | Status |
|---|---|
| Verbindung per Radioadmin-Token (verschlüsselt lokal), Stationswahl | ✅ |
| Übersicht: Station, Aktiv-Status + Aktivieren, Hörer, laufende Playlist, aktueller Titel | ✅ |
| Playlists: anlegen, bearbeiten, löschen, Titel hinzufügen/entfernen | ✅ |
| Titel: Suche, Vorhören, zu Playlist, MP3-Upload, Uploads in Verarbeitung | ✅ |
| Sendeplan: Wochenraster (Slot = Tag×24+Stunde), Stunden belegen | ✅ |
| Statistik: Hörer jetzt, Einschaltungen, gespielte Titel 24 h | ✅ |
| Benutzer: einladen, Rolle ändern, entfernen | ✅ |
| Station: Beschreibung, Format, DJs, Links, Genres, Logo | ✅ |
| Live: Zugangsdaten → als AirDeck-Ausgang übernehmen (mit ?prio=) | ✅ |
| Automation-Algorithmen, Tags, Deep-Stats/Mail | ⏳ |

## KI Tools (ki-tools.html)

Voice Studio, KI-Assistent, Musik-Studio (Suno), Spot-Werkstatt, Sendeablauf-Planer, Transkription und Office-Studio
kommen in die AirDeck-AI-Schicht (Phase 8 der Roadmap). Dort gelten eigene Provider-Keys, lokale bzw. kostenlose Engines
(Piper/Whisper) zuerst und ein Kosten-Ledger. AI darf nie Single Point of Failure sein.

## LunarCaster DJ 1.2 Beta 5 (Funktionsvorlage für den lokalen Betrieb)

LunarCaster wird nicht mehr gepflegt und darf frei verwendet werden. Übernommen wurden **nur Funktionsideen**.
Die mitgelieferten Fremdbibliotheken (BASS/Bass.Net von un4seen, Winamp-DSP-Plugins, Encoder-EXEs) sind eigenständige
Drittsoftware mit eigenen Lizenzen und sind **nicht** Teil von AirDeck. AirDeck nutzt stattdessen ffmpeg.

| LunarCaster | Status | AirDeck |
|---|---|---|
| Decks A/B, Auto-Crossfade, Fade-In/Fade-Out/Next-Start | ✅ | Überblendung, Einblenden, Segue pro Titel |
| Mikrofon + Voice-Over-Lautstärke, Aux-Eingänge in den Stream | ✅ | Server-Automation: Mikrofon/Line-In am PC mit Ducking (🎙 Mikro) |
| Lokale Lautstärke / Mithören | ✅ | Programm über PC-Lautsprecher (ffplay) oder 🎧 |
| 10-Band-EQ, DSP | ✅ | Master-DSP: 10-Band-EQ, Kompressor, Limiter |
| Encoder MP3/AAC/OGG/OPUS | ✅ | MP3, AAC, Ogg/Opus |
| Server: Icecast, SHOUTcast v1, SHOUTcast v2, mehrere, Auto-Reconnect | ✅ | Ausgänge inkl. SHOUTcast v1/v2 (Stream-ID) |
| Hörerzahl vom Server | ✅ | Icecast status-json, SHOUTcast 7.html bzw. stats |
| Songdatenbank mit ID3-Tags, Vorschau, Suche, Historie | ✅ | ffprobe liest Titel, Interpret, Album, Genre, Jahr und BPM |
| Zufallstitel, Queue mischen, M3U öffnen/speichern | ✅ | |
| Sound-FX-Ordner | ✅ | Cardwall und Ordner |
| Event-Kalender (Wochentage, URL-Events, Wiederholung) | ✅ | Zeitplan, Stunden-Uhr, Sendeplan |
| Nachricht senden (Titelanzeige) | ✅ | Titelanzeige senden |
| Winamp-DSP-Plugins | ✗ | bewusst nicht: proprietär und nur für Windows |
