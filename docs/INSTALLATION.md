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

**Vorher (Test aus dem Pull Request):** GitHub → *Actions* → Workflow **Build** → neuester grüner Lauf → unten unter *Artifacts*:
`AirDeck-Windows-Installer`, `AirDeck-Windows` (portable) und `AirDeck-Android`. Die Artefakte sind ZIP-Dateien und müssen erst entpackt werden.

## Windows

### A) Mit Installer
1. `AirDeck-Setup.exe` starten. Windows SmartScreen meldet sich, weil die Datei noch nicht signiert ist: **„Weitere Informationen“ → „Trotzdem ausführen“**.
2. Optionen wählen: Desktop-Verknüpfung, ggf. **Autostart (24/7)**.
3. Nach der Installation startet AirDeck und öffnet das Studio-Fenster. Eine Anmeldung ist nicht nötig.

Deinstallieren geht über *Einstellungen → Apps*. Deine Daten bleiben erhalten.

### Datenspeicher (im Installer oder später unter „Datenspeicher & Sync“)
- **Nur lokal** (Standard): keine Einrichtung, läuft offline.
- **MySQL / MariaDB**: Server, Port, Benutzer, Passwort und Datenbank eintragen. Die Datenbank muss existieren, die Tabelle legt AirDeck selbst an.
- **Firebase (Cloud Firestore)**: Service-Account-Schlüssel (JSON) auswählen.

Synchronisiert werden Sender, Quellen, Ausgänge, Bibliothek (Metadaten), Playlists und Planung, damit mehrere Standorte denselben Stand haben.
Musikdateien werden **nicht** übertragen; sie müssen auf jedem Standort vorhanden sein.
Ist die Datenbank nicht erreichbar, startet AirDeck trotzdem lokal und zeigt den Fehler unter „Datenspeicher & Sync“.
Ändern beide Seiten gleichzeitig, gewinnt der lokale Stand. Der andere Stand wird als `airdeck.remote-conflict-….json` gesichert.

### B) Ohne Installation (portable)
1. `AirDeck-Windows-Portable.zip` entpacken, z. B. nach `D:\AirDeck`.
2. `AirDeck.exe` doppelklicken. Das Studio öffnet sich.
3. `AirDeck-Headless.cmd` startet AirDeck nur im Hintergrund (24/7 ohne Fenster).

In beiden Fällen liegen Musik, Einstellungen und die verschlüsselten Passwörter unter `%LOCALAPPDATA%\AirDeck\data`.
Soll alles im Programmordner bleiben (z. B. USB-Stick), vorher `set AIRDECK_DATA=.\data` setzen.

### Erster Test (5 Minuten)
1. Unter **Playlist / Archiv → „＋ Ordner“** einen Musikordner hochladen.
2. **AUTO** drücken. Die Browser-Automation spielt jetzt über die PC-Lautsprecher.
3. Für den Sendebetrieb rechts unter **Stream & Encoder → ＋** deinen Icecast-, SHOUTcast- oder laut.fm-Zugang eintragen.
4. Für 24/7 ohne offenes Fenster: **Server-Automation 24/7 → Start**. Im Menü **⋯** stellst du Mikrofon, Lautsprecher-Abhören und DSP ein.

## Android

Die App ist das Studio für unterwegs: Fernbedienung, **MIC LIVE** (das Handy sendet als Live-Quelle mit Priority 3) und Mithören.
Sie verbindet sich mit AirDeck auf deinem PC. Die Automation selbst läuft auf dem PC.

1. **Am PC:** AirDeck mit Netzwerkfreigabe starten, damit das Handy es erreicht.
   - Portable: `AirDeck-Netzwerk.cmd` starten (oder `set AIRDECK_HOST=0.0.0.0` und dann `AirDeck.exe`).
   - Windows-Firewall-Abfrage für **private Netzwerke** erlauben.
   - Ein Token für das Handy erzeugen: `AirDeck.exe --new-admin-token` (in der Eingabeaufforderung im AirDeck-Ordner).
2. **Am Handy:** `AirDeck-Android.apk` öffnen und die Installation aus unbekannten Quellen erlauben.
   Es ist eine Test-APK; eine signierte Play-Store-Version folgt.
3. App starten, dann **Server-Adresse** eintragen (z. B. `http://192.168.1.20:8750`, die IP deines PCs) und das Token.

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
