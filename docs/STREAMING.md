# Streaming, Klang & Liquidsoap

## Sendeweg

Quellen (Automation, Live, Remote, Android) → **Source Priority Engine** → aktive Quelle → **Ausgänge** (Icecast, SHOUTcast v1/v2, laut.fm) und **Recorder**. Die Server-Automation mischt selbst, die Kette läuft so:

```
Titel (ffmpeg-Decoder) → Lautheitsangleich pro Titel → Mixer (Crossfade, Carts, Ducking, Mikrofon)
  → Master-DSP (Rumpelfilter, 10-Band-EQ, Multiband, Kompressor, AGC, Limiter) → Encoder (LAME/AAC/Opus) → Ausgänge
```

## Encoder

| Format | Encoder | Optionen |
|---|---|---|
| MP3 | LAME (libmp3lame) | CBR (Bitrate) oder VBR (Qualität 0–9), Algorithmus-Qualität 0–9 |
| AAC | ffmpeg-AAC (ADTS) | Bitrate |
| Opus | libopus (Ogg) | Bitrate |

Im Windows-Paket und im Docker-Image ist ffmpeg samt LAME und Opus enthalten.

## Automatische Klangoptimierung

- **Lautheitsangleich pro Titel (EBU R128):** Jeder neue Titel wird im Hintergrund gemessen (integrierte Lautheit und True Peak), immer ein Titel nach dem anderen, damit der Sendebetrieb nicht leidet. Beim Abspielen gleicht AirDeck auf das Ziel an (Standard −16 LUFS), höchstens ±12 dB. Die Spitzen bleiben dabei unter −1 dBTP, mit Limiter gibt es 3 dB Reserve. Ein manuell gesetzter Gain hat Vorrang. Sprachbeiträge bleiben unverändert. Unter „Server-Automation → Einstellungen“ lässt sich die ganze Bibliothek neu messen.
- **Klangprofile:** Neutral, Musik ausgewogen, Pop/Dance (laut & dicht, Multiband), Wort & Moderation, Klassik/Jazz. Ein Profil setzt EQ und Dynamik als Startpunkt, danach ist alles frei anpassbar.
- **AGC:** Die Summe wird mit `loudnorm` in Echtzeit auf die Ziel-Lautheit geregelt (EBU R128, TP −1,5 dB). Das bringt ein paar Sekunden Verzögerung im Stream, die Pegel bleiben aber gleichmäßig.
- **Multiband:** 5 Bänder (`mcompand`) für einen dichten Radio-Sound.

## Liquidsoap (optional)

Wer Liquidsoap nutzen will, etwa auf einem Server mit guter Anbindung oder für viele Ziele, lässt AirDeck an Liquidsoap senden. Liquidsoap verteilt dann weiter:

1. Stream & Encoder → **LIQ** → Skript herunterladen. Es wird aus den eingerichteten Ausgängen erzeugt.
2. Umgebungsvariablen setzen: `AIRDECK_LIQ_INPUT_PASSWORD` und `AIRDECK_LIQ_OUT<n>_PASSWORD`. Passwörter stehen nie im Skript.
3. `liquidsoap airdeck-<sender>.liq` starten, zum Beispiel mit Docker `savonet/liquidsoap:v2.2.5`.
4. In AirDeck einen Icecast-Ausgang auf den Liquidsoap-Harbor anlegen (Port/Mount wie gewählt, Benutzer `source`) und die direkten Ausgänge deaktivieren.

Die CI prüft das erzeugte Skript bei jedem Build mit echtem Liquidsoap (`liquidsoap --check`).
