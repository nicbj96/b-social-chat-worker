import type {SupabaseClient} from '@supabase/supabase-js';
import {parseSearchRequest,searchIntentKey,normalizedDiscoveryQuery,type SearchRequest} from './searchIntent';
export interface DiscoveryItem {kind:'event'|'place';data:Record<string,unknown> & {id:string;title?:string;name?:string}}
export interface DiscoveryPage {items:DiscoveryItem[];status:'complete';consistency:'live-keyset';hasMore:boolean;nextCursor:SearchRequest['cursor']|null;retrievedAt:string}
export class DiscoveryError extends Error {
 constructor(public code:'unsupported_region_metadata'|'invalid_discovery_cursor'|'invalid_search_intent'|'discovery_unavailable'){super(code);}
}
/** Canonical adapter. Worker mirror changes only the contract import path.
 * Continuation is editable hex JSON with advisory mismatch guards, not auth.
 * Each request rechecks SQL invoker RLS. Live keysets are NOT a frozen
 * MVCC snapshot: writes/eligibility changes between pages may move membership.
 */
export async function fetchDiscoveryPage(client:SupabaseClient,input:SearchRequest,signal?:AbortSignal):Promise<DiscoveryPage> {
 let request:SearchRequest;
 try {request=parseSearchRequest(input);} catch {throw new DiscoveryError('invalid_search_intent');}
 // Region intents are supported by discovery_search_v1/discovery_map_v1 and
 // validated against verified region geodata in SQL; no client-side throw.
 const deadline=AbortSignal.timeout(6000);
 const cancellation=signal?AbortSignal.any([signal,deadline]):deadline;
 cancellation.throwIfAborted();
 const {data,error}=await client.rpc(request.viewport?'discovery_map_v1':'discovery_search_v1',{
  ...(request.viewport?{p_viewport:request.viewport}:{}),
  p_intent:{...request.intent,query:normalizedDiscoveryQuery(request.intent.query)},p_cursor:request.cursor?.token??null,p_limit:request.pageSize,
 }).abortSignal(cancellation);
 cancellation.throwIfAborted();
 if(error) {
  const known=['unsupported_region_metadata','invalid_discovery_cursor','invalid_search_intent'] as const;
  throw new DiscoveryError(known.find(code=>error.message===code)??'discovery_unavailable');
 }
 if(!data || data.status!=='complete' || data.consistency!=='live-keyset' || !Array.isArray(data.items)
   || data.items.length>request.pageSize || typeof data.hasMore!=='boolean'
   || (data.hasMore ? typeof data.nextCursor!=='string' || !/^[0-9a-f]{1,2048}$/.test(data.nextCursor) : data.nextCursor!==null)
   || !Number.isFinite(Date.parse(data.retrievedAt))
   || data.items.some((i:any)=>!['event','place'].includes(i?.kind) || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(i?.data?.id??'')
     || typeof i.data[i.kind==='event'?'title':'name']!=='string')) throw new DiscoveryError('discovery_unavailable');
 return {...data,nextCursor:data.nextCursor?{intentKey:searchIntentKey(request.intent),token:data.nextCursor}:null};
}
