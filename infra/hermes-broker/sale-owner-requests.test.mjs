import test from 'node:test';
import assert from 'node:assert/strict';
import {HERMES_OWNER_REQUESTS} from './sale-owner-requests.mjs';
import {saleSetup,ROOM,REQUEST,binding,code,ORG,SCOPE} from './sale-action-sql-fixture.mjs';
import {saleActionInput,mayUseSaleAction} from './sale-action-contract.mjs';
import {createPublicTextGuard} from './public-text-guard.mjs';
test('Hermes owner requests',{timeout:60000},async t=>{
 const {db,rpc}=await saleSetup(t);
 const writeCount=async()=>Number((await db.query('SELECT count(*) n FROM public.fixture_sale_writes')).rows[0].n);
 for(const c of HERMES_OWNER_REQUESTS) await t.test(`${c.id} | ${c.role} | ${c.request}`,async()=>{
  await db.exec(`DELETE FROM app_private.hermes_sale_action_receipts;DELETE FROM public.fixture_sale_writes;DELETE FROM public.room_sale_locks;DELETE FROM public.room_reservations;
   UPDATE public.fixture_sale_acl SET allowed=true;UPDATE app_private.hermes_capabilities SET enabled=true;
   UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit','income_expenses.create','income_expenses.approve'],scope_ids=ARRAY['${SCOPE}'::uuid];
   CREATE OR REPLACE FUNCTION app_private.can_v3(text,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;`);
  const run=()=>rpc(c.operation,c.input),guard=createPublicTextGuard({clock:()=>1000});
  if(c.id==='H01'){assert.equal((await run()).items[0].id,ROOM);}
  else if(['H02','H10','H23'].includes(c.id)){
   if(c.id==='H10')await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.manage_images']");
   if(c.id==='H23'){assert.equal(mayUseSaleAction({read:['rooms.view'],action:[]},c.operation,c.input),false);await db.exec("UPDATE app_private.hermes_connections SET action_capabilities='{}'");}
   await assert.rejects(run,code('42501'));assert.equal(await writeCount(),0);
  }else if(c.id==='H04'){await assert.rejects(run,code('PT409'));assert.equal(await writeCount(),0);}
  else if(c.id==='H05'){assert.equal(guard.review('c','crm_sale_room_patch',c.input).confirmation.applied,false);assert.equal(await writeCount(),0);}
  else if(c.id==='H06'){
   const token=guard.review('c','crm_sale_room_patch',c.input).confirmation.confirmToken;
   assert.equal(guard.review('c','crm_sale_room_patch',c.input,token).allow,true);assert.equal((await run()).outcome,'applied');
   assert.equal(guard.review('c','crm_sale_room_patch',c.input,token).refused,true);assert.equal(await writeCount(),1);
  }else if(c.id==='H07'){
   const token=guard.review('c','crm_sale_room_patch',{...c.input,sale_note:'Wifi miễn phí'}).confirmation.confirmToken;
   assert.equal(guard.review('c','crm_sale_room_patch',c.input,token).refused,true);assert.equal(await writeCount(),0);
  }else if(c.id==='H08'){assert.equal(guard.review('c','crm_sale_room_patch',c.input).allow,true);assert.deepEqual((await run()).receipt.fields,['sale_bonus_note']);}
  else if(c.id==='H09'){await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.manage_images']");assert.equal((await run()).outcome,'applied');}
  else if(c.id==='H12'){assert.throws(()=>saleActionInput(c.operation,c.input));await assert.rejects(run,code('22023'));assert.equal(await writeCount(),0);}
  else if(c.id==='H13'){const first=await run();await db.exec("UPDATE app_private.hermes_sale_action_receipts SET created_at=now()-interval '3 days'");assert.deepEqual(await run(),first);assert.equal(await writeCount(),1);}
  else if(c.id==='H14'){await rpc('lock',{...c.input,hours:6});await assert.rejects(run,code('PT409'));assert.equal(await writeCount(),1);}
  else if(c.id==='H15'){assert.equal((await run()).outcome,'not_found');assert.equal(await writeCount(),0);}
  else if(c.id==='H16'){await rpc('patch',{requestId:REQUEST,roomId:ROOM,expectedRevision:'a'.repeat(32),rent_price:3});await db.exec("UPDATE public.fixture_sale_acl SET allowed=false WHERE key='rooms.edit'");await assert.rejects(run,code('42501'));}
  else if(c.id==='H17'){
   const out=await run();assert.equal(out.receipt.receivedAmount,0);assert.equal(out.receipt.receipts[0].received,false);
   assert.equal(out.receipt.receipts[0].approvalStatus,'APPROVED');assert.ok(!JSON.stringify(out).includes('customer_phone'));
  }else if(c.id==='H18'){
   await db.exec("CREATE OR REPLACE FUNCTION app_private.can_v3(text,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;UPDATE app_private.hermes_connections SET action_capabilities=array_remove(action_capabilities,'income_expenses.approve')");
   await assert.rejects(run,code('42501'));assert.equal(await writeCount(),0);
  }else if(['H19','H20','H22'].includes(c.id)){
   await db.query('INSERT INTO public.room_reservations VALUES($1,$2,$3)',[c.input.reservationId,ORG,ROOM]);
   assert.deepEqual(saleActionInput(c.operation,c.input),c.input);assert.equal((await run()).outcome,'applied');
   assert.equal(await writeCount(),1);
  }else if(c.id==='H21'){
   await rpc('lock',{requestId:REQUEST,roomId:ROOM,hours:6,note:null});assert.equal((await run()).receipt.state,'RELEASED');
  }else if(c.id==='H24'){
   await db.exec("UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['sale_phong.manage_images']");
   assert.deepEqual((await run()).room.fields,{images:[]});
   await db.exec("CREATE OR REPLACE FUNCTION public.get_sale_room_inventory_v1(uuid,uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('rooms','[]'::jsonb)$$");
   await assert.rejects(run,code('PT409'));
  }else{const result=await run();assert.equal(result.outcome,'applied');assert.equal(await writeCount(),1);}
 });
});
