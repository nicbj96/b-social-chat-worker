import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('cloudflare:workers',()=>({DurableObject:class{}}));
import worker from './index';
import {defaultSearchIntent,searchIntentKey} from './discovery-contract';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const intent={...defaultSearchIntent(),query:'cafe kbh',kind:'event' as const,geography:{kind:'country' as const,country:'DK'},price:{mode:'free' as const,min:0,max:0,currency:null,unknown:'exclude' as const}};
const page={items:[{kind:'event',data:{id,title:'Café',price:0,price_currency:null,date:'2099-01-01T12:00:00Z',event_timezone:null}}],status:'complete',consistency:'live-keyset',hasMore:false,nextCursor:null,retrievedAt:'2026-10-04T12:00:00Z'};
let run:any, calls:any[], response:Response,ip=0;
beforeEach(()=>{run=vi.fn();calls=[];response=Response.json(page);vi.stubGlobal('fetch',vi.fn(async(input:any,init:any)=>{calls.push({url:String(input),init});return response;}));});
afterEach(()=>vi.unstubAllGlobals());
async function chat(discovery_intent:any=intent,discovery_cursor?:any){
 return worker.fetch!(new Request('https://worker.test/chat',{method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':`203.0.113.${++ip}`},body:JSON.stringify({messages:[{role:'user',content:'Find noget'}],discovery_intent,...(discovery_cursor?{discovery_cursor}:{})})}),{AI:{run},SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_KEY:'fixture-key'} as any,{waitUntil:vi.fn(),passThroughOnException:vi.fn(),props:{}} as any);
}
describe('deterministic discovery through actual /chat handler and SDK',()=>{
 it.each([[50,'CHF','50 CHF'],[390,'CHF','390 CHF'],[50,'kr','50 (valuta ukendt)'],[null,'CHF','Pris ukendt']])('C14 explicit price %s currency %s',async(price,currency,label)=>{
  const data={...page.items[0].data,price,price_currency:currency,price_evidence:{raw:'fixture'}};
  response=Response.json({...page,items:[{kind:'event',data}]});
  const res=await chat({...intent,price:null});const body:any=await res.json();
  expect(body.reply).toContain(label);expect(body.sources[0].verified_fields).toEqual(data);expect(run).not.toHaveBeenCalled();
 });
 it('valid intent reaches the exact RPC, produces grounded IDs and no model/telemetry call',async()=>{
  const res=await chat();expect(res.status).toBe(200);const body:any=await res.json();
  expect(body.event_ids).toEqual([id]);expect(body.applied_filters).toEqual(intent);
  expect(body.retrieval_status).toBe('complete');expect(body.sources[0]).toMatchObject({id,url:`/event/${id}`,retrieved_at:page.retrievedAt});
  expect(body.reply).toContain('Gratis');expect(body.reply).not.toContain('DKK');
  expect(calls).toHaveLength(1);expect(calls[0].url).toContain('/rest/v1/rpc/discovery_search_v1');
  expect(JSON.parse(calls[0].init.body)).toEqual({p_intent:intent,p_cursor:null,p_limit:8});
  expect(run).not.toHaveBeenCalled();
 });
 it('does not turn unavailable or malformed RPC into an empty answer',async()=>{
  response=Response.json({message:'offline'},{status:503});const res=await chat();expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({retrieval_status:'failed',applied_filters:null});expect(run).not.toHaveBeenCalled();
 });
 it('keeps unsupported regions and invalid cursors explicit without a query/model',async()=>{
  expect((await chat({...intent,geography:{kind:'region',country:'DK',region:'DK-84'}})).status).toBe(422);
  expect((await chat(intent,{intentKey:'wrong',token:'abcdef'})).status).toBe(400);
  expect(calls).toHaveLength(0);expect(run).not.toHaveBeenCalled();
 });
 it('forwards bound next cursor without changing hard filters',async()=>{
  const res=await chat(intent,{intentKey:searchIntentKey(intent),token:'abcdef'});expect(res.status).toBe(200);
  expect(JSON.parse(calls[0].init.body).p_cursor).toBe('abcdef');
 });
});
