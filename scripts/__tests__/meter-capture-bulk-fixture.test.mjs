import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newFixture} from '../test-env/meter-capture-fixture.mjs';
import {validateBulkRoom} from '../test-env/meter-capture-bulk-fixture.mjs';
const make=()=>{
 const f=newFixture(randomUUID(),'a'.repeat(40),'synthetic@example.invalid','2026-10-27');
 f.bulkRoom={roomId:randomUUID(),meterId:randomUUID(),contractId:randomUUID(),customerId:randomUUID(),marker:f.marker+'-B',meterCode:f.marker+'-B',serial:f.marker+'-B',previousValue:'100.00',currentValue:'140.50'};return f;
};
test('bulk fixture accepts only distinct marked subjects in the separate TEST project',()=>{
 const f=make();assert.equal(validateBulkRoom(f),f.bulkRoom);
 for(const parentKey of ['buildingId','roomId','contractId','meterId','serviceId','customerId','internalAccountId']){
  const changed=structuredClone(f);changed.bulkRoom.roomId=f[parentKey];assert.throws(()=>validateBulkRoom(changed));
 }
 for(const key of ['roomId','meterId','contractId','customerId']){
  const changed=structuredClone(f);changed.bulkRoom[key]='not-a-uuid';assert.throws(()=>validateBulkRoom(changed));
 }
 const duplicate=structuredClone(f);duplicate.bulkRoom.roomId=duplicate.bulkRoom.meterId;assert.throws(()=>validateBulkRoom(duplicate));
 const wrongProject=structuredClone(f);wrongProject.projectRef='tryymsxyyckgbrmmvozx';assert.throws(()=>validateBulkRoom(wrongProject));
 const wrongMarker=structuredClone(f);wrongMarker.bulkRoom.marker='existing';assert.throws(()=>validateBulkRoom(wrongMarker));
});
