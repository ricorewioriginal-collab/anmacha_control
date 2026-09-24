# AI Tools Reliability & Cost Control — Phase 1 Extension

## Priority
This work is mandatory **during the later part of Phase 1 or immediately after Phase 1**, and must be completed before Phase 2 AI Radio Director work expands the AI layer.

Do not replace the existing AI infrastructure. Audit and repair the existing KI Tools implementation first.

## Current reported problems
The existing KI Tools area has multiple reliability problems:

1. **Suno**
   - generation now works in some cases;
   - generated songs cannot reliably be opened or downloaded;
   - UI/backend sometimes reports "nicht eingeloggt" although the connection is configured/connected.
2. **KI Assistant / data-driven tools**
   - responses sometimes contain empty or incomplete data;
   - examples include labels such as "Hörer" without a numeric value;
   - this occurs across multiple applications/tools.
3. **Model selection**
   - model selection is partially broken;
   - automatic selection can choose a model that is unavailable, unhealthy, incompatible, or otherwise fails;
   - a known-good fallback is required.
4. **Paid model providers**
   - providers configured with API keys work only partially;
   - authentication, model availability, provider errors, timeout handling, quota handling and fallback need a full audit.
5. **ElevenLabs**
   - provider is configured, but important settings are missing from the UI/configuration;
   - provider capability discovery should determine which settings are actually supported by the selected model/voice.
6. **Cost visibility**
   - admin.html needs a central cost/usage overview;
   - KI Tools need a visible budget/cost hint;
   - team members using a shared `teamkey` need transparent usage and remaining-budget information without seeing the secret itself.

## Required implementation

### A. Provider health and capability layer
Create/reuse a provider abstraction with:
- provider ID
- credential reference (never expose the secret)
- connection status
- auth status
- quota/rate-limit status where available
- model list/capabilities
- last successful request
- last failure
- latency
- health score/status
- supported operations

Every provider/model selection must be capability-aware.

### B. Model selection and fallback
Implement deterministic model resolution:
1. explicit user-selected model if available and healthy;
2. configured preferred model;
3. last known-good compatible model;
4. provider fallback model;
5. cross-provider fallback if configured and permitted;
6. clear failure state if no compatible model exists.

Never silently select an arbitrary model merely because it appears in a static list.

Maintain a small health cache with expiry and a lightweight provider/model test. Do not spam paid APIs with health checks.

If a model fails repeatedly, temporarily mark it unhealthy and do not keep retrying it in a tight loop.

### C. Generic AI response/data validation
For every KI Tool:
- define an explicit response schema;
- validate backend responses before rendering;
- distinguish `0`, `null`, `unknown`, `not available`, and `loading`;
- never render a bare metric label such as `Hörer` when the numeric value is missing;
- show a truthful fallback such as `Hörer: nicht verfügbar` or an equivalent localized state;
- preserve source and timestamp when data is external;
- log schema/parse failures with tool ID and request correlation ID.

No fabricated values.

### D. Suno reliability
Audit the entire flow, not just the UI:

`connection → authentication/session → request → generation job → job ownership → result persistence → audio asset → download/open URL → expiry/refresh → frontend state`

Specifically test:
- connected state vs actual authenticated API/session state;
- token/session refresh;
- backend-vs-frontend auth mismatch;
- generated job IDs and ownership;
- persistence of generated tracks;
- signed/temporary download URLs and refresh;
- browser download permissions and content-disposition;
- retry/idempotency without duplicate paid generation;
- reconnect/re-authentication;
- generation history after page reload;
- download after delayed generation.

The UI must never say "nicht eingeloggt" solely because a cached frontend state is stale.

If Suno uses an official/authorized authentication or API mechanism, use that mechanism. Do not bypass authentication, scrape private endpoints, or invent undocumented APIs.

### E. Paid model provider reliability
For every configured paid provider:
- validate key without exposing it;
- validate account/provider availability;
- retrieve or maintain a capability/model registry;
- test one minimal request where appropriate;
- classify failures: auth, permission, quota, rate-limit, model-unavailable, timeout, network, provider-error, invalid-request;
- show actionable diagnostics in admin;
- use configured fallbacks;
- never retry non-retryable billing/auth failures endlessly.

### F. ElevenLabs settings
Do not hard-code settings that a selected ElevenLabs model/voice does not support.

Expose supported configuration dynamically where available, for example:
- voice
- model
- output format
- language/locale
- stability
- similarity/style controls where supported
- speaker boost where supported
- speed where supported
- pronunciation/dictionary controls where supported
- normalization/output options where supported

The UI should clearly indicate which settings are provider/model/voice dependent.

### G. Central AI usage/cost ledger
Implement a normalized usage ledger for all KI Tools/provider calls.

Minimum fields:
- timestamp
- request/correlation ID
- sender ID if applicable
- user/team member ID if applicable
- tool ID
- provider
- model
- credential reference type (`own_key`, `teamkey`, etc.) — never the secret
- operation
- input usage where available
- output usage where available
- media duration/characters/credits where applicable
- provider-reported cost where available
- calculated/estimated cost where provider does not return a price
- currency
- cost source/version
- success/failure
- error category

Cost records must be immutable/auditable. Corrections should be represented as adjustments rather than silently rewriting history.

### H. Cost calculation
Prefer provider-reported billing/usage data when an official API exposes it.
Otherwise calculate an estimate from a versioned local pricing table and mark it clearly as `estimated`.

Never present an estimate as an invoice or exact provider bill.

Pricing tables must be updateable without code changes where practical.

### I. admin.html — cost dashboard
Add a dedicated cost/usage area to `admin.html` with:
- current period
- today / 7 days / 30 days / custom range
- total estimated/reported cost
- by provider
- by model
- by tool
- by sender
- by user/team member
- by teamkey credential group
- successful vs failed calls
- token/character/credit/media usage where available
- budget consumption
- remaining budget
- projected usage/cost where enough data exists
- alerts and threshold breaches
- provider health
- last errors

Clearly distinguish `reported` from `estimated` costs.

### J. Teamkey budget visibility in KI Tools
When a team member uses a configured shared `teamkey`, the tool UI should show a compact, non-sensitive budget hint, for example:
- `Team-Budget: 68% verfügbar`
- `Monat: 12,40 € / 50,00 €`
- `Heute: 3,10 €`

Exact display can follow the existing design system.

Never reveal:
- API keys
- full credential identifiers
- secret provider responses containing credentials

The budget display must be permission-aware.

### K. Budget controls
Support:
- soft budget warning
- hard budget limit
- per-teamkey budget
- per-user budget where configured
- per-tool limit where configured
- per-provider limit where configured
- optional daily/monthly reset
- configurable warning thresholds
- optional automatic block/fallback when hard limit is reached

A blocked paid operation must return a clear reason and must not silently incur another paid request.

### L. Admin diagnostics
Admin needs a provider diagnostics view:
- Test connection
- Test authentication
- Test selected model
- Show last success
- Show last failure
- Show latency
- Show quota/limit information where officially available
- Show fallback chain
- Show whether current model is healthy

Tests must be designed to avoid unnecessary paid consumption.

## Security requirements
- API keys/secrets stay in secure secret storage.
- Never write secrets to logs, analytics, Git, client-visible API payloads or cost records.
- Teamkey users see budget information, not credentials.
- Cost/usage endpoints enforce RBAC.
- Admin audit logs record configuration changes and budget-limit changes.

## Required tests
- Suno generate → persist → reload → open → download.
- Suno expired-session/re-auth flow.
- Suno frontend/backend auth mismatch.
- Model unavailable → fallback.
- Model timeout → bounded retry → fallback.
- Auth failure → no endless retry.
- Provider quota/rate limit → correct classification.
- Missing metric value → no empty numeric UI.
- ElevenLabs supported/unsupported settings.
- Teamkey budget display.
- Budget warning threshold.
- Hard budget block.
- Reported vs estimated cost rendering.
- Admin aggregation by provider/model/tool/user/teamkey.
- No secret leakage in logs/responses.
- Regression tests for all existing KI Tools.

## Definition of Done
KI Tools must fail explicitly and diagnostically rather than appearing connected while failing underneath. Generated Suno results must remain usable after generation and page reload. Model selection must choose only compatible/healthy models. Paid providers must expose actionable diagnostics. ElevenLabs must expose supported settings. Admin must provide auditable usage/cost visibility, and team members using `teamkey` must see their remaining budget without access to the key itself.
