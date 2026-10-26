import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lit,psql,psqlJson} from './lib.mjs';
import {assertTestLease} from './lock.mjs';
import {inspectFixture,validateFixture} from './meter-capture-fixture.mjs';

export function validateBulkRoom(f){
 validateFixture(f);const b=f.bulkRoom;assert(b,'Bulk room missing');
 const ids=['roomId','meterId','contractId','customerId'];
 const parentIds=new Set(['fixtureId','buildingId','roomId','meterId','contractId','serviceId','customerId','internalAccountId','operatingAccountId'].map(key=>f[key]));
 for(const key of ids){assert.match(b[key],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert(!parentIds.has(b[key]),'Bulk IDs must not alias parent records');}
 assert.equal(new Set(ids.map(key=>b[key])).size,ids.length);
 assert.equal(b.marker,f.marker+'-B');assert.equal(b.meterCode,b.marker);assert.equal(b.serial,b.marker);
 assert.equal(b.previousValue,'100.00');assert.equal(b.currentValue,'140.50');return b;
}
export async function provisionBulkRoom(lease,test,f){
 await assertTestLease(lease,test);assert.equal(inspectFixture(test,f)?.state,'ACTIVE');
 f.bulkRoom={roomId:randomUUID(),meterId:randomUUID(),contractId:randomUUID(),customerId:randomUUID(),marker:f.marker+'-B',meterCode:f.marker+'-B',serial:f.marker+'-B',previousValue:'100.00',currentValue:'140.50'};
 const b=validateBulkRoom(f),q=lit;
 psql(test,`BEGIN;SET LOCAL statement_timeout='30s';
 SELECT set_config('request.jwt.claim.sub',${q(f.actorId)},true),set_config('request.jwt.claims',${q(JSON.stringify({sub:f.actorId,role:'authenticated'}))},true);
 INSERT INTO public.rooms(id,organization_id,building_id,name,code,rent_price,deposit_amount,description) VALUES(${q(b.roomId)},${q(f.organizationId)},${q(f.buildingId)},${q(b.marker)},${q(b.marker)},0,0,${q(b.marker)});
 INSERT INTO public.customers(id,organization_id,user_id,full_name,phone,notes) VALUES(${q(b.customerId)},${q(f.organizationId)},${q(f.actorId)},${q(b.marker)},'0000000000',${q(b.marker)});
 INSERT INTO public.contracts(id,organization_id,user_id,room_id,contract_number,status,signed_date,start_date,end_date,rent_price,total_deposit,initial_electricity_reading,notes)
 VALUES(${q(b.contractId)},${q(f.organizationId)},${q(f.actorId)},${q(b.roomId)},${q(b.marker)},'ACTIVE',${q(f.readingDate.slice(0,7)+'-01')},${q(f.readingDate.slice(0,7)+'-01')},(${q(f.readingDate)}::date+interval '1 year')::date,0,0,100,${q(b.marker)});
 INSERT INTO public.contract_customers(organization_id,contract_id,customer_id,is_representative,notes) VALUES(${q(f.organizationId)},${q(b.contractId)},${q(b.customerId)},true,${q(b.marker)});
 INSERT INTO public.contract_services(organization_id,contract_id,service_id,unit_price,initial_reading) VALUES(${q(f.organizationId)},${q(b.contractId)},${q(f.serviceId)},1000,100);
 INSERT INTO public.meters(id,organization_id,user_id,building_id,room_id,service_id,code,meter_type,initial_reading,serial_number,notes)
 VALUES(${q(b.meterId)},${q(f.organizationId)},${q(f.actorId)},${q(f.buildingId)},${q(b.roomId)},${q(f.serviceId)},${q(b.meterCode)},'ELECTRICITY',100,${q(b.serial)},${q(b.marker)});
 UPDATE test_env.meter_capture_fixtures SET manifest=${q(JSON.stringify(f))}::jsonb WHERE fixture_id=${q(f.fixtureId)} AND state='ACTIVE';
 SET CONSTRAINTS ALL IMMEDIATE;COMMIT;`);
 return inspectBulkRoom(test,f);
}
export function inspectBulkRoom(test,f){
 const b=validateBulkRoom(f),q=lit;
 const [row]=psqlJson(test,`SELECT
 (r.organization_id=${q(f.organizationId)} AND r.building_id=${q(f.buildingId)} AND r.description=${q(b.marker)}
 AND c.organization_id=r.organization_id AND c.room_id=r.id AND c.user_id=${q(f.actorId)} AND c.contract_number=${q(b.marker)} AND c.notes=${q(b.marker)}
 AND m.organization_id=r.organization_id AND m.room_id=r.id AND m.building_id=r.building_id AND m.service_id=${q(f.serviceId)} AND m.notes=${q(b.marker)}
 AND u.organization_id=r.organization_id AND u.user_id=${q(f.actorId)} AND u.notes=${q(b.marker)}
 AND l.manifest->'bulkRoom'->>'roomId'=r.id::text AND l.manifest->'bulkRoom'->>'meterId'=m.id::text
 AND l.manifest->'bulkRoom'->>'contractId'=c.id::text AND l.manifest->'bulkRoom'->>'customerId'=u.id::text) owned,
 (r.deleted_at IS NOT NULL AND c.deleted_at IS NOT NULL AND m.deleted_at IS NOT NULL AND u.deleted_at IS NOT NULL) retired,
 (SELECT count(*)::int FROM app_private.meter_captures x WHERE x.meter_id=m.id OR x.contract_id=c.id) captures,
 (SELECT count(*)::int FROM public.invoices x WHERE x.contract_id=c.id) invoices
 FROM public.rooms r JOIN public.contracts c ON c.id=${q(b.contractId)} JOIN public.meters m ON m.id=${q(b.meterId)}
 JOIN public.customers u ON u.id=${q(b.customerId)} JOIN test_env.meter_capture_fixtures l ON l.fixture_id=${q(f.fixtureId)} WHERE r.id=${q(b.roomId)}`);
 if(!row){
  const [left]=psqlJson(test,`SELECT (SELECT count(*) FROM public.rooms WHERE id=${q(b.roomId)})+(SELECT count(*) FROM public.contracts WHERE id=${q(b.contractId)})+(SELECT count(*) FROM public.meters WHERE id=${q(b.meterId)})+(SELECT count(*) FROM public.customers WHERE id=${q(b.customerId)}) n`);
  assert.equal(Number(left.n),0,'Partially present bulk fixture requires ownership recovery');return null;
 }
 assert.equal(row.owned,true,'Exclusive bulk fixture ownership required');return row;
}
export async function retireBulkRoom(lease,test,f){
 if(!f.bulkRoom)return;
 await assertTestLease(lease,test);const before=inspectBulkRoom(test,f);if(!before||before.retired)return;
 const b=validateBulkRoom(f),q=lit;
 const [active]=psqlJson(test,`SELECT count(*)::int n FROM app_private.meter_capture_jobs j JOIN app_private.meter_captures c ON c.id=j.capture_id WHERE c.meter_id=${q(b.meterId)} AND j.state='RUNNING'`);assert.equal(active.n,0,'Bulk worker must settle before cleanup');
 const unexpected=psqlJson(test,`SELECT id FROM app_private.meter_captures WHERE (meter_id=${q(b.meterId)} OR contract_id=${q(b.contractId)}) AND (organization_id<>${q(f.organizationId)} OR meter_id<>${q(b.meterId)} OR contract_id<>${q(b.contractId)} OR actor_id<>${q(f.actorId)})`);assert.equal(unexpected.length,0);
 psql(test,`BEGIN;SET LOCAL statement_timeout='30s';
 UPDATE app_private.meter_capture_jobs j SET state='FAILED' FROM app_private.meter_captures c WHERE c.id=j.capture_id AND c.organization_id=${q(f.organizationId)} AND c.meter_id=${q(b.meterId)} AND c.contract_id=${q(b.contractId)} AND c.actor_id=${q(f.actorId)} AND j.state='QUEUED';
 UPDATE public.contracts SET deleted_at=clock_timestamp() WHERE id=${q(b.contractId)} AND organization_id=${q(f.organizationId)} AND notes=${q(b.marker)};
 UPDATE public.meters SET status='INACTIVE',deleted_at=clock_timestamp() WHERE id=${q(b.meterId)} AND organization_id=${q(f.organizationId)} AND notes=${q(b.marker)};
 UPDATE public.rooms SET deleted_at=clock_timestamp() WHERE id=${q(b.roomId)} AND organization_id=${q(f.organizationId)} AND description=${q(b.marker)};
 UPDATE public.customers SET deleted_at=clock_timestamp() WHERE id=${q(b.customerId)} AND organization_id=${q(f.organizationId)} AND notes=${q(b.marker)};
 SET CONSTRAINTS ALL IMMEDIATE;COMMIT;`);
 const after=inspectBulkRoom(test,f);assert.equal(after.retired,true);assert.equal(after.captures,before.captures);assert.equal(after.invoices,before.invoices);
}
