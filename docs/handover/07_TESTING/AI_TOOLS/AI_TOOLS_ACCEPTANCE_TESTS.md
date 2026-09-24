# AI Tools Reliability & Cost — Acceptance Tests

## Suno
- [ ] Connected status reflects actual usable authentication/session state.
- [ ] Generation succeeds without duplicate paid requests during retries.
- [ ] Generated track persists after page reload.
- [ ] Generated track opens from history.
- [ ] Generated track downloads successfully.
- [ ] Expired/invalid session triggers controlled re-authentication.
- [ ] Backend and frontend auth state cannot drift silently.
- [ ] Temporary download URLs are refreshed when required.
- [ ] Failed downloads produce actionable diagnostics.

## AI Assistant / Data Tools
- [ ] No metric label is rendered without a value.
- [ ] 0 is shown as 0, not treated as missing.
- [ ] null/unknown/not-available states are distinct.
- [ ] External data source and timestamp are retained where applicable.
- [ ] Schema validation catches malformed responses.
- [ ] No fabricated values are inserted.

## Model Selection
- [ ] Explicit healthy model is respected.
- [ ] Unavailable model is rejected or replaced by configured fallback.
- [ ] Last-known-good fallback works.
- [ ] Repeated failures temporarily quarantine the unhealthy model.
- [ ] Auth/quota failures do not cause endless retries.

## Paid Providers
- [ ] Configured API key is validated without exposure.
- [ ] Auth, permission, quota, rate-limit, timeout and provider errors are distinguishable.
- [ ] Minimal diagnostic tests do not create unnecessary paid usage.
- [ ] Fallback chain is visible to admins.

## ElevenLabs
- [ ] Supported voice/model settings are available.
- [ ] Unsupported settings are hidden/disabled instead of sent blindly.
- [ ] Provider/model/voice-dependent settings are labeled.
- [ ] Voice generation and error handling work end-to-end.

## Costs / Budgets
- [ ] Every billable AI operation creates a usage ledger entry.
- [ ] Provider-reported cost is marked reported.
- [ ] Calculated cost is marked estimated.
- [ ] admin.html aggregates by provider/model/tool/sender/user/teamkey.
- [ ] Teamkey users see budget status but never the secret.
- [ ] Soft warning is displayed at configured threshold.
- [ ] Hard limit blocks further paid calls when enabled.
- [ ] Budget block does not create a paid retry loop.
- [ ] Cost history is auditable and corrections are represented as adjustments.

## Security / Regression
- [ ] No secrets appear in logs.
- [ ] No secrets appear in client payloads.
- [ ] RBAC protects cost and provider diagnostics.
- [ ] Existing KI Tools continue to work after the refactor.
