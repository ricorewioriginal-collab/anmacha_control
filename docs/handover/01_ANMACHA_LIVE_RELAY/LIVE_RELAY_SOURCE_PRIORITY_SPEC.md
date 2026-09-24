# Live/Relay — Source Priority Engine

## Ziel
Mehrere Sendquellen können denselben Sender/Mountpoint bedienen. Die Engine entscheidet anhand einer positiven Ganzzahl, welche Quelle Vorrang hat.

**Smaller number = higher priority.**

| Quelle | Priority | Rolle |
|---|---:|---|
| Live Studio | 1 | höchste Live-Quelle |
| Remote Studio | 2 | Remote DJ |
| Android Live | 3 | Mobile Studio |
| Automation | 10 | Regelbetrieb |
| Backup Automation | 20 | Fallback |
| Emergency | 100 | Policy-gesteuert |

## Anforderungen
- positive Integer > 0
- senderbezogen
- sourcebezogen
- RBAC/Permissions
- Target/Mountpoint
- Health Check
- Atomic Takeover
- Audit Log
- Debounce gegen Flapping
- optional Cooldown/Grace Period
- Operator Override
- Emergency Override
- Fallback Source
- Simulation/Test Mode

Priority allein ist keine Berechtigung.

## State Machine
```text
DISCONNECTED → CONNECTING → STANDBY → TAKEOVER_PENDING → TAKING_OVER → ACTIVE
ACTIVE → FAILED → FALLBACK
ACTIVE → DISCONNECT → FALLBACK / STANDBY
```

## Events
`SOURCE_CONNECTED`, `SOURCE_HEALTH_CHANGED`, `SOURCE_PRIORITY_CHANGED`, `TAKEOVER_REQUESTED`, `TAKEOVER_APPROVED`, `TAKEOVER_REJECTED`, `TAKEOVER_STARTED`, `TAKEOVER_COMPLETED`, `SOURCE_DISPLACED`, `SOURCE_FAILED`, `FALLBACK_STARTED`, `FALLBACK_COMPLETED`.

## API-Idee
```http
GET  /api/v1/sources
POST /api/v1/sources
PATCH /api/v1/sources/{id}
POST /api/v1/sources/{id}/takeover
POST /api/v1/sources/{id}/release
GET  /api/v1/sources/{id}/health
GET  /api/v1/senders/{senderId}/active-source
```
Die konkreten Endpunkte müssen an die vorhandene API angepasst werden. Keine Parallel-API bauen, wenn bereits eine passende existiert.
