# P4 – Beta-1-Abnahme

Stand: 26.09.2026; Ausgangscommit `296b799`. Grundlage: vom Betreiber bereitgestellter „AIRDECK P4 – V1 BETA QUALIFICATION“-Masterprompt.

PASS gilt nur für den ausdrücklich beschriebenen Prüfumfang. Vorhandener Code oder frühere CI ist kein plattformübergreifender UI-Abnahmenachweis. IN PROGRESS bedeutet noch nicht qualifiziert, nicht zwingend laufender Test. FAIL bedeutet konkret belegte Lücke. Kein Release-Gate ist durch diese Inventur bestanden.

| Nr. | Anforderung | Status | Nachweis / offener Prüfschritt |
|---|---|---|---|
| 1 | FEATURE FREEZE | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 2 | FEATURE → UI → PLATFORM MATRIX | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 3 | ZERO TO AIR – CLEAN INSTALL | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 4 | DEPENDENCY / RUNTIME AUDIT | FAIL | Runtime-Versionen teils unfixiert (node:22-slim, FFmpeg latest); Artefakt-Inventar fehlt. |
| 5 | WINDOWS INSTALLER | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 6 | LINUX / DEBIAN | IN PROGRESS | `54fe05b`: ffmpeg von Recommends nach Depends verschoben. CI Run 36270262561: Debian-Paket gebaut, installiert, Dienst gestartet, via systemd neu gestartet und gepurgt – erfolgreich. Vollständige Clean-Install-/Reboot-/TLS-/Upgrade-Abnahme bleibt offen. |
| 7 | DOCKER | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 8 | ANDROID | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 9 | RUNTIME SELF TEST / SYSTEMDIAGNOSE | FAIL | health.ts meldet Dependencies; umfassender funktionaler Systemtest mit Export fehlt. |
| 10 | AUTOMATISCHER SENDER-STANDARDAUSGANG | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 11 | AIRDECKCAST / ICECAST | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 12 | MULTI-SENDER ISOLATION | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 13 | VOLLSTÄNDIGE MEDIENVERWALTUNG | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 14 | SFTP / FTP / MEDIENAUSTAUSCH | FAIL | Keine SFTP-Implementierung in src/ oder Studio gefunden. |
| 15 | PLAYLIST / ROTATION | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 16 | CLOCK / SCHEDULER | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 17 | EXTERNE STREAMS ALS PROGRAMMINHALT | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 18 | AUDIO TRANSITION MATRIX | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 19 | LIVE / PTT / VOICE | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 20 | CARDWALL / DECKS | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 21 | DASHBOARD / NAVIGATION | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 22 | LAUT.FM | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 23 | NEXTCLOUD | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 24 | AIRDECKCAST PROFILE / HLS / RELAY / FAILOVER | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 25 | STREAM HEALTH | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 26 | DEAD AIR / EMERGENCY | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 27 | HÖRERZAHLEN / STATISTIK | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 28 | STORAGE MANAGEMENT | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 29 | BACKUP / RESTORE | FAIL | Backup exportiert Tabellen und secrets.json, aber weder Medien noch Entschlüsselungsschlüssel; frische Instanz nicht abgenommen. |
| 30 | SENDER EXPORT / IMPORT | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 31 | PERSISTENZ / CRASH | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 32 | HEADLESS / AUTOSTART | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 33 | CHAOS TESTS | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 34 | 24–72H SOAK TEST | IN PROGRESS | Kein 24h/72h-Test gestartet oder nachgewiesen. |
| 35 | LARGE LIBRARY TEST | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 36 | MULTI USER / RBAC | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 37 | LOGIN / OAUTH / RECOVERY | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 38 | PAIRING | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 39 | UPDATE SYSTEM | FAIL | update.ts verwendet latest/festes Tag; stable/beta-Kanaltrennung fehlt. |
| 40 | ROLLBACK | FAIL | Kein App-/DB-Rollback im Updater implementiert. |
| 41 | VERSION IDENTITY | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 42 | TLS / HTTPS | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 43 | NETWORK | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 44 | EXTENSIONS | FAIL | Allgemeine Erweiterungsverwaltung und Safe Mode fehlen; Capacitor-Plugin ist kein Erweiterungsmarktplatz. |
| 45 | PUBLIC API | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 46 | PUBLIC STATION PAGE | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 47 | COMMUNITY / BUG REPORT | FAIL | Zentrales Bugreport-Backend laut README noch nicht begonnen. |
| 48 | ACCESSIBILITY / RESPONSIVE | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 49 | ERROR UX | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 50 | NOTIFICATION CENTER | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 51 | SECURITY BASELINE | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 52 | DEMO INSTANCE | FAIL | README beschreibt Demo ohne Audio-Engine; daher kein Zero-to-Air-Abnahmenachweis. |
| 53 | NO CONSOLE RULE | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 54 | NO PLACEHOLDERS | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 55 | HANDBUCH | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 56 | RELEASE ARTEFACTS | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 57 | THIRD-PARTY / LICENSE COMPLIANCE | FAIL | Releasebezogene exakte Drittanbieter-/Lizenzinventur noch nicht vollständig. |
| 58 | RELEASE GATE | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 59 | FAIL POLICY | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 60 | GIT DISCIPLINE | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 61 | BETA-1-DEFINITION | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 62 | PRIORISIERUNG / BUDGETEFFIZIENZ | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |
| 63 | START JETZT | IN PROGRESS | Code/Testbestand inventarisieren; reale UI, Persistenz, Neustart und Zielplattform praktisch prüfen. |

## Vorhandene CI-Evidenz

Build für `e44164b`: test, windows, android, linux und docker erfolgreich (Run 36263301155). Zusätzlich bestätigt Run 36270262561 für `54fe05b` bislang test, docker, docker-arm64, linux und android erfolgreich; Windows lief bei letzter Prüfung noch. Der Linux-Job baut das Debian-Paket und prüft Installation, Dienststart, systemd-Neustart und Purge mit ffmpeg als Pflichtabhängigkeit. Der Masterprompt verlangt darüber hinaus reale Workflows. Historische Testzahlen in README/alten Audits sind nicht als aktuelle Messung zu verwenden.

## Lokale Prüfung

Regression am 26.09.2026 unter Windows / Node 24.19.0: 177 Tests, 143 bestanden, 6 fehlgeschlagen, 28 übersprungen. Vier Fehler betreffen plattformabhängige Pfadannahmen in config.test.ts; listeners.test.ts meldet ECONNRESET; nextcloud.test.ts hält beim Löschen noch eine zweite Datenbankinstanz offen (EPERM). Diese Fehler werden nicht als PASS umgedeutet. Server- und Studio-Typprüfung bestanden.

Windows, Node 24.19.0, Abhängigkeiten aus package-lock.json installiert. ffmpeg/ffprobe nicht im PATH; entsprechende Audio-Abnahmen bleiben offen. Keine Windows-Clean-VM, Android-Geräteabnahme oder Linux-/Docker-Abnahme in dieser Sitzung durchgeführt.
