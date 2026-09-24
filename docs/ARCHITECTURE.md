# AirDeck – Architektur & Entscheidungen

## Überblick

```text
 Encoder (BUTT/Mixxx/…)      Studio (Browser/PWA, Web Audio)
   PUT|SOURCE /ingest/…        4 Decks · Cardwall · Automation
          │                     │ MediaRecorder-Chunks   │ REST + SSE
          ▼                     ▼                         ▼
 ┌──────────────────────── AirDeck Server (node:http) ────────────────────────┐
 │  Source Priority Engine ──events──► Relay Core ──► Broadcast Adapter        │
 │  (src/core, rein)                    (nur aktive      Icecast (PUT, ?prio=)  │
 │                                       Quelle)         SHOUTcast: unsupported │
 │  Automation Core (Queue, Sendeuhr, Rotation, Backtiming, Stille)            │
 │  Persistenz: data/airdeck.json · Audit: data/audit.log · Secrets: AES-GCM   │
 └─────────────────────────────────────────────────────────────────────────────┘
```

Die UI sendet nur Commands an Domain-Services. Der Relay-Kern hängt nie direkt an Buttons.

## Entscheidungen (ADR-Kurzform)

1. **TypeScript ohne Build, ohne Laufzeit-Abhängigkeiten.** Node ≥ 22.18 führt `.ts` direkt aus (Type Stripping). Der Code nutzt deshalb nur „erasable syntax“, also keine Enums und keine Parameter-Properties. Das spart Ressourcen und Angriffsfläche.
2. **Core ist rein.** `src/core` enthält kein I/O. Dieselbe Logik soll später in Windows- und Android-Shells laufen.
3. **Priorität ≠ Berechtigung.** Jede Übernahme prüft Rolle, Sender, Sperre, Health und Policy. Bei gleicher Priorität bleibt die sendende Quelle, damit das Verhalten deterministisch ist.
4. **Abweichung zu laut.fm, bewusst gewählt.** Bei laut.fm wird die verdrängte Quelle getrennt. AirDeck hält sie verbunden im *Standby*, damit der Fallback ohne Neuverbindung sofort greift. Nach außen, etwa zu laut.fm, wird nur `?prio=` gesetzt. Mehr ist dort nicht belegt (siehe `handover/10_REFERENCE/SOURCE_PRIORITY_NOTES.md`).
5. **Nach einem Neustart sind alle Quellen getrennt.** Sie müssen sich neu verbinden. So entstehen nie zwei konkurrierende aktive Quellen.
6. **Anti-Flapping.** Eine Quelle muss 2 s stabil verbunden sein, bevor sie automatisch übernimmt (`stableMs`). Ist gar keine Quelle aktiv, geht sie sofort auf Sendung.
7. **Formatwechsel beim Takeover.** Ausgänge verbinden sich mit dem Content-Type der neuen Quelle neu. Bei WebM/Ogg wird der Container-Header (erster Chunk) zuerst gesendet. Mithörer werden bei einem Formatwechsel getrennt.
8. **Live-Audio verwirft statt zu puffern.** Pro Ausgang gilt ein Puffer-Limit von 512 KB. Darüber werden Chunks verworfen und gezählt.
9. **Secrets.** Sie liegen AES-256-GCM-verschlüsselt in `data/secrets.json`. Die API zeigt nur `hasPassword`, und Audit-Log sowie Antworten enthalten keine Secrets. API-Tokens werden nur als SHA-256-Hash gespeichert.
10. **Studio-Stream.** Der Browser nimmt die Master-Summe per `MediaRecorder` als WebM/Opus in 1-s-Chunks auf und sendet sie per `POST …/chunks` an die Automation-Quelle. Grund: fetch-Streaming-Uploads funktionieren über HTTP/1.1 nicht zuverlässig.
11. **Kein LUFS-Versprechen.** Die Meter zeigen RMS und Peak. Eine echte LUFS-Messung (K-Gewichtung) ist noch offen.

## API (Auszug)

Alle Pfade liegen unter `/api/v1`. Auth läuft über `Authorization: Bearer <token>`. Nur GET-Streams wie SSE und `<audio>` akzeptieren zusätzlich `?token=`.

| Bereich | Endpunkte | Scope |
|---|---|---|
| Sender | `GET/POST /stations`, `GET/PATCH /stations/{id}` | `branding:read`, `stations:write` |
| Quellen | `GET/POST …/sources`, `PATCH/DELETE …/sources/{id}`, `POST …/{id}/takeover` (`{force}`), `…/release`, `…/password`, `…/health`, `…/chunks` | `sources:read/write` |
| Ausgänge | `GET/POST …/outputs`, `PATCH/DELETE …/outputs/{id}` | `outputs:read/write` |
| Medien | `GET …/media`, `PUT …/media?name=&category=`, `PATCH/DELETE …/media/{id}`, `GET …/media/{id}/file` (Range) | `media:read/write` |
| Queue | `GET …/queue`, `POST …/queue`, `…/queue/next`, `…/queue/fill`, `…/queue/clear`, `…/queue/{uid}/move`, `DELETE …/queue/{uid}` | `queue:read/write` |
| Automation | `GET/PATCH …/automation`, `GET/POST …/now-playing`, `GET …/decks`, `PUT …/decks/{A-D}` | `automation:*`, `now_playing:read` |
| Cardwall | `GET …/cardwall`, `PATCH …/cardwall/{slot}`, `POST …/cardwall/{slot}/trigger` | `cardwall:*` |
| Events | `GET /events?station=` (SSE) | Token |
| System | `GET /health` (öffentlich), `GET /me`, `GET /capabilities`, `GET /audit`, `GET/POST/DELETE /tokens` | `audit:read`, `tokens:write` |

Außerhalb der API: `PUT|SOURCE /ingest/{sender}/{mount}` für Encoder (Basic Auth) und `GET /listen/{sender}/{mount}?token=` zum Mithören (`stream:read`).
