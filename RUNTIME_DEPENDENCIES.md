# Runtime-Abhängigkeiten – initiales Code-Audit

Status: IN PROGRESS. Kein vollständiges Release-SBOM. Prüfung von spawn/exec-Aufrufen in src/, scripts/ und apps/. Fehlende exakte Versionen sind Release-Lücken.

| Komponente | Version/Quelle | Zweck/Plattform | Pflicht/Bündelung | Update/Ausfall |
|---|---|---|---|---|
| Node.js | >=22.18; CI 22; Docker node:22-slim | Core, alle Server | SEA gebündelt; Docker Basisimage | Build/Image; ohne Runtime kein Core |
| FFmpeg | Windows BtbN latest; Linux/Docker Distributionsversion | Decoding, Mixer-Ein-/Ausgänge, Encoder, Analyse | Sendebetrieb Pflicht; Windows beigepackt, Linux bisher nur Recommends | neuer Build/Paket; ohne Binary kein Server-Playout |
| ffprobe | aus FFmpeg-Paket | Dauer/Metadaten | Medienanalyse; plattformabhängig gebündelt | Paket; Analyse eingeschränkt |
| ffplay | aus FFmpeg-Paket | lokales Monitoring | optional | Paket; kein lokales Monitoring |
| SQLite | node:sqlite, Version abhängig vom Node-Build | lokale DB | eingebaut | Node-Build; Persistenzfehler |
| mysql2 / pg | siehe THIRD_PARTY_COMPONENTS.md | externe DB-Treiber | optional je DB-Wahl; npm ci | Lockfile; DB-Verbindungsfehler |
| PostgreSQL | Compose postgres:17 (bewegliches Tag) | Server-DB | Compose-Service; Volume | Image; DB-Ausfall separat testen |
| .NET Framework | net48 | Windows-GUI | Systemruntime | Windows; GUI startet sonst nicht |
| WebView2 | SDK 1.0.2903.40; Runtime nicht fixiert | Windows-Studio | SDK-DLLs/Runtime prüfen | Microsoft Runtime; UI-Ausfall |
| Capacitor | ^7.0.0; exakten Android-Lock prüfen | Android-Hülle/Bridge | APK | APK-Update; Geräteworkflow prüfen |
| Piper | Betreiber-Binary, nicht fixiert | optionale Offline-TTS | extern | Betreiber; TTS-Fallback |
| Liquidsoap | optional, Betreiber/Docker-Test | externe Audiointegration | extern | Betreiber/Paket; Integration fällt aus |
| ca-certificates/tini | Debian-Paketstände nicht fixiert | TLS/Prozessverwaltung Docker | Image | Image; TLS/Signalprobleme |

## Erforderliche Release-Nachweise

Exakte Binary-Versionen und Hashes, DLL/.so-Abhängigkeitsbaum, Codec-Konfiguration, Lizenztexte, Herkunft und Updateweg pro Artefakt erfassen. Clean-Install ohne vorhandene Entwicklertools prüfen. Keine Aussagen über eine erforderliche VC-Runtime ohne Binary-Analyse.
