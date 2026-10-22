import { describe,expect,it,vi } from 'vitest';
vi.mock('../lib/ctx.js',()=>({sb:{},log:vi.fn(),SUPABASE_URL:'https://example.invalid'}));
const {saleContentGuard,validateSaleContent}=await import('../lib/automation-content-guard.js');
const {mapPayloadSangToa}=await import('../lib/vacant-rooms.js');
const payload=()=>({pages:1,contact:{phone:'0900000000'},sale_policy:'Hoa hồng theo hợp đồng',
 buildings:[{id:'b',name:'Tòa A',address:'1 Đường A'}],
 rooms:[{id:'r',building_id:'b',name:'101',rent_price:3000000,status_public:'free',amenities:['Máy lạnh'],images:['a.jpg'],sale_note:'Wifi miễn phí'}]});
const template={roomTemplate:'{ma_phong} {gia} {khuyen_mai}'};
const guardFor=data=>saleContentGuard({buildings:mapPayloadSangToa(data),hotline:data.contact.phone,trangSale:data.pages},template);
const job={organization_id:'org',payload:{sale_content_guard:guardFor(payload())}};
describe('H4 revalidate public sale snapshot before provider side effect',()=>{
 it('unchanged snapshot passes and RPC is scoped to the queued organization',async()=>{
  const rpc=vi.fn(async()=>({data:payload(),error:null}));
  expect(await validateSaleContent(job,{rpc},template)).toEqual({ok:true});
  expect(rpc).toHaveBeenCalledWith('zalo_phong_trong_cho_worker_v1',{p_organization_id:'org'});
 });
 it.each([
  ['lock/cọc removed room',p=>{p.rooms=[];}],
  ['price',p=>{p.rooms[0].rent_price=4000000;}],
  ['image',p=>{p.rooms[0].images=['new.jpg'];}],
  ['room policy',p=>{p.rooms[0].sale_note='Chính sách mới';}],
  ['company policy',p=>{p.sale_policy='Đã hết chương trình';}],
  ['pass policy',p=>{p.rooms[0].status_public='pass';p.rooms[0].pass_sale_policy='Hoa hồng pass';}],
  ['revoked public page',p=>{p.pages=0;p.rooms=[];p.buildings=[];}],
 ])('rejects a queued message after %s changes',async(_,change)=>{
  const fresh=payload();change(fresh);
  expect(await validateSaleContent(job,{rpc:async()=>({data:fresh,error:null})},template)).toMatchObject({ok:false,reason:expect.stringContaining('STALE_SALE_CONTENT')});
 });
 it('template changed after enqueue blocks old text',async()=>{
  expect(await validateSaleContent(job,{rpc:async()=>({data:payload(),error:null})},{roomTemplate:'new'})).toMatchObject({ok:false,reason:expect.stringContaining('STALE')});
 });
 it('legacy metadata, malformed metadata, missing response and RPC outage all fail closed',async()=>{
  for(const guard of [undefined,{version:2,fingerprint:'a'.repeat(64)},{version:1,fingerprint:'a'}]){
   const rpc=vi.fn();expect((await validateSaleContent({organization_id:'org',payload:{sale_content_guard:guard}},{rpc},template)).ok).toBe(false);
   expect(rpc).not.toHaveBeenCalled();
  }
  for(const rpc of [async()=>({error:{message:'offline'}}),async()=>({data:{}}),async()=>{throw new Error('offline');}])
   expect(await validateSaleContent(job,{rpc},template)).toMatchObject({ok:false,reason:expect.stringContaining('UNVERIFIED')});
 });
 it('SQL row reordering is stable; per-room photo order is content',()=>{
  const p=payload();p.rooms.push({...p.rooms[0],id:'r2'});const a=guardFor(p);
  p.rooms.reverse();expect(guardFor(p)).toEqual(a);
  p.rooms[0].images=['b.jpg','a.jpg'];const b=guardFor(p);p.rooms[0].images.reverse();expect(guardFor(p)).not.toEqual(b);
 });
});
