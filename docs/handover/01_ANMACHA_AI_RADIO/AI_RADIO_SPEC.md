# AnMaCha — Vollständige KI-Radio-Funktion

## Ziel
Ein Sender kann nach Konfiguration vollständig KI-gesteuert und KI-moderiert 24/7 laufen. Der Mensch kann jederzeit übernehmen.

## AI Director
Der AI Director entscheidet innerhalb der vom Betreiber gesetzten Regeln über:
- Programmstruktur
- Musikrotation
- Moderationszeitpunkte
- Themen
- Jingles/Sweeper
- Events
- TTS
- Community-Inhalte
- News/Trend-Segmente
- Humor
- Übergänge
- Backtiming

## Senderprofil
- Zielgruppe
- Sprache
- Tonalität
- erlaubte Themen
- verbotene Themen
- Musikregeln
- AI-Musik-Anteil
- Moderationshäufigkeit
- maximale Moderationslänge
- feste Shows
- feste Events
- Voice Profile
- lokale/extern Provider

## Ablaufmaschine
IDLE → PREPARE → VALIDATE → CUE → PLAY → TRANSITION → NEXT

Jeder Schritt ist beobachtbar und wiederholbar.

## Human Override
- Sofort Live
- Deck Override
- Queue Override
- Pause AI Director
- Automation Manual
- Emergency Playlist
- Rückkehr zur AI nur nach definierter Regel

## Fallbacks
1. vorbereitete Moderation
2. lokale TTS
3. Bridge Library
4. Musikrotation
5. Emergency Playlist
6. Silence Monitor + Alarm

## Monitoring
- AI provider health
- TTS health
- queue health
- scheduler drift
- stream health
- encoder health
- silence
- CPU/RAM
- audio level/LUFS
- event latency

## Erfolgskriterium
Ein 24h-Test muss ohne manuellen Eingriff durchlaufen, inklusive simuliertem Ausfall von LLM/TTS/News/Netzwerk und anschließendem Recovery.
