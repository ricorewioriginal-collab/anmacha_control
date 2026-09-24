# Live/Relay Target Architecture

```text
                     SENDER
                        │
                 Source Manager
                        │
              Source Priority Engine
                        │
          ┌─────────────┼─────────────┐
          │             │             │
      Live Studio   Remote/Android  Automation
          │             │             │
          └─────────────┼─────────────┘
                        │
                 Takeover Manager
                        │
                 Audio / Relay Core
                        │
          ┌─────────────┼─────────────┐
          │             │             │
         DSP         Encoder      Metadata
          │             │             │
          └─────────────┼─────────────┘
                        │
               Broadcast Adapter
                        │
          Icecast / SHOUTcast / Relay
```

Audio-/Relay-Kern nicht direkt von UI-Buttons abhängig machen. UI sendet Commands/Events an Domain Services.

Source-Konfiguration persistent speichern. Secrets nicht als Klartext in Tabellen/Logs.

Monitoring mindestens: active source, priority, connection health, bitrate, codec, silence, metadata freshness, encoder state, relay state, last takeover, fallback state.

Recovery muss nach Prozess-/Netzwerkneustart den gewünschten Zustand rekonstruieren, ohne unkontrollierte konkurrierende aktive Quellen.
