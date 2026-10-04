# Deterministic discovery v1 — local integrated milestone, not release

Canonical chain: SearchIntent → Pages searchDiscovery.ts / Worker discovery-retrieval.ts → discovery_search_v1(jsonb,text,integer) → /soeg or /chat. Adapter bytes are identical and SHA-pinned alongside schema/fixtures by both check-discovery-contract scripts; Worker searchIntent.ts is only an import-path re-export. fetchDiscoveryPage(client,request,signal) / DiscoveryPage serve Søg, Kort and deterministic /chat. Optional SearchRequest.viewport is ViewState transport, never part of SearchIntent. Kort sends discovery_map_v1(jsonb,jsonb,text,integer); both RPCs call the same invoker discovery_page_v1 core after the additive viewport migration.

## SQL / data truth

Additive migration 20261004193000_discovery_search_v1.sql is registered in the canonical management runner, exact ledger, verify-only metadata and repo-safety checks. Old RPCs, policies and data remain unchanged. Production events public SELECT permits all statuses: explicit active/null eligibility remains essential. Local fixtures test both restrictive anon/auth RLS and permissive public SELECT, not hosted auth.

Same token-AND/accent/city-alias/typo motor with/without tags. Exact-token matches precede approximate matches, then date/type/id; date and distance sorts use stable tie breakers. All type/status/date/price/currency/tags/country/radius predicates precede limit+1. Tags union expanded slugs across legacy arrays/category and invoker junction views. Radius uses great-circle distance including dateline; world/country never borrow cached GPS.

Known end must be strictly after now; unknown end requires start at/after now. Date windows overlap known intervals, half-open at upper start bound. Places have N/A date/price, not free status. Region is explicitly unsupported: existing place-region text is not complete verified country/region identifier metadata for both entity types.

Nullable additions only: price_currency, price_evidence JSONB, event_timezone. No DKK/Copenhagen defaults, FX or backfill. Evidence fields: raw conditions, parser_version, source_uid, canonical_url, occurrence_start, observed_at, upstream_updated_at. Ingestion/population remains open. catalog_updated_at is events.content_updated_at / places.updated_at (confirmed by read-only live schema); it is NOT upstream time. source_updated_at remains null.

## Cursor and deadlines

Size clamps 1–50, null→20; server limit+1 owns hasMore. Continuation marker carries intent/role/claims/viewport identity, version, issued-at and rank/date/type/id. IMPORTANT: hex JSON is client-editable, not signed/encrypted. MD5 is a mismatch guard, NOT integrity/authentication. Issued-at checks are advisory only: clients can change time/key and replay pages. Never use it for security expiry, quotas, snapshots or authorization. Every call rechecks invoker RLS and eligibility. Query trim/case normalization agrees between JS key and SQL binding. No entity candidate-ID caps or guessed total.

consistency=live-keyset is NOT a frozen MVCC snapshot. Each page rechecks current membership/status. Concurrent edits may move/hide/introduce entities; reload starts again. Unchanged eligible data traverses completely and deterministically. UI deduplicates typed IDs, labels loaded count/hasMore, and never promises a frozen count.

Function config requests statement_timeout=4s; SDK abort deadline is 6s. Function SET metadata alone does NOT prove the hosted outer statement-cancellation deadline. Verify actual PostgREST role/transaction timeout/cancellation before release. Query-plan/production-size latency evidence is still open.

## Callers / release switch

/soeg uses VITE_DISCOVERY_V1_ENABLED=true only after migration/readback. OFF preserves legacy incomplete behavior. Enabled path uses the one RPC for empty query/filter browse, text and tags, forward pagination, AbortSignal/request-generation, preserved-intent retry and no model/embedding. Suggestions remain global legacy data, a separate §5 UX gate.

/chat explicit discovery_intent uses identical RPC, page size8, structured sources/verified_fields, applied_filters and nextCursor, no model/CC-forwarding. discovery_cursor is {intentKey,token}. Region→422; invalid→400; unavailable/missing migration→503 with applied_filters:null. Old caller bodies retain the legacy path. AIChatWidget now offers explicit “Søg med aktive filtre” (only behind the default-OFF flag). That mode sends validated private text as literal token search and active intent to existing /chat; NO model-derived filters/facts, no profile writes, no legacy hydration/sampling. It validates returned identity/filter/cursor/source fields and renders structured title/price/date, catalogue versus upstream timestamps, unknowns, empty/error/partial and paging. Normal chat and its auth/action gates remain. Suggested legacy tags require Anvend; Fortryd restores the actual prior tag selection. Full model filter proposals/grounding remain OPEN.

## Proof / gates

searchDiscoverySql.test.ts executes PGlite0.5.8 PostgreSQL, SDK→SQL, anon/auth roles, permissive eligibility, invoker views, keysets, ranking, beyond-old-cap eligibility, overlap/radius/tags/currency, nullable metadata and real management verify-only SQL. Soeg.discovery.test.tsx mounts actual providers/controls/SDK with HTTP substituted. Worker tests use the real handler/SDK. None proves live new-RPC operation.

OPEN: exact-commit independent review; protected migration/ledger/grants/source readback; hosted anon/auth/PostgREST and legacy repeated-OR proof; latency/plans/outer statement timeout; reviewed flag activation; new-RPC preflight in Worker release; mobile/browser-wide UI and performance acceptance; regions; source metadata ingestion; device/provider/performance/privacy/action gates. No push/merge/deploy or live data/schema mutations in this milestone.

## Map/handoff local milestone

Additive `20261004210000_discovery_viewport_v1.sql` registers a single shared engine plus search/map wrappers, revokes PUBLIC EXECUTE and preserves invoker roles. Bounded latitude/longitude eligibility (including wrapped longitude) is inside each candidate source BEFORE ranking/cap, alongside the same date/price/tags/radius predicates. Nullable/invalid/placeholder coordinates cannot become (0,0). Two additive B-tree coordinate indexes are proposals, not evidence of production latency; migration lock/build cost needs review. A large world viewport can still scan/rank many candidates. No production-volume EXPLAIN success or actual hosted outer cancellation is claimed; prior 12k-row full-scan evidence remains an OPEN release blocker. Do not infer bounded DB work from bounded response size.

Kort v1 fetches 50/page via the common SDK, uses server hasMore, aborts changed query/filter/viewport work and deduplicates typed identities. Pins and list use the loaded server set; list has no hidden 100-row cap. Carousel remains the existing 20-card visual subset; the complete loaded set is available in the list. Routes are explicitly excluded from the v1 catalogue, not appended unfiltered; legacy OFF routes remain unchanged. Manual/GPS radius is intent; camera pan/zoom is separate tab history. Wrapped Leaflet longitudes normalize before one map RPC.

Version-1 handoff uses URL-safe public intent plus full history.state. Same-tab Søg↔Kort and chat→Kort→normal preserve private text/intent and normal camera; /kort→/udforsk?view=kort alias carries the envelope instead of erasing it. Legacy typed/untyped ID links remain. Copy/new-tab only receives the public URL; private state is deliberately not transferred. Private/GPS discovery origins are not newly persisted in cross-tab localStorage (old private origins are ignored). This is not a full audit of unrelated user-location/profile storage.

Proof: mounted real callers/SDK with substituted HTTP; PGlite SQL with >100 eligible rows behind 600 ineligible rows, date/radius/dateline, scoped cursor and malformed direct RPCs; workflow-owned smoke-core-browser fixture-only Søg→Kort→chat→Kort→normal and 105-row actual-pointer paging. Local Chromium used /usr/bin/chromium because bundled Playwright binary was absent. The diagnostic discovery-only selector is NOT full core-browser/mobile/WebKit/a11y acceptance. No provider fetches in this journey; tile/image bytes are local fixtures. Default production flag remains OFF; neither migration was applied remotely.

Existing dependency audit (8 high, no patched braces version), unsafe Worker workflow, protected migration/readback, indexes/plans/outer timeout, provider/device/performance/accessibility/privacy/action gates and exact final review belong to the parent release workstream. No push/deploy/model/provider writes here.
