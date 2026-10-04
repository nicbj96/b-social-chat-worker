# Deterministic discovery v1 — local integrated milestone, not release

Canonical chain: SearchIntent → Pages searchDiscovery.ts / Worker discovery-retrieval.ts → discovery_search_v1(jsonb,text,integer) → /soeg or /chat. Adapter bytes are identical and SHA-pinned alongside schema/fixtures by both check-discovery-contract scripts; Worker searchIntent.ts is only an import-path re-export. fetchDiscoveryPage(client,request,signal) / DiscoveryPage are the K3/K5 seam, not an implemented map viewport contract.

## SQL / data truth

Additive migration 20261004193000_discovery_search_v1.sql is registered in the canonical management runner, exact ledger, verify-only metadata and repo-safety checks. Old RPCs, policies and data remain unchanged. Production events public SELECT permits all statuses: explicit active/null eligibility remains essential. Local fixtures test both restrictive anon/auth RLS and permissive public SELECT, not hosted auth.

Same token-AND/accent/city-alias/typo motor with/without tags. Exact-token matches precede approximate matches, then date/type/id; date and distance sorts use stable tie breakers. All type/status/date/price/currency/tags/country/radius predicates precede limit+1. Tags union expanded slugs across legacy arrays/category and invoker junction views. Radius uses great-circle distance including dateline; world/country never borrow cached GPS.

Known end must be strictly after now; unknown end requires start at/after now. Date windows overlap known intervals, half-open at upper start bound. Places have N/A date/price, not free status. Region is explicitly unsupported: existing place-region text is not complete verified country/region identifier metadata for both entity types.

Nullable additions only: price_currency, price_evidence JSONB, event_timezone. No DKK/Copenhagen defaults, FX or backfill. Evidence fields: raw conditions, parser_version, source_uid, canonical_url, occurrence_start, observed_at, upstream_updated_at. Ingestion/population remains open. catalog_updated_at is events.content_updated_at / places.updated_at (confirmed by read-only live schema); it is NOT upstream time. source_updated_at remains null.

## Cursor and deadlines

Size clamps 1–50, null→20; server limit+1 owns hasMore. Cursor binds intent, role/claims, version, issued-at and rank/date/type/id tuple; wrong intent/invalid/expired >15min fails. No entity candidate-ID caps or guessed total.

consistency=live-keyset is NOT a frozen MVCC snapshot. Each page rechecks current membership/status. Concurrent edits may move/hide/introduce entities; reload starts again. Unchanged eligible data traverses completely and deterministically. UI deduplicates typed IDs, labels loaded count/hasMore, and never promises a frozen count.

Function config requests statement_timeout=4s; SDK abort deadline is 6s. Function SET metadata alone does NOT prove the hosted outer statement-cancellation deadline. Verify actual PostgREST role/transaction timeout/cancellation before release. Query-plan/production-size latency evidence is still open.

## Callers / release switch

/soeg uses VITE_DISCOVERY_V1_ENABLED=true only after migration/readback. OFF preserves legacy incomplete behavior. Enabled path uses the one RPC for empty query/filter browse, text and tags, forward pagination, AbortSignal/request-generation, preserved-intent retry and no model/embedding. Suggestions remain global legacy data, a separate §5 UX gate.

/chat explicit discovery_intent uses identical RPC, page size8, structured sources/verified_fields, applied_filters and nextCursor, no model/CC-forwarding. discovery_cursor is {intentKey,token}. Region→422; invalid→400; unavailable/missing migration→503 with applied_filters:null. Old caller bodies retain the legacy path. AIChatWidget does not yet send this intent; K5/§6 remains open.

## Proof / gates

searchDiscoverySql.test.ts executes PGlite0.5.8 PostgreSQL, SDK→SQL, anon/auth roles, permissive eligibility, invoker views, keysets, ranking, beyond-old-cap eligibility, overlap/radius/tags/currency, nullable metadata and real management verify-only SQL. Soeg.discovery.test.tsx mounts actual providers/controls/SDK with HTTP substituted. Worker tests use the real handler/SDK. None proves live new-RPC operation.

OPEN: exact-commit independent review; protected migration/ledger/grants/source readback; hosted anon/auth/PostgREST and legacy repeated-OR proof; latency/plans/outer statement timeout; reviewed flag activation; new-RPC preflight in Worker release; actual browser three-surface journey; K3/K5 map/widget adoption; regions; source metadata ingestion; device/provider/performance/privacy/action gates. No push/merge/deploy or live data/schema mutations in this milestone.
