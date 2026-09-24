# AI Radio — after Live/Relay

Diese Phase beginnt erst nach erfolgreicher Stabilisierung der Live-/Relay-Automation.

## AI Director
Senderbezogene Policies für content, music, moderation frequency, voice profile, news topics, humor, AI/non-AI ratio, takeover permissions und fallback.

## Engine
```text
Scheduler → AI Director → Content Planner → Event Engine → Audio Builder → Queue → Playback
```

AI-Ausfall darf die laufende Sendung nicht stoppen.
