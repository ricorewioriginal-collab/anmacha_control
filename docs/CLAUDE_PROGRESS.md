# Fortschritt

- **Aktuelle Phase:** Phase 3, AirDeck Standalone. Auf Wunsch des Nutzers wird sie vorgezogen: Die AnMaCha-Control-Center-Erweiterung ist PHP und noch nicht in Git, sie wird später angebunden.
- **Branch:** `claude/bestehendes-projekt-fortsetzen-daf00s`
- **Tests:** `npm run check` → Typprüfung (Server und Studio) plus 35 Tests, alle grün. Zusätzlich lief ein manueller Browsertest mit Chromium (Automation, Crossfade, Stream-Übernahme, Drag & Drop, Handy-Layout) ohne Konsolenfehler.

## Erledigt (0.1)

- [x] Source Priority Engine (Domain-Modell, State Machine, Events, Validierung, RBAC, Anti-Flapping, Cooldown, Fallback, Override, Restore) mit allen Punkten aus `PHASE_1_ACCEPTANCE_TESTS` zur Priorität
- [x] Relay-Kern mit Icecast-kompatiblem Ingest (`PUT`/`SOURCE`)
- [x] Icecast-Ausgang mit `?prio=`, Metadaten, Backoff und Fehlerklassen
- [x] Automation Core: Queue, Sendeuhr, Rotation, Backtiming, Stilleerkennung
- [x] REST API v1, SSE, Tokens mit Scopes, Rate-Limit, Audit-Log, verschlüsselte Secrets
- [x] Studio: 4 Decks, Cardwall, Archiv/Upload, Queue, Quellen, Ausgänge, Meter, Branding, PWA

## Nächste Schritte (Vorschlag, in dieser Reihenfolge)

1. **Headless-24/7-Playout auf dem Server**, damit die Automation ohne offenen Browser läuft. Das braucht einen Decoder/Encoder (ffmpeg per Capability-Erkennung, sonst *unsupported*).
2. **Encoder-Health serverseitig:** Stilleerkennung auf dem Relay-Stream und Metadata-Freshness.
3. **Monitoring-Panel:** Bitrate, Codec, letzter Takeover, Fallback-Status, Audit-Ansicht im Studio.
4. **Sendeplan und Events** (zeitgesteuerte Shows, Uhr pro Stunde/Wochentag), Voice Tracking.
5. **DSP-Kette erweitern:** EQ, Kompressor/Multiband, AGC, echte LUFS-Messung.
6. **Windows-Shell** (Tauri oder Electron um Server und Studio) und **Android** (PWA ist schon installierbar, später Capacitor mit Mikrofon/Live-Quelle).
7. **Webhooks (signiert), Plugin-Manifest, Sandbox**, dazu das WordPress-Plugin.
8. **AI-Schicht** (Provider-Abstraktion, TTS-Cache, AI Director). AI darf nie Single Point of Failure sein.
9. **Optionaler AnMaCha-Connector**, sobald die PHP-Erweiterung in Git liegt.

## Bekannte Grenzen

- Die Automation läuft derzeit im Browser-Studio. Wird der Tab geschlossen, übernimmt die nächste Quelle nach Priorität, sonst meldet das System OFF AIR.
- SHOUTcast-Ausgang ist noch nicht implementiert.
- Die Meter zeigen RMS/Peak, noch kein LUFS.
- Persistenz liegt in einer JSON-Datei. Das reicht für Einzelstationen, für große Archive ist später SQLite geplant.
