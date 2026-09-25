# AirDeck installieren und testen

AirDeck läuft **komplett lokal** auf deinem PC. Du brauchst keinen eigenen Server, kein PHP und keine Datenbank.
Intern startet AirDeck einen kleinen Dienst, den nur dieser PC erreicht (`127.0.0.1:8750`), und öffnet das Studio als App-Fenster.

## Download

**Nach dem Mergen auf den Hauptbranch:** GitHub → *Releases* → **„AirDeck – aktueller Stand“**. Dort liegen:

| Datei | Wofür |
|---|---|
| `AirDeck-Setup.exe` | Windows-Installer |
| `AirDeck-Windows-Portable.zip` | Windows **ohne Installation** |
| `AirDeck-Android.apk` | Android-App |
| `AirDeck-Linux.deb` | Linux-Server (Debian/Ubuntu, systemd) |

**Vorher (Test aus dem Pull Request):** GitHub → *Actions* → Workflow **Build** → neuester grüner Lauf → unten unter *Artifacts*:
`AirDeck-Windows-Installer`, `AirDeck-Windows` (portable), `AirDeck-Android` und `AirDeck-Linux-Deb`. Die Artefakte sind ZIP-Dateien und müssen erst entpackt werden.

## Windows

### A) Mit Installer
1. `AirDeck-Setup.exe` starten und die Sprache wählen (Deutsch/English).
2. Den **Haftungsausschluss** lesen und annehmen. AirDeck ist ein Hobbyprojekt.
3. **Installationsart** wählen:
   - **Vollständig:** Studio, Server, Audio-Engine ffmpeg (LAME/AAC/Opus) und Android-APK zum Verteilen.
   - **Nur Studio:** als Fernbedienung, ohne Audio-Engine.
   - **Benutzerdefiniert.**
   Im ersten Dialog wählst du außerdem „nur für mich“ (ohne Adminrechte) oder „für alle Benutzer“. Nur bei „für alle Benutzer“ trägt der Installer die Firewall-Freigabe selbst ein.
4. Optionen: Desktop-Verknüpfung, **im Hintergrund bei der Anmeldung starten (24/7)**, **im Netzwerk erreichbar** (für die Android-App).
5. Datenspeicher wählen (siehe unten). Danach startet AirDeck. Das Handbuch lässt sich direkt öffnen.

**AirDeck läuft ohne Konsolenfenster im Hintergrund.** Im Infobereich der Taskleiste (neben der Uhr) sitzt das AirDeck-Symbol mit den Einträgen **Studio öffnen**, **Protokoll anzeigen** und **AirDeck beenden**. Beenden geht auch über das Startmenü („AirDeck beenden“) oder im Studio über „AirDeck beenden“. Das Protokoll liegt unter `%LOCALAPPDATA%\AirDeck\data\logs\airdeck.log`.

Deinstallieren geht über *Einstellungen → Apps*. Deine Daten bleiben erhalten.

#### Warnung von Windows (SmartScreen)
Windows warnt bei Programmen, die nicht mit einem gekauften Code-Signing-Zertifikat signiert sind, und bei Downloads, die noch wenige Nutzer haben. Für ein Hobbyprojekt ohne Zertifikat lässt sich das nicht abschalten. Klicke auf **„Weitere Informationen“ → „Trotzdem ausführen“**.
Die Build-Pipeline signiert AirDeck.exe und das Setup automatisch, sobald ein Zertifikat hinterlegt ist: GitHub-Secrets `WINDOWS_CERT_PFX_B64` (PFX als Base64) und `WINDOWS_CERT_PASSWORD`. Günstige Wege dazu sind Microsoft *Trusted Signing* (Azure) oder ein Open-Source-Zertifikat, zum Beispiel von Certum.

### Datenspeicher (im Installer oder später unter „Datenspeicher & Sync“)
- **Nur lokal** (Standard): keine Einrichtung, läuft offline.
- **MySQL / MariaDB**: Server, Port, Benutzer, Passwort und Datenbank eintragen. Die Datenbank muss existieren, die Tabelle legt AirDeck selbst an.
- **Firebase (Cloud Firestore)**: Service-Account-Schlüssel (JSON) auswählen.

Synchronisiert werden Sender, Quellen, Ausgänge, Bibliothek (Metadaten), Playlists und Planung, damit mehrere Standorte denselben Stand haben.
Musikdateien werden **nicht** übertragen; sie müssen auf jedem Standort vorhanden sein. Die Nextcloud-Brücke hilft dabei.
Ist die Datenbank nicht erreichbar, startet AirDeck trotzdem lokal und zeigt den Fehler unter „Datenspeicher & Sync“.
Ändern beide Seiten gleichzeitig, gewinnt der lokale Stand. Der andere Stand wird als `airdeck.remote-conflict-….json` gesichert.

### B) Ohne Installation (portable)
1. `AirDeck-Windows-Portable.zip` entpacken, z. B. nach `D:\AirDeck`.
2. `AirDeck.exe` doppelklicken. AirDeck öffnet sein eigenes Fenster und startet die Audio-Engine (`airdeck-engine.exe`). Schließt du das Fenster, laufen Automation und Streams im Hintergrund weiter (Symbol im Infobereich). Beenden über das Symbol.
3. `AirDeck-Headless.cmd` startet nur die Engine, ohne Fenster (24/7 auf einem Sende-PC).

In beiden Fällen liegen Musik, Einstellungen und die verschlüsselten Passwörter unter `%LOCALAPPDATA%\AirDeck\data`.
Soll alles im Programmordner bleiben (z. B. USB-Stick), vorher `set AIRDECK_DATA=.\data` setzen.

### Erster Test (5 Minuten)
1. Unter **Playlist / Archiv → „＋ Ordner“** einen Musikordner hochladen oder Dateien einfach ins Fenster ziehen.
2. **Server-Automation 24/7 → Start** (oder **AUTO**). Mit 🎧 hörst du mit, das Ausgabegerät legst du unter **Audio & Geräte** fest.
3. Für den Sendebetrieb unter **Stream & Encoder → ＋** Icecast, SHOUTcast oder laut.fm eintragen.

## Server (Docker)

Siehe [DOCKER.md](DOCKER.md): `docker compose up -d`. Das Admin-Token steht im Log.

## Server (Linux, systemd)

Für einen eigenen Linux-Server ohne Docker: `AirDeck-Linux.deb` herunterladen und installieren.

```sh
sudo apt install ./AirDeck-Linux.deb   # oder: sudo dpkg -i AirDeck-Linux.deb
```

Das Paket richtet einen eigenen Systembenutzer `airdeck` ein und startet den Dienst `airdeck-server` sofort
(automatisch bei jedem Systemstart). Das Einmal-Passwort bzw. Admin-Token steht im Protokoll:

```sh
sudo journalctl -u airdeck-server -n 50
```

Konfiguration unter `/etc/airdeck/airdeck.conf`, Daten (Musik, Datenbank, verschlüsselte Passwörter) unter
`/var/lib/airdeck`, Protokoll unter `/var/log/airdeck`. Ohne installiertes `ffmpeg` läuft der Dienst weiter,
nur ohne 24/7-Automation/Encoder – `sudo apt install ffmpeg` und `sudo systemctl restart airdeck-server` reicht nach.
Standardmäßig ist AirDeck nur von diesem Server aus erreichbar (`127.0.0.1`); Netzwerkfreigabe wie bei den anderen
Plattformen über den Setup-Assistenten im Studio oder `bind = lan` in `airdeck.conf`.

```sh
sudo systemctl status airdeck-server     # Zustand
sudo systemctl restart airdeck-server    # Neu starten
sudo apt remove airdeck                  # Entfernen (Daten bleiben erhalten)
sudo apt purge airdeck                   # Entfernen inkl. Konfiguration (Daten bleiben trotzdem erhalten)
```

## Android

Die App ist das komplette Studio für Touch-Bedienung, MIC LIVE (das Handy sendet als Live-Quelle mit Priorität 3) und Mithören. Die Automation läuft auf dem PC bzw. Server.

1. **Am PC:** Im Studio **Android-App** öffnen → „Im Netzwerk erreichbar“ einschalten. Das geht auch schon im Installer. AirDeck einmal neu starten und die Windows-Firewall-Abfrage für **private Netzwerke** erlauben.
2. **Am Handy (gleiches WLAN):** den angezeigten Link `http://<PC-Adresse>:8750/download/AirDeck-Android.apk` im Browser öffnen, installieren und „Unbekannte Apps installieren“ erlauben.
3. Im Studio am PC **Android-App → „Gerät koppeln“** wählen. In der App bei „Mit AirDeck verbinden“ die angezeigte Adresse und den **Kopplungscode** eingeben (6 Ziffern, 5 Minuten gültig, einmalig). Ein Benutzerkonto ist nicht nötig. Gekoppelte Geräte lassen sich dort einzeln widerrufen.

Die offizielle APK ist signiert, sobald im Repository der Android-Signaturschlüssel hinterlegt ist. Die Secrets dafür: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Einen Schlüssel erzeugst du einmalig mit:
`keytool -genkeypair -v -keystore airdeck.jks -alias airdeck -keyalg RSA -keysize 4096 -validity 36500`
Danach `base64 -w0 airdeck.jks` als `ANDROID_KEYSTORE_B64` eintragen. Den Schlüssel gut aufbewahren, denn nur mit ihm lassen sich Updates über die installierte App spielen.

## Updates

Unter **Updates** in der Seitenleiste zeigt AirDeck die installierte und die neueste Version. Ein roter Hinweis „neu“ erscheint, sobald ein Update bereitsteht. Geprüft wird beim Start und danach alle 6 Stunden. Das lässt sich im Dialog abschalten.

- **Windows (installiert):** „Jetzt installieren“ lädt das Setup und prüft die SHA-256-Prüfsumme. Danach wird AirDeck beendet, still aktualisiert und neu gestartet. Daten und Einstellungen bleiben erhalten. Die laufende Sendung wird dabei kurz unterbrochen.
- **Windows (portable) / Server:** Das Update wird angezeigt, aber manuell eingespielt (ZIP entpacken bzw. Paket ersetzen).
- **Android:** „Neue APK laden & installieren“ lädt die APK über den verbundenen AirDeck-Server. Danach die Installation bestätigen. Beim ersten Mal muss „Unbekannte Apps installieren“ erlaubt werden.
- **Privates Repository:** Im Dialog ein GitHub-Token mit reinem Lesezugriff („Contents: Read“) hinterlegen. Es wird verschlüsselt gespeichert und verlässt den Server nie.
- **Eigene Update-Adresse:** Alternativ eine https-URL zu einer JSON-Datei `{ "build": "<commit>", "publishedAt": "…", "assets": { "setup": { "url", "size", "sha256" }, "portable": {…}, "apk": {…} } }`.

API: `GET /api/v1/update`, `GET|PUT /api/v1/update/settings`, `POST /api/v1/update/install` (Admin), `GET /api/v1/update/apk`.

## Häufige Fragen

- **„Windows hat den PC geschützt“** – das liegt an der fehlenden Code-Signatur. Ein Signaturzertifikat kann später ergänzt werden.
- **Kein Ton in der Server-Automation am PC** – im Menü **⋯** „Programm über die Lautsprecher dieses PCs mithören“ aktivieren.
- **Port belegt** – eine andere Portnummer setzen: `set AIRDECK_PORT=8760`.
