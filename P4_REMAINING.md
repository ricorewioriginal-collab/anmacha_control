# P4 – verbleibende Arbeit

Ausgangscommit: 296b799. Arbeitsbranch: codex/p4-beta-qualification.

## Beta-Blocker

1. Vollständigen Zero-to-Air-UI-Workflow mit Standardstream und hörbarem Audio auf sauberer Installation nachweisen.
2. Linux: FFmpeg als Pflichtabhängigkeit deklarieren und Installation ohne Recommends prüfen.
3. Backup/Restore auf frischer Instanz: Passwort-geschützter portabler Secret-Export, Import über UI, Medienoption, Konfiguration, Retention; anschließend echtes Audio. Aktuelles Backup ist keine vollständige Disaster-Recovery-Sicherung.
4. Windows-Dienst ohne Login, Android-Gerät/Emulator, Docker-Persistenz und Clean-Install-/Upgrade-Matrix qualifizieren.
5. Update-Kanäle, Backup vor Migration, transaktionaler Rollback und Versionsidentität.
6. Funktionale Systemdiagnose und vollständige plattformbezogene UI-Abnahme.
7. SFTP, Erweiterungen/Safe Mode und Bugreport-Zentrale gemäß Masterprompt vervollständigen; nicht stillschweigend als V1.1 ausklammern.
8. RBAC/IDOR/XSS, mindestens drei Sender, Chaos, große Bibliothek, Storage und 24–72h-Soak.
9. Releasebezogene Runtime-/Lizenzinventur, reproduzierbare Artefakte und Demo mit Audio.

## Nächster konkreter Schritt

Senderbezogenen Stream-Gesamtstatus korrigieren und prüfen: Ein verbundener fremder Sender verdeckt aktuell den Fehler des eigenen Senders. Danach Linux-Abhängigkeit und Zero-to-Air prüfen.

## Grenzen der bisherigen Evidenz

Keine echte laut.fm-/Nextcloud-Zugangsdatenprüfung. Keine isolierte Windows-VM/Android-Geräteabnahme. Kein gestarteter Langzeittest. Vorhandene Tests prüfen häufig Backend/API; sie erfüllen allein nicht die UI-Definition-of-Done.
