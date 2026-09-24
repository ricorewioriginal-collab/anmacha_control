# Phase 1 Acceptance Tests

## Priority
- [ ] Priority 1 displaces Priority 10 when authorized.
- [ ] Priority 10 does not displace Priority 1.
- [ ] Equal priority has deterministic policy.
- [ ] 0 rejected.
- [ ] negative values rejected.
- [ ] non-integers rejected.
- [ ] unauthorized takeover rejected.
- [ ] wrong sender rejected.

## Stability
- [ ] disconnect fallback
- [ ] network flap without takeover storm
- [ ] restart reconstructs state
- [ ] metadata remains correct
- [ ] silence triggers fallback
- [ ] encoder failure surfaced

## Live
- [ ] live studio takeover
- [ ] remote studio takeover
- [ ] mobile source takeover where implemented
- [ ] automation return after release

## Regression
- [ ] playlists
- [ ] queue
- [ ] cardwall
- [ ] encoder
- [ ] sender configuration
