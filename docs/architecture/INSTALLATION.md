# Installation und Setup-Assistent

Ziel: **Download → Installieren → Setup → Sender → Musik → Stream → AUTO**, ohne Kommandozeile und ohne manuell installierte Abhängigkeiten.

## Windows-Installer (`AirDeck-Setup.exe`)

Komponenten:

| Komponente | Standard |
|---|---|
| AirDeck Studio (Oberfläche) | ✔ fest |
| AirDeck Server (Core, API, Datenbank SQLite) | ✔ fest |
| Audio-Engine ffmpeg (LAME/AAC/Opus) | ✔ |
| Als Windows-Dienst einrichten (24/7 ohne Anmeldung) | ✔ bei „Für alle Benutzer“ |
| Lokale KI-Stimme (Piper, deutsche Stimmen) | ☐ |
| Android-APK zum Verteilen | ✔ |
| Startmenü, Desktop, Start mit Windows | ✔ |

Datenbank im Installer:
- **SQLite:** Standard, nichts weiter zu tun.
- **Vorhandenes PostgreSQL / MariaDB / MySQL:** Verbindungsdaten eingeben, der Installer testet die Verbindung.
- **PostgreSQL automatisch installieren:** Der Installer lädt das offizielle Setup, installiert es still als Dienst und legt Datenbank und Benutzer an. Das geht nur mit Adminrechten und nur nach ausdrücklicher Auswahl. Eine vorhandene Installation wird erkannt und nicht doppelt installiert.

Geprüft wird: Adminrechte (für den Dienst), freier Port, Schreibrechte der Pfade, vorhandene frühere Installation (Übernahme der Daten), Laufzeitbibliotheken. Die eingebettete Node-Laufzeit braucht **keine** zusätzliche VC++-Runtime, das mitgelieferte ffmpeg ebenfalls nicht (statisch gebaut). Das wird beim Installer-Test auf einem frischen Windows geprüft.

## Linux

```bash
# Debian/Ubuntu
sudo apt install ./airdeck-server_<version>_amd64.deb   # Laufzeit + ffmpeg enthalten, legt Dienst und Benutzer an
sudo airdeck setup                                     # oder im Browser: http://<server>:8750/setup
```

Ohne Paket: `airdeck-server-<version>-linux-x64.tar.gz` entpacken, dann `sudo ./install.sh`. Das Skript legt Benutzer, Pfade und systemd-Dienst an.

## Docker

`docker compose up -d`. Beim ersten Aufruf von `http://<server>:8750` öffnet sich der Setup-Assistent.

## Setup-Assistent (erster Start, im Studio)

1. **Willkommen** (Sprache, Haftungsausschluss)
2. **Betriebsart:** Local · Self-Hosted · Erweitert
3. **Datenbank:** SQLite · PostgreSQL · MariaDB · MySQL (mit Verbindungstest)
4. **Speicher:** Medienverzeichnis, vorhandene Musikordner einbinden
5. **Admin-Konto:** Benutzername, Passwort
6. **Netzwerk:** Port, nur dieser PC / im LAN / Internet (HTTPS mit Domain und E-Mail über Caddy)
7. **Sender:** Name, Logo, Zeitzone
8. **Stream:** Icecast / SHOUTcast / laut.fm (mit Verbindungstest) oder später
9. **Audio:** Mithör- und CUE-Gerät, Mikrofon (am Client)
10. **Automation:** Sendeuhr-Vorlage, Notfall-Ordner, Autostart
11. **KI (optional):** keine / lokal (Piper, Ollama erkennen) / Cloud-Keys
12. **Fertig:** Zusammenfassung → „Automation starten“

Jeder Schritt lässt sich überspringen und später unter **Administration** ändern. Konfigurationsdateien muss niemand bearbeiten.

**Stand der Umsetzung** (`src/server/services/setup.ts`, `studio/js/setup.js`):
- Der Assistent öffnet sich beim ersten Start automatisch für die Administration. Bestehende Installationen mit Titeln, Ausgängen oder Konten bleiben unberührt. Erneut starten geht über „Einrichtung (Assistent)“ im Menü.
- Betriebsart, Datenbank, Netzwerk und Medienordner werden in `airdeck.conf` geschrieben, Kommentare bleiben erhalten. Sie gelten nach einem Neustart, den der Assistent selbst auslöst. Unter Docker/systemd beendet sich AirDeck dafür mit Code 75 und der Dienst-Manager startet neu.
- Datenbank-Wechsel: Die Verbindung wird getestet, der bisherige Stand in die neue Datenbank übernommen und das Passwort verschlüsselt im Secret-Store abgelegt (nicht in der Datei).
- Speicher: **Vorhandene Musikordner einbinden**. Die Titel bleiben, wo sie sind. AirDeck indiziert sie, gleicht jede Minute ab und löscht nie eine Originaldatei. Ein nicht erreichbares Laufwerk entfernt nichts aus der Bibliothek.
- KI lokal: Ollama wird unter `http://127.0.0.1:11434` gesucht und als Text-Anbieter eingetragen.
- Noch nicht im Assistenten: PostgreSQL automatisch installieren (kommt mit dem Windows-Installer, Schritt 7), Logo, Zeitzone, Sendeuhr-Vorlage und die Stream-Verbindungsprüfung (ein Ausgang zeigt seinen Zustand direkt im Studio).

## Systemanforderungen

Mindestwerte für Hardware werden erst veröffentlicht, wenn sie gemessen sind. Die Messung ist Teil der Installationstests. Bekannte Messwerte bisher:
- Core im Leerlauf mit laufender Automation: etwa 105–112 MB RAM und 2–4 % CPU.
- Pro Encoder zusätzlich etwa 50 MB.

Unterstützt werden:
- Windows 10/11 64 bit
- Debian 12 und Ubuntu 22.04/24.04 (x64)
- Docker (x64, arm64 geplant)
- Android ab Version 8
