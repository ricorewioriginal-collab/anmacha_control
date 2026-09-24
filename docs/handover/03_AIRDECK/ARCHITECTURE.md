# AirDeck Architektur

```text
                         AIRDECK
                  RADIO AUTOMATION PLATFORM
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
       Windows           Android          Self-Hosted
        Studio            Mobile             Server
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
                       AIRDECK CORE
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   Automation          Live Studio        Broadcast I/O
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
           Icecast       SHOUTcast       Relay
              │             │             │
              └─────────────┼─────────────┘
                            │
                         laut.fm*

* nur über reale, erlaubte Schnittstellen.
```

## Adapter
Broadcast Adapter, Cloud Adapter, AI Adapter, TTS Adapter, Widget Adapter, External Provider Adapter, Hardware Adapter.

## Core-Prinzip
Der Core kennt keine AnMaCha-Abhängigkeit.

## Multi-Station
Senderkonfigurationen isolieren Branding, Media, Scheduler, Credentials, Widgets und Rechte.
