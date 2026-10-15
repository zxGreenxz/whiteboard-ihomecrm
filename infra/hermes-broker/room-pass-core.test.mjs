import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, BUILDING, LISTING, REQUEST, binding, code } from './room-pass-sql-fixture.mjs';
import { USER, ORG, FOREIGN, SESSION, id } from '../hermes-zalo-router/private-command-fixture.mjs';
import { roomPassInput, roomPassResult, mayUseRoomPass, roomPassOperation } from './room-pass-contract.mjs';
import { createRoomPassReads } from './room-pass-adapter.mjs';
test('room-pass maps only the three fixed tool names',()=>{
  for(const name of ['toString','__proto__','constructor','arbitrary'])assert.equal(roomPassOperation(name),null);
  assert.equal(roomPassOperation('crm_room_pass_observe'),'observe');
  assert.equal(roomPassOperation('crm_room_pass_set_active'),'set_active');
  assert.equal(roomPassOperation('crm_room_pass_status'),'status');
});
test('room-pass typed operations reject actor/org/RPC and require independent Action overlay',()=>{
 assert.equal(mayUseRoomPass({read:['sale_phong.manage_pass_listings'],action:[]},'set_active'),false);
 for(const input of [{listingId:LISTING,userId:USER},{listingId:LISTING,organizationId:ORG},{listingId:LISTING,rpc:'anything'}])assert.throws(()=>roomPassInput('observe',input));
 assert.throws(()=>roomPassInput('set_active',{requestId:REQUEST,listingId:LISTING,active:true,expectedRevision:'old'}));
 assert.throws(()=>roomPassResult('set_active',{requestId:REQUEST,outcome:'not_found',listing:null},{row:{organizationId:ORG}},{requestId:REQUEST}));
});
test('actual canonical setter is idempotent per request, rejects ABA/CAS and rechecks current binding/ACL',{timeout:60000},async t=>{
 const{db,rpc}=await setup(t);
 const capabilities=await rpc('capabilities',{});assert.equal(capabilities.allowed,true);assert.deepEqual(capabilities.buildingIds,[BUILDING]);
 const observed=await rpc('observe',{listingId:LISTING});assert.equal(observed.listing.active,false);
 const input={requestId:REQUEST,listingId:LISTING,active:true,expectedRevision:observed.listing.revision};
 const applied=await rpc('set_active',input);assert.equal(applied.outcome,'applied');assert.equal(applied.listing.active,true);
 assert.deepEqual(await rpc('set_active',input),applied);assert.deepEqual(await rpc('status',{requestId:REQUEST}),applied);
 assert.equal((await db.query('SELECT count(*)::integer n FROM public.fixture_action_audit')).rows[0].n,1);
 await assert.rejects(rpc('set_active',{...input,active:false}),code('PT409'));
 await assert.rejects(rpc('set_active',{...input,requestId:id('9')}),code('PT409'));
 const fresh=await rpc('observe',{listingId:LISTING});
 await db.exec(`UPDATE public.room_pass_listings SET active=false;UPDATE public.room_pass_listings SET active=true`);
 await assert.rejects(rpc('set_active',{...input,requestId:id('8'),expectedRevision:fresh.listing.revision}),code('PT409'));
 assert.equal((await db.query('SELECT count(*)::integer n FROM app_private.hermes_room_pass_receipts')).rows[0].n,1,'rejected writes leave no committed placeholder');
 assert.deepEqual(await rpc('status',{requestId:id('7')}),{requestId:id('7'),outcome:'not_found',listing:null});
 for(const role of ['anon','service_role'])await assert.rejects(rpc('observe',{listingId:LISTING},binding,role),/permission denied/);
 await assert.rejects(rpc('observe',{listingId:LISTING},binding,'authenticated',FOREIGN),code('42501'));
 await assert.rejects(rpc('observe',{listingId:LISTING},{...binding,expectedEpoch:2}),code('PT409'));
 await db.exec("UPDATE public.fixture_action_acl SET deadline=clock_timestamp()-interval '1 second'");await assert.rejects(rpc('set_active',input),code('42501'));
 await db.exec('UPDATE public.fixture_action_acl SET deadline=null');
 await db.exec('UPDATE public.fixture_action_acl SET allowed=false');await assert.rejects(rpc('set_active',input),code('42501'));
 await db.exec(`UPDATE public.fixture_action_acl SET allowed=true;INSERT INTO public.super_admins VALUES('${USER}');UPDATE app_private.hermes_connections SET action_capabilities='{}'`);
 await assert.rejects(rpc('set_active',input),code('42501'));
 await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.manage_pass_listings']");
 await db.exec(`UPDATE public.authorization_scopes SET building_id='${FOREIGN}'`);await assert.rejects(rpc('observe',{listingId:LISTING}),code('42501'));
 await db.exec(`UPDATE public.authorization_scopes SET building_id='${BUILDING}';UPDATE public.rooms SET organization_id='${FOREIGN}'`);await assert.rejects(rpc('observe',{listingId:LISTING}),code('42501'));
});
test('write transport dispatches once, marks confirmed rejection, and never retries after ACK loss',async()=>{
 const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:USER,session_id:SESSION})).toString('base64url'),'signature'].join('.');
 let calls=0,dispatched=0,rejected=0;
 const options={url:'https://example.invalid/',publishableKey:'sb_publishable_test',dependencyScope:{track:fn=>fn()},fetch:async(url,request)=>{
   calls++;assert.equal(new URL(url).pathname,'/rest/v1/rpc/hermes_room_pass_action_v1');assert.equal(request.headers.authorization,'Bearer '+accessToken);throw new Error('synthetic_ack_loss');}};
 const value={accessToken,binding,input:{requestId:REQUEST,listingId:LISTING,active:true,expectedRevision:'a'.repeat(64)}};
 const callOptions={signal:new AbortController().signal,onDispatch(){dispatched++;},onRejected(){rejected++;}};
 await assert.rejects(createRoomPassReads(options).execute('set_active',value,callOptions),/synthetic_ack_loss/);
 assert.deepEqual({calls,dispatched,rejected},{calls:1,dispatched:1,rejected:0});
 const rejectOptions={...options,fetch:async()=>Response.json({code:'PT409',message:'changed',details:null,hint:null},{status:409})};
 await assert.rejects(createRoomPassReads(rejectOptions).execute('set_active',value,callOptions),code('context_changed'));assert.equal(rejected,1);
});
