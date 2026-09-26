# AirDeck-Demo (öffentliche Testinstanz)

Eine bewusst abgetrennte AirDeck-Testinstanz zum Ausprobieren. Sie **setzt sich automatisch alle 10 Minuten zurück** und ist vollständig von produktiven AirDeck-Installationen getrennt (eigener Container, eigenes Volume, eigener Port).

## Vollfunktions-Demo

Das Demo-Image enthält jetzt **ffmpeg und einen nur containerintern erreichbaren Icecast**. Nach jedem Reset werden automatisch ein AirDeckCast-Ausgang (MP3 128 kbit/s), HLS, synthetische Testmedien und Server-Automation eingerichtet. Dadurch lassen sich Encoder, Decks, Queue, Medienverwaltung, Automation, HLS und Stream-Status real ausprobieren, ohne produktive Streaming-Zugangsdaten zu verwenden.

Externe Integrationen wie laut.fm, Nextcloud oder Cloud-KI bleiben naturgemäß von eigenen Zugangsdaten bzw. externen Diensten abhängig. Die öffentliche Demo erhält bewusst keine produktiven Secrets.

## Einrichtung (einmalig)

1. **DNS**: `airdeck-demo.ricorewi-radio.de` per A/CNAME-Eintrag auf den Server zeigen lassen (denselben
   wie `admin.ricorewi.de`).
2. **Reverse Proxy**: Je nachdem, was auf dem Server schon läuft, das passende Snippet einfügen:
   - nginx: [`nginx.demo.conf`](nginx.demo.conf)
   - Caddy: [`Caddyfile.demo`](Caddyfile.demo)
   - Apache: [`apache.demo.conf`](apache.demo.conf) (braucht `a2enmod proxy proxy_http`)

   Der Container selbst ist **nicht öffentlich erreichbar** (`127.0.0.1:8751`, siehe
   [`docker-compose.demo.yml`](docker-compose.demo.yml)) - HTTPS und der öffentliche Zugriff laufen
   ausschließlich über euren bestehenden Webserver.
3. **Erststart**:
   ```bash
   cd /opt/airdeck-demo   # oder wo auch immer das Repository liegt
   docker compose -f packaging/demo/docker-compose.demo.yml up -d
   ```
4. **Automatischer Reset alle 10 Minuten** - als Cron-Job (`crontab -e`):
   ```
   */10 * * * * /opt/airdeck-demo/packaging/demo/reset-demo.sh >> /var/log/airdeck-demo-reset.log 2>&1
   ```
   [`reset-demo.sh`](reset-demo.sh) löscht dabei **alle** Daten (Container + Volume weg, komplett neu erzeugt) und legt danach automatisch wieder „AirDeck-FM“, Testmedien, HLS, den internen AirDeckCast/Icecast-Ausgang und den Demo-Zugang an.

## Zugang für Besucher

Jeder Reset legt intern zwar ein neues, zufälliges Admin-Konto an (wie bei jeder frischen
AirDeck-Installation) - **das ist aber nicht der Zugang für Demo-Besucher**, den kennt niemand ohne
Server-Zugriff. Stattdessen legt [`reset-demo.sh`](reset-demo.sh) nach jedem Reset zusätzlich einen
**festen** Demo-Zugang an, der immer gleich bleibt:

| | |
|---|---|
| Benutzername | `demo` |
| Passwort | `airdeck-demo` |

Dieser Zugang ist absichtlich öffentlich (steht auch im Haupt-[README.md](../../README.md)) und bewusst
eingeschränkt: nur auf den Demo-Sender selbst (kann keine anderen Sender/Benutzer anlegen oder löschen),
und ohnehin alle 10 Minuten zurückgesetzt. Eigenen Namen/Passwort ändern via Umgebungsvariablen
`AIRDECK_DEMO_USER` / `AIRDECK_DEMO_PASSWORD` vor `reset-demo.sh` (Passwort braucht mindestens 10 Zeichen,
Buchstaben und eine Ziffer oder ein Sonderzeichen).

Falls doch mal das interne (zufällige) Admin-Konto gebraucht wird, z. B. zum Debuggen:
```bash
cd /opt/airdeck-demo
docker compose -f packaging/demo/docker-compose.demo.yml logs airdeck-demo | grep -A1 -e "Admin-Token" -e "Einmal-Passwort"
```

## Wichtig

- **Nichts Echtes hier ablegen.** Alle 10 Minuten ist alles weg - Musik, Einstellungen, Benutzer.
- Diese Demo ist von jeder echten AirDeck-Installation komplett getrennt (eigene Container/Volumes/Ports) -
  ein Reset hier betrifft ausschließlich die Demo.
- Update: `git pull && docker compose -f packaging/demo/docker-compose.demo.yml up -d --build` (der nächste
  automatische Reset holt sich das neue Image ohnehin beim nächsten `up -d`, sofern es schon gebaut wurde).
