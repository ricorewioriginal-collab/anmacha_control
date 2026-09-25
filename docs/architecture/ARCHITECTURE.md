# AirDeck – Zielarchitektur (verbindlich)

Grundlage: [AUDIT.md](AUDIT.md). Dieses Dokument legt fest, **wie** AirDeck aufgebaut ist. Code, der dem widerspricht, wird angepasst, nicht umgekehrt.
Details: [DEPLOYMENT](DEPLOYMENT.md) · [DATABASE](DATABASE.md) · [INSTALLATION](INSTALLATION.md) · [NETWORK](NETWORK.md) · [STORAGE](STORAGE.md) · [SECURITY](SECURITY.md) · [MULTI_PLATFORM](MULTI_PLATFORM.md)

## Antworten auf die Grundfragen

| Frage | Festlegung |
|---|---|
| Was ist **AirDeck Core**? | Der Sendekern als eigenständiger Prozess: Mode-Manager, Source Priority, Audio-Engine (Decoder, Mixer, DSP, Encoder), Ausgänge, Scheduler, Playlist/Queue, Cardwall, Metadaten, Stille-Wächter, Notfall, KI/TTS, Event-Bus, API. Läuft **ohne** Oberfläche |
| Was ist der **Server**? | Core plus Verwaltungsdienste: Auth, Benutzer, Sender, Medien, Datenbank, Speicher, Sync, Monitoring, Plugins, Widget-API. Technisch **derselbe Prozess** `airdeck-server`, der je nach Betriebsart mehr oder weniger Dienste aktiviert |
| Was ist der **Client**? | AirDeck Studio (Web-UI im Desktop-Fenster, Browser oder Android-App). Hat **keinen** eigenen Sendezustand und spricht ausschließlich über die API mit einem Server |
| Was läuft **lokal**? | Betriebsart Local: alles auf einem PC. Hybrid: Core und SQLite lokal, Verwaltung zusätzlich zentral |
| Was läuft **zentral**? | Betriebsart Self-Hosted: Server mit Datenbank und Medien. Der Core läuft dort, wenn der Sender vom Server senden soll (konfigurierbar pro Sender: `broadcastOn = server | client`) |
| Wer braucht eine **Datenbank**? | Jeder Server. Local: SQLite (eingebettet, nichts zu installieren). Self-Hosted: PostgreSQL empfohlen, SQLite/MariaDB/MySQL möglich |
| Wo liegen **Audiodateien**? | Im Medienverzeichnis (frei wählbar), **nie** in der Datenbank. Die Datenbank hält nur Metadaten und relative Pfade |
| Wo liegen **Logs/Konfiguration**? | Plattform-Standardpfade, siehe [STORAGE](STORAGE.md) |
| Wie funktioniert **Authentifizierung**? | Benutzerkonten auf **jedem** Server (auch lokal). Sitzungen für Menschen, gekoppelte Geräte-Tokens für Apps/Clients, API-Tokens mit Scopes für Integrationen. Siehe [SECURITY](SECURITY.md) |
| Wie kommunizieren **Client und Server**? | HTTPS/HTTP-REST `/api/v1`, Live-Ereignisse per SSE `/api/v1/events` (später zusätzlich WebSocket, wenn ein Client bidirektional braucht), Audio-Ingest Icecast-kompatibel |
| Was funktioniert **offline**? | Local komplett. Hybrid: Sendebetrieb, Bibliothek und Planung mit dem lokalen Stand, Änderungen werden nachsynchronisiert. Nur Online-Dienste (laut.fm, KI in der Cloud, Nextcloud) fallen aus |
| **Serverausfall** (Hybrid)? | Der lokale Core sendet weiter. Das Studio zeigt „Server nicht erreichbar – lokaler Betrieb“, der Sync holt nach |
| **Internetausfall**? | Der Core sendet weiter an lokale bzw. LAN-Ausgänge. Internet-Ausgänge verbinden sich mit Backoff neu. Die Sendeuhr läuft ohne KI weiter (KI-Rückfall) |
| **Datenbankausfall**? | Der Core behält den aktuellen Sendeplan und die Queue im Speicher und sendet weiter. Schreibende Verwaltungsaktionen werden abgelehnt (klare Meldung), die Health zeigt „database: error“, und der Core verbindet sich neu |
| Wie wird **aktualisiert**? | Semantische Version und API-Version. Vor jeder Datenbankmigration wird automatisch gesichert. Rollback über die Sicherung plus die vorherige Version |
| Wie wird **migriert**? | Nummerierte Migrationen pro Datenbank-Dialekt, beim Start oder über `airdeck migrate` |
| Wie wird **gesichert/wiederhergestellt**? | AirDeck-Sicherung (datenbankneutraler Export + Konfiguration, optional Medien), dazu ein Wiederherstellungs-Assistent. Siehe [STORAGE](STORAGE.md) |

## 1. Bausteine

```
                       ┌────────────────────────── airdeck-server ──────────────────────────┐
                       │  API-Schicht  (REST /api/v1 · SSE /events · Ingest · Status/Widget)│
 Studio (Desktop/Web) ─┤  Auth · RBAC · Geräte-Kopplung · Rate-Limit · Audit                 │
 Android-App ──────────┤  Verwaltung: Sender · Benutzer · Medien · Planung · Integrationen    │
 Integrationen ────────┤  Event-Bus (intern) ──────────────────────────────────────────────  │
                       │  CORE: Mode-Manager · Source Priority · Scheduler · Playlist/Queue  │
                       │        Audio-Engine (Decoder → Mixer → DSP → Encoder) · Ausgänge     │
                       │        Metadaten · Stille-Wächter · Notfall · KI/TTS                 │
                       │  Speicher-Schicht (Medien)      Datenbank-Schicht (Provider)         │
                       │  Dependency-Manager (ffmpeg, Datenbank, KI-Laufzeit) · Health        │
                       └──────────────────────────────────┬──────────────────────────────────┘
                                                          │
                              SQLite | PostgreSQL | MariaDB | MySQL        Medienverzeichnis
```

Regeln:
- Der Core kennt keine Oberfläche und keine SQL-Dialekte. Er arbeitet mit Repositories.
- Die Oberfläche hat **keinen** Sendepfad. Die bisherige Browser-Automation entfällt, Web-Audio bleibt nur fürs Vorhören.
- Jede Funktion liegt in einem Dienstmodul (`stations`, `media`, `playout`, `planning`, `outputs`, `integrations`, `auth`, `system`) statt im Sammelobjekt `app.ts`.

## 2. Betriebsarten

```
A) LOCAL                         B) SELF-HOSTED                    C) HYBRID
┌─────────── PC ───────────┐     ┌────────── Server ──────────┐     ┌──── PC ────┐        ┌── Server ──┐
│ Studio ─► airdeck-server │     │ airdeck-server (+Core)     │     │ Studio      │        │ airdeck-   │
│           Core + SQLite  │     │ PostgreSQL · Medien        │     │ airdeck-    │◄─Sync─►│ server     │
│           Medien lokal   │     │ Caddy (HTTPS)              │     │ server+Core │        │ PostgreSQL │
└──────────┬───────────────┘     └──────────┬─────────────────┘     │ SQLite      │        │ Medien     │
           ▼                                ▼                        └─────┬──────┘        └────────────┘
   Icecast / SHOUTcast / laut.fm    Icecast / SHOUTcast / laut.fm          ▼ sendet lokal weiter, auch offline
```

Die Betriebsart wird im Setup-Assistenten gewählt und steht in `airdeck.conf` (`mode = local | server | hybrid`).

## 3. Audiopfad (für **alle** Quellen)

```
Automation (Titel)  ─ffmpeg-Decoder─┐
Carts/Jingles       ─ffmpeg-Decoder─┤
Live-Encoder/Relay  ─ffmpeg-Decoder─┤──► PCM-Bus 44,1 kHz ─► Mixer (Priorität, Ducking,  ─► DSP ─► Encoder je
Mikrofon (Studio/App)─ffmpeg-Decoder┘      Stereo 16 bit          Überblendung, Mode)            Format ─► Ausgänge
```

- Neu gegenüber heute: Live- und Relay-Quellen werden **dekodiert** und laufen durch denselben Mixer. Nach außen hat jeder Ausgang ein **festes Format**, Quellenwechsel ändern es nie (behebt AUDIT 5.2).
- Die Source Priority Engine entscheidet weiterhin, welche Quelle hörbar ist. Der Mixer blendet über (Übergangszeit konfigurierbar) statt hart umzuschalten.
- Gerätebezogenes Audio (Mithören, CUE, Mikrofon am PC) gehört zum **Client**, siehe [MULTI_PLATFORM](MULTI_PLATFORM.md) (Windows-Dienste haben keinen Zugriff auf die Soundkarte des Benutzers).

## 4. Mode-Manager

```
            ┌──────── Live-Quelle verbindet (Priorität) ────────┐
            ▼                                                   │
 AUTO ◄──────────── LIVE ──── Live-Quelle endet ───────────────►│ zurück in den vorherigen Modus
  │  ▲                                                           │
  │  └── „Weiter Automation“ ◄── MANUAL ◄── „Manuell übernehmen“─┘
  │
  └── keine Quelle / Stille ──► EMERGENCY (Notfall-Ordner) ── Quelle wieder da ──► vorheriger Modus
```

| Modus | Automation | Wer bestimmt den Ton | Metadaten |
|---|---|---|---|
| AUTO | spielt Queue, Sendeuhr, Sendeplan | Core | vom laufenden Titel |
| MANUAL | **pausiert** (Position bleibt) | Operator: Titel/Carts „jetzt senden“, Decks steuern den Core | vom manuell gestarteten Titel |
| LIVE | **pausiert**, optional Musikbett | Live-Quelle | Live-Titel (z. B. „Live: Sendungsname“) oder vom Encoder |
| EMERGENCY | Notfall-Ordner | Core | Notfall-Titel, Alarm |

Jeder Wechsel löst `MODE_CHANGED` aus und landet im Audit-Log. Die Automation verbraucht während LIVE und MANUAL keine Titel mehr (behebt AUDIT 5.3).

## 5. Sendepfad (Broadcast)

```
Encoder (MP3/AAC/Opus) ─► Ausgang Icecast (PUT, Rückfall SOURCE) ─► Hörer
                       ─► Ausgang SHOUTcast v1/v2
                       ─► Ausgang laut.fm (Zugang aus Radioadmin, ?prio=)
                       ─► optional Liquidsoap-Harbor
                       ─► Recorder
```

Jeder Ausgang hat einen eigenen Zustand (verbunden, verbindet, Fehler mit Kategorie), eine Wiederverbindung mit Backoff und einen Health-Eintrag.

## 6. KI-Pfad

```
Mode-Manager/Scheduler ─► AI Director ─► Text-Provider (Cloud-Key oder lokal: Ollama/LM Studio)
                                      ─► TTS-Provider (lokal: Piper [mitlieferbar], Kokoro; Cloud optional)
                                      ─► Sprachdatei ─► Medien ─► Queue (oder Freigabe)
Fehler/Budget ─► Rückfall: Sendeuhr läuft ohne KI weiter
```

Lokale KI ist eine **optionale Komponente** des Installers (Piper und deutsche Stimmen, klein). Große Sprachmodelle laufen über Ollama, AirDeck erkennt sie und hilft bei der Einrichtung. Sie werden nicht still mitgeliefert, weil sie Gigabytes groß sind.

## 7. Authentifizierung

```
Mensch ──Benutzer/Passwort──► Sitzung (12 h, gleitend)            ┐
App/Studio-Gerät ──Kopplung (Code/QR)──► Geräte-Token (widerrufbar) ├─► Principal { Rollen, Sender, Scopes } ─► RBAC
Integration ──API-Token──► Scopes                                    ┘
Lokales Desktop-Studio ──Maschinen-Token (nur 127.0.0.1)──► angemeldeter Admin
```

## 8. Ereignisse

SSE `/api/v1/events` mit einheitlichen Namen:
- `MODE_CHANGED`, `SOURCE_CHANGED`, `TRACK_STARTED`, `TRACK_STOPPED`, `QUEUE_CHANGED`, `NOW_PLAYING_CHANGED`
- `SERVER_STATUS_CHANGED`, `STREAM_STATUS_CHANGED`, `ENCODER_STATUS_CHANGED`, `AI_STATUS_CHANGED`, `DATABASE_STATUS_CHANGED`, `STORAGE_STATUS_CHANGED`

Die bisherigen Namen (`playout.state` usw.) bleiben eine Version lang als Alias erhalten.

## 9. Umbau-Reihenfolge (verbindlich)

1. Konfigurations- und Pfadmodell, Betriebsart, Health-/Dependency-Manager
2. Datenbankschicht mit SQLite und Migration der JSON-Daten, dann PostgreSQL, MariaDB/MySQL, CI-Matrix
3. Aufteilung von `app.ts` in Dienstmodule auf Repositories
4. Audio-Engine für alle Quellen und Mode-Manager (AUTO/MANUAL/LIVE/EMERGENCY)
5. Serververbindung: Erkennung, Verbindungstest, Profile, Versionsprüfung, Kopplung, Admin-Konto auch lokal
6. Setup-Assistent (erster Start)
7. Windows-Dienst und Installer, Linux-Paket mit systemd, Docker mit PostgreSQL
8. laut.fm gegen echtes System prüfen (PUT/SOURCE), Android nativ (Foreground-Service, Kopplung, Live)
9. Lokale KI, Sync (Hybrid), Backup/Restore, Update mit Rollback, Installationstests
