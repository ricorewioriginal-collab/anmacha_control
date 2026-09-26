#!/bin/sh
# Setzt die öffentliche AirDeck-Demo komplett zurück: alle Daten (Sender, Bibliothek, Einstellungen,
# Benutzer) weg, Container frisch neu gestartet, danach ein Beispielsender mit Testtiteln angelegt -
# läuft am besten per Cron alle 10 Minuten (siehe README.md in diesem Ordner):
#   */10 * * * * /opt/airdeck-demo/packaging/demo/reset-demo.sh >> /var/log/airdeck-demo-reset.log 2>&1
set -e
cd "$(dirname "$0")/../.."
compose="docker compose -f packaging/demo/docker-compose.demo.yml"

echo "[$(date -Is)] Demo wird zurückgesetzt ..."
$compose down -v --remove-orphans
$compose up -d

echo "Warte auf Health-Check ..."
ok=""
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:8751/api/v1/health | grep -q '"ok":true'; then
    ok=1
    break
  fi
  sleep 1
done
[ -n "$ok" ] || { echo "Health-Check nach 30 s nicht erreicht - Beispielsender wird übersprungen."; exit 0; }

token=$($compose logs airdeck-demo 2>/dev/null | grep -o 'ad_[A-Za-z0-9_-]*' | head -1)
if [ -z "$token" ]; then
  echo "Kein Admin-Token im Log gefunden - Beispielsender wird übersprungen."
  exit 0
fi

api="http://127.0.0.1:8751/api/v1/stations/main"
auth="Authorization: Bearer $token"
curl -fs -X PATCH -H "$auth" -H "Content-Type: application/json" \
  -d '{"name":"AirDeck-FM","slogan":"Testinstanz - setzt sich alle 10 Minuten zurueck"}' "$api" > /dev/null
curl -fs -X PUT -H "$auth" -H "Content-Type: application/json" \
  -d '{"requests":true,"messages":true,"voting":true,"voice":false}' "$api/listener" > /dev/null

# Fester Demo-Zugang statt eines sich staendig aendernden Tokens: wer ueber GitHub/README zur Demo
# kommt, hat keinen Token und keinen SSH-Zugriff auf den Server, um sich einen zu holen. Benutzer/
# Passwort sind bewusst oeffentlich (siehe README.md) - der Zugang ist auf den einen Demo-Sender
# beschraenkt (stationIds: main, nicht "*"), kann also keine anderen Sender/Benutzer anlegen oder
# loeschen, und alle 10 Minuten ist ohnehin alles wieder auf Anfang.
demo_user="${AIRDECK_DEMO_USER:-demo}"
demo_pass="${AIRDECK_DEMO_PASSWORD:-airdeck-demo}"
curl -fs -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
  -d "{\"username\":\"$demo_user\",\"name\":\"Demo\",\"password\":\"$demo_pass\",\"roles\":[\"admin\"],\"stationIds\":[\"main\"],\"mustChangePassword\":false}" \
  "http://127.0.0.1:8751/api/v1/users" > /dev/null

echo "[$(date -Is)] Demo zurückgesetzt, Beispielsender \"AirDeck-FM\" und fester Demo-Zugang ($demo_user) eingerichtet."
