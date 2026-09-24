# AirDeck + AnMaCha — Complete Claude Code Handover

Stand: 24.09.2026

## Entwicklungsreihenfolge
1. **Bestehende eigene Live-/Relay-Automation zuerst vollständig ausbauen.**
2. **AnMaCha AI Radio Director** danach vollständig integrieren.
3. **Standalone AirDeck** danach als unabhängiges Produkt für Windows, Android und Self-Hosted.
4. Gemeinsames Design/UX erst anschließend optional übertragen.

## Wichtigste neue Festlegung
Die **Source Priority Engine** gehört direkt in die bestehende eigene Live-/Relay-Automation und ist dort eine Kernfunktion.

- positive Ganzzahlen
- kleinere Zahl = höhere Priorität
- z. B. Priority 1 kann Priority 10 übernehmen, wenn Ziel, Berechtigung und Policy passen
- generisch für eigene Quellen; später wiederverwendbar für AirDeck und laut.fm, soweit technisch/vertraglich zulässig

## Grundprinzip
Erst realen Bestand analysieren, dann gezielt erweitern. Keine unnötigen Parallel-Systeme und keine Abhängigkeit der bestehenden Automation von AirDeck/AnMaCha.

## Claude Code / Git / Cloud
Der Nutzer hat Claude Code Git-Zugriff gegeben und nutzt Claude Code Cloud mit kostenlosem Budget. Claude soll deshalb:
- im vorhandenen Repository arbeiten
- vor größeren Änderungen Branch/Checkpoint nutzen
- kleine nachvollziehbare Commits erzeugen
- keine Secrets committen
- keine destruktiven Git-Befehle ohne Freigabe
- nach jedem relevanten Arbeitspaket testen
- Fortschritt dokumentieren
- bei Unklarheit zuerst Code lesen statt neue Architektur zu erfinden

## Start
Zuerst lesen:
- `00_START_HERE/CLAUDE_MASTERPROMPT_COMPLETE.md`
- `01_ANMACHA_LIVE_RELAY/LIVE_RELAY_SOURCE_PRIORITY_SPEC.md`
- `01_ANMACHA_LIVE_RELAY/LIVE_RELAY_TARGET_ARCHITECTURE.md`
- `09_GIT_CLAUDE_WORKFLOW/CLAUDE_CODE_WORKFLOW.md`
