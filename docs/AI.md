# KI-Automation (AI Radio Director)

AirDeck kann einen Sender auf Wunsch vollständig von KI moderieren und musikalisch planen lassen. Dafür nutzt es deine eigenen API-Keys oder lokale Modelle. Die KI ist nie Single Point of Failure. Scheitert ein Aufruf, läuft die Sendeuhr weiter und nichts Unfertiges geht auf Sendung.

## Anbieter

| Aufgabe | Anbieter | Hinweise |
|---|---|---|
| Text | OpenAI, Anthropic (Claude), Google Gemini | eigener API-Key |
| Text | OpenAI-kompatibel | Ollama `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`, eigene Proxys; lokal ohne Key |
| Sprache | OpenAI TTS, ElevenLabs | eigener API-Key |
| Sprache | OpenAI-kompatibel | z. B. Kokoro-FastAPI `http://localhost:8880/v1` |
| Sprache | Piper | lokal/offline, Stimme = Pfad zur `.onnx` (z. B. Thorsten) |

- Keys liegen verschlüsselt im Secret-Store (AES-256-GCM) und werden nie angezeigt oder an den Browser geschickt.
- Modell- und Stimmenlisten werden beim Anbieter abgefragt. AirDeck gibt keine Modelle vor.
- Pro Aufgabe gibt es Primär und Fallback. Fehler, Zeitüberschreitungen, leere Antworten und Ablehnungen des Modells führen zum Fallback, danach zum Überspringen.

## Director (pro Sender)

- **Moderation** nach jedem n-ten Musiktitel. Kontext: Uhrzeit, gerade gelaufener und nächster Titel, letzte Titel, Wetter-/Info-Quellen. Der Text wird gesäubert (kein Markdown, keine Regieanweisungen) und auf die Wortzahl begrenzt. Danach wird er vertont und direkt vor den nächsten Titel gesetzt.
- **Nachrichten zur vollen Stunde** entstehen nur aus hinterlegten Quellen (RSS/JSON/Text). Ohne erreichbare Quelle entfallen sie. Es wird nichts erfunden.
- **KI-Musikplanung:** Die KI wählt aus einer zufälligen Kandidatenliste freier Titel, geschützt durch Rotation und ohne gerade gespielte Titel. Die Antwort wird streng geprüft: nur bekannte Kürzel, keine Doppelten. Optional wird alle n Titel eine Station-ID bzw. ein Jingle eingefügt. Die Sendeuhr springt ein, sobald die Queue leer ist.
- **Freigabe (optional):** Moderationen landen erst nach Prüfung in der Queue. Nach 30 Minuten verfallen sie.
- **Protokoll:** Jede Entscheidung wird im Studio, im Audit-Log und per Live-Ereignis `ai.decision` festgehalten, mit Anbieter, Modell, Kosten und Dauer.
- Alte KI-Sprachdateien werden automatisch aufgeräumt (Einstellung „behalten“).

## Kosten & Budgets

Preise trägst du selbst ein, je 1 Mio. Ein-/Ausgabe-Token bzw. je 1 Mio. Zeichen. Ohne Preis werden nur Token und Zeichen gezählt. Budgets gelten pro Monat und pro Anbieter oder Sender:

- **Warnung:** Eintrag im Audit-Log.
- **Stopp:** Der Anbieter bzw. Sender wird bis Monatsende nicht mehr genutzt. Der Fallback oder die Sendeuhr übernimmt.

## Werkzeuge

- **Assistent:** Spots, Station-IDs, Sendungsideen, Hörergrüße.
- **Voice Studio:** Text vertonen und in die Bibliothek legen (Ordner „KI-Studio“, Kategorie wählbar).

## API

| Methode | Pfad | Recht |
|---|---|---|
| GET/PUT | `/api/v1/ai/settings` | globaler Admin |
| GET | `/api/v1/ai/usage` | globaler Admin |
| GET | `/api/v1/ai/providers/:id/models`, `/voices` | globaler Admin |
| GET/PUT | `/api/v1/stations/:sid/ai` | `ai:read` / `ai:write` |
| POST | `/api/v1/stations/:sid/ai/moderation` `{kind: 'break'\|'news'}` | `ai:write` |
| POST | `/api/v1/stations/:sid/ai/music` | `ai:write` |
| POST | `/api/v1/stations/:sid/ai/pending/:id/approve` \| `reject` | `ai:write` |
| POST | `/api/v1/stations/:sid/ai/text` `{prompt}` | `ai:write` |
| POST | `/api/v1/stations/:sid/ai/speech` `{text, title, category}` | `ai:write` |

## Offen (TODO)

- Google-/Azure-TTS und CosyVoice als eigene Sprach-Anbieter (CosyVoice lässt sich über einen OpenAI-kompatiblen Server anbinden)
- Hörerwünsche/Studiomail als Moderationskontext
- Transkription (Speech-to-Text) für Mitschnitte
