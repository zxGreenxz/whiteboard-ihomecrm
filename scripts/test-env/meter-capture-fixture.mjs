import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lit, psql, psqlJson } from './lib.mjs';
import { assertTestLease, markTestCleanupRequired } from './lock.mjs';

export const METER_TEST_REF='hzulujxgonszuleqticb';
export const METER_TEST_ORG='aaaa0000-0000-4000-8000-000000000001';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateFixture(f){
 assert.equal(f.projectRef,METER_TEST_REF);assert.equal(f.environment,'TEST');assert.equal(f.disposable,true);
 const ownedIds=['fixtureId','buildingId','roomId','meterId','contractId','serviceId','customerId','internalAccountId','operatingAccountId'];
 for(const key of ownedIds)assert.match(f[key],UUID,key);
 assert.equal(new Set(ownedIds.map(key=>f[key])).size,ownedIds.length,'Synthetic subject IDs must be distinct');
 assert.equal(f.organizationId,METER_TEST_ORG);assert.match(f.actorId,/^[0-9a-f-]{36}$/);
 assert.equal(typeof f.actorEmail,'string');assert.match(f.actorEmail,/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
 assert.equal(f.marker,`E2E-METER-${f.fixtureId}`);assert.equal(f.meterCode,f.marker);assert.equal(f.serial,f.marker);
 assert.match(f.expectedBuildSha,/^[a-f0-9]{40}$/);assert.match(f.readingDate,/^\d{4}-\d{2}-\d{2}$/);
 assert.equal(f.previousValue,'100.00');assert.equal(f.currentValue,'120.25');
 return f;
}
export function newFixture(actorId,expectedBuildSha,actorEmail,date=new Date().toISOString().slice(0,10)){
 const fixtureId=randomUUID();
 if(date.endsWith('-01'))throw new Error('Use an explicit in-month fixture date after day 1.');
 return validateFixture({version:1,projectRef:METER_TEST_REF,environment:'TEST',disposable:true,fixtureId,organizationId:METER_TEST_ORG,
  actorId,actorEmail,buildingId:randomUUID(),roomId:randomUUID(),meterId:randomUUID(),contractId:randomUUID(),serviceId:randomUUID(),customerId:randomUUID(),internalAccountId:randomUUID(),operatingAccountId:randomUUID(),
  marker:`E2E-METER-${fixtureId}`,meterCode:`E2E-METER-${fixtureId}`,serial:`E2E-METER-${fixtureId}`,registerCode:'1.8.0',previousValue:'100.00',currentValue:'120.25',readingDate:date,expectedBuildSha});
}
const guard=f=>`IF NOT EXISTS(SELECT 1 FROM test_env.danh_dau WHERE ref=${lit(METER_TEST_REF)}) THEN RAISE EXCEPTION 'TEST marker mismatch';END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.users u JOIN public.organization_memberships m ON m.user_id=u.id WHERE u.id=${lit(f.actorId)} AND u.email=${lit(f.actorEmail)} AND m.organization_id=${lit(f.organizationId)} AND m.status='ACTIVE') THEN RAISE EXCEPTION 'TEST actor membership mismatch';END IF;`;
export function provisionSql(input){
 const f=validateFixture(input),q=lit;
 return `BEGIN;SET LOCAL statement_timeout='30s';SET LOCAL lock_timeout='5s';
 DO $guard$ BEGIN ${guard(f)}
 IF to_regprocedure('app_private.meter_capture_replacement_v1(uuid)') IS NULL THEN RAISE EXCEPTION 'Reviewed meter schema missing';END IF;
 IF EXISTS(SELECT 1 FROM public.accounts WHERE user_id=${q(f.actorId)} AND deleted_at IS NULL AND name='Cấn trừ thanh lý (nội bộ)') THEN RAISE EXCEPTION 'Actor already has an internal account; refuse to use or change non-fixture account';END IF;
 END $guard$;
 SELECT set_config('request.jwt.claim.sub',${q(f.actorId)},true),set_config('request.jwt.claims',${q(JSON.stringify({sub:f.actorId,role:'authenticated'}))},true);
 CREATE TABLE IF NOT EXISTS test_env.meter_capture_fixtures(fixture_id uuid PRIMARY KEY,manifest jsonb NOT NULL,state text NOT NULL CHECK(state IN('ACTIVE','RETIRED')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),retired_at timestamptz,audit jsonb);
 REVOKE ALL ON test_env.meter_capture_fixtures FROM PUBLIC,anon,authenticated,service_role;
 INSERT INTO test_env.meter_capture_fixtures(fixture_id,manifest,state) VALUES(${q(f.fixtureId)},${q(JSON.stringify(f))}::jsonb,'ACTIVE');
 INSERT INTO public.accounts(id,organization_id,user_id,name,code,description,initial_amount,is_virtual,is_default,initial_date) VALUES
 (${q(f.internalAccountId)},${q(f.organizationId)},${q(f.actorId)},'Cấn trừ thanh lý (nội bộ)',${q(f.marker+'-INT')},${q(f.marker)},0,true,false,${q(f.readingDate)}),
 (${q(f.operatingAccountId)},${q(f.organizationId)},${q(f.actorId)},${q(f.marker+' Thu')},${q(f.marker+'-OP')},${q(f.marker)},0,false,false,${q(f.readingDate)});
 INSERT INTO public.buildings(id,organization_id,user_id,name,code,province,district,ward,description) VALUES(${q(f.buildingId)},${q(f.organizationId)},${q(f.actorId)},${q(f.marker)},${q(f.marker)},'TEST','TEST','TEST',${q(f.marker)});
 UPDATE public.buildings SET default_account_id_tt=${q(f.operatingAccountId)},default_account_id_tk=${q(f.operatingAccountId)} WHERE id=${q(f.buildingId)};
 INSERT INTO public.rooms(id,organization_id,building_id,name,code,rent_price,deposit_amount,description) VALUES(${q(f.roomId)},${q(f.organizationId)},${q(f.buildingId)},${q(f.marker)},${q(f.marker)},0,0,${q(f.marker)});
 INSERT INTO public.services(id,organization_id,user_id,name,code,type,unit_price,unit,fee_type,pricing_type,description) VALUES(${q(f.serviceId)},${q(f.organizationId)},${q(f.actorId)},${q(f.marker)},${q(f.marker)},'METER_READING',1000,'kWh','TIEN_DIEN','DON_GIA_CO_DINH_DONG_HO',${q(f.marker)});
 INSERT INTO public.customers(id,organization_id,user_id,full_name,phone,notes) VALUES(${q(f.customerId)},${q(f.organizationId)},${q(f.actorId)},${q(f.marker)},'0000000000',${q(f.marker)});
 INSERT INTO public.contracts(id,organization_id,user_id,room_id,contract_number,status,signed_date,start_date,end_date,rent_price,total_deposit,initial_electricity_reading,notes)
 VALUES(${q(f.contractId)},${q(f.organizationId)},${q(f.actorId)},${q(f.roomId)},${q(f.marker)},'ACTIVE',${q(f.readingDate.slice(0,7)+'-01')},${q(f.readingDate.slice(0,7)+'-01')},(${q(f.readingDate)}::date+interval '1 year')::date,0,0,100,${q(f.marker)});
 INSERT INTO public.contract_customers(organization_id,contract_id,customer_id,is_representative,notes) VALUES(${q(f.organizationId)},${q(f.contractId)},${q(f.customerId)},true,${q(f.marker)});
 INSERT INTO public.contract_services(organization_id,contract_id,service_id,unit_price,initial_reading) VALUES(${q(f.organizationId)},${q(f.contractId)},${q(f.serviceId)},1000,100);
 INSERT INTO public.meters(id,organization_id,user_id,building_id,room_id,service_id,code,meter_type,initial_reading,serial_number,notes)
 VALUES(${q(f.meterId)},${q(f.organizationId)},${q(f.actorId)},${q(f.buildingId)},${q(f.roomId)},${q(f.serviceId)},${q(f.meterCode)},'ELECTRICITY',100,${q(f.serial)},${q(f.marker)});
 SET CONSTRAINTS ALL IMMEDIATE;COMMIT;`;
}
export function inspectFixture(test,input){
 const f=validateFixture(input),q=lit;
 if(!psqlJson(test,"SELECT to_regclass('test_env.meter_capture_fixtures') IS NOT NULL present")[0].present)return null;
 const [row]=psqlJson(test,`SELECT l.state,l.manifest,
  (b.id IS NOT NULL AND b.organization_id=${q(f.organizationId)} AND b.description=${q(f.marker)} AND b.user_id=${q(f.actorId)}) building_owned,
  (r.id IS NOT NULL AND r.organization_id=${q(f.organizationId)} AND r.building_id=b.id AND r.description=${q(f.marker)}) room_owned,
  (c.id IS NOT NULL AND c.organization_id=${q(f.organizationId)} AND c.user_id=${q(f.actorId)} AND c.room_id=r.id AND c.contract_number=${q(f.marker)} AND split_part(c.notes,E'\\n',1)=${q(f.marker)} AND c.initial_electricity_reading=100) contract_owned,
  (m.id IS NOT NULL AND m.organization_id=${q(f.organizationId)} AND m.room_id=r.id AND m.building_id=b.id AND m.service_id=${q(f.serviceId)} AND m.notes=${q(f.marker)} AND m.code=${q(f.meterCode)}) meter_owned,
  (s.id IS NOT NULL AND s.organization_id=${q(f.organizationId)} AND s.description=${q(f.marker)}) service_owned,
  (customer.id IS NOT NULL AND customer.organization_id=${q(f.organizationId)} AND customer.notes=${q(f.marker)}) customer_owned,
  (ai.id IS NOT NULL AND ai.organization_id=${q(f.organizationId)} AND ai.user_id=${q(f.actorId)} AND ai.description=${q(f.marker)} AND ai.name='Cấn trừ thanh lý (nội bộ)' AND ai.is_virtual AND ai.initial_amount=0) internal_owned,
  (ao.id IS NOT NULL AND ao.organization_id=${q(f.organizationId)} AND ao.user_id=${q(f.actorId)} AND ao.description=${q(f.marker)} AND NOT ao.is_virtual AND ao.initial_amount=0 AND b.default_account_id_tt=ao.id AND b.default_account_id_tk=ao.id) operating_owned,
  (c.status='ACTIVE' AND c.deleted_at IS NULL AND b.deleted_at IS NULL AND r.deleted_at IS NULL AND m.deleted_at IS NULL AND m.status='ACTIVE') active,
  (c.deleted_at IS NOT NULL AND b.deleted_at IS NOT NULL AND b.status='INACTIVE' AND r.deleted_at IS NOT NULL AND m.deleted_at IS NOT NULL AND m.status='INACTIVE' AND s.deleted_at IS NOT NULL AND customer.deleted_at IS NOT NULL AND ai.deleted_at IS NOT NULL AND ao.deleted_at IS NOT NULL) retired,
  (SELECT count(*)::int FROM app_private.meter_captures cap WHERE cap.meter_id=m.id OR cap.contract_id=c.id) captures,
  (SELECT count(*)::int FROM public.meter_readings x WHERE x.meter_id=m.id OR x.contract_id=c.id) readings,
  (SELECT count(*)::int FROM public.invoices x WHERE x.contract_id=c.id) invoices,
  (SELECT a.id FROM public.accounts a WHERE a.user_id=${q(f.actorId)} AND a.deleted_at IS NULL AND a.name='Cấn trừ thanh lý (nội bộ)' ORDER BY a.created_at LIMIT 1) selected_internal,
  public._termination_pick_account(${q(f.actorId)}::uuid,b.id) selected_operating,
  (SELECT 'ihome-meter:'||p.qr_token FROM app_private.meter_capture_profiles p WHERE p.meter_id=m.id AND p.revoked_at IS NULL AND p.serial_number=${q(f.serial)} AND p.register_code='1.8.0' AND p.decimal_places=2) qr
 FROM test_env.meter_capture_fixtures l
 LEFT JOIN public.buildings b ON b.id=${q(f.buildingId)} LEFT JOIN public.rooms r ON r.id=${q(f.roomId)}
 LEFT JOIN public.contracts c ON c.id=${q(f.contractId)} LEFT JOIN public.meters m ON m.id=${q(f.meterId)}
 LEFT JOIN public.services s ON s.id=${q(f.serviceId)} LEFT JOIN public.customers customer ON customer.id=${q(f.customerId)}
 LEFT JOIN public.accounts ai ON ai.id=${q(f.internalAccountId)} LEFT JOIN public.accounts ao ON ao.id=${q(f.operatingAccountId)} WHERE l.fixture_id=${q(f.fixtureId)}`);
 if(!row)return null;
 for(const key of ['building_owned','room_owned','contract_owned','meter_owned','service_owned','customer_owned','internal_owned','operating_owned'])assert.equal(row[key],true,`Exclusive fixture ownership ${key}`);
 for(const key of ['organizationId','actorId','actorEmail','buildingId','roomId','contractId','meterId','serviceId','customerId','internalAccountId','operatingAccountId','marker'])assert.equal(row.manifest[key],f[key],key);
 if(row.state==='ACTIVE'){assert.equal(row.selected_internal,f.internalAccountId);assert.equal(row.selected_operating,f.operatingAccountId);}
 return row;
}
export async function provisionFixture(lease,test,f){
 await assertTestLease(lease,test);markTestCleanupRequired(lease,test);psql(test,provisionSql(f),{timeoutMs:45000});
 const row=inspectFixture(test,f);assert.equal(row?.state,'ACTIVE');assert.equal(row?.captures,0);assert.equal(row?.readings,0);assert.equal(row?.invoices,0);return row;
}
export async function verifyFixture(lease,test,f){
 await assertTestLease(lease,test);const row=inspectFixture(test,f);assert.equal(row?.active,true);assert.equal(row?.state,'ACTIVE');assert.equal(row?.qr,f.qrText);
 assert.equal(row?.captures,0);assert.equal(row?.readings,0);assert.equal(row?.invoices,0);
 return {projectRef:METER_TEST_REF,projectName:'ihomecrm-test',fixtureId:f.fixtureId,exclusive:true,noPriorCaptures:true};
}
export async function retireFixture(lease,test,f,created={clientIds:[],captureIds:[]}){
 await assertTestLease(lease,test);const row=inspectFixture(test,f);
 if(!row){
  const [left]=psqlJson(test,`SELECT (SELECT count(*) FROM public.buildings WHERE id=${lit(f.buildingId)})+(SELECT count(*) FROM public.rooms WHERE id=${lit(f.roomId)})+(SELECT count(*) FROM public.contracts WHERE id=${lit(f.contractId)})+(SELECT count(*) FROM public.meters WHERE id=${lit(f.meterId)})+(SELECT count(*) FROM public.services WHERE id=${lit(f.serviceId)})+(SELECT count(*) FROM public.customers WHERE id=${lit(f.customerId)})+(SELECT count(*) FROM public.accounts WHERE id IN(${lit(f.internalAccountId)},${lit(f.operatingAccountId)})) AS n`);
  assert.equal(Number(left.n),0,'No ledger but fixture entities exist; manual ownership review required');
  return {fixtureId:f.fixtureId,state:'RETIRED',retainedImmutableAudit:true};
 }
 if(row.state==='RETIRED'){assert.equal(row.retired,true);return {fixtureId:f.fixtureId,state:'RETIRED',retainedImmutableAudit:true};}
 const q=lit;
 const unexpected=psqlJson(test,`SELECT id FROM app_private.meter_captures WHERE (meter_id=${q(f.meterId)} OR contract_id=${q(f.contractId)}) AND (organization_id<>${q(f.organizationId)} OR meter_id<>${q(f.meterId)} OR contract_id<>${q(f.contractId)} OR actor_id<>${q(f.actorId)})`);assert.equal(unexpected.length,0,'Unexpected capture ownership');
 const running=psqlJson(test,`SELECT j.id FROM app_private.meter_capture_jobs j JOIN app_private.meter_captures c ON c.id=j.capture_id WHERE c.meter_id=${q(f.meterId)} AND j.state='RUNNING'`);assert.equal(running.length,0,'Worker must settle before fixture retirement');
 // Keep immutable originals, approved readings, captures and document links. Only
 // exclusive synthetic business entities are retired; there is no trigger bypass.
 psql(test,`BEGIN;SET LOCAL statement_timeout='30s';DO $guard$ BEGIN ${guard(f)} END $guard$;
 UPDATE app_private.meter_capture_jobs j SET state='FAILED' FROM app_private.meter_captures c WHERE c.id=j.capture_id AND c.organization_id=${q(f.organizationId)} AND c.meter_id=${q(f.meterId)} AND c.contract_id=${q(f.contractId)} AND c.actor_id=${q(f.actorId)} AND j.state='QUEUED';
 UPDATE public.contracts SET deleted_at=clock_timestamp() WHERE id=${q(f.contractId)} AND organization_id=${q(f.organizationId)} AND user_id=${q(f.actorId)} AND contract_number=${q(f.marker)} AND split_part(notes,E'\\n',1)=${q(f.marker)};
 UPDATE public.meters SET status='INACTIVE',deleted_at=clock_timestamp() WHERE id=${q(f.meterId)} AND organization_id=${q(f.organizationId)} AND notes=${q(f.marker)};
 UPDATE public.rooms SET deleted_at=clock_timestamp() WHERE id=${q(f.roomId)} AND organization_id=${q(f.organizationId)} AND description=${q(f.marker)};
 UPDATE public.buildings SET status='INACTIVE',deleted_at=clock_timestamp() WHERE id=${q(f.buildingId)} AND organization_id=${q(f.organizationId)} AND description=${q(f.marker)};
 UPDATE public.services SET deleted_at=clock_timestamp() WHERE id=${q(f.serviceId)} AND organization_id=${q(f.organizationId)} AND description=${q(f.marker)};
 UPDATE public.customers SET deleted_at=clock_timestamp() WHERE id=${q(f.customerId)} AND organization_id=${q(f.organizationId)} AND notes=${q(f.marker)};
 UPDATE public.accounts SET deleted_at=clock_timestamp() WHERE id IN(${q(f.internalAccountId)},${q(f.operatingAccountId)}) AND organization_id=${q(f.organizationId)} AND user_id=${q(f.actorId)} AND description=${q(f.marker)};
 UPDATE test_env.meter_capture_fixtures SET state='RETIRED',retired_at=clock_timestamp(),audit=${q(JSON.stringify(created))}::jsonb WHERE fixture_id=${q(f.fixtureId)} AND state='ACTIVE';
 SET CONSTRAINTS ALL IMMEDIATE;COMMIT;`,{timeoutMs:45000});
 const after=inspectFixture(test,f);assert.equal(after?.state,'RETIRED');assert.equal(after?.retired,true);assert.equal(after?.captures,row.captures);assert.equal(after?.readings,row.readings);assert.equal(after?.invoices,row.invoices);
 return {fixtureId:f.fixtureId,state:'RETIRED',retainedImmutableAudit:true};
}
