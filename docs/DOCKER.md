# AirDeck im Docker-Container

Der Container ist AirDeck als Server für den 24/7-Betrieb, zum Beispiel auf einem VPS, einem NAS oder einem Raspberry Pi 4/5 mit 64 Bit. ffmpeg mit LAME (MP3), AAC und Opus ist enthalten.

## Start

```bash
git clone https://github.com/ricorewioriginal-collab/anmacha_control.git airdeck
cd airdeck && git checkout "AirDeck-Radio-Automation-&-Broadcast"
echo "AIRDECK_DB_PASSWORD=$(openssl rand -hex 24)" > .env   # Passwort der Datenbank, einmalig
docker compose up -d
docker compose logs airdeck | grep -A1 -e "Admin-Token" -e "Einmal-Passwort"
```

Gestartet werden zwei Container: `airdeck` und `airdeck-postgres` (PostgreSQL 17, nur intern erreichbar). Redis wird nicht gebraucht.

**Ohne PostgreSQL** (kleine Installation): in `docker-compose.yml` den Dienst `postgres`, den Abschnitt `depends_on` und die drei `AIRDECK_DB`-Zeilen entfernen. AirDeck nutzt dann SQLite im Datenordner.

Danach das Studio unter `http://<server>:8750/#token=<Admin-Token>` öffnen. Die Android-App verbindet sich mit derselben Adresse. Handys koppelst du im Studio unter „Android-App → Gerät koppeln“ (Adresse + Kopplungscode).

## Daten & Updates

- Sender, Bibliothek, Planung, Benutzer und Einstellungen liegen in PostgreSQL (Volume `airdeck-pg`). Mediendateien, Aufnahmen, verschlüsselte Zugangsdaten und Logs liegen im Volume `airdeck-data` (`/data` im Container).
- Umstieg von einer älteren Version: Die bisherigen JSON-Dateien in `/data` werden beim ersten Start übernommen und als `*.imported` aufbewahrt.
- Update: `git pull && docker compose up -d --build`. Die Daten bleiben erhalten.
- Sicherung (bis Backup/Restore im Programm fertig ist):
  - Datenbank: `docker compose exec postgres pg_dump -U airdeck airdeck > airdeck-db.sql`
  - Dateien: `docker run --rm -v airdeck_airdeck-data:/data -v "$PWD":/backup busybox tar czf /backup/airdeck-data.tgz /data`

## Hinweise

- **Öffentlich erreichbar?** Dann nur hinter HTTPS, zum Beispiel mit einem Reverse Proxy wie Caddy, Traefik oder nginx. Tokens nur mit den nötigen Rechten vergeben. Siehe [Haftungsausschluss](../HAFTUNGSAUSSCHLUSS.md).
- **Live-Quellen (Icecast-Ingest)** laufen über denselben Port: `/ingest/<sender>/live`.
- **Mikrofon/Line-In am Server** gibt es im Container nicht, weil kein Audiogerät vorhanden ist. Live-Sendungen kommen per Studio (MIC LIVE), Android-App oder Encoder wie BUTT.
- **KI lokal:** Für Ollama oder Kokoro im selben Compose-Projekt als Basis-URL `http://ollama:11434/v1` bzw. `http://kokoro:8880/v1` eintragen.
