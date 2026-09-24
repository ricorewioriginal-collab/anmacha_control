# AirDeck im Docker-Container

Der Container ist AirDeck als Server für den 24/7-Betrieb, zum Beispiel auf einem VPS, einem NAS oder einem Raspberry Pi 4/5 mit 64 Bit. ffmpeg mit LAME (MP3), AAC und Opus ist enthalten.

## Start

```bash
git clone https://github.com/ricorewioriginal-collab/anmacha_control.git airdeck
cd airdeck && git checkout "AirDeck-Radio-Automation-&-Broadcast"
docker compose up -d
docker compose logs airdeck | grep -A1 "Admin-Token"
```

Danach das Studio unter `http://<server>:8750/#token=<Admin-Token>` öffnen. Die Android-App verbindet sich mit derselben Adresse. Einen Verbindungslink erzeugst du im Studio unter „Android-App → Zugang erstellen“.

## Daten & Updates

- Alle Daten (Bibliothek, Einstellungen, verschlüsselte Zugangsdaten, Aufnahmen) liegen im Volume `airdeck-data` (`/data` im Container).
- Update: `git pull && docker compose up -d --build`. Die Daten bleiben erhalten.
- Sicherung: `docker run --rm -v airdeck-data:/data -v "$PWD":/backup busybox tar czf /backup/airdeck-backup.tgz /data`

## Hinweise

- **Öffentlich erreichbar?** Dann nur hinter HTTPS, zum Beispiel mit einem Reverse Proxy wie Caddy, Traefik oder nginx. Tokens nur mit den nötigen Rechten vergeben. Siehe [Haftungsausschluss](../HAFTUNGSAUSSCHLUSS.md).
- **Live-Quellen (Icecast-Ingest)** laufen über denselben Port: `/ingest/<sender>/live`.
- **Mikrofon/Line-In am Server** gibt es im Container nicht, weil kein Audiogerät vorhanden ist. Live-Sendungen kommen per Studio (MIC LIVE), Android-App oder Encoder wie BUTT.
- **KI lokal:** Für Ollama oder Kokoro im selben Compose-Projekt als Basis-URL `http://ollama:11434/v1` bzw. `http://kokoro:8880/v1` eintragen.
