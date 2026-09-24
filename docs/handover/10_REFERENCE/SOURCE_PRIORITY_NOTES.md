# Source Priority — Reference Notes

`08_IMAGES/1000137952_lautfm_source_priority.jpg` ist vom Nutzer bereitgestellte Evidence aus dem laut.fm-Kontext.

Beschrieben wird:
- `?prio=<positive integer>`
- kleinere Zahl = höhere Priorität
- höhere Priorität kann niedrigere verdrängen
- Anwendungsfälle: DJ-Handover und AutoDJ + Live Source

Engineering-Entscheidung: nicht als laut.fm-only Sondercode bauen, sondern als generische Source Priority Engine in der eigenen Live-/Relay-Automation. Bei laut.fm nur nutzen, soweit der aktuelle technische/vertragliche Mechanismus dies erlaubt.
