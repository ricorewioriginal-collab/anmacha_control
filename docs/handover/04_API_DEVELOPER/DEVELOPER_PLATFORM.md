# AirDeck Developer Platform

## Ziel
Nutzer und externe Entwickler können AirDeck selbst erweitern.

## API-Bereiche
- stations
- branding
- now-playing
- next
- playlists
- queue
- decks
- cardwall
- automation
- schedule
- events
- stream
- encoder
- dsp
- widgets
- ai
- tts
- cloud
- integrations

## Events
Webhooks und optional WebSocket/Realtime Events für:
- now_playing.changed
- queue.changed
- automation.state_changed
- stream.state_changed
- event.triggered
- deck.state_changed
- ai.decision_created
- tts.ready

## Security
Scopes, RBAC, token rotation, rate limits, audit logs, signed webhooks, secret isolation.

## Plugin System
Plugin Manifest → Permission Request → Install → Enable → Health Check → Disable/Uninstall.

## Sandbox
Entwickler können Erweiterungen testen, ohne produktive Automation zu gefährden.
