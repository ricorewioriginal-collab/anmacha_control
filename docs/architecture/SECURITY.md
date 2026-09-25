# Sicherheit

| Thema | Festlegung | Stand |
|---|---|---|
| Transport | HTTPS über Reverse Proxy (Caddy) für alles außerhalb des LAN | Vorlage fehlt noch |
| Benutzer | Konten auf **jeder** Installation, Admin-Konto im Setup | vorhanden, bisher nur im Servermodus |
| Passwörter | scrypt mit Salz, nie im Klartext, Mindestlänge 10 | vorhanden |
| Sitzungen | zufälliges Token, nur als Hash gespeichert, 12 h gleitend, Abmelden beendet sie | vorhanden |
| Geräte | Kopplung per Code/QR → Geräte-Token mit Scopes, einzeln widerrufbar | neu |
| API-Tokens | Scopes, Sender-Bindung, nur als Hash gespeichert | vorhanden |
| RBAC | Rollen Administrator, Sendeleitung, Redaktion, Moderation, Ansicht, je Sender | vorhanden |
| Anmeldeschutz | Sperre nach 5 Fehlversuchen (15 min), gleiche Antwortzeit bei unbekannten Namen | vorhanden |
| Rate-Limits | pro Token/Sitzung | vorhanden |
| Secrets | AES-256-GCM, Schlüssel getrennt von den Daten | vorhanden |
| Logs | keine Passwörter, keine Tokens, keine API-Keys | vorhanden, wird mit Tests abgesichert |
| Audit | alle Anmeldungen, Rechteänderungen, Übernahmen, Konfigurationsänderungen | vorhanden (Datei), künftig zusätzlich Datenbank |
| Datenbank | nie direkt vom Client erreichbar, eigener Datenbankbenutzer mit minimalen Rechten | neu |
| Öffentliche Endpunkte | nur Health (ohne Details), Status/Widget (pro Sender abschaltbar), APK-Download, Anmeldung | vorhanden |
| Updates | Prüfsumme (SHA-256), optional Code-Signatur (Windows/Android) | vorhanden, Signatur braucht Zertifikate |
