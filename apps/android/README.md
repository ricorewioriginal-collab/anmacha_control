# AirDeck für Android

Die App ist das AirDeck-Studio als native Android-App (Capacitor). Sie verbindet sich mit einem
AirDeck-Server, also dem Windows-Programm oder einem Self-Hosted-Server:

- Studio, 4 Decks, Cardwall, Queue und Quellen fernsteuern
- **MIC LIVE**: Das Handy-Mikrofon sendet als Quelle „Android Live“ (Priority 3) und übernimmt nach Priorität
- 🎧 Sendesignal mithören
- Server-Automation (24/7) starten, stoppen und weiterschalten

Die 24/7-Automation läuft absichtlich auf dem Server bzw. Windows-PC. Android pausiert
Hintergrund-WebViews, deshalb ist das Handy keine zuverlässige Dauer-Sendequelle.

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
