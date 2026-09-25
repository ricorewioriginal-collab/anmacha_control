# Bereitstellung

## Laufzeit

**Endanwender installieren nie selbst Node.js, npm oder ffmpeg.**

| Paket | Laufzeit | ffmpeg |
|---|---|---|
| Windows (Installer/portable) | Node als Einzelprogramm eingebettet (`AirDeck.exe`, heute schon so) | mitgeliefert (inkl. LAME/Opus), wahlweise System oder eigener Pfad |
| Linux (`.deb`) | Node als Einzelprogramm eingebettet (SEA, wie Windows), `/opt/airdeck/airdeck-server` | System-ffmpeg (`Recommends: ffmpeg`), Automation läuft ohne ffmpeg nicht |
| Docker | im Image | im Image |
| Entwicklung | Node ≥ 22.18 aus dem System | System-ffmpeg |

Der **Dependency-Manager** meldet für Laufzeit, ffmpeg, Datenbank, Audio-Backend, KI-Laufzeit und TTS jeweils einen Zustand: `READY`, `MISSING`, `OUTDATED` oder `BROKEN`. Dazu kommen Version und Quelle (mitgeliefert/System/eigener Pfad). Eine fehlgeschlagene ffmpeg-Prüfung wird automatisch wiederholt und fällt auf die mitgelieferte Version zurück (behebt AUDIT 5.4).

## Prozesse und Dienste

| Plattform | Dienst | Start | Neustart |
|---|---|---|---|
| Windows | `AirDeck Server` (Windows-Dienst) | automatisch, auch ohne Anmeldung | bei Fehler (Dienst-Wiederherstellung) |
| Windows (Einfach-Modus) | Hintergrundprozess mit Tray, wie heute | bei Anmeldung | über den Tray |
| Linux | `airdeck-server.service` (systemd, eigener Benutzer `airdeck`) | automatisch (`apt install`/`dpkg -i` aktiviert und startet ihn) | `Restart=on-failure` + `RestartForceExitStatus=75` (Neustart aus dem Programm) |
| Docker | Container `airdeck` | `restart: unless-stopped` | Docker |

Nach einem Rechnerneustart wird der vorherige Zustand wiederhergestellt: Modus, Queue-Position, laufende Automation, Ausgänge verbinden neu, Encoder startet neu. Das ist heute schon für die Automation umgesetzt und wird auf den Mode-Manager übertragen.

## Docker

```yaml
services:
  airdeck:   { image: airdeck, ports: ["8750:8750"], volumes: [data:/data, media:/media], depends_on: [postgres] }
  postgres:  { image: postgres:17, volumes: [pg:/var/lib/postgresql/data] }
  # optional: caddy (HTTPS) – Profil "https"
```

- **Minimal:** `airdeck` plus `postgres`, alternativ `airdeck` allein mit SQLite.
- **Redis wird nicht verwendet.** AirDeck braucht ihn nicht, und unnötige Dienste kommen nicht dazu.
- Caddy ist ein optionales Profil für automatisches HTTPS.

## Updates

- Version nach SemVer (`1.4.2`) plus API-Version (`1.x`). Der Server meldet beides in der Health-Route, der Client prüft die Kompatibilität (siehe [NETWORK](NETWORK.md)).
- Ablauf: prüfen → Sicherung → Paket installieren → Migration → Health prüfen. Schlägt die Health-Prüfung fehl, wird zurückgerollt: vorherige Version und Wiederherstellung der Sicherung.
- Windows: Setup im Update-Modus (vorhanden, wird um Sicherung und Rollback ergänzt). Linux: Paket-Update bzw. neues Tarball. Docker: neues Image.
