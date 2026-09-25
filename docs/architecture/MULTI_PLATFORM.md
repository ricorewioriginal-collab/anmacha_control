# Plattformen

## Windows

```
┌──────────── Windows-PC ─────────────────────────────────────────────┐
│ Dienst „AirDeck Server“ (Session 0)   Studio (Desktop-Fenster)      │
│  Core · API · SQLite · Encoder ◄─HTTP─► Oberfläche                  │
│  Ausgänge ins Internet                  Mithören/CUE (Soundkarte)   │
│                                         Mikrofon ─► Ingest an Core  │
│ Tray-Symbol: Studio öffnen · Status · Beenden/Neustarten des Dienstes│
└─────────────────────────────────────────────────────────────────────┘
```

**Wichtig, Session-0-Isolation:** Ein Windows-Dienst hat keinen verlässlichen Zugriff auf die Soundkarte und das Mikrofon des angemeldeten Benutzers. Daraus folgt:
- **Senden** (Dekodieren, Mischen, Kodieren, Streamen) braucht keine Soundkarte und läuft im Dienst.
- **Mithören, CUE und Mikrofon** laufen im Studio-Client beim Benutzer. Das Mikrofon geht als Live-Quelle in den Core und wird dort dekodiert und gemischt.
- Wer ausdrücklich über die Soundkarte **ausspielen** will (etwa UKW-Sender am Line-Out), nutzt den **Einfach-Modus ohne Dienst** (Hintergrundprozess mit Tray, wie heute). Der Installer bietet beide Varianten an.

## Linux

Server bzw. Core als systemd-Dienst. Ein Linux-Desktop-Client ist der Browser oder eine spätere Desktop-Hülle mit derselben Oberfläche. Es gibt keine eigene Linux-Oberfläche.

## Android

Nicht nur eine WebView. Die Oberfläche bleibt Web (dieselbe wie auf dem Desktop), dazu kommen **native Module**:

| Modul | Zweck |
|---|---|
| Serververbindung | Erkennung (UDP), QR-Kopplung, Verbindungstest, Profile, Token im Android Keystore |
| Live-Sender (Foreground-Service mit Benachrichtigung) | Mikrofon → nativer Encoder (AAC über MediaCodec) → an den AirDeck-Ingest **oder direkt** an Icecast/laut.fm (Standalone). Läuft weiter, wenn die App im Hintergrund ist |
| Audio | Mithören über den nativen Player (weiterläuft im Hintergrund) |
| Berechtigungen | Mikrofon, Benachrichtigungen, Netzwerk, sauber abgefragt |

Android wird **kein** 24/7-Automationsserver. Das System erlaubt keinen dauerhaften Hintergrundbetrieb dieser Art verlässlich. Der Foreground-Service gilt nur für Live-Sendungen und Mithören.

## Sync (Hybrid)

Der lokale Core arbeitet immer mit seiner eigenen SQLite-Datenbank. Der Abgleich mit dem Server läuft über das Änderungsprotokoll (`sync_changes`: Tabelle, Schlüssel, Änderungszeit, Herkunft). Bei Konflikten gewinnt die neuere Änderung pro Datensatz, der Konflikt wird protokolliert und im Studio angezeigt. Das ersetzt die bisherige Komplett-Blob-Replikation.
