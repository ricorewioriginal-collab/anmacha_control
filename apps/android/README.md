# AirDeck für Android

Die App hat zwei Betriebsarten, die Wahl kommt beim ersten Start:

**Handy-Sender (ohne Server):** Das Handy sendet selbst, mit eigener Engine in Java. Die läuft als Vordergrund-Dienst weiter, auch bei ausgeschaltetem Bildschirm.
- Mikrofon und Musik vom Handy (MP3, AAC, FLAC, OGG, WAV), Musik unter dem Mikrofon wird leiser (Ducking)
- MP3-Encoder: LAME als reines Java (jump3r, LGPL 2.1+), keine nativen Bibliotheken
- Sendet an laut.fm, Icecast oder AzuraCast (Icecast-Quellprotokoll PUT, bei älteren Servern SOURCE). Bei Abbruch verbindet sich die App selbst neu, die Titelanzeige geht an den Server.
- Titelliste mit automatischem Weiterspielen, Mithören über Kopfhörer, Pegelanzeigen

**Mit AirDeck verbinden:** Studio eines AirDeck-PCs oder -Servers fernsteuern (Decks, Cardwall, Queue, Quellen). Dazu MIC LIVE als Live-Quelle (Priorität 3) und Mithören.

Aufbau:
- `engine/src`: Engine ohne Android-Bezug (Mischpult, Encoder, Icecast-Quelle, Takt). Wird mit `engine/test.sh` gegen einen echten Icecast getestet.
- `native/`: Android-Schicht (Mikrofon, Decoder, Vordergrund-Dienst, Capacitor-Plugin „AirDeckEngine“)
- Oberfläche: `studio/handy.html`

## Bauen

Voraussetzungen: Node ≥ 22, JDK 21 und Android SDK (`ANDROID_HOME`).

```bash
cd apps/android
npm install
npm run build:debug      # → android/app/build/outputs/apk/debug/app-debug.apk
```

Automatisch passiert das über GitHub Actions (Workflow „Build“, Artefakt `AirDeck-Android`).

## Verbinden

1. AirDeck auf dem PC mit Netzwerkfreigabe starten: `AIRDECK_HOST=0.0.0.0`
2. In der App die Server-Adresse eingeben (z. B. `http://192.168.1.20:8750`) und ein Token.
   Ein Token erzeugst du mit `airdeck-engine.exe --new-admin-token`.
