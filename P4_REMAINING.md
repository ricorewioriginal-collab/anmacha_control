# P4 – verbleibende Arbeit

Arbeitsstand: Default-Branch `AirDeck-Radio-Automation-&-Broadcast`. Letzter P4-Fix: `54fe05b` (Linux: ffmpeg Pflichtabhängigkeit); CI-Evidenz wird fortlaufend ergänzt.

## Beta-Blocker

1. Vollständigen Zero-to-Air-UI-Workflow mit Standardstream und hörbarem Audio auf sauberer Installation nachweisen.
2. Linux: Pflichtabhängigkeit ist mit `54fe05b` behoben und der Debian-Paket-/systemd-Test in CI grün. Noch offen: vollständige Clean-Install-/Reboot-/Upgrade-/TLS-Abnahme.
3. Backup/Restore auf frischer Instanz: Passwort-geschützter portabler Secret-Export, Import über UI, Medienoption, Konfiguration, Retention; anschließend echtes Audio. Aktuelles Backup ist keine vollständige Disaster-Recovery-Sicherung.
4. Windows-Dienst ohne Login, Android-Gerät/Emulator, Docker-Persistenz und Clean-Install-/Upgrade-Matrix qualifizieren.
5. Update-Kanäle, Backup vor Migration, transaktionaler Rollback und Versionsidentität.
6. Funktionale Systemdiagnose und vollständige plattformbezogene UI-Abnahme.
7. SFTP, Erweiterungen/Safe Mode und Bugreport-Zentrale gemäß Masterprompt vervollständigen; nicht stillschweigend als V1.1 ausklammern.
8. RBAC/IDOR/XSS, mindestens drei Sender, Chaos, große Bibliothek, Storage und 24–72h-Soak.
9. Releasebezogene Runtime-/Lizenzinventur, reproduzierbare Artefakte und Demo mit Audio.

## Nächster konkreter Schritt

Der senderbezogene Stream-Gesamtstatus ist bereits mit Merge `21057bc` korrigiert und regressionsgetestet. Linux-FFmpeg-Pflichtabhängigkeit ist mit `54fe05b` behoben. Nächster Beta-Blocker: Zero-to-Air/Clean-Install real nachweisen; parallel Windows-Installer-CI vollständig abschließen. Danach Backup/Restore und Systemdiagnose.

## Grenzen der bisherigen Evidenz

Keine echte laut.fm-/Nextcloud-Zugangsdatenprüfung. Keine isolierte Windows-VM/Android-Geräteabnahme. Kein gestarteter Langzeittest. Vorhandene Tests prüfen häufig Backend/API; sie erfüllen allein nicht die UI-Definition-of-Done.
