# Streaming, Klang & Liquidsoap

## Sendeweg

Alle Quellen laufen durch **einen Sendebus** je Sender. Nach außen gibt es damit ein festes Format: Wechselt die Quelle (Automation → Live → Automation), bleiben Format und Verbindung der Ausgänge gleich. Hörer-Player brechen nicht ab, und SHOUTcast oder laut.fm bekommen nie plötzlich WebM.

```
Automation (Titel)      ─ffmpeg-Decoder─┐
Carts/Jingles           ─ffmpeg-Decoder─┤
Live-Encoder (BUTT …)   ─ffmpeg-Decoder─┤─► Mixer (Überblendung nach Source Priority, Crossfade, Ducking)
Studio-Mikrofon, App    ─ffmpeg-Decoder─┤     → Master-DSP (Rumpelfilter, EQ, Multiband, Kompressor, AGC, Limiter)
Relay/Stream (Brücke)   ─ffmpeg-Decoder─┘     → Encoder (LAME/AAC/Opus) → Ausgänge (Icecast, SHOUTcast, laut.fm), Recorder, Mithören
```

- Die **Source Priority Engine** entscheidet, welche Quelle hörbar ist. Der Mixer blendet über (Standard 400 ms), statt Rohdaten umzuschalten.
- Live-Quellen werden kurz gepuffert (300 ms gegen Netzwerk-Jitter, höchstens 1,5 s Verzögerung). Formate: MP3, Ogg/Opus, WebM/Opus (Browser-Mikrofon, Android-App), AAC.
- **Live ohne laufende Automation:** Verbindet sich eine Live-Quelle, während der Sendebus aus ist, startet AirDeck ihn automatisch (Betriebsart LIVE, Automation pausiert) und beendet ihn mit der Live-Sendung wieder.
- Ohne ffmpeg gibt es keinen Sendebus. Dann wird wie früher der Strom der aktiven Quelle unverändert weitergereicht (Notbetrieb). Mit dem mitgelieferten ffmpeg tritt das nicht auf.

## Betriebsarten (Mode-Manager)

| Betriebsart | Wer bestimmt den Ton | Automation | Titelanzeige |
|---|---|---|---|
| **AUTO** | Automation | spielt Queue, Sendeuhr und Sendeplan | laufender Titel |
| **MANUELL** | Operator: Titel mit ▶ „Jetzt senden“, Cartwall | pausiert, startet keinen Titel selbst, die Queue bleibt unangetastet | manuell gestarteter Titel |
| **LIVE** | Live-Quelle (automatisch, sobald sie laut Priorität auf Sendung ist) | pausiert, verbraucht keine Titel. Der laufende Titel wird ausgeblendet | „Live: <Quelle>“ |
| **NOTFALL** | Notfall-Ordner | nur Notfall-Material, weil Queue, Sendeuhr und Sendeplan nichts liefern oder die Automation-Quelle wegen Stille ausfiel | Notfall-Titel |

- AUTO und MANUELL wählt der Operator (Studio: Knopf neben ON AIR, API `PUT /api/v1/stations/<sender>/mode`). LIVE und NOTFALL ergeben sich aus dem Sendezustand. Danach gilt wieder die gewählte Grundbetriebsart.
- **Stille:** Ist das Programm eine Live-Quelle, fällt der Sender auf die Automation zurück. Die stille Live-Quelle bleibt abgeschaltet, bis sie neu verbindet. Ist das Programm die Automation, folgt der nächste Titel, sonst eine Backup-Quelle bzw. der Notfall-Ordner.
- Jeder Wechsel löst das Ereignis `MODE_CHANGED` aus (`{ mode, from, base, reason }`) und landet im Audit-Log.

| API | Zweck |
|---|---|
| `GET /api/v1/stations/<sender>/mode` | `{ mode, base, program, bus, live }` |
| `PUT /api/v1/stations/<sender>/mode` `{ "mode": "AUTO" \| "MANUAL" }` | Grundbetriebsart |
| `POST /api/v1/stations/<sender>/onair` `{ "mediaId": "…" }` | Titel sofort senden (nicht während LIVE, dafür gibt es die Cartwall) |

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
