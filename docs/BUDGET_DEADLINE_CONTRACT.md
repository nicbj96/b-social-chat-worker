# Chat budget, deadline and degradation contract (Plan §9 P186–191 / M41)

Status: implemented and tested on the `/chat` path (`src/index.ts`), unit
contract in `src/chat-provider.ts` (+ `chat-provider.test.ts`), request-path
probes in `src/index.budget-deadline.test.ts`. All behaviours are named and
honest: the reader is never given an invented completion, a fabricated result
set or a silent degradation.

## 1. Per-turn wall-clock deadline

- ONE deadline covers the whole turn: first model call, every tool call, the
  embedding call, and the follow-up model call. Default **8000 ms**
  (`CHAT_TURN_DEADLINE_MS` env override, tests use small values).
- Expiry raises the NAMED error `turn_deadline_exceeded`
  (`TurnDeadlineExceeded`), **distinct** from a model/upstream failure
  (`provider_*`, opens the AI breaker) and from the per-turn call caps
  (`TurnBudgetExceeded` → `budget_exhausted_*`).
- Deadline expiry never opens the AI breaker (the provider is not sick).
- **Deadline hit mid-tools** (adversarial case): no further tool starts; the
  follow-up model call is SKIPPED (exactly one model call is spent); the turn
  answers 200 with an honest PARTIAL reply built ONLY from tool evidence
  (`groundModelReply("")` renders verified rows), prefixed with the notice
  `Tidsgrænsen for svaret udløb. Her er det, der nåede at blive hentet — intet
  er gættet.`, plus `partial: true` and
  `degradation.reason: "turn_deadline_exceeded"`. `event_ids`/`place_ids`
  contain only what actually came back.

## 2. Session budget ledger (per-account, persisted)

- Cap: **20 turns / 24 h** (`SESSION_CHAT_BUDGET`) per account; logged-out
  turns scope to the hashed actor key (never a raw IP; same privacy rule as
  the rate limiter).
- Persisted account-scoped in the existing `RateLimitDurableObject` store
  under `session-chat-budget:v1:account:<userId>` /
  `...:anon:<actorPrefix>` — one atomic `consume` per validated turn
  (`Plan §9 P189`; invalid/model-free requests charge nothing because the
  charge sits after body validation).
- Exhaustion is a NAMED 429: `error: "session_budget_exhausted"`,
  `Retry-After` header, Danish notice "Du har brugt dagens chat-kvota. …",
  `degraded: true`. The model is never called for an exhausted account.
- Store missing or failing → fail OPEN with a loud
  `session_budget_unavailable` log (CLAUDE.md contract: a budget-store outage
  never takes chat down; the per-actor rate limiter still applies). The
  decision is then marked `persisted: false` — never fail-fake.

## 3. Resource caps (asserted, flagged — never silent)

| Cap | Value | Named behaviour |
|---|---|---|
| Embedding dimensions | 1024 (`cap_exceeded_embedding_dims`) | vector never reaches the RPC; the named error reaches the reader; no rows invented |
| Rows | 8 (`rows_capped: 8`) | collected events are capped with an explicit flag |
| Response bytes | 200 000 (`response_truncated: 200000`) | the reply is cut to fit and the cut is flagged on the payload |

## 4. Degraded provider fallback contract (fail-closed)

- Every model-call failure is classified: `provider_429` (429/quota/rate
  limit), `provider_timeout` (`AbortError`/`TimeoutError`/timeout text),
  `provider_error` (everything else).
- The fallback answer is the deterministic catalogue path
  (`catalogueFallbackForTurn`) — it queries the LIVE database on every
  degraded turn. **There is no cached or replayed "fake" answer anywhere in
  the contract.**
- The degraded response carries `degraded: true`,
  `degradation: { reason, notice, retry_after_seconds? }`, and for 429 also a
  `Retry-After` header (60 s) plus the Danish notice (Plan §9 P190).

## Response additions (additive; no existing field changed)

`partial?`, `degraded?`, `degradation?`, `rows_capped?`,
`response_truncated?`, `budget` (existing TurnBudget snapshot).
