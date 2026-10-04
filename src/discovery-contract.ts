/** Canonical discovery contract v1. Source of truth: Pages source/src/lib/searchIntent.ts.
 * Mirror byte-for-byte to Worker src/discovery-contract.ts; run check-discovery-contract.mjs.
 * Viewport/camera are ViewState. Cursor/page size are transport, never intent.
 * Dates are half-open instants; timezone is the user's IANA calendar zone, not event provenance.
 */
export type SearchGeography =
  | { kind: "world" }
  | { kind: "country"; country: string }
  | { kind: "region"; country: string; region: string }
  | { kind: "radius"; lat: number; lng: number; radiusKm: number; source: "manual" | "gps"; shareable: boolean };
export interface SearchIntent {
  version: 1;
  query: string;
  queryShareable: boolean;
  kind: "event" | "place" | "both";
  /** Absent = inherit selection; explicit [] = intentionally no tags. */
  tags?: { selected: string[]; expanded: string[]; provenance: "selection" | "taxonomy"; taxonomyVersion: string };
  geography: SearchGeography;
  date: { from: string; to: string; timezone: string } | null;
  price: { mode: "free" | "range"; min: number; max: number | null; currency: string | null; unknown: "exclude" | "include" } | null;
  sort: "relevance" | "date" | "distance";
}
export function defaultSearchIntent(): SearchIntent {
  return {version:1, query:"", queryShareable:false, kind:"both", geography:{kind:"world"}, date:null, price:null, sort:"relevance"};
}
function fail(): never { throw new Error("invalid_search_intent"); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const out = value as Record<string, unknown>;
  if (Object.keys(out).some(key => !keys.includes(key))) return fail();
  return out;
}
function text(v: unknown, max: number, pattern?: RegExp): string {
  if (typeof v !== "string" || v.length > max || (pattern && !pattern.test(v))) return fail();
  return v;
}
function choice<T extends string>(v: unknown, choices: readonly T[]): T {
  if (!choices.includes(v as T)) return fail();
  return v as T;
}
function number(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return fail();
  return v;
}
function bool(v: unknown): boolean { if (typeof v !== "boolean") return fail(); return v; }
function slugs(v: unknown, max: number): string[] {
  if (!Array.isArray(v) || v.length > max) return fail();
  return [...new Set(v.map(s => text(s,80,/^[a-z0-9]+(?:-[a-z0-9]+)*$/)))].sort();
}
function instant(v: unknown): string {
  const s = text(v,32,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime()) || d.toISOString().replace('.000Z','Z') !== s.replace('.000Z','Z')) return fail();
  return d.toISOString();
}
export function parseSearchIntent(value: unknown): SearchIntent {
  const v = object(value,['version','query','queryShareable','kind','tags','geography','date','price','sort']);
  if (v.version !== 1) return fail();
  const rawGeo = object(v.geography,['kind','country','region','lat','lng','radiusKm','source','shareable']);
  let geography: SearchGeography;
  switch (rawGeo.kind) {
    case 'world': object(rawGeo,['kind']); geography={kind:'world'}; break;
    case 'country': object(rawGeo,['kind','country']); geography={kind:'country',country:text(rawGeo.country,2,/^[A-Z]{2}$/)}; break;
    case 'region': object(rawGeo,['kind','country','region']); geography={kind:'region',country:text(rawGeo.country,2,/^[A-Z]{2}$/),region:text(rawGeo.region,80,/^[A-Za-z0-9][A-Za-z0-9_-]*$/)}; break;
    case 'radius': {
      object(rawGeo,['kind','lat','lng','radiusKm','source','shareable']);
      const source=choice(rawGeo.source,['manual','gps']); const shareable=bool(rawGeo.shareable);
      if (source==='gps' && shareable) return fail();
      geography={kind:'radius',lat:number(rawGeo.lat,-90,90),lng:number(rawGeo.lng,-180,180),radiusKm:number(rawGeo.radiusKm,0.1,2000),source,shareable}; break;
    }
    default: return fail();
  }
  let tags: SearchIntent['tags'];
  if (v.tags !== undefined) {
    const t=object(v.tags,['selected','expanded','provenance','taxonomyVersion']);
    tags={selected:slugs(t.selected,32),expanded:slugs(t.expanded,256),provenance:choice(t.provenance,['selection','taxonomy']),taxonomyVersion:text(t.taxonomyVersion,80,/^[A-Za-z0-9._-]+$/)};
    if (tags.selected.some(s=>!tags!.expanded.includes(s)) || (tags.provenance==='selection' && JSON.stringify(tags.selected)!==JSON.stringify(tags.expanded))) return fail();
  }
  let date: SearchIntent['date']=null;
  if (v.date !== null) {
    const d=object(v.date,['from','to','timezone']);
    const timezone=text(d.timezone,80,/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/);
    try { new Intl.DateTimeFormat('en',{timeZone:timezone}).format(0); } catch { return fail(); }
    date={from:instant(d.from),to:instant(d.to),timezone};
    if (date.from>=date.to) return fail();
  }
  let price: SearchIntent['price']=null;
  if (v.price !== null) {
    const p=object(v.price,['mode','min','max','currency','unknown']);
    const currency=p.currency===null ? null : text(p.currency,3,/^[A-Z]{3}$/);
    // ISO currency allowlist from ICU, not a guessed country/default or FX conversion.
    if (currency && !(Intl as typeof Intl & {supportedValuesOf(key:string):string[]}).supportedValuesOf('currency').includes(currency)) return fail();
    price={mode:choice(p.mode,['free','range']),min:number(p.min,0,1e9),max:p.max===null?null:number(p.max,0,1e9),currency,unknown:choice(p.unknown,['exclude','include'])};
    if ((price.max!==null && price.max<price.min) || (price.mode==='range' && !currency) || (price.mode==='free' && (price.min!==0 || price.max!==0 || currency!==null || price.unknown!=='exclude'))) return fail();
  }
  const sort=choice(v.sort,['relevance','date','distance']);
  if (sort==='distance' && geography.kind!=='radius') return fail();
  return {version:1,query:text(v.query,500),queryShareable:bool(v.queryShareable),kind:choice(v.kind,['event','place','both']),...(tags?{tags}:{}),geography,date,price,sort};
}

/** Stable semantic identity. No cursor, viewport or implicit cached GPS. */
export function searchIntentKey(intent: SearchIntent): string {
  const i=parseSearchIntent(intent);
  return JSON.stringify({...i,query:i.query.trim().toLocaleLowerCase('da-DK')});
}
export interface SearchRequest {
  version: 1; intent: SearchIntent; pageSize: number;
  cursor?: {intentKey:string; token:string};
}
export function parseSearchRequest(value: unknown): SearchRequest {
  const v=object(value,['version','intent','pageSize','cursor']);
  if (v.version!==1) return fail();
  const intent=parseSearchIntent(v.intent); const pageSize=number(v.pageSize,1,50);
  if (!Number.isInteger(pageSize)) return fail();
  let cursor: SearchRequest['cursor'];
  if (v.cursor!==undefined) {
    const c=object(v.cursor,['intentKey','token']);
    cursor={intentKey:text(c.intentKey,40000),token:text(c.token,2048,/^[A-Za-z0-9_.~-]+$/)};
    if (cursor.intentKey!==searchIntentKey(intent)) return fail();
  }
  return {version:1,intent,pageSize,...(cursor?{cursor}:{})};
}
/** Single URL codec. Personal coordinates and private text never enter the URL.
 * The caller may preserve the full intent in tab-local history.state instead.
 */
export function encodeSearchIntent(intent: SearchIntent): URLSearchParams {
  const i=parseSearchIntent(intent);
  const privateGeo=i.geography.kind==='radius' && !i.geography.shareable;
  const publicIntent={...i, query:i.queryShareable?i.query:'',
    geography:privateGeo?{kind:'world' as const}:i.geography,
    sort:privateGeo && i.sort==='distance'?'relevance' as const:i.sort};
  const params=new URLSearchParams();
  // Tags live in their familiar URL parameter; keep expansion provenance in the envelope.
  if (i.tags) params.set('tags',i.tags.selected.join(','));
  params.set('intent',JSON.stringify(publicIntent));
  return params;
}
export function decodeSearchIntent(params: URLSearchParams): SearchIntent {
  for (const key of ['intent','tags','tag','q']) if (params.getAll(key).length>1) return fail();
  const raw=params.get('intent');
  if (raw && raw.length>40000) return fail();
  let i=raw!==null ? parseSearchIntent(JSON.parse(raw)) : defaultSearchIntent();
  if (!raw && params.has('q')) i={...i,query:text(params.get('q'),500),queryShareable:true};
  const tags=params.get('tags')??params.get('tag');
  if (tags!==null) {
    const selected=slugs(tags===''?[]:tags.split(','),32);
    if (!i.tags || JSON.stringify(i.tags.selected)!==JSON.stringify(selected)) {
      i={...i,tags:{selected,expanded:selected,provenance:'selection',taxonomyVersion:'v1'}};
    }
  }
  return parseSearchIntent(i);
}
