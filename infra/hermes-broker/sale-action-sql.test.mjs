import test from 'node:test';
import assert from 'node:assert/strict';
import { saleSetup, BUILDING, ROOM, SCOPE, REQUEST, binding, code, USER, ORG, FOREIGN } from './sale-action-sql-fixture.mjs';
const patch={requestId:REQUEST,roomId:ROOM,expectedRevision:'a'.repeat(32),rent_price:3100000};
test('sale SQL is disabled by default, canonical writer once, durable replay and input mismatch',{timeout:60000},async t=>{
 const {db,rpc,seeded}=await saleSetup(t);assert.equal(seeded,true);
 const first=await rpc('patch',patch);assert.equal(first.outcome,'applied');assert.equal(first.receipt.revision,'b'.repeat(32));
 assert.deepEqual(await rpc('patch',patch),first);
 assert.deepEqual(await rpc('status',{requestId:REQUEST}),first);
 await assert.rejects(()=>rpc('patch',{...patch,rent_price:3200000}),code('PT409'));
 assert.equal((await db.query('SELECT count(*)::int n FROM public.fixture_sale_writes')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM public.fixture_action_audit')).rows[0].n,1);
});
test('sale SQL full binding, scope, registry and current key govern replay/status',{timeout:60000},async t=>{
 const {db,rpc}=await saleSetup(t);await rpc('patch',patch);
 await assert.rejects(()=>rpc('status',{requestId:REQUEST},{...binding,expectedEpoch:2}),code('PT409'));
 await assert.rejects(()=>rpc('status',{requestId:REQUEST},binding,'authenticated',FOREIGN),code('42501'));
 await db.exec("UPDATE public.fixture_sale_acl SET allowed=false WHERE key='rooms.edit'");
 await assert.rejects(()=>rpc('status',{requestId:REQUEST}),code('42501'));
 await assert.rejects(()=>rpc('patch',patch),code('42501'));
 await db.exec("UPDATE public.fixture_sale_acl SET allowed=true;UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='rooms.edit'");
 await assert.rejects(()=>rpc('status',{requestId:REQUEST}),code('42501'));
 await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true;UPDATE app_private.hermes_connections SET scope_ids='{}'");
 await assert.rejects(()=>rpc('status',{requestId:REQUEST}),code('42501'));
});
test('sale SQL image-only overlay cannot modify or observe private fields',{timeout:60000},async t=>{
 const {db,rpc}=await saleSetup(t);
 await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.manage_images']");
 const observed=await rpc('observe',{roomId:ROOM});assert.deepEqual(observed.room.fields,{images:[]});
 await assert.rejects(()=>rpc('patch',patch),code('42501'));
 const input={requestId:REQUEST,roomId:ROOM,expectedRevision:'a'.repeat(32),images:['https://example.invalid/a.jpg']};
 assert.equal((await rpc('patch',input)).outcome,'applied');
 assert.equal((await rpc('status',{requestId:REQUEST})).outcome,'applied');
 await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.lock_room']");
 await assert.rejects(()=>rpc('status',{requestId:REQUEST}),code('42501'));
 await assert.rejects(()=>rpc('observe',{roomId:ROOM}),code('42501'));
});
test('sale SQL lock request replay is durable beyond canonical short retry window',{timeout:60000},async t=>{
 const {db,rpc}=await saleSetup(t);
 const input={requestId:REQUEST,roomId:ROOM,hours:6,note:null};
 const result=await rpc('lock',input);
 await db.exec("UPDATE app_private.hermes_sale_action_receipts SET created_at=now()-interval '3 days'");
 assert.deepEqual(await rpc('lock',input),result);
 assert.equal((await db.query('SELECT count(*)::int n FROM public.fixture_sale_writes')).rows[0].n,1);
 assert.equal(result.receipt.state,'LOCKED');
});
test('sale SQL deposit receipt excludes customer data and does not infer received from approval',{timeout:60000},async t=>{
 const {db,rpc}=await saleSetup(t);
 const input={requestId:REQUEST,roomId:ROOM,customerId:null,customerHint:'Anh A',intendedMoveInOn:null,topupDueOn:null,depositTarget:3000000,notes:null,
  receipt:{amount:2000000,accountId:null,voucherDate:'2026-10-21',name:null,description:null}};
 const result=await rpc('reservation_create',input);
 assert.equal(result.receipt.receivedAmount,0);assert.equal(result.receipt.receipts[0].approvalStatus,'APPROVED');
 assert.equal(result.receipt.receipts[0].received,false);assert.equal(JSON.stringify(result).includes('must never'),false);
 await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=array_remove(action_capabilities,'income_expenses.create')");
 await assert.rejects(()=>rpc('status',{requestId:REQUEST}),code('42501'));
});
test('sale SQL options intersect selected action/building and unknown status is explicit',{timeout:60000},async t=>{
 const {db,rpc}=await saleSetup(t);
 assert.deepEqual((await rpc('options',{action:'rooms.edit',buildingId:null,query:'P101',limit:20,cursor:null})).items,
  [{id:ROOM,buildingId:BUILDING,label:'P101',buildingLabel:'Tòa A'}]);
 await assert.rejects(()=>rpc('options',{action:'rooms.edit',buildingId:FOREIGN,query:'',limit:20,cursor:null}),code('42501'));
 assert.deepEqual(await rpc('status',{requestId:REQUEST}),{organizationId:ORG,requestId:REQUEST,operation:null,outcome:'not_found',receipt:null});
 await db.exec("UPDATE public.fixture_sale_acl SET allowed=false WHERE key='rooms.edit'");
 await assert.rejects(()=>rpc('options',{action:'rooms.edit',buildingId:null,query:'',limit:20,cursor:null}),code('42501'));
});
test('sale options extension preserves reader values and intersects each new action scope',{timeout:60000},async t=>{
 const {db}=await saleSetup(t);
 await db.query("SELECT set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[USER]);
 const base={organizationId:ORG,userId:USER,membershipId:USER,authorizationVersion:1,isSuperadmin:false,policyVersion:1,
  enabled:true,read:['rooms.view'],action:[],scopes:[]};
 const extend=async snapshot=>(await db.query("SELECT app_private.hermes_sale_extend_options_v1($1::jsonb,'connection_options') result",[JSON.stringify(snapshot)])).rows[0].result;
 const result=await extend(base);assert.deepEqual(result.read,base.read);
 assert.ok(result.action.includes('rooms.edit'));assert.equal(result.scopes[0].scopeId,SCOPE);
 await db.exec(`UPDATE public.fixture_sale_acl SET building_id='${FOREIGN}' WHERE key='rooms.edit'`);
 const changed=await extend(base);assert.ok(!changed.action.includes('rooms.edit'));assert.ok(changed.action.includes('sale_phong.manage_images'));
 const context={...base,restrictions:{read:['rooms.view'],action:['rooms.edit']},companyCeilings:{read:['rooms.view'],action:['rooms.edit']},
  effective:{read:['rooms.view'],action:[]},scopeIds:[SCOPE]};
 const scoped=(await db.query("SELECT app_private.hermes_sale_extend_options_v1($1::jsonb,'context') result",[JSON.stringify(context)])).rows[0].result;
 assert.deepEqual(scoped.effective,context.effective);
});
