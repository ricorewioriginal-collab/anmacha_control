# MASTERPROMPT — ANMACHA LIVE/RELAY → AI RADIO → AIRDECK

Du arbeitest in einem **bestehenden Repository** für eine professionelle Multi-Sender-Radio-Plattform namens AnMaCha Control Center. Danach soll AirDeck als unabhängiges Produkt entstehen.

# 0. ABSOLUTE ENTWICKLUNGSREIHENFOLGE

## PHASE 1 — ZUERST: EIGENE LIVE-/RELAY-AUTOMATION
Die vorhandene eigene Live-/Relay-Automation wird zuerst vollständig auditiert, stabilisiert und ausgebaut. Sie bleibt eigenständig und produktiv.

## PHASE 2 — ANMACHA AI RADIO DIRECTOR
Erst wenn die Live-/Relay-Basis stabil ist, wird die vorhandene KI-Schicht zur vollständigen AI-Radio-Funktion ausgebaut.

## PHASE 3 — AIRDECK
Danach: Windows, Android, Self-Hosted/Server, lokale 24/7-Automation, optionale Cloud, eigene AI-Konfiguration, Broadcast-Adapter, Developer API, WordPress.

**AirDeck darf nicht von AnMaCha abhängig sein.**

# 1. PFLICHT: AUDIT VOR CODE

Vor produktiven Änderungen:
1. Repository-Struktur erfassen.
2. Frontend, Backend, API, DB, Auth/RBAC analysieren.
3. Jobs/Queues/Cron/Worker/WebSockets/Events analysieren.
4. Audio-/Streaming-Code, Encoder, DSP analysieren.
5. Live-/Relay-Automation lokalisieren.
6. Scheduler/Sendeplan/Music Library/Playlist/Queue analysieren.
7. laut.fm-Anbindung lokalisieren.
8. bestehende AI/LLM/TTS-Funktionen lokalisieren.
9. Fehler, technische Schulden und Duplikate dokumentieren.
10. Bestehende Funktionen vor Änderungen absichern.

**Keine Parallel-Implementierung eines Systems, das bereits existiert.**

# 2. PHASE 1 — LIVE-/RELAY-AUTOMATION

## 2.1 Source Priority Engine — PFLICHT

Regel:
> Je kleiner die positive Ganzzahl, desto höher die Priorität.

Beispiel:
```text
Priority 1   Live Studio
Priority 2   Remote Studio
Priority 3   Android Live
Priority 10  AirDeck/Automation
Priority 20  Backup Automation
Priority 100 Emergency Source
```

Eine Quelle höherer Priorität darf eine niedrigere Quelle übernehmen, wenn:
- Ziel/Mountpoint passt
- Authentifizierung und Autorisierung passen
- Policy dies erlaubt
- keine Safety-Sperre greift

## 2.2 Source-Modell
```text
Source
├── id
├── senderId
├── type
├── endpoint
├── authenticationRef
├── priority
├── status
├── capabilities
├── permissions
├── fallbackSourceId
├── takeoverPolicy
├── health
├── metadata
└── auditInfo
```

## 2.3 Zustände
`disconnected`, `connecting`, `standby`, `active`, `takeover_pending`, `taking_over`, `blocked`, `failed`, `fallback`.

## 2.4 Takeover
1. A aktiv.
2. B meldet sich.
3. Authorization + Target + Health prüfen.
4. Takeover Event erzeugen.
5. B aktivieren.
6. A sauber verdrängen/stoppen, soweit möglich.
7. Metadata/Now Playing aktualisieren.
8. Audit Log schreiben.
9. Monitoring informieren.

Bei Fehlern sicheren Fallback oder möglichst sicheren Erhalt des bisherigen Zustands.

## 2.5 Bestehende Live-/Relay-Funktionen erhalten/ausbauen
- Live Takeover
- DJ Handover
- Remote Studio
- Android/Mobile Source
- Automation / Backup / Emergency
- Encoder
- DSP
- Mixer
- Faderstart/Hotkeys/MIDI soweit technisch vorhanden
- Cardwall
- 4 Decks
- Playlist / Queue
- Quick Triggers
- Events
- URL Streams
- Voice Tracking
- Ducking
- Sweeper/Jingles
- Now Playing / Next
- Backtiming
- Sendeplan
- Silence Detection
- Emergency Folder
- Monitoring
- Logging
- Metadata Pass-through

## 2.6 Cardwall
Cardwall gehört in die normale Studioansicht.
Drag & Drop: Audio→Deck, Audio→Queue, Audio→Playlist, Jingle→Cardwall, Cardwall→Deck, Datei→Library.

## 2.7 Audio/DSP
Vorhandene Module wiederverwenden. Relevante Funktionen: EQ, Bass, Compressor, Multiband, Expander, Gate, AGC, Limiter, Clipper, Stereo Processing, LUFS/Peak/RMS, Gain, Ducking, Crossfade, Silence Detection, PFL/Cue.

## 2.8 Broadcast Adapter
```text
Broadcast Adapter
├── Icecast
├── SHOUTcast
├── Relay
├── laut.fm (nur reale/zulässige Schnittstellen)
└── Custom/Future
```

# 3. LAUT.FM

Drei Konzepte sauber trennen:
1. laut.fm Radioadmin / laut.fm Integration
2. eigene AnMaCha/AirDeck Automation
3. Live-/Relay-Betrieb

Regeln:
- nur tatsächlich verfügbare und zulässige Schnittstellen
- keine erfundenen Endpunkte
- keine Berechtigungsumgehung
- Capability Detection
- unsupported statt Fake-Funktion

Die generische Source Priority Engine wird bei laut.fm nur dort genutzt, wo der aktuelle Mechanismus technisch und vertraglich zulässig ist.

`08_IMAGES/1000137952_lautfm_source_priority.jpg` ist Nutzer-Evidence zum beschriebenen `?prio=`-Mechanismus: positive Ganzzahl, kleinere Zahl gewinnt, höhere Priorität kann niedrigere verdrängen. Das ist Evidence, kein vollständiger API-Vertrag.

# 3.5 PHASE 1 EXTENSION — KI TOOLS RELIABILITY + COST CONTROL

Immediately during the later part of Phase 1 or directly after the Phase-1 Live/Relay expansion, audit and repair the existing `ki-tools.html` / KI Tools ecosystem. This work is a mandatory gate before Phase 2 AI Radio Director expansion.

Current reported problems that must be treated as real bug reports to verify in the repository:
- Suno generation can succeed, but generated songs cannot reliably be opened/downloaded; the UI can say `nicht eingeloggt` although the integration is configured/connected.
- AI Assistant and other KI applications sometimes render incomplete data, e.g. a metric label such as `Hörer` without a number.
- Model selection is partially broken and automatic selection can choose a failing/unavailable model.
- Configured paid-model API keys work only partially.
- ElevenLabs is configured but needs a complete, capability-aware settings surface.
- `admin.html` needs AI usage/cost visibility.
- KI Tools need a compact budget/cost hint, especially when a shared `teamkey` is used.

## Mandatory KI Tools repair scope

### Provider health + model capability
- Audit the existing provider abstraction before creating another one.
- Separate credential state, authentication state, provider availability, model availability and model health.
- Use capability-aware model resolution.
- Prefer explicit healthy model → configured preferred model → last-known-good compatible model → configured fallback → cross-provider fallback where allowed.
- Do not silently select an arbitrary broken model.
- Quarantine repeatedly failing models temporarily and use bounded retries.

### Data integrity
- Define/validate response schemas for KI Tools.
- Never display an empty metric as though it were a real value.
- Distinguish `0`, `null`, `unknown`, `not available` and `loading`.
- Never fabricate missing values.
- Keep source/timestamp metadata where applicable.

### Suno
Audit the complete lifecycle:
`auth/session → generation → job/result ownership → persistence → audio asset → open/download → URL expiry/refresh → frontend state`.

Verify actual authorized/official mechanisms in the repository/current provider documentation. Never bypass authentication or invent private endpoints. Ensure page reload, session refresh, delayed downloads, signed URL refresh and idempotent retry behavior work.

### Paid models
For every configured paid provider classify failures into auth, permission, quota, rate-limit, model-unavailable, timeout, network, provider-error and invalid-request. Provide diagnostics and a safe fallback path. Do not retry non-retryable billing/auth failures endlessly.

### ElevenLabs
Expose supported voice/model/output/language and other provider/model/voice-dependent controls dynamically where supported. Do not send unsupported parameters.

### AI usage/cost ledger
Create/reuse one normalized usage ledger for all KI Tool provider calls. Record timestamp, correlation ID, sender/user/tool/provider/model, credential reference type (never the secret), operation, usage units, media duration/credits where applicable, provider-reported cost when available, estimated cost otherwise, currency, pricing source/version, success/failure and error category.

Prefer official provider-reported usage/cost. Otherwise use a versioned local pricing table and label the result `estimated`. Never present estimates as invoices.

### `admin.html` cost control
Add today/7d/30d/custom period views with totals, provider/model/tool/sender/user/teamkey breakdowns, usage units, reported vs estimated cost, budget consumption, remaining budget, thresholds, alerts and provider health.

### Teamkey budget hint
When a team member uses a shared `teamkey`, show a compact permission-aware budget indicator in the tool UI. Never reveal the key itself. Support soft warnings, hard limits, per-teamkey/per-user/per-tool/per-provider limits and daily/monthly resets where configured.

### Security
No API keys in logs, Git, client payloads, analytics or cost records. Protect diagnostics and cost data with RBAC.

## KI Tools acceptance gate
Before Phase 2 starts, verify at minimum:
- Suno generate → persist → reload → open → download.
- Suno session/auth mismatch and re-authentication.
- Model unavailable → healthy fallback.
- Provider quota/auth errors classified correctly.
- Missing metric values never render as blank labels.
- ElevenLabs settings are capability-aware.
- Usage ledger records billable operations.
- `admin.html` displays auditable costs.
- Teamkey users see budget status without secrets.
- Hard budget limits prevent additional paid calls when enabled.
- Existing KI Tools regressions are covered by tests.

See `01_ANMACHA_AI_TOOLS_RELIABILITY/` and `07_TESTING/AI_TOOLS/` for the detailed specification and acceptance tests.

# 4. PHASE 2 — ANMACHA AI RADIO DIRECTOR

Nach Live/Relay-Stabilisierung: vorhandene AI-Infrastruktur erweitern für Musikplanung, Rotation, Variation, Sendeuhr, Backtiming, Events, URL Streams, Jingles, Sweeper, TTS, News, Tech/AI/Gaming/Hardware/Trends, Humor, Community, Voice Mail, Voice Tracking, Ducking, Takeover, Fallback und Monitoring.

AI darf kein Single Point of Failure sein. Bei Ausfall von LLM/TTS/News/Internet: laufende Automation weiter, lokale Inhalte, vorbereitete Moderation, TTS-Cache, Fallback, Logging, Benachrichtigung, kontrollierte Recovery.

# 5. AI AUDIO PIPELINE
```text
Plan → Context → LLM → Safety/Quality → TTS → Audio Processing → Cue/Duration → Schedule → Playback → Metadata → Logging
```
Lokale/free-first TTS-Adapter wie Piper/Thorsten/Kokoro; externe Provider optional.

# 6. NEWS / COMMUNITY
News nur aus echten konfigurierten Quellen. Keine erfundenen Fakten.

Voicemail:
`Upload → File Validation → Moderation → Optional Approval → Normalization → Metadata → Scheduling → Playback → Audit`

# 7. PHASE 3 — AIRDECK

AirDeck ist eigenständig:
- Windows
- Android
- Self-Hosted Server
- Local PC 24/7
- Self-Hosted 24/7
- laut.fm Adapter soweit zulässig
- Icecast/SHOUTcast/Relay
- 4 Decks
- Cardwall Standardansicht
- Playlist/Queue/Scheduler
- Drag & Drop
- Quick Triggers
- Live Voice
- Encoder/DSP/Monitoring
- Live Takeover
- Source Priority

## AirMotion Engine
Originale AirDeck-Funktion für dynamische Arrangements: intro, loop, drop, outro, beds, stingers, energy, mood, transitions, ducking, live arrangement. Keine proprietäre Fremdsoftware kopieren.

# 8. AIRDECK AI
Eigene Provider/Keys, verschlüsselte lokale Secrets, Provider-Abstraktion, LLM, TTS, Moderation, AI Director, News, Humor, Voice Tracking, Playlist Intelligence, lokale Modelle, TTS Cache, Health Checks. Keine AnMaCha-Abhängigkeit.

# 9. LOCAL-FIRST / SYNC
Kein direkter Client→Shared-MySQL-Aufbau. Bevorzugt:
```text
Local AirDeck → Local DB + Media → Sync Engine → HTTPS/WebSocket → AirDeck Server → PostgreSQL + Object Storage + Event Bus
```
Offline muss Automation weiterlaufen.

# 10. CLOUD
User-konfigurierbar: eigener Server, HTTPS/API, S3, WebDAV, Nextcloud, NAS. Secrets nicht ungeschützt synchronisieren.

# 11. WIDGET ENGINE
On Air, Now Playing, Next, Schedule, Events, Stream, Weather, News, System, AI. AnMaCha ist nur optionale Datenquelle.

# 12. DEVELOPER PLATFORM
REST + WebSocket + Webhooks, API Keys/OAuth, Scopes/RBAC, Rate Limits, Audit Log, Sandbox/Testmodus, SDK-Beispiele, Dokumentation. Keine Credential-Lesezugriffe für Plugins.

# 13. WORDPRESS
Eigenes AirDeck WordPress Plugin, unabhängig von AnMaCha.

# 14. GIT / CLAUDE CODE / CLOUD

Git-Zugriff ist vorhanden. Claude Code Cloud hat ein kostenloses Budget. Regeln:
1. Vor größeren Änderungen Branch/Checkpoint.
2. Kleine nachvollziehbare Commits.
3. Keine Secrets/API-Keys committen.
4. Keine destruktiven Befehle wie Force Push/Hard Reset ohne ausdrückliche Freigabe.
5. Tests lesen und nach Änderungen ausführen.
6. Keine unnötigen Komplett-Rewrites.
7. Architekturentscheidungen dokumentieren.
8. Audit-Ergebnisse speichern und nicht wiederholt komplett neu analysieren.

Empfohlene Phase-1-Commits:
1. Audit + Baseline Tests
2. Source Priority Domain Model
3. Priority Engine + Takeover State Machine
4. Live/Relay UI + Source Management
5. Encoder/Relay Integration + Metadata
6. Monitoring/Fallback/Emergency
7. End-to-End Tests

Danach erst AI Radio Director.

# 15. DEFINITION OF DONE — PHASE 1

Mehrere Quellen, korrekte Priority-Auswertung, autorisierte Takeovers, stabile Encoder/Relay-Verbindung, Metadata, Fallback, Silence Detection, Cardwall/Decks, Queue/Playlist, Monitoring, Audit Logs, Restart/Recovery, Netzwerkfehler und Regressionstests müssen funktionieren.

# 16. GESAMT-DONE

AirDeck unabhängig installierbar und betrieben mit Windows Studio, Android Studio, Self-Hosted Server, lokaler 24/7-Automation, Source Priority, Broadcast Adapter, DSP, Encoder, Scheduler, Cardwall, 4 Decks, AI Director, TTS, Voice Tracking, AirMotion, Widget Engine, WordPress, Developer API, Cloud Sync, Offline-first, Monitoring, Security und Dokumentation.

**Immer vom realen Bestand ausgehen. Keine Fantasie-APIs. Keine erfundenen Fähigkeiten. Erst Stabilität, dann Erweiterung.**
