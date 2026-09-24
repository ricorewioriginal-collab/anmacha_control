# KI Tools Implementation Order

## Relationship to Phase 1
This is a **Phase 1 extension / Phase 1.5 gate**.

Claude Code may audit KI Tools while Phase 1 Live/Relay work is underway. Production implementation should be interleaved only where it does not destabilize the Live/Relay work. Otherwise complete the critical Phase 1 Live/Relay milestones first, then execute this package immediately.

**Phase 2 AI Radio Director must not start until this reliability gate is passed.**

## Recommended commits
1. `audit: map existing KI Tools provider/model/auth flows`
2. `fix: normalize provider health and model capability resolution`
3. `fix: repair AI tool response validation and empty-state handling`
4. `fix: stabilize Suno auth/result/download lifecycle`
5. `fix: complete ElevenLabs capability-aware settings`
6. `feat: add normalized AI usage ledger`
7. `feat: add admin AI cost and budget dashboard`
8. `feat: add teamkey budget hints and enforcement`
9. `test: add AI Tools reliability regression suite`

## Important
Do not rewrite the entire KI Tools subsystem if existing components can be repaired and reused.
