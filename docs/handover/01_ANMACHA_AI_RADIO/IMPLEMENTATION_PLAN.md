# Implementierungsplan Priorität 1

## Phase A — Audit
1. vorhandene Automation lokalisieren
2. vorhandene KI lokalisieren
3. vorhandene TTS/LLM-Funktionen lokalisieren
4. Sendeplan/Scheduler lokalisieren
5. Music Library/Metadata lokalisieren
6. Event/URL/Relay-Funktionen lokalisieren
7. Encoder/Streamstatus lokalisieren
8. Fehler- und Fallbackpfade prüfen

## Phase B — AI Director Core
- State Machine
- Senderprofil
- Regeln
- Context Builder
- Decision Engine
- Event Scheduler
- Queue Controller

## Phase C — AI Content
- TTS
- News
- Humor
- Voice Tracking
- Community/Voicemail
- dynamische Moderation

## Phase D — Broadcast
- Deck/Queue Integration
- Ducking
- Crossfade
- Jingles
- Backtiming
- Stream metadata
- Silence Monitor
- Emergency fallback

## Phase E — 24/7 Stabilität
- Recovery
- Retry/Timeout
- provider health
- persistent queue
- watchdog
- monitoring
- alerts

## Phase F — UI
Bestehende Automation um AI Director Status, nächste Entscheidung, Queue, Events und Override erweitern. Keine neue unnötige Hauptseite.
