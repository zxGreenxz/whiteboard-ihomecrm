import { DEMO_ORG, digest, validC02Ownership } from './copilot-golden-browser-evidence.mjs';

export const CUSTOMER_CASES = { C02:'customer-nguyen-an-v1', C14:'absent-synthetic-phone-v1' };
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text=v=>typeof v==='string' && v.trim().length>0;
const requireFixture=ok=>{if(!ok)throw new Error('fixture_unbound');};
export function customerQuery(caseId,contextId) {
  requireFixture(Object.prototype.hasOwnProperty.call(CUSTOMER_CASES,caseId) && typeof contextId==='string' && /^[a-zA-Z0-9-]{1,100}$/.test(contextId));
  return caseId==='C02'?'Nguyễn An':`000${String(parseInt(digest(contextId).slice(0,12),16)%10000000).padStart(7,'0')}`;
}
/** Raw phone and payload stay in memory; callers persist only attestation. */
export function bindCustomerScenario(scenario,{query,contextId,actorDigest,payload,ownedCustomerId,ownership}) {
  requireFixture(Object.prototype.hasOwnProperty.call(CUSTOMER_CASES,scenario?.id) && scenario.oracle===CUSTOMER_CASES[scenario.id]);
  requireFixture(query===customerQuery(scenario.id,contextId) && typeof actorDigest==='string' && /^[a-f0-9]{64}$/.test(actorDigest));
  const absent=scenario.id==='C14';
  requireFixture(Array.isArray(payload) && payload.length===(absent?0:1));
  const keys=['customer_id','customer_name','phone','contract_id','contract_number','contract_status','room_id','room_name','building_id','building_name','is_representative'];
  for(const row of payload) {
    requireFixture(row && typeof row==='object' && Object.keys(row).length===keys.length && keys.every(k=>Object.prototype.hasOwnProperty.call(row,k)));
    requireFixture(['customer_id','contract_id','room_id','building_id'].every(k=>typeof row[k]==='string' && UUID.test(row[k])));
    requireFixture(row.customer_name==='Nguyễn An' && ['contract_number','room_name','building_name'].every(k=>text(row[k])));
    requireFixture(['DRAFT','ACTIVE','EXTENDED','TRANSFERRED','TERMINATED','EXPIRED'].includes(row.contract_status) && typeof row.is_representative==='boolean');
    requireFixture(typeof row.phone==='string' && /^\d{10}$/.test(row.phone));
    requireFixture(validC02Ownership(ownership,{actorDigest,contextDigest:digest(contextId),responseDigest:digest(payload)}));
    requireFixture(row.customer_id===ownership.customerId&&row.contract_id===ownership.hostId&&row.room_id===ownership.roomId&&row.building_id===ownership.buildingId&&row.is_representative===false&&row.contract_status==='TERMINATED');
    requireFixture(row.phone===customerQuery('C14',contextId)&&digest(row.phone)===ownership.phoneDigest&&ownership.markerDigest===digest(`COPILOT_C02_${contextId}_${row.customer_id}`));
    requireFixture(ownedCustomerId===undefined);
  }
  requireFixture(!absent || ownedCustomerId===undefined&&ownership===undefined);
  const template=absent?'Tìm khách bằng số điện thoại {{absent.syntheticPhone}}':'Tìm khách hàng Nguyễn An';
  requireFixture(scenario.prompt===template);
  const prompt=absent?template.replace('{{absent.syntheticPhone}}',query):template;
  const rows=payload.map(({phone,...row})=>({...row,maskedPhone:`${phone.slice(0,3)}***${phone.slice(-4)}`,phoneDigest:digest(phone)}));
  const attestation={kind:absent?'customer-absent':'customer-search',organizationId:DEMO_ORG,actorDigest,contextDigest:digest(contextId),
    queryDigest:digest({p_organization_id:DEMO_ORG,p_search:query}),identityDigest:digest({organizationId:DEMO_ORG,actorDigest,rows}),responseDigest:digest(payload),...(absent?{}:{ownership:structuredClone(ownership)})};
  return {prompt,query,contextId,actorDigest,payload,...(absent?{}:{ownership:structuredClone(ownership)}),bindingDigest:digest(attestation),attestation};
}
