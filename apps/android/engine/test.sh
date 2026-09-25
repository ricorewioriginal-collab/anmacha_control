#!/usr/bin/env bash
# Tests der Handy-Engine (reines Java, ohne Android): kompilieren, echten Icecast starten, senden, prüfen.
# Voraussetzungen: JDK ≥ 17, icecast2, ffprobe (ffmpeg). Aufruf: apps/android/engine/test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'kill "${ice_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT

JUMP3R_VERSION=1.0.5
jar="$here/.cache/jump3r-$JUMP3R_VERSION.jar"
if [ ! -f "$jar" ]; then
  mkdir -p "$here/.cache"
  curl -fsSL -o "$jar" "https://repo1.maven.org/maven2/de/sciss/jump3r/$JUMP3R_VERSION/jump3r-$JUMP3R_VERSION.jar"
fi

# Java 8-kompatibel kompilieren, damit Android (Desugaring) alles versteht
javac --release 8 -encoding UTF-8 -cp "$jar" -d "$work/classes" $(find "$here/src" -name '*.java') 2>&1 | grep -v 'warning: \[options\]' || true
javac --release 17 -encoding UTF-8 -cp "$jar:$work/classes" -d "$work/test" "$here/test/EngineTest.java"

port=$((20000 + RANDOM % 20000))
mkdir -p "$work/ice/log"
# Icecast läuft nicht als root: dann unter seinem eigenen Dienstkonto
owner=""
if [ "$(id -u)" = 0 ] && id icecast2 > /dev/null 2>&1; then
  owner="<changeowner><user>icecast2</user><group>$(id -gn icecast2)</group></changeowner>"
  chmod 755 "$work" "$work/ice"
  chown -R icecast2 "$work/ice/log"
fi
cat > "$work/ice/icecast.xml" <<EOF
<icecast>
  <limits><sources>4</sources></limits>
  <authentication>
    <source-password>quelle-geheim</source-password>
    <admin-user>admin</admin-user><admin-password>admin-geheim</admin-password>
  </authentication>
  <hostname>127.0.0.1</hostname>
  <listen-socket><port>$port</port><bind-address>127.0.0.1</bind-address></listen-socket>
  <paths><basedir>/usr/share/icecast2</basedir><logdir>$work/ice/log</logdir><webroot>/usr/share/icecast2/web</webroot><adminroot>/usr/share/icecast2/admin</adminroot></paths>
  <logging><loglevel>2</loglevel></logging>
  <security><chroot>0</chroot>$owner</security>
</icecast>
EOF
icecast2 -c "$work/ice/icecast.xml" > "$work/ice/out.log" 2>&1 &
ice_pid=$!
for i in $(seq 1 50); do curl -fs "http://127.0.0.1:$port/status-json.xsl" > /dev/null 2>&1 && break; sleep 0.1; done
curl -fs "http://127.0.0.1:$port/status-json.xsl" > /dev/null || { echo "Icecast startet nicht:"; cat "$work/ice/out.log"; exit 1; }

mkdir -p "$work/out"
java -Dstdout.encoding=UTF-8 -cp "$jar:$work/classes:$work/test" EngineTest "$work/out" "$port"

# Was der Hörer bekam, muss sauberes MP3 sein
probe="$(ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "$work/out/heard.mp3")"
echo "  Hörer-Mitschnitt: $probe"
case "$probe" in mp3,44100,2*) echo "  ok  Mitschnitt ist MP3, 44,1 kHz, Stereo" ;; *) echo "  FEHLER  Mitschnitt: $probe"; exit 1 ;; esac
dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$work/out/tone.mp3")"
awk -v d="$dur" 'BEGIN { if (d > 2.9 && d < 3.2) { print "  ok  Encoder-Datei " d " s"; exit 0 } print "  FEHLER  Encoder-Datei " d " s"; exit 1 }'
