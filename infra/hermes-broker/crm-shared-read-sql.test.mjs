import test from 'node:test';
import assert from 'node:assert/strict';
import {settings,localCluster,setup,jwt,fast,normal1,web,live,id,ORG,FOREIGN,USER,MEMBER,BUILDING,OTHER_BUILDING,ROLE,BINDING,ORG_SCOPE,BUILDING_SCOPE,ROOM,CUSTOMER,CUSTOMER2,HIDDEN,CONTRACT,CONTRACT2,INVOICE,INVOICE2} from './crm-shared-read-sql-fixture.mjs';

test('TG5 shared INVOKER cores preserve web semantics while Hermes reuses UUID keysets, live CRM/RLS and exclusions', {timeout:120000},async t=>{
 const {pool,cleanup}=await localCluster(t);t.after(async()=>{await pool.end();cleanup();});const {before}=await setup(pool);
 assert.deepEqual(before.customer_list_v1.rows.map(r=>r.id),[CUSTOMER2,CUSTOMER]);
 const prepared=await jwt(pool,async c=>(await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value",[ORG])).rows[0].value);
 const tokenDigest='a'.repeat(64),expiry=Date.now()+600000;
 const activated=(await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb) value',[JSON.stringify({connectionId:prepared.id,expectedEpoch:1,operationId:id(33),intentSecret:prepared.intentSecret,
 userId:USER,providerSessionId:id(32),credentialRef:id(31),tokenDigest,tokenExpiresAt:expiry,sessionExpiresAt:Date.now()+3600000,
 sessionEnvelope:{v:1,algorithm:'A256GCM',keyVersion:'fixture',nonce:'a'.repeat(16),tag:'a'.repeat(22),ciphertext:'abcd'}})])).rows[0].value;
 const binding={connectionId:prepared.id,tokenDigest,expectedEpoch:2,expectedSessionRevision:1};
 for(const domain of ['customers','contracts','invoices']){
 const result=(await fast(pool,binding,domain,{limit:1})).result;
 assert.equal(result.items.length,1);assert.equal(result.nextCursor,result.items[0].id);
 const second=(await fast(pool,binding,domain,{limit:1,cursor:result.nextCursor})).result;
 assert.equal(second.items.length,1);assert(second.items[0].id>result.nextCursor);assert.equal(second.nextCursor,null);
 }
 const customers=(await fast(pool,binding,'customers')).result.items;assert.deepEqual(customers.map(r=>r.id),[CUSTOMER,CUSTOMER2]);assert.equal(customers[0].contractId,CONTRACT);
 assert.equal((await fast(pool,binding,'customers',{query:'nguyen an'})).result.items[0].id,CUSTOMER);
 const invoices=(await fast(pool,binding,'invoices')).result.items;assert.equal(invoices[0].totalAmount,'123456.75');assert.equal(invoices[1].status,'CANCELLED');
 // B5c step 2 (20261020173818): the fast rows name their building/room. customers: the ACTIVE contract only
 // (CUSTOMER2 holds a TERMINATED one ⇒ empty text, no room); contracts/invoices: room P101 of the fixture building.
 assert.deepEqual(customers.map(r=>[r.id,r.buildingName,r.roomName]),[[CUSTOMER,'Fixture building','P101'],[CUSTOMER2,'',null]]);
 const contracts=(await fast(pool,binding,'contracts')).result.items;
 assert.deepEqual(contracts.map(r=>[r.id,r.buildingName,r.roomName]),[[CONTRACT,'Fixture building','P101'],[CONTRACT2,'Fixture building','P101']]);
 assert.deepEqual(invoices.map(r=>[r.id,r.buildingName,r.roomName]),[[INVOICE,'Fixture building','P101'],[INVOICE2,'Fixture building','P101']]);
 assert.deepEqual(Object.keys(contracts[0]).sort(),['buildingId','buildingName','endDate','id','number','roomId','roomName','startDate','status']);
 assert.deepEqual(Object.keys(invoices[0]).sort(),['billingMonth','buildingId','buildingName','id','number','roomId','roomName','status','totalAmount']);
 // Parity with the family v1 reserve lane (hermes_domain_read_v1, DEFINER, seven-key binding) on the same data and
 // JWT: identical rows, fields and order for contracts and invoices (the lanes a host switches between).
 const bind7={...binding,expectedPolicyVersion:0,expectedMembershipId:MEMBER,expectedAuthorizationVersion:1};
 for(const domain of ['contracts','invoices']){
  const legacy=await normal1(pool,bind7,domain),quick=(await fast(pool,binding,domain)).result;
  assert.deepEqual(quick.items,legacy.items,`fast-vs-v1 ${domain}`);assert.equal(legacy.nextCursor,null);
 }
 const scoped={...activated.connection};let changed=await settings(pool,scoped,{read:['customers.view'],action:[]});binding.expectedEpoch=changed.epoch;
 assert.deepEqual((await fast(pool,binding,'invoices',{query:'Nguyễn An'})).result.items,[]);
 assert.deepEqual((await fast(pool,binding,'contracts',{query:'Nguyễn An'})).result.items,[]);
 await assert.rejects(fast(pool,binding,'customers'),{code:'42501'});
 changed=await settings(pool,changed);binding.expectedEpoch=changed.epoch;
 assert.equal((await fast(pool,binding,'invoices',{query:'Nguyễn An'})).result.items.length,1);
 await pool.query("UPDATE role_permissions SET effect='DENY' WHERE permission_key='invoices.view'");await assert.rejects(fast(pool,binding,'invoices'),{code:'42501'});
 await pool.query("UPDATE role_permissions SET effect='ALLOW' WHERE permission_key='invoices.view'");assert.equal((await fast(pool,binding,'invoices')).result.items.length,2);
 await assert.rejects(fast(pool,{...binding,expectedEpoch:2},'invoices'),{code:'PT409'});
 await assert.rejects(fast(pool,{...binding,expectedSessionRevision:2},'invoices'),{code:'PT409'});
 await assert.rejects(fast(pool,binding,'invoices',{buildingId:OTHER_BUILDING}),{code:'42501'});
 await assert.rejects(fast(pool,binding,'invoices',{}, {user:id(997)}),{code:'42501'});
 await assert.rejects(fast(pool,binding,'invoices',{}, {session:id(998)}),{code:'42501'});
 await pool.query('UPDATE organizations SET authorization_version=authorization_version+1 WHERE id=$1',[ORG]);
 await pool.query("INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,read_capabilities,action_capabilities,scope_ids,updated_by) SELECT $1,true,2,array_agg(capability),'{}',ARRAY[$2]::uuid[],$3 FROM app_private.hermes_capabilities WHERE mode='read' AND enabled",[ORG,ORG_SCOPE,USER]);
 assert.equal((await fast(pool,binding,'invoices')).result.items.length,2,'CRM/policy version changes do not require a new token/binding');
 await pool.query(`INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort) VALUES('${id(500)}','${ORG}','${USER}','New building','new');
 INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES('${id(501)}','${ORG}','BUILDING','${id(500)}');
 INSERT INTO public.rooms VALUES('${id(502)}','${ORG}','${id(500)}','P999','p999',null);
 INSERT INTO public.invoices(id,organization_id,user_id,building_id,room_id,invoice_number,billing_month,status,total_amount,paid_amount,created_at)
 VALUES('${id(503)}','${ORG}','${USER}','${id(500)}','${id(502)}','NEW','2026-10','APPROVED',777.25,0,now());`);
 // The company ceiling intentionally covered only the existing org scope;
 // it still covers the new building through that same organization scope.
 assert.equal((await fast(pool,binding,'invoices')).result.items.length,3,'A newly created building is visible without a new token/session binding');

 await pool.query("UPDATE app_private.hermes_connection_tokens SET revoked_at=now() WHERE token_digest=$1",[tokenDigest]);
 await assert.rejects(fast(pool,binding,'invoices'),{code:'42501'});
 await pool.query("UPDATE app_private.hermes_connection_tokens SET revoked_at=null,expires_at=now()-interval '1 second' WHERE token_digest=$1",[tokenDigest]);
 await assert.rejects(fast(pool,binding,'invoices'),{code:'42501'});
 await pool.query('UPDATE app_private.hermes_connection_tokens SET expires_at=to_timestamp($2/1000.0) WHERE token_digest=$1',[tokenDigest,expiry]);
 const writer=await pool.connect(), reader=await pool.connect();
 try {
  await writer.query('BEGIN');await writer.query("UPDATE organizations SET name='held writer' WHERE id=$1",[ORG]);
  await reader.query('BEGIN READ ONLY');await reader.query("SET LOCAL lock_timeout='100ms'");
  await reader.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claims',$2,true)",[USER,JSON.stringify({sub:USER,session_id:id(32)})]);
  await reader.query('SET LOCAL ROLE authenticated');
  assert.equal((await reader.query('SELECT public.hermes_domain_read_fast_v1($1,$2,$3) value',[JSON.stringify(binding),'invoices',JSON.stringify({query:'',limit:20,cursor:null,buildingId:null,status:null})])).rows[0].value.result.items.length,3);
  await reader.query('COMMIT');
 } finally {await reader.query('ROLLBACK');await writer.query('ROLLBACK');reader.release();writer.release();}
 await pool.query('REVOKE USAGE ON SCHEMA app_private FROM authenticated');
 assert.equal((await fast(pool,binding,'invoices')).result.items.length,3);
 const flags=(await pool.query("SELECT p.proname,p.prosecdef FROM pg_proc p WHERE p.proname=ANY(ARRAY['customer_list_core_v1','contract_list_core_v1','invoice_list_core_v1','hermes_domain_read_rows_fast_v1','hermes_domain_read_fast_v1'])")).rows;
 assert.equal(flags.length,5);assert(flags.every(p=>p.prosecdef===false));
 for(const signature of ['public.hermes_domain_read_fast_v1(jsonb,text,jsonb)','public.customer_list_core_v1(uuid,text,text,text,uuid[],uuid,integer,integer,boolean,text,uuid,uuid[])'])
 assert.equal((await pool.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') value",[signature])).rows[0].value,false);

});
