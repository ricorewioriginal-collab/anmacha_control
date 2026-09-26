# P4 – Fehlerkorrekturen

## Senderbezogener Streamstatus

Problem: GET /api/v1/stream filterte die Ausgangsliste nach Senderrechten, berechnete den Gesamtstatus jedoch über alle Sender. Ein fremder verbundener Ausgang ließ einen eigenen fehlerhaften Sender als connected erscheinen.

Änderung: derselbe Senderfilter gilt jetzt für Liste und Status. Regression: eigener Fehler, eigener verbundener Ausgang und keine sichtbaren Sender in test/health.test.ts. Server- und Studio-Typprüfung bestanden. Health-Tests: 4 bestanden, 1 mangels FFmpeg übersprungen, 0 fehlgeschlagen. Kein vollständiger UI-/RBAC-Gate-PASS allein durch diesen Test.

## Linux-Paket ohne FFmpeg

Problem: Das Debian-Paket führte `ffmpeg` nur unter `Recommends`, obwohl Automation und Encoder davon abhängen. Mit `--no-install-recommends` konnte damit ein AirDeck ohne funktionsfähige Audio-Engine installiert werden.

Änderung: `packaging/linux/control` führt `ffmpeg` jetzt unter `Depends`. Commit `54fe05b`. CI Run 36270262561: Test, Docker, Docker ARM64, Linux und Android erfolgreich; der Linux-Job hat Paketbau, Installation, Dienststart, systemd-Neustart und Purge erfolgreich durchlaufen. Vollständige plattformbezogene Beta-Abnahme bleibt separat offen.
