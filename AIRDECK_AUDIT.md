# AIRDECK_AUDIT.md

Stand: `ec512d8` (Hauptbranch `AirDeck-Radio-Automation-&-Broadcast`), 24.09.2026.
Geprüft wurde der **tatsächliche Code**: 8 766 Zeilen in `src/`, `studio/` und `test/`, 60 automatische Tests, CI-Builds für Windows und Android.
Nichts hier beruht auf Annahmen aus dem Masterprompt.

Legende: **A** vollständig vorhanden · **B** teilweise · **C** nur UI/Mock · **D** fehlt · **E** fehlerhaft · **F** Architekturproblem · **G** Performance · **H** Sicherheit · **I** Test fehlt

## Kurzfazit

- **Solide:** Headless-Kern mit Source Priority, Relay, 24/7-Playout (ffmpeg), Icecast/SHOUTcast/laut.fm-Ausgängen, Planung (Zeitplan/Uhr/Sendeplan), Recorder, REST+SSE-API mit Scopes, verschlüsselten Secrets und Windows-/Android-Builds mit CI.
- **Größtes Architekturproblem (F):** Es gibt **zwei Automationen**: die Server-Automation (Kern, autoritativ) und eine **Browser-Automation** im Studio (`studio/js/app.js` → `autoNext`, Web-Audio-Decks). Die Browser-Variante verstößt gegen die goldene Regel „UI ist nie die einzige Stelle“. Außerdem zeigen die Decks nur Browser-Wiedergabe, nicht das, was der Kern sendet.
- **Große Lücken (D):** Voice-Tracking-Editor, Sweeper-/Intro-Engine, Waveform/Marker, Multiband-DSP/AGC/LUFS, Webhooks/Now-Playing-Export/Benachrichtigungen, KI/TTS, Cloud/Sync, Datenbanken (MySQL/Firebird), Widgets/WordPress/Magazin/URL-Shortener, MIDI/Hotkeys/GPIO, ASIO/WASAPI.

## Funktionen im Einzelnen

### Kern & Architektur
| Feature | Status | Dateien | Bewertung / notwendige Änderung | Test |
|---|---|---|---|---|
| Headless-Kern (`AirDeck.exe --headless`, `npm start`) | A | `src/server/main.ts`, `app.ts` | Läuft ohne UI, Autostart des Playouts nach Neustart | CI-Smoke-Test Windows, `playout.test.ts` |
| Server-Automation 24/7 (Playout) | A | `src/server/playout.ts` | Eigener Mixer (20-ms-Blöcke), Crossfade, Carts, Ducking, Encoder-Neustart | Integrationstest mit echtem ffmpeg |
| Browser-Automation im Studio | **F** | `studio/js/app.js`, `audio.js` | Doppelte Automations-Logik in der UI → auf „lokales Vorhören/Notbetrieb“ zurückstufen, AUTO startet den Kern | I |
| Decks zeigen Kern-Zustand | **E/F** | `app.js` | Decks bleiben „LEER“, wenn der Kern sendet → Kern-Zustand spiegeln | I |
| VU/Pegel im Serverbetrieb | **E** | `playout.ts`, `app.js` | Meter misst nur Browser-Audio → Kern-Pegel per SSE senden | I |
| Persistenz | B | `store.ts` (JSON, atomar), `sync.ts` | Lokal JSON (maßgeblich) + **Sync mit MySQL/MariaDB oder Firebase** (Zustands-Dokument, Konflikterkennung). Firebird/SQLite und tabellenweise Speicherung fehlen | `sync.test.ts` (echte MariaDB, Firestore-Mock) |
| Event-Bus / SSE | A | `app.ts` `publish`, `http.ts` `/events` | Push statt Polling; Systemwerte werden noch gepollt (G, gering) | teilw. |
| Audit-Log (JSONL, Rotation) | A | `store.ts` | Keine Secrets im Log (getestet) | ✔ |

### Source Priority / Live / Relay
| Feature | Status | Dateien | Bewertung | Test |
|---|---|---|---|---|
| Priority-Engine (kleiner = wichtiger, RBAC, Anti-Flapping, Cooldown, Override, Fallback, Restore) | A | `src/core/source-priority.ts` | Vollständig nach Phase-1-Abnahme | 19 Tests |
| Icecast-kompatibler Ingest (PUT/SOURCE) | A | `http.ts` `handleIngest`, `relay.ts` | Encoder (BUTT/Mixxx) können senden | E2E-Test |
| Hierarchie Emergency › Live › Quick › Scheduled › Automation › Fallback | B | – | Quellen-Prioritäten decken Emergency/Live/Automation/Fallback ab; Quick/Scheduled sind **Inhalte** innerhalb der Automation, keine Quellen (bewusste Entscheidung, dokumentieren) | ✔ |
| Source Lock / Clean Restore | B | `requestTakeover`, `release` | Sperren (`blocked`) und Freigeben vorhanden; „Automation pausiert und setzt an gleicher Stelle fort“ fehlt (Automation läuft während Live im Hintergrund weiter) | I |
| Metadaten aus externer Quelle übernehmen | D | – | Ingest liest keine ICY-Metadaten | I |

### Audio / Decks / Cardwall
| Feature | Status | Bewertung |
|---|---|---|
| 4 Decks: Play/Pause/Stop/Seek/Volume/CUE-PFL/Gain/BPM/Dauer/Rest | A (Browser) | Nur Browser-Decks (siehe F) |
| Waveform, Intro/Outro/Cue-/Fade-Marker | D (Intro-Feld `introMs` existiert, ungenutzt) | Waveform per ffmpeg erzeugen, Marker-Editor |
| Formate WAV/MP3/AAC/FLAC/OGG/M4A/OPUS/WEBM | A | über ffmpeg bzw. Browser |
| Crossfade, Segue, Fade-In, Hard Cut, Mix Point | B | Crossfade/Segue/Fade-In/Cue-In/Cue-Out vorhanden; Hard Cut und Mix-Point-Editor fehlen |
| Gapless | B | Ohne Crossfade startet der nächste Titel im selben Block (lückenlos im Mixer), nicht verifiziert (I) |
| Backtiming | B | Startzeiten in der Queue; Zielzeit-Planung (z. B. „News um 19:00 exakt“) fehlt |
| Cardwall (Farbe, Gruppe, Icon, Ducking) | B | Hotkeys, MIDI, Faderstart, Loop/Play-Modi fehlen |
| Voice Tracking Editor | D | |
| Sweeper-Engine (Intro-/Vocal-Erkennung) | D | |
| AirMotion | D | |

### DSP / Live-Audio
| Feature | Status | Bewertung |
|---|---|---|
| 10-Band-EQ, Kompressor, Limiter (ffmpeg-Filter) | B | pro Station; nicht pro Ausgang; nicht einzeln live umschaltbar (Neustart nötig) |
| Multiband (5/2), Expander, Gate, AGC, Clipper, Stereo-Width, Presets | D | über ffmpeg-Filter realisierbar (`mcompand`, `agate`, `dynaudnorm`, `stereotools`, `asoftclip`) |
| LUFS / True Peak | D | Anzeige ist RMS/Peak (ehrlich beschriftet) → `ebur128` im Kern |
| Mikrofon/Line-In am PC (Talkover mit Ducking) | A | dshow/avfoundation/pulse; nur mit Testsignal getestet |
| WASAPI/ASIO, Booth, Talkback | D | ffmpeg-dshow ≠ ASIO |
| PFL auf eigenem Ausgabegerät | A (Browser, `setSinkId`) | |
| MIDI/GPIO/Tally/On-Air-Lampe | D | |

### Streaming
| Feature | Status | Bewertung |
|---|---|---|
| Icecast (PUT, `?prio=`, Metadaten, Backoff) | A | E2E-Test gegen Mock |
| SHOUTcast v1/v2 | A | Protokolltest gegen Mock |
| laut.fm-Live-Zugang als Ausgang | B | Code vorhanden, **nicht mit echtem laut.fm getestet** |
| Mehrere Ausgänge gleichzeitig | A | teilen sich **einen** Encoder/Bitrate (pro Ausgang eigener Encoder fehlt) |
| Hörerzahlen | A | öffentliche Statusseiten |

### Automation / Planung
| Feature | Status | Bewertung |
|---|---|---|
| Sendeuhr, Rotation (Artist/Title-Separation), Kategorien, Ordner | A | |
| Zeitplan (einmalig/stündlich/täglich/Mo–Fr/wöchentlich), Stunden-Uhr, Sendeplan (Dayparts), Playlists | A | Tests vorhanden |
| Events „nach Intro/Outro“, Fixzeit exakt (Backtiming) | D | |
| Emergency-Playlist/-Ordner | B | Notfall = zufälliger Musiktitel; eigener Emergency-Ordner fehlt |
| Smart Shuffle (Energy/Mood/BPM-Kurven, AI-Anteil) | D | Felder Energy/Mood/Explicit/AI fehlen im Datenmodell |
| Stilleerkennung + Fallback | A | Kern und Browser; **Benachrichtigung (Mail/Telegram/Webhook) fehlt (D)** |
| Datei fehlt → überspringen | B | Decoder-Fehler → nächster Titel; Test fehlt (I) |

### Metadaten / Integration
| Feature | Status | Bewertung |
|---|---|---|
| Now Playing an Icecast/SHOUTcast | A | |
| Now-Playing-Export (Textdatei, JSON, Webhook) | A | `notify.ts`; HTTP/Serial/RDS fehlen |
| Webhooks (HMAC-signiert), Telegram-Alarme | A | E-Mail fehlt (per Webhook-Brücke möglich) |
| laut.fm Radioadmin (Playlists, Titel, Sendeplan, Statistik, Benutzer, Station, Live) | B | UI + Proxy vorhanden, **ohne echten Token ungetestet** |
| Developer API (REST, SSE, Scopes, Rate Limit, Tokens) | A | Doku nur als Tabelle in `docs/ARCHITECTURE.md` (API.md fehlt) |
| Plugin-System | D | |

### Plattformen
| Feature | Status | Bewertung |
|---|---|---|
| Windows: Installer, portable ZIP, Edge-App-Fenster, Autostart | A | CI installiert/startet/deinstalliert; **unsigniert** |
| Android: eine App (Capacitor), Fernsteuerung, MIC LIVE, Mithören | B | Remote-Studio wie gefordert; nicht auf Gerät getestet (I); Hintergrund-Mic eingeschränkt |
| Web-Studio / PWA | A | |
| Multi-Sender mit Branding (Name, Claim, Farben) | B | Logo-Upload, Hintergrund, Theme fehlen |
| Multi-Standort, Cloud, Sync, Offline-Konflikte | D | |

### KI / TTS / Content
| Feature | Status |
|---|---|
| KI-Provider-Abstraktion, Fallback, Kosten-Ledger, Budgets | D |
| AI Radio Director | D |
| TTS (Piper/Thorsten/Kokoro…) | D |
| Wetter/externe Datenquellen → Template → TTS | D |
| Widgets, WordPress-Plugin, Magazin, URL-Shortener | D |

## Sicherheit (H)
| Punkt | Bewertung |
|---|---|
| Secrets | AES-256-GCM, Schlüssel lokal (0600) oder `AIRDECK_SECRET_KEY`; API gibt nur `hasPassword` zurück ✔ |
| Tokens | nur SHA-256-Hash gespeichert, Scopes, Rate Limit ✔ |
| Token in Query-String | nur für GET (SSE, Audio, Cover); kann in Proxy-Logs landen → später kurzlebige Stream-Tokens (H, mittel) |
| CORS | nur Capacitor-Origins + Konfiguration ✔ |
| Pfad-Traversal Studio/Medien | geprüft und getestet ✔ |
| laut.fm-Proxy | Pfad-Whitelist, Token verlässt den Server nie ✔ |
| Netzwerkbetrieb | HTTP ohne TLS; für LAN ok, für Internet Reverse-Proxy mit TLS nötig (dokumentiert) |
| Windows-Binary | unsigniert (SmartScreen) |

## Performance (G) – gemessen
| Messung | Wert |
|---|---|
| Start bis `/health` antwortet | **0,54 s** |
| Kern (Node) RAM / CPU bei laufendem 24/7-Playout | **105–112 MB**, **2–4 %** |
| Encoder (ffmpeg, MP3 128 kbit/s) | **~50 MB**, **~1,8 %** |
| Decoder pro Titel | kurzlebiger ffmpeg-Prozess, Vorlauf max. 10 s |
| Auffällig | RAM stieg in 2 min um ~6 MB → **Langzeittest (24 h) nötig**, bevor ein Leck ausgeschlossen werden kann |
| Polling | Studio pollt `/system` alle 5 s (klein); alles andere läuft per SSE |

## Tests (I)
Vorhanden: 60 Tests (Priority, Automation, Scheduler, PCM, Playout mit echtem ffmpeg, Server-E2E, SHOUTcast, Features, laut.fm-Proxy).
Fehlend: 24-h-Soak, Datei-fehlt-Test im Playout, Netzwerkverlust am Ausgang (nur Backoff-Logik), Android auf Gerät, echter laut.fm-Token, Lasttest vieler SSE-Clients, UI-Regressionstests.

## Priorisierung (nächste Schritte nach Masterprompt Phase 1 → 3)
1. **Kern autoritativ machen (F/E):** Decks und VU spiegeln das Server-Playout, AUTO startet den Kern, Browser-Automation nur noch als gekennzeichneter lokaler Notbetrieb.
2. **Emergency-Ordner** fürs Playout, Datei-fehlt-Test.
3. **Webhooks + Now-Playing-Export + Stille-Benachrichtigung** (Metadaten-Engine).
4. DSP-Kette ausbauen (AGC, Multiband, Clipper, Stereo, Presets, Bypass) + LUFS/True Peak im Kern.
5. Waveform, Marker, Intro/Outro, Events „nach Intro“, Zielzeit-Backtiming.
6. Danach Voice Tracking, Sweeper-Engine, KI/TTS, Cloud, Widgets (Phasen 8–12).
