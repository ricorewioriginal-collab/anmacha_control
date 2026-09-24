# Fortschritt

- **Aktuelle Phase:** Phase 3, AirDeck Standalone. Auf Wunsch des Nutzers wird sie vorgezogen: Die AnMaCha-Control-Center-Erweiterung ist PHP und noch nicht in Git, sie wird später angebunden.
- **Branch:** `claude/bestehendes-projekt-fortsetzen-daf00s`
- **Tests:** `npm run check` → Typprüfung (Server und Studio) plus 40 Tests, alle grün (inkl. Playout-Integrationstest mit echtem ffmpeg). Zusätzlich lief ein manueller Browsertest mit Chromium (Automation, Crossfade, Stream-Übernahme, Drag & Drop, Handy-Layout) ohne Konsolenfehler.

## Erledigt (0.1)

- [x] Source Priority Engine (Domain-Modell, State Machine, Events, Validierung, RBAC, Anti-Flapping, Cooldown, Fallback, Override, Restore) mit allen Punkten aus `PHASE_1_ACCEPTANCE_TESTS` zur Priorität
- [x] Relay-Kern mit Icecast-kompatiblem Ingest (`PUT`/`SOURCE`)
- [x] Icecast-Ausgang mit `?prio=`, Metadaten, Backoff und Fehlerklassen
- [x] Automation Core: Queue, Sendeuhr, Rotation, Backtiming, Stilleerkennung
- [x] REST API v1, SSE, Tokens mit Scopes, Rate-Limit, Audit-Log, verschlüsselte Secrets
- [x] Studio: 4 Decks, Cardwall, Archiv/Upload, Queue, Quellen, Ausgänge, Meter, Branding, PWA

## Erledigt (0.2)

- [x] Server-Playout 24/7 (ffmpeg, eigener Mixer, Crossfade, Carts, Ducking, Limiter, Stille-Fallback, Encoder-Neustart, Autostart nach Neustart)
- [x] Windows-Programm: Einzeldatei `AirDeck.exe` (Node SEA) mit Studio-Fenster (Edge-App-Modus), Headless-Start, Autostart-Skript, ffmpeg beigelegt
- [x] Android-App (Capacitor): Serververbindung, MIC LIVE, Mithören, Playout-Steuerung
- [x] CORS für die App, Serveradresse im Studio einstellbar
- [x] GitHub Actions: Tests, Windows-Build mit Smoke-Test, Android-APK

## Nächste Schritte (Vorschlag, in dieser Reihenfolge)

1. Windows-Installer (Startmenü-Verknüpfung) und signierte Release-APK (Keystore als GitHub-Secret)
2. **Encoder-Health serverseitig:** Stilleerkennung auf dem Relay-Stream und Metadata-Freshness.
3. **Monitoring-Panel:** Bitrate, Codec, letzter Takeover, Fallback-Status, Audit-Ansicht im Studio.
4. **Sendeplan und Events** (zeitgesteuerte Shows, Uhr pro Stunde/Wochentag), Voice Tracking.
5. **DSP-Kette erweitern:** EQ, Kompressor/Multiband, AGC, echte LUFS-Messung.
6. **Webhooks (signiert), Plugin-Manifest, Sandbox**, dazu das WordPress-Plugin.
7. **AI-Schicht** (Provider-Abstraktion, TTS-Cache, AI Director). AI darf nie Single Point of Failure sein.
8. **Optionaler AnMaCha-Connector**, sobald die PHP-Erweiterung in Git liegt.

## Bekannte Grenzen

- Die Android-App ist Studio und Live-Quelle, aber kein 24/7-Sender, weil Android Hintergrund-WebViews pausiert. 24/7 läuft auf Windows oder dem Server.
- Die Windows-`.exe` ist nicht signiert. Beim ersten Start warnt SmartScreen („Weitere Informationen“ → „Trotzdem ausführen“).
- SHOUTcast-Ausgang ist noch nicht implementiert.
- Die Meter zeigen RMS/Peak, noch kein LUFS.
- Persistenz liegt in einer JSON-Datei. Das reicht für Einzelstationen, für große Archive ist später SQLite geplant.
