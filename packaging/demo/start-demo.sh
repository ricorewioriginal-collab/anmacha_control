#!/bin/sh
set -eu
mkdir -p /data/icecast-logs
# Eigener, nur containerintern erreichbarer Icecast fuer die Demo. Dadurch funktionieren
# Encoder/Ausgaenge/AirDeckCast real, ohne einen externen Streaming-Server zu benoetigen.
icecast2 -b -c /app/packaging/demo/icecast.demo.xml
exec node src/server/main.ts --headless
