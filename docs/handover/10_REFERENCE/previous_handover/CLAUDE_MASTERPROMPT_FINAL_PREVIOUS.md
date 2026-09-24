# MASTERPROMPT FÜR CLAUDE CODE — ANMACHA + AIRDECK

Du arbeitest an einem bestehenden professionellen Multi-Sender-Radio-System namens AnMaCha Control Center und anschließend an einem neuen eigenständigen Produkt namens AirDeck.

## 1. WICHTIGSTE PRIORITÄT
Arbeite zuerst an der bestehenden AnMaCha Automation. Das primäre Ziel dieser Entwicklungsphase ist:

> Ein konfigurierter Sender soll im 24/7-Betrieb vollständig KI-gestützt moderiert, geplant, gesteuert und überwacht werden können.

Das bedeutet nicht, dass ein neues paralleles KI-System gebaut werden soll. Zuerst das vorhandene AI-System, Backend, APIs, Datenmodell und bestehende Automation vollständig finden, verstehen und erweitern.

## 2. PFLICHT: ERST AUDIT, DANN CODE
Vor Änderungen:
- Repository-Struktur analysieren.
- Frontend/Backend/API/DB/Auth/Jobs/Queues/WebSockets/Audio/Streaming/Automation analysieren.
- Bestehende AI-Funktionen lokalisieren.
- Bestehende laut.fm-, Relay-, Icecast-, Encoder- und Scheduler-Funktionen lokalisieren.
- Bestehende Music Library, Metadata, Playlist, Events und Sendeplan-Funktionen lokalisieren.
- Bestehende TTS-/LLM-/Moderationslogik lokalisieren.
- Abhängigkeiten und Duplikate dokumentieren.
- Keine Funktion ersetzen, bevor ihre reale Verwendung verstanden wurde.

Erzeuge zunächst einen Auditbericht mit:
- vorhandenen Funktionen
- vorhandenen APIs
- vorhandenen Datenmodellen
- vorhandenen AI-Komponenten
- fehlenden Komponenten
- Bugs/Architekturproblemen
- Risiken
- konkreter Änderungsstrategie

## 3. KI-RADIO: ZIELFUNKTION
Die bestehende AnMaCha Automation soll pro Sender einen konfigurierbaren AI Radio Director besitzen.

Der AI Director darf abhängig von Berechtigungen und Konfiguration:
- Musikplanung
- Playlist-Erstellung
- Rotation
- intelligente Variation
- Sendeuhr/Clock
- Backtiming
- Events
- URL-Streams
- Jingles/Sweeper
- TTS-Moderation
- News
- Technik-/Gaming-/AI-/Trend-Themen
- Humor/Comedy
- Gewinnspiel-/Community-Beiträge
- Voice-Mail-Eingänge
- Voice-Tracking
- Übergänge
- Ducking
- Sonderaktionen
- Fallbacks
- Now Playing / Next
- Sendestatus
- Fehlerreaktionen
- Notfallinhalte
steuern.

## 4. KI DARF NICHT SINGLE POINT OF FAILURE SEIN
Wenn LLM, TTS, News-Provider, Internet oder ein externer AI-Dienst ausfällt:
- laufende Automation weiterführen
- vorhandene lokale Inhalte nutzen
- vorbereitete Moderationen verwenden
- Fallback-Playlist/Bridge-Library verwenden
- Fehler protokollieren
- Operator benachrichtigen
- nach Wiederherstellung kontrolliert zurückkehren

## 5. AI-MODERATION
Moderationen werden nicht blind live erzeugt.

Pipeline:
Input/Plan → Kontext → LLM → Sicherheits-/Qualitätsprüfung → TTS → Audio-Processing → Cue/Duration → Scheduling → Playback → Logging.

TTS:
- lokale/free-first Optionen unterstützen
- Piper/Thorsten/Kokoro etc. als mögliche Adapter
- externe TTS optional
- TTS-Cache
- Sender-/Show-/Voice-Profil
- mehrere Stimmen
- Lautheitsnormalisierung
- Ducking

## 6. NEWS
News sind nicht als klassische Vollnachrichten gedacht. Sender können Themenfelder konfigurieren, z. B.:
- KI
- Technologie
- Gaming
- Hardware
- digitale Trends
- Innovationen

Quellen müssen konfigurierbar sein. Inhalte müssen vor Ausspielung verarbeitet und geprüft werden. Keine erfundenen Nachrichten.

## 7. VOICEMAILS / COMMUNITY
Upload/Input → Dateiprüfung → Moderation → ggf. Freigabe → Normalisierung → Metadaten → Scheduling → Ausspielung → Logging.

Operator kann Freigabepflicht erzwingen.

## 8. KI-MUSIK / NICHT-KI-MUSIK
Tracks müssen Herkunfts-/AI-Metadaten unterstützen. Rotation kann gewünschte Verhältnisse berücksichtigen. Keine automatische Löschung oder Überschreibung vorhandener Playlist-Strukturen ohne Konfiguration.

## 9. LAUT.FM
laut.fm als Adapter behandeln.
- Offizielle/verfügbare Schnittstellen prüfen.
- Radioadmin und eigene Automation sauber unterscheiden.
- Keine erfundenen Endpunkte.
- Nur technisch und vertraglich zulässige Funktionen implementieren.
- Capability Detection.
- Wenn eine Funktion nicht verfügbar ist: als unsupported darstellen, nicht simulieren.

## 10. AIRDECK NACH PRIORITÄT 1
AirDeck ist ein unabhängiges Produkt:
- Windows
- Android
- Self-Hosted/Server
- lokale 24/7-Automation
- eigene Cloud optional
- eigene AI Provider Keys
- Icecast / SHOUTcast / Relay / laut.fm-Adapter nach realer technischer Möglichkeit
- professionelles Studio mit 4 Decks
- Cardwall Standardansicht
- Drag & Drop
- Playlist/Queue/Scheduler
- DSP
- Encoder
- Live Takeover
- Voice Tracking
- Events
- Monitoring
- Emergency Fallback

## 11. AIRDECK BRANDING
Jeder Sender erhält eigene:
- Logos
- Slogan
- Farben
- Akzentfarben
- Theme
- Senderassets
- On-Air-/Now-Playing-Darstellung

## 12. AIRDECK CLOUD
Cloud ist vom User konfigurierbar. Mögliche Adapter:
- eigener AirDeck Server/VPS
- eigener REST/HTTPS-Endpunkt
- S3-kompatibler Storage
- WebDAV/Nextcloud
- weitere Provider später

Granular synchronisierbar:
- Senderkonfiguration
- Branding
- Playlists
- Sendepläne
- Cardwall
- Jingles/Beds/Drops
- Musik-Metadaten/-dateien
- Voice Tracking
- Aufnahmen
- Shows
- Widget-Konfiguration
- AI-Konfiguration
- TTS Cache
- Statistiken

Secrets standardmäßig lokal/secure; niemals ungeschützt synchronisieren.

## 13. AIRDECK WIDGET ENGINE
Die aus AnMaCha bekannten Widgets sollen als eigenständige AirDeck Widget Engine funktionieren.
AnMaCha ist nur eine optionale Datenquelle.

Beispiele:
- On Air
- Now Playing
- Next
- Sendeplan
- Stream Status
- Wetter
- Events
- News
- System
- AI Status

## 14. WORDPRESS
AirDeck bekommt ein eigenes WordPress-Plugin als Alternative zu eingebauten Web-Widgets.
Es bezieht Daten über die konfigurierbare AirDeck/eigene API/Cloud.
Senderbranding wird übernommen.

## 15. DEVELOPER API
AirDeck erhält eine öffentliche, dokumentierte API und ein Plugin-/Connector-System.
Mindestens:
- REST API
- Webhooks
- Live Events/WebSocket, soweit sinnvoll
- API Keys/OAuth
- Scopes
- Rate Limits
- Audit Log
- Sandbox/Testmodus
- SDK-Beispiele
- API-Dokumentation

Entwickler sollen eigene Widgets, Plugins, Connectoren, Automationen, Tools, externe Apps und WordPress-Integrationen bauen können.

## 16. EXTERNE ANBIETER
Provider sind optional.
Motionmixes und weitere externe Anbieter dürfen über Connectoren eingebunden werden, sofern deren technische Schnittstelle und Lizenzbedingungen dies erlauben.
Keine fremde Software nachbauen oder Lizenzbeschränkungen umgehen.

## 17. AIRDECK DESIGN → ANMACHA
Erst wenn AirDeck stabil ist, wird das AirDeck Design System auf AnMaCha Automation übertragen.
Nicht AirDeck technisch von AnMaCha abhängig machen.
Gemeinsame Design Tokens möglich:
- Farben
- Panels
- Decks
- Cardwall
- Status
- Widgets
- Meter
- Typografie

## 18. KEINE UI-EXPLOSION
Keine unnötigen Hauptmenüpunkte. Bestehende Seiten logisch erweitern. Vor neuer Oberfläche prüfen, ob eine vorhandene Seite erweitert werden kann.

## 19. SICHERHEIT
- RBAC
- Sender-Isolation
- Secrets Vault/Secure Store
- CSRF/CORS korrekt
- Input Validation
- Upload Validation
- Rate Limits
- Audit Logs
- sichere Webhooks
- Plugin Permissions
- keine Credential-Leaks

## 20. ABNAHME
Jede Phase endet mit:
- Build/Test
- Unit Tests
- Integration Tests
- End-to-End Tests
- Failure Tests
- Rechte-/Security Tests
- 24/7-Simulation
- Dokumentation
- Änderungsprotokoll

Arbeite inkrementell. Keine blind vollständigen Rewrites.
