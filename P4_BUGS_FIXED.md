# P4 – Fehlerkorrekturen

## Senderbezogener Streamstatus

Problem: GET /api/v1/stream filterte die Ausgangsliste nach Senderrechten, berechnete den Gesamtstatus jedoch über alle Sender. Ein fremder verbundener Ausgang ließ einen eigenen fehlerhaften Sender als connected erscheinen.

Änderung: derselbe Senderfilter gilt jetzt für Liste und Status. Regression: eigener Fehler, eigener verbundener Ausgang und keine sichtbaren Sender in test/health.test.ts. Server- und Studio-Typprüfung bestanden. Health-Tests: 4 bestanden, 1 mangels FFmpeg übersprungen, 0 fehlgeschlagen. Kein vollständiger UI-/RBAC-Gate-PASS allein durch diesen Test.
