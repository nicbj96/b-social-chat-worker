import { describe, expect, it } from "vitest";
import * as contract from "./discovery-contract";
import fixtures from "./discovery-contract.fixtures.json";
const buildSearchRequestKey=contract.searchIntentKey;

describe("versioned intent/URL/request identity", () => {
  for (const f of fixtures) it(f.name, () => {
    if (f.valid) expect(() => contract.parseSearchIntent(f.intent)).not.toThrow();
    else expect(() => contract.parseSearchIntent(f.intent)).toThrow();
  });
  it("roundtrips every public field, including empty versus absent tags", () => {
    for (const f of fixtures.filter(f=>f.valid)) {
      const i=contract.parseSearchIntent({...f.intent,queryShareable:true});
      expect(contract.decodeSearchIntent(contract.encodeSearchIntent(i))).toEqual(i);
    }
    expect(contract.decodeSearchIntent(new URLSearchParams('tags='))).toHaveProperty('tags.selected',[]);
    expect(contract.decodeSearchIntent(new URLSearchParams())).not.toHaveProperty('tags');
  });
  it("never automatically serializes private query or GPS; viewport/cursor cannot become geo", () => {
    const i=contract.parseSearchIntent({...fixtures[0].intent, query:'PRIVATE MEDICAL TEXT', geography:{kind:'radius',lat:56.123456,lng:10.234567,radiusKm:25,source:'gps',shareable:false},sort:'distance'});
    const url=contract.encodeSearchIntent(i).toString();
    expect(decodeURIComponent(url)).not.toMatch(/PRIVATE|56.123456|10.234567/);
    expect(contract.decodeSearchIntent(new URLSearchParams(url)).geography).toEqual({kind:'world'});
    expect(()=>contract.decodeSearchIntent(new URLSearchParams('intent=%7Bbroken'))).toThrow();
  });
  it("all date/price/provenance changes invalidate the caller key; transport stays separate", () => {
    const i=contract.parseSearchIntent(fixtures[3].intent);
    const key=buildSearchRequestKey(i);
    for (const change of [{date:null},{price:null},{sort:'date'},{tags:{...i.tags!,taxonomyVersion:'v2'}}]) {
      expect(buildSearchRequestKey(contract.parseSearchIntent({...i,...change}))).not.toBe(key);
    }
    expect(contract.parseSearchRequest({version:1,intent:i,pageSize:20,cursor:{intentKey:key,token:'next'}}).intent).toEqual(i);
    expect(()=>contract.parseSearchRequest({version:1,intent:i,pageSize:20,cursor:{intentKey:'old',token:'next'}})).toThrow();
  });
});
