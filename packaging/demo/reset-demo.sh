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
  -d '{"requests":true,"messages":true,"voting":true,"voice":true}' "$api/listener" > /dev/null

# Voll funktionsfaehige lokale Demo-Ausgabe: eigener Icecast laeuft im selben Container und ist
# von aussen nicht direkt erreichbar. Damit koennen Encoder, AirDeckCast-Test, Failover-Status und
# Server-Playout real ausprobiert werden, ohne fremde Zugangsdaten zu hinterlegen.
curl -fs -X POST -H "$auth" -H "Content-Type: application/json" \
  -d '{"name":"AirDeckCast Demo","type":"icecast","host":"127.0.0.1","port":8000,"mount":"/airdeck-demo.mp3","username":"source","password":"airdeck-demo-source","bitrateKbps":128,"enabled":true}' \
  "$api/outputs" > /dev/null

# Kleine, bei jedem Reset neu erzeugte Testbibliothek. Keine urheberrechtlich geschuetzten Titel,
# sondern synthetische Toene; dadurch funktionieren Medienverwaltung, Queue, Decks und Automation sofort.
upload_tone() {
  freq="$1"; name="$2"; category="$3"; dur="${4:-8}"
  $compose exec -T airdeck-demo ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=${freq}:duration=${dur}" \
    -c:a pcm_s16le -f wav - \
    | curl -fs -X PUT -H "$auth" -H "Content-Type: audio/wav" --data-binary @- \
      "http://127.0.0.1:8751/api/v1/stations/main/media?name=${name}.wav&category=${category}"
}
track_a="$(upload_tone 440 "DemoTrack-A" "music" 12 | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
track_b="$(upload_tone 554 "DemoTrack-B" "music" 12 | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
track_c="$(upload_tone 659 "DemoTrack-C" "music" 12 | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
station_id="$(upload_tone 880 "AirDeck-FM-ID" "station_id" 3 | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
jingle="$(upload_tone 988 "Demo-Jingle" "jingle" 3 | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"

# Demo-Cardwall direkt mit echten Testmedien befüllen.
curl -fs -X PATCH -H "$auth" -H "Content-Type: application/json" -d "{\"mediaId\":\"$jingle\",\"label\":\"Demo Jingle\"}" "$api/cardwall/cart1" > /dev/null
curl -fs -X PATCH -H "$auth" -H "Content-Type: application/json" -d "{\"mediaId\":\"$station_id\",\"label\":\"AirDeck-FM ID\"}" "$api/cardwall/cart2" > /dev/null
curl -fs -X PATCH -H "$auth" -H "Content-Type: application/json" -d "{\"mediaId\":\"$track_a\",\"label\":\"Demo Track A\"}" "$api/cardwall/cart3" > /dev/null

# Automation direkt startbereit machen. Wenn der Start wider Erwarten fehlschlaegt, bleibt die Demo
# trotzdem erreichbar; der Fehler steht dann im Containerlog statt den gesamten Reset abzubrechen.
curl -fs -X PATCH -H "$auth" -H "Content-Type: application/json" \
  -d '{"autostart":true,"hls":{"enabled":true,"bitrateKbps":96,"segmentSeconds":2}}' \
  "$api/playout" > /dev/null || true
curl -fs -X POST -H "$auth" -H "Content-Type: application/json" -d '{"autostart":true}' \
  "$api/playout/start" > /dev/null || true

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

echo "[$(date -Is)] Demo vollstaendig zurueckgesetzt: AirDeck-FM, Testmedien, HLS, interner Icecast/AirDeckCast und Demo-Zugang ($demo_user) sind eingerichtet."
