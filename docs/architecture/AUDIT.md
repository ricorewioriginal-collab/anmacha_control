# AirDeck – Architektur-Audit

Stand: 25.09.2026 · Grundlage: Code auf `AirDeck-Radio-Automation-&-Broadcast` (Commit `9ed0450`), eigene Reproduktionen in einer Linux-Testumgebung mit echtem ffmpeg 6.1. Was nicht gegen ein echtes System geprüft werden konnte, ist ausdrücklich so markiert.

**Ergebnis in einem Satz:** Die Einzelteile sind zum großen Teil echt und getestet (93 automatische Tests, CI mit Windows-Installer, Docker, Liquidsoap). Es fehlt aber eine tragende Architektur. Es gibt keinen Betriebsarten-Begriff (Local/Server/Hybrid), keine Datenbankschicht, keinen Mode-Manager und keinen gemeinsamen Audiopfad für alle Quellen. Mehrere Kernfunktionen scheitern genau daran.

---

## 1. Dokumentierte Architektur (was die Doku behauptet)

- README und INSTALLATION: „Windows-Programm ohne Server“, „Server/Docker“, „Android-App“. Voraussetzung für die Server-Installation ohne Docker ist „Node.js ≥ 22.18 und ffmpeg“.
- `docs/ARCHITECTURE.md` (58 Zeilen) beschreibt vor allem die Source Priority Engine und den Relay. Betriebsarten, Datenhaltung, Deployment, Netzwerk und Sicherheit fehlen.
- `docs/STREAMING.md` beschreibt eine Kette „Titel → Mixer → DSP → Encoder → Ausgänge“. Die gilt aber **nur für die Automation**, nicht für Live-Quellen (siehe 5.2).

## 2. Tatsächliche Architektur (was der Code tut)

```
                      ┌──────────────────────── ein Node-Prozess ─────────────────────────┐
 Browser/Edge-Fenster │ http.ts (REST, SSE, Static, laut.fm-Proxy, Status, Ingest)        │
 Android-WebView  ───►│ app.ts  (2 677 Zeilen: Sender, Quellen, Medien, Queue, Playout,   │
                      │          Planung, Recorder, laut.fm, KI, Bridge, Nextcloud, Status,│
                      │          Updates, Liquidsoap, Benutzer-Anbindung …)                │
                      │ core/   source-priority · automation · scheduler · pcm            │
                      │ playout.ts → ffmpeg (Decoder je Titel, Mixer in JS, Encoder)      │
                      │ relay.ts   → aktive Quelle roh an Ausgänge (Icecast/SHOUTcast)    │
                      │ Persistenz: data/airdeck.json (+ tokens/users/sessions/ai/…json)  │
                      └───────────────────────────────────────────────────────────────────┘
```

| Bereich | Ist-Zustand |
|---|---|
| Laufzeit | Windows: Node als Single-Executable (SEA) **mitgeliefert**, ffmpeg mitgeliefert. Der Endanwender braucht kein Node. Linux nativ: Node ≥ 22.18 und ffmpeg selbst installieren. Docker: alles im Image |
| Prozessmodell | Ein Prozess für API, Automation, Encoder und UI-Auslieferung. Windows: Hintergrundprozess mit Tray, Autostart über `HKCU\…\Run` (erst nach Benutzer-Anmeldung). **Kein Windows-Dienst, kein systemd-Dienst** |
| Datenhaltung | **Keine Datenbank.** Der gesamte Senderzustand steht in `data/airdeck.json` und wird bei jeder Änderung komplett neu geschrieben (entprellt). Dazu kommen getrennte JSON-Dateien für Tokens, Benutzer, Sitzungen, KI, Bridge-Zuordnung, Netzwerk, Update, Nextcloud und Secrets (verschlüsselt). Keine Migrationen, nur ein Feld `version: 1` |
| „Datenbank-Sync“ | MySQL/MariaDB und Firestore speichern **den ganzen JSON-Zustand als einen Blob**. Das ist Replikation und keine Datenbankschicht |
| Speicherorte | Paket: `%LOCALAPPDATA%\AirDeck\data` pro Windows-Benutzer, darin `media/<sender>/`, `recordings/`, `logs/`, `logos/`. Keine Trennung von Konfiguration, Daten, Medien und Logs. Medienordner nicht wählbar |
| Client/Server | Das Studio ist eine Web-App vom selben Prozess. Ein anderer Server lässt sich nur in der Android-App setzen, und nur über den Anmeldedialog. Keine gespeicherten Serverprofile, keine Erkennung, keine Versionsprüfung |
| Authentifizierung | API-Tokens mit Scopes, dazu Benutzerkonten und Sitzungen. Konten gibt es **nur im Servermodus**. Das Desktop-Programm kennt nur ein internes Token |
| Health | `GET /api/v1/health` liefert fest `{"ok":true,"version":"0.4.0"}`. Datenbank, Audio, Encoder und Stream werden nicht geprüft |
| Updates | Build-Kennung (Commit) statt semantischer Version. Keine API-Kompatibilitätsprüfung, kein Backup vor dem Update, kein Rollback |
| Backup/Restore | nicht vorhanden |
| Android | Capacitor-WebView-Hülle um das Studio. Kein natives Audio, kein Foreground-Service, kein eigenes Netzwerk. MIC LIVE über `getUserMedia` + `MediaRecorder` (WebM/Opus) |
| Linux | kein Paket, kein Dienst, kein Setup |
| KI lokal | Anbindung an Ollama, LM Studio, Kokoro und Piper vorhanden. **Keine lokale KI-Laufzeit mitgeliefert oder eingerichtet** |

## 3. Zielarchitektur (Kurzfassung, Details in `ARCHITECTURE.md`)

- **AirDeck Core** als eigenständiger Dienst, UI-unabhängig: Mode-Manager, Source Priority, gemeinsame Audio-Engine für alle Quellen, Encoder, Ausgänge, Scheduler, Event-Bus, API.
- **Drei Betriebsarten:**
  - *Local:* Core und SQLite auf dem PC.
  - *Self-Hosted:* Core, PostgreSQL (oder SQLite/MariaDB/MySQL) und Medienspeicher, als Dienst oder Docker.
  - *Hybrid:* Studio mit lokalem Core, der mit einem Server synchronisiert und bei dessen Ausfall weiterarbeitet.
- **Datenbankschicht** (`DatabaseProvider`) mit Migrationen. SQLite ist Standard: in Node 22 als `node:sqlite` eingebaut, ohne native Zusatzmodule, bündelbar. PostgreSQL für Server, MariaDB/MySQL optional. Clients greifen nie direkt auf die Datenbank zu.
- **Dienste:** Windows-Dienst „AirDeck Server“ (Autostart, Neustart bei Fehler, `%ProgramData%\AirDeck`), Linux `airdeck-server.service`, Docker mit Restart-Policy. Das Studio ist ein getrennter Client.
- **Setup-Assistent** im ersten Start: Betriebsart, Datenbank, Speicher, Admin, Netzwerk, Sender, Stream, Audio, Automation, KI.
- **Health- und Dependency-Manager** mit echten Prüfungen und Status (bereit, fehlt, veraltet, defekt).

## 4. Abweichungen Ist → Ziel

| Ziel | Ist | Abweichung |
|---|---|---|
| Core unabhängig von UI | Core läuft ohne Browser ✔ | Die „Browser-Automation“ ist als zweite, konkurrierende Automation im Studio noch vorhanden |
| Mode-Manager AUTO/MANUAL/LIVE | fehlt | AUTO heißt „Playout starten/stoppen“, LIVE ergibt sich aus der Quellen-Priorität, MANUAL gibt es im Kern nicht |
| Gemeinsamer Audiopfad | nur Automation | Live-Quellen werden roh durchgereicht (5.2) |
| Datenbank-Abstraktion | JSON-Dateien | vollständig neu, siehe 9 |
| Betriebsarten Local/Server/Hybrid | implizit (Desktop/headless) | kein Begriff, keine Konfiguration, kein Hybrid-Offline-Betrieb |
| Windows-Dienst | Tray-Prozess, HKCU-Autostart | Sendebetrieb erst nach Benutzer-Anmeldung, nicht als Dienst |
| Linux-Installation | nur Docker | kein natives Paket, kein systemd |
| Setup-Assistent | Installer-Seiten für Speicher/Sync | kein Erststart-Assistent, keine Datenbankwahl, kein Medienordner |
| Server hinzufügen | nur Anmeldedialog der App | keine Erkennung, kein Verbindungstest, keine Profile, keine Versionen |
| Health-API | statisch | keine echten Prüfungen |
| Backup/Restore, Rollback | fehlt | vollständig neu |

## 5. Kritische Fehler (reproduziert)

### 5.1 „Server hinzufügen“ scheitert gegen eine Windows-/Desktop-Installation
Nachvollzogen auf dem Weg App → Anmeldedialog → `POST /api/v1/auth/login` → Server:

1. **Netzwerk:** Das Desktop-Programm lauscht standardmäßig nur auf `127.0.0.1`. Vom Handy ist es nicht erreichbar, bis „Im Netzwerk erreichbar“ eingeschaltet **und** AirDeck neu gestartet ist. Die App meldet dann nur „Server nicht erreichbar“.
2. **Anmeldung:** Eine Desktop-Installation legt **keine Benutzerkonten** an. Reproduziert: `GET /api/v1/auth/status` → `{"users":false}`. `POST /auth/login` → 401 „Benutzername oder Passwort falsch“. Mit Benutzername und Passwort kann die Anmeldung deshalb **nie** gelingen. Es funktioniert nur der Verbindungslink.
3. **CORS:** in Ordnung. Der Preflight von `https://localhost` (Capacitor) liefert 204 mit passendem `Access-Control-Allow-Origin`.
4. **„Lokal“ auf dem Handy:** Gibt man in der App `127.0.0.1`/`localhost` ein, zeigt das auf das Handy selbst, nicht auf den PC. Es gibt weder Erkennung noch Hinweis.
5. Es fehlen Verbindungstest, Versionsprüfung und gespeicherte Serverprofile. Ein Fehler wird erst nach dem Neuladen sichtbar.

**Behoben (Schritt 5):** Kopplung per Code (ohne Benutzerkonto, eigenes Geräte-Token, einzeln widerrufbar). Verbindungstest in sechs Stufen mit gezielten Hinweisen, zum Beispiel für „localhost auf dem Handy“, „LAN aus/Firewall“ und „keine Benutzerkonten, bitte koppeln“. Dazu Versionsprüfung über die API-Hauptversion, Serverprofile und LAN-Erkennung (UDP 8751). Tests: `test/devices.test.ts`, `test/connect.test.ts`.

### 5.2 LIVE bricht Stream-Format und Ausgänge (Ursache für „Live senden geht nicht“)
`relay.ts` gibt beim Quellenwechsel den **Rohstrom** der neuen Quelle weiter. Hat sie ein anderes Format, werden die Ausgänge mit dem neuen `Content-Type` neu verbunden (Zeile 86). MIC LIVE aus Browser oder App sendet **WebM/Opus**, die Automation **MP3**. Folgen:
- Der Icecast-Mount wechselt mitten in der Sendung von MP3 zu WebM, und laufende Hörer-Player brechen ab.
- SHOUTcast kann kein WebM. laut.fm erwartet nach allen Unterlagen MP3. Ein Live-Wechsel dorthin kann so nicht funktionieren. *(Gegen echtes laut.fm nicht geprüft, die Testumgebung hat keinen Zugang.)*
- Externe Encoder (BUTT etc.) funktionieren nur, wenn sie zufällig dasselbe Format senden.

**Ziel:** Jede Quelle wird dekodiert und läuft durch denselben Mixer, dieselbe DSP und denselben Encoder. Nach außen gibt es ein festes Format pro Ausgang.

**Behoben (Schritt 4):** Sendebus mit Live-Kanälen. Test `test/live-bus.test.ts`: Ogg- und WebM-Live-Quellen werden gemischt, der Ausgang bleibt MP3 und wird nicht neu verbunden.

### 5.3 AUTO/MANUAL/LIVE ohne Mode-Manager
Reproduziert im Kern mit echtem ffmpeg (AUTO → LIVE → AUTO):
- Der Quellenwechsel funktioniert: Automation aktiv, dann Live aktiv und Automation in Bereitschaft, dann wieder Automation.
- **Während LIVE spielt die Automation im Hintergrund weiter.** Titel werden „verbraucht“ (im Test startete „Ton 550“ während der Live-Phase). Ihre Titelanzeigen gehen an die Ausgänge, obwohl Live auf Sendung ist.
- **MANUAL existiert im Kern nicht.** Es gibt keine API „diesen Titel jetzt auf Sendung“ und keine Pause der Automation. Die Deck-Knöpfe im Studio spielen lokal im Browser und nicht über den Sender, wenn der Kern sendet.
- Im Studio hat AUTO zwei Bedeutungen: Kern-Playout starten/stoppen, oder ohne ffmpeg die Browser-Automation. Der Knopf STREAM schickt die Browser-Mischung als Automation-Quelle. Beides konkurriert mit dem Kern-Playout um dieselbe Quelle.

**Behoben (Schritt 4):** Mode-Manager mit AUTO/MANUELL/LIVE/NOTFALL. Während LIVE und MANUELL verbraucht die Automation keine Titel (im Test geprüft). Neu: „Jetzt senden“ über den Kern.

### 5.4 ffmpeg-Erkennung einmalig und ohne Rückmeldung
Die Erkennung läuft nur beim Start, mit bis zu vier aufeinanderfolgenden Aufrufen und je 5 s Zeitlimit. In der Testumgebung hat sie **einmal unter Last fehlgeschlagen** („ffmpeg nicht gefunden“), bei drei Wiederholungen dann nicht. Danach bleibt die Automation bis zum Neustart „nicht unterstützt“, ohne Hinweis im Studio und ohne erneuten Versuch. Unter Windows kann der erste Start einer frisch entpackten `ffmpeg.exe` durch den Virenscanner länger dauern. *(Unter Windows nicht gemessen.)*

### 5.5 laut.fm
- Der Origin-Header ist ergänzt, wie von laut.fm beschrieben. Gegen die **echte** Radioadmin-API ist das **nicht verifiziert**, die Testumgebung blockiert `api.radioadmin.laut.fm`. Alle Tests laufen gegen Nachbauten der Spezifikation.
- Der Live-Ausgang nutzt ausschließlich **HTTP PUT** (Icecast ≥ 2.4). Ob der laut.fm-Live-Server PUT oder nur das ältere `SOURCE` annimmt, ist nicht belegt. Hier fehlt ein Rückfall auf `SOURCE`.
- Live mit Mikrofon scheitert zusätzlich am Formatproblem aus 5.2.

### 5.6 Android
Die App ist eine WebView-Hülle. MIC LIVE läuft nur bei geöffneter App im Vordergrund (kein Foreground-Service) und sendet WebM (5.2). Senden ohne AirDeck-Server ist nicht möglich. Streaming-Uploads aus der WebView funktionieren über HTTP/1.1 nicht, das braucht natives Netzwerk.

## 6. Technische Schulden

- **`app.ts` ist ein Gott-Objekt** (2 677 Zeilen). Fast jedes Fachgebiet steckt darin, was Tests, Austausch der Datenhaltung und Dienst-Trennung erschwert.
- **Zustand als eine JSON-Datei**, bei jeder Änderung komplett geschrieben. Das skaliert bei großen Bibliotheken schlecht. Keine Transaktionen, keine Abfragen, keine Migrationen.
- Zwei Automationen (Kern und Browser) und zwei Mischpfade (Kern-Mixer und Browser-Web-Audio).
- Die Version steht an mehreren Stellen fest („0.4.0“ in der Health-Route), Updates vergleichen Commit-Kennungen.
- Konfiguration liegt verteilt in `data/*.json`. Kein zentrales Konfigurationsmodell, kein Schema.
- Die Studio-Oberfläche ist über viele Bereiche gewachsen (Seitenleiste mit rund 20 Einträgen), Bedienung und Administration sind vermischt.

## 7. Notwendige Refactorings (Reihenfolge)

1. **Konfigurations- und Pfadmodell** mit Betriebsart, Datenverzeichnis, Medienverzeichnis, Log- und Konfigurationsverzeichnis. Plattform-Standards: Windows `%ProgramData%\AirDeck`, Linux `/etc/airdeck`, `/var/lib/airdeck`, `/var/log/airdeck`.
2. **Datenbankschicht** (`DatabaseProvider`, Repositories, Migrationen) mit SQLite als Standard. Die bestehenden JSON-Daten werden per Migration übernommen, nichts geht verloren.
3. **`app.ts` in Dienste aufteilen:** Stations, Media, Queue/Playout, Planning, Outputs, Integrations, Auth. Jeder Dienst bekommt ein Repository statt direktem JSON-Zugriff.
4. **Audio-Engine für alle Quellen:** Live- und Relay-Quellen werden dekodiert und in den Kern-Mixer eingespeist. Ausgänge bekommen ein festes Format.
5. **Mode-Manager** (AUTO / MANUAL / LIVE / EMERGENCY). Automation pausiert während LIVE und MANUAL, Metadaten richten sich nach der aktiven Quelle.
6. **Health- und Dependency-Manager** mit echter Health-API, erneuter ffmpeg-Prüfung und Anzeige.
7. **Serververbindung:** Erkennung (lokal und LAN), Verbindungstest in Schritten, Profile, Versionsprüfung, Kopplung per Code/QR. Auch Desktop-Installationen bekommen ein Admin-Konto.
8. **Dienste und Installer:** Windows-Dienst, Linux-Paket mit systemd, Docker-Compose mit PostgreSQL, Setup-Assistent.
9. Backup/Restore, Update mit Backup und Rollback.

## 8. Installationsprobleme

- Linux nativ verlangt Node und ffmpeg manuell. Es gibt weder Paket noch Dienst noch Setup.
- Windows installiert pro Benutzer. 24/7-Betrieb setzt eine Benutzer-Anmeldung voraus (kein Dienst). Daten liegen im Benutzerprofil.
- Kein Erststart-Assistent: Sender, Stream und Musik muss man sich im Studio zusammensuchen.
- Keine Wahl des Medienordners. Musik wird in das Datenverzeichnis kopiert.
- Keine Datenbankwahl im eigentlichen Sinn: Der Installer bietet „Sync“ an, was etwas anderes ist.
- README nennt Mindestanforderungen an Hardware nicht. Sie sind auch nicht gemessen und werden nicht erfunden, bevor Messungen vorliegen.

## 9. Datenbankprobleme

- Es gibt keine Datenbank, nur JSON-Dateien und eine Blob-Replikation.
- Keine Migrationen, keine Integritätsregeln, keine Abfragen über große Bibliotheken.
- Mehrbenutzerbetrieb auf dem Server schreibt denselben Gesamtzustand. Das geht nur, weil es ein einziger Prozess ist.
- **Machbarkeit:** SQLite ist in Node 22 eingebaut (`node:sqlite`, hier geprüft mit Node 22.22). Damit ist kein natives Zusatzmodul nötig, was für das Windows-Einzelprogramm wichtig ist. PostgreSQL braucht das Paket `pg` (reines JavaScript), MariaDB/MySQL nutzen das vorhandene `mysql2`. **Firebird:** Es gibt einen reinen JavaScript-Treiber (`node-firebird`), der aber nur sporadisch gepflegt wird. Gegenüber SQLite (lokal, eingebettet) und PostgreSQL (Server) bringt Firebird AirDeck keinen Vorteil. Firebird kommt deshalb vorerst **nicht** in den Lieferumfang und wird nicht vorgetäuscht. Wird es später gebraucht, entsteht ein eigener Provider mit eigenem Test gegen echtes Firebird.

## 10. Server-Probleme

- Health, Version und Kompatibilität sind nicht aussagekräftig.
- API, Automation und Auslieferung laufen in einem Prozess. Stürzt etwas ab, fällt alles aus. Es gibt keinen Überwachungsdienst.
- Keine HTTPS-Unterstützung im Programm. Für den Serverbetrieb sind Reverse-Proxy-Vorlagen (Caddy) nötig.
- Live-Ereignisse laufen über SSE statt WebSocket. SSE ist für Server-→-Client-Ereignisse ausreichend und wird **nicht** ohne Grund ersetzt. Die Ereignisnamen werden aber vereinheitlicht (`MODE_CHANGED` usw.).

## 11. Plattformprobleme

| Plattform | Problem |
|---|---|
| Windows | kein Dienst, Daten im Benutzerprofil, ohne Zertifikat SmartScreen-Warnung, Autostart nur nach Anmeldung |
| Linux | keine native Installation |
| Docker | nur ein Container mit JSON-Speicher. PostgreSQL ist im Compose-Setup noch nicht vorgesehen, weil die Datenbankschicht fehlt |
| Android | WebView-Hülle, kein natives Audio, kein Foreground-Service, kein Standalone-Live, WebM-Format |
| Alle | kein Setup-Assistent, keine Serverprofile, keine Versionsprüfung |

---

## Was bleibt (funktioniert und wird nicht verworfen)

Source Priority Engine, Queue/Sendeuhr/Rotation, Scheduler, PCM-Mixer, Server-Playout mit DSP und Lautheitsangleich, Icecast-/SHOUTcast-Ausgänge, Recorder, laut.fm-Radioadmin-Anbindung, KI-Schicht, Stream-Status und Widget, Bridge, Nextcloud, Benutzer und Rollen, Secret-Store, Updater-Grundlage, Windows-Build und CI. Diese Teile werden in die Zielarchitektur **umgehängt**, nicht neu geschrieben.
