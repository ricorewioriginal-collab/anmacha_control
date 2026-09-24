# Claude Code + Git + Cloud Workflow

Git-Zugriff ist vorhanden; Claude Code Cloud steht mit kostenlosem Budget zur Verfügung.

## Vor größerer Änderung
```bash
git status --short
git branch --show-current
git log -5 --oneline
```

## Branching
Vorhandene Repository-Konventionen haben Vorrang. Sonst z. B.:
- `feature/live-relay-source-priority`
- `feature/live-relay-monitoring`
- `feature/ai-radio-director`
- `feature/airdeck-core`

## Commit-Prinzip
Kleine logisch geschlossene Commits, z. B.:
```text
feat(live-relay): add source priority domain model
feat(live-relay): implement takeover state machine
feat(live-relay): integrate priority with relay source manager
fix(live-relay): prevent takeover flapping
test(live-relay): add source priority integration tests
```

## Nie ohne Freigabe
- `git reset --hard`
- `git clean -fd` auf unbekannten Dateien
- Force Push
- produktive Migrationen löschen
- Secrets aus Repository/Logs extrahieren
- Produktionsfunktion blind ersetzen

## Cloud-Budget effizient nutzen
1. Audit einmal durchführen.
2. Audit-Ergebnis speichern.
3. Phase in Teilaufgaben zerlegen.
4. Nach jedem Block testen und committen.
5. Nächste Aufgabe auf bestehender Dokumentation aufbauen.
6. Keine wiederholten Voll-Repository-Analysen.

## Fortschritt
Eine Datei wie `docs/CLAUDE_PROGRESS.md` führen mit Current phase, branch, last commit, tests, known issues, next task, blockers und architecture decisions.

## Secret Hygiene
`.env*`, API Keys, Tokens und private Schlüssel schützen; Logs redigieren; keine Secrets in Screenshots/Issues.
