# P4 – Beta-1-Abnahme

Stand: 26.09.2026; Ausgangscommit `296b799`. Grundlage: vom Betreiber bereitgestellter „AIRDECK P4 – V1 BETA QUALIFICATION“-Masterprompt.

PASS gilt nur für den ausdrücklich beschriebenen Prüfumfang. Vorhandener Code oder frühere CI ist kein plattformübergreifender UI-Abnahmenachweis. IN PROGRESS bedeutet noch nicht qualifiziert, nicht zwingend laufender Test. FAIL bedeutet konkret belegte Lücke. Kein Release-Gate ist durch diese Inventur bestanden.

Initiale Funktionsgruppen-Inventur. Vor Abschluss müssen Unterfunktionen einzeln abgenommen werden; dies ist ausdrücklich noch keine vollständige Feature-Abnahme. „Code“ ist lediglich statische Evidenz; „offen“ bedeutet ungeprüft. Android-Serverfunktionen müssen nach Client-/Handy-Sender-Modus abgegrenzt werden.

| Funktion | Backend | API | Web UI | Windows sichtbar | Android sichtbar | Desktop | Tablet | Smartphone | Bedienbar | Touch | Persistent/Neustart | E2E | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sender/Branding | services/stations.ts | /stations | Dashboard/Sendereinstellungen (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Setup/Admin | services/setup.ts | /setup | Setup-Assistent (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Medien/Upload/Metadaten | services/media.ts | /stations/:sid/media | Medienverwaltung (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Nextcloud | services/nextcloud.ts | /stations/:sid/nextcloud | Medien/Nextcloud (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Playlist/Shuffle | services/planning.ts | /stations/:sid/playlists | Playlistverwaltung (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Clock/Scheduler/Preflight | core/scheduler.ts | Planning-API | Sendeplan & Events (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Decks/Cardwall/Queue/PTT | playout.ts | Playout-/Queue-API | Live Studio (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Encoder/Profile/HLS/Failover | app.ts, playout.ts | Stream-/Profil-API | Stream & Encoder (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Relay/Brücken | services/bridges.ts | Bridge-API | Anbindungen (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| laut.fm | services/lautfm.ts | laut.fm-Proxy | laut.fm Automation (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Recorder | services/recorder.ts | Recorder-API | Recorder (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| KI/TTS | ai/, services/ai.ts | AI-API | KI-Automation (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Hörerinteraktion | services/listeners.ts | Listener-API | Hörer (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Benutzer/Rollen | services/auth.ts, users.ts | Auth-/Users-API | Benutzer & Rollen (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Pairing/Geräte | services/devices.ts | Pairing-API | Gerät koppeln (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Backup/Restore | services/backup.ts | /backup | FEHLT: Menü „Updates & Backup“ öffnet ausschließlich Updates | offen | offen | offen | offen | offen | nein | offen | offen | offen | FAIL |
| Update | update.ts | Update-API | Update-Dialog; Kanal/Rollback offen (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Datenspeicher/Sync | db/, sync.ts | Sync-API | Datenspeicher & Sync (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Diagnose | health.ts | /health, /system | Status; vollständiger Selbsttest fehlt (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Benachrichtigungen | notify.ts | Notifications-API | Konfiguration; Zentrale nicht qualifiziert (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Öffentliche Senderseite | status.ts | Status-/Listen-Routen | Öffentlicher Player separat prüfen (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Handbuch | statische Inhalte | statische Route | Handbuch (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| Android Handy-Sender | apps/android/native | native Bridge | Handy-Sender (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | IN PROGRESS |
| SFTP | fehlt | fehlt | fehlt (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | FAIL |
| Erweiterungen/Safe Mode | fehlt | fehlt | fehlt (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | FAIL |
| Zentrale Bugreports | fehlt | fehlt | fehlt (Code) | offen | offen | offen | offen | offen | offen | offen | offen | offen | FAIL |
