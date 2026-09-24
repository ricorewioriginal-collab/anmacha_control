# Phase 1 Implementation Plan — Live/Relay zuerst

## Step 0 — Audit
- [ ] Live/Relay entry points
- [ ] Source handling
- [ ] Encoder
- [ ] Relay
- [ ] Existing takeover
- [ ] Auth/RBAC
- [ ] DB models
- [ ] UI
- [ ] Tests

## Step 1 — Domain
- [ ] Source entity
- [ ] Priority validation
- [ ] Capabilities
- [ ] Permissions
- [ ] Health
- [ ] Fallback

## Step 2 — Engine
- [ ] Priority resolver
- [ ] Active source resolver
- [ ] Takeover state machine
- [ ] Debounce
- [ ] Audit events

## Step 3 — Integration
- [ ] Relay connection
- [ ] Encoder
- [ ] Metadata
- [ ] Now Playing
- [ ] Monitoring

## Step 4 — UI
- [ ] Source list
- [ ] Priority editor
- [ ] Active source indicator
- [ ] Takeover button
- [ ] Source health
- [ ] Audit history

## Step 5 — Resilience
- [ ] Disconnect
- [ ] Reconnect
- [ ] Network failure
- [ ] Encoder failure
- [ ] Silence
- [ ] Fallback
- [ ] Restart

## Step 6 — Tests
- [ ] Unit
- [ ] Integration
- [ ] End-to-end
- [ ] Concurrency
- [ ] Recovery
