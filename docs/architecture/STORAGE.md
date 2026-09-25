# Speicher, Pfade, Sicherung

## Verzeichnisse

| Zweck | Windows (Dienst/alle Benutzer) | Windows (portable) | Linux (Paket) | Docker |
|---|---|---|---|---|
| Programm | `C:\Program Files\AirDeck` | Ordner der ZIP | `/opt/airdeck` | Image |
| Konfiguration | `%ProgramData%\AirDeck\config` | `.\data\config` | `/etc/airdeck` | `/data/config` |
| Daten (SQLite, Secrets, Cache) | `%ProgramData%\AirDeck\data` | `.\data` | `/var/lib/airdeck` | `/data` |
| Medien (frei wählbar) | Standard `C:\AirDeck\Media` | `.\media` | `/var/lib/airdeck/media` | Volume `/media` |
| Logs | `%ProgramData%\AirDeck\logs` | `.\data\logs` | `/var/log/airdeck` | stdout und `/data/logs` |
| Sicherungen | `%ProgramData%\AirDeck\backups` | `.\data\backups` | `/var/lib/airdeck/backups` | `/data/backups` |

Alle Pfade stehen in `airdeck.conf` (Konfigurationsverzeichnis) und lassen sich im Setup-Assistenten ändern. Die bisherige Ablage unter `%LOCALAPPDATA%\AirDeck\data` wird beim ersten Start der neuen Version erkannt und übernommen.

## Medienverzeichnis

```
Media/
├── music/        ├── jingles/     ├── voice/        (Voicetracks, KI-Sprache)
├── beds/         ├── effects/     ├── recordings/   (Mitschnitte)
└── <eigene Ordner> – werden als Bibliotheksordner angezeigt
```

- **Audiodateien liegen nie in der Datenbank.** Dort stehen nur Metadaten und der Pfad relativ zum Medienverzeichnis. So lassen sich Medien verschieben, ohne die Datenbank anzufassen.
- **Ordner einbinden statt kopieren** (umgesetzt): Vorhandene Musikordner werden indiziert, jede Minute abgeglichen (neue Dateien kommen dazu, gelöschte verschwinden) und nie kopiert oder gelöscht. Unterordner werden zu Bibliotheksordnern, Interpret und Titel kommen aus dem Dateinamen bzw. den Tags. API: `GET/POST/DELETE /api/v1/stations/<sender>/folders/linked`. Hochgeladene Dateien landen weiter im Medienordner.
- Mögliche Medienquellen: lokal, Netzlaufwerk (SMB/NFS über das Betriebssystem), Nextcloud (WebDAV-Import, vorhanden). S3 folgt später als Sicherungsziel, nicht als Abspielquelle.

## Sicherung

Inhalt einer Sicherung (`airdeck-backup-<datum>.tar.gz`):

| Teil | Immer | Optional |
|---|---|---|
| Datenbank als **datenbankneutraler Export** (JSON-Lines je Tabelle, mit Schema-Version) | ✔ | |
| Konfiguration, Secrets (verschlüsselt, nur mit Schlüssel verwendbar) | ✔ | |
| Sender, Playlists, Pläne, Benutzer, Widgets, KI-Einstellungen, Metadaten | ✔ (in der Datenbank) | |
| Mediendateien | | ✔ |

- Der neutrale Export erlaubt das Wiederherstellen in eine **andere** Datenbank, etwa von SQLite nach PostgreSQL beim Umzug auf einen Server.
- **Ziele:** lokaler Ordner, externes Laufwerk, WebDAV/Nextcloud. S3 kommt in einer späteren Ausbaustufe.
- **Automatisch** vor jeder Migration und jedem Update, außerdem nach Zeitplan (Standard täglich, 7 Stück werden aufbewahrt).

## Wiederherstellung (Assistent)

Sicherung wählen → prüfen (Prüfsumme, Schema-Version, Vollständigkeit) → Ziel-Datenbank → wiederherstellen → betroffene Dienste neu starten → prüfen (Health, Sender, Zählwerte).
