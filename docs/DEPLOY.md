# Automatischer Rollout auf einen eigenen Server (GitHub Actions → SSH)

Der Workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) rollt AirDeck per Knopfdruck
(„Run workflow“ unter **Actions → Deploy**) auf einen eigenen Server aus: Er verbindet sich per SSH mit dem
Server und führt dort `git fetch/checkout` + `docker compose up -d --build` aus. Läuft **nicht automatisch**
bei jedem Push – nur wenn du ihn manuell startest.

Diese Sandbox selbst kann kein SSH (nur ausgehendes HTTPS über einen Proxy) – deshalb läuft der eigentliche
Rollout auf einem GitHub-Actions-Runner, der normales Internet hat.

## 1. Server einmalig vorbereiten

Auf dem Server (per SSH mit deinem bestehenden Zugang):

```bash
# Docker + Compose-Plugin, falls noch nicht vorhanden
curl -fsSL https://get.docker.com | sh

# Eigenes, eingeschränktes Deploy-Konto statt root (empfohlen)
adduser --disabled-password --gecos "" airdeck-deploy
usermod -aG docker airdeck-deploy

# Repository einmalig klonen
mkdir -p /opt/airdeck-demo
chown airdeck-deploy:airdeck-deploy /opt/airdeck-demo
su - airdeck-deploy -c '
  git clone https://github.com/ricorewioriginal-collab/anmacha_control.git /opt/airdeck-demo
  cd /opt/airdeck-demo && git checkout "AirDeck-Radio-Automation-&-Broadcast"
  echo "AIRDECK_DB_PASSWORD=$(openssl rand -hex 24)" > .env
'
```

Reicht dir root als Deploy-Konto (einfacher, aber mehr Rechte als nötig), einfach `airdeck-deploy` durch
`root` ersetzen und `usermod`/`adduser` weglassen.

**Öffentlich erreichbar?** Vor AirDeck einen Reverse Proxy (Caddy/Traefik/nginx) mit HTTPS schalten – siehe
`docker-compose.yml` und [docs/DOCKER.md](DOCKER.md#hinweise).

## 2. Deploy-Schlüssel hinterlegen

Ich habe dir einen eigenen SSH-Schlüssel **nur für diesen Deploy** erzeugt (ed25519, ohne Passphrase, damit
der Actions-Runner ihn automatisiert nutzen kann). Den privaten Teil bekommst du als Datei – bitte:

1. Den **öffentlichen** Schlüssel auf dem Server für das Deploy-Konto eintragen:
   ```bash
   su - airdeck-deploy -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh'
   echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILhZ9h2C6zZt1QVI3GS8JqU0TDmIcIonyEjEWiK9Xya/ airdeck-deploy@github-actions" \
     | su - airdeck-deploy -c 'tee -a ~/.ssh/authorized_keys' && \
     su - airdeck-deploy -c 'chmod 600 ~/.ssh/authorized_keys'
   ```
2. Im Repository unter **Settings → Secrets and variables → Actions → New repository secret** folgende Secrets anlegen:

   | Name | Wert |
   |---|---|
   | `DEPLOY_HOST` | Servername/IP, z. B. `admin.ricorewi.de` |
   | `DEPLOY_USER` | `airdeck-deploy` (oder `root`) |
   | `DEPLOY_SSH_KEY` | Inhalt der zugeschickten privaten Schlüsseldatei (die ganze Datei, inkl. `-----BEGIN...` / `-----END...`-Zeilen) |
   | `DEPLOY_PATH` | `/opt/airdeck-demo` (Pfad aus Schritt 1) |
   | `DEPLOY_PORT` | nur nötig, wenn SSH nicht auf Port 22 läuft |
   | `DEPLOY_HEALTH_URL` | optional, z. B. `https://airdeck-demo.ricorewi.de/api/v1/health` – prüft nach dem Rollout, ob AirDeck antwortet |
   | `DEPLOY_HOST_KEY` | optional: Ausgabe von `ssh-keyscan -p <Port> <Host>` – ohne dieses Secret wird der Host-Schlüssel beim ersten Lauf automatisch abgerufen (leicht geringere Absicherung gegen einen Server-Tausch mitten im Deploy) |

3. Die private Schlüsseldatei danach **lokal löschen** (sie liegt nur bei dir und im GitHub-Secret, nirgends
   sonst) und das alte, im Chat genannte Root-Passwort separat rotieren, falls noch nicht geschehen.

## 3. Rollout starten

**Actions → Deploy → Run workflow** (optional: anderen Branch/Tag als `ref` angeben). Der Job meldet fehlende
Secrets klar, statt sich falsch zu verhalten, macht `git fetch/checkout` + `docker compose up -d --build` auf
dem Server und prüft danach den Health-Check, falls `DEPLOY_HEALTH_URL` gesetzt ist.

## Danach erneut ausrollen (Updates)

Einfach den Workflow erneut starten – `git reset --hard` auf dem Server holt den gewünschten Stand, Docker
baut nur das, was sich geändert hat. Daten (Datenbank, Medien) liegen in Docker-Volumes und bleiben erhalten
(siehe [docs/DOCKER.md](DOCKER.md#daten--updates)).
