import { DEMO_ORG, digest } from './copilot-golden-primitives.mjs';

export const FINANCIAL_READ_CASES = {
  C03:'unpaid-invoices-2026-07-v1', C05:'revenue-2026-07-v1', C15:'empty-invoices-2099-01-partial-v1',
  C17:'accrual-2026-07-v1', C19:'empty-receivables-2099-01-v1',
  C24:'revenue-and-invoices-2026-07-v1', C26:'invoices-and-receivables-2026-07-v1',
};
const PROMPTS = {C03:'Hóa đơn 2026-07 chưa thanh toán',C05:'Doanh thu tháng 2026-07',C15:'Hóa đơn 2099-01 trạng thái partial',C17:'KQKD dồn tích 2026-07',C19:'Công nợ kỳ 2099-01',C24:'Doanh thu 07/2026 còn nợ tháng đó?',C26:'Hóa đơn chưa thu và tổng công nợ 07/2026'};
const ROLE_KEYS = {invoice:['id','invoice_number','billing_month','total_amount','status','building_id','building_name','room_id','room_name'],pnl:['month','building_id','building_name','is_virtual','revenue','expense','net'],stats:['total_amount','total_paid','total_remaining','total_refunded','total_count','rent_amount','electric_amount','water_amount','pdv_amount','total_collected','payment_tm','payment_tk','payment_tt','payment_ct','change_amount','deposit_collected']};
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text=v=>typeof v==='string' && v.trim().length>0;
const numeric=v=>typeof v==='number' && Number.isFinite(v);
const requireFixture=ok=>{if(!ok)throw new Error('fixture_unbound');};
const origin=v=>{try{return typeof v==='string' && new URL(v).origin===v && new URL(v).protocol==='https:';}catch{return false;}};
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
export const sameFinancialArgs=(a,b)=>exact(a,Object.keys(b)) && Object.keys(b).every(k=>a[k]===b[k]);
function exactDifference(revenue,expense,net) {
  const values=[revenue,expense,net].map(n=>{
    const [mantissa,exponent='0']=String(n).split('e'),[integer,fraction='']=mantissa.split('.');
    return {digits:BigInt(integer+fraction),scale:fraction.length-Number(exponent)};
  });
  const scale=Math.max(0,...values.map(v=>v.scale));
  const [r,e,n]=values.map(v=>v.digits*10n**BigInt(scale-v.scale));
  return r-e===n;
}

/** Canonical role order is independent of model/request arrival order. */
export function financialReadRequests(caseId) {
  requireFixture(Object.hasOwn(FINANCIAL_READ_CASES,caseId));
  const period=['C15','C19'].includes(caseId)?'2099-01':'2026-07',roles={};
  if(['C03','C15','C24','C26'].includes(caseId))roles.invoice={rpc:'copilot_invoice_search_v1',args:{p_organization_id:DEMO_ORG,p_billing_month:period,p_payment_status:caseId==='C15'?'partial':'unpaid'}};
  if(['C05','C17','C24'].includes(caseId))roles.pnl={rpc:'copilot_financial_pnl_v1',args:{p_organization_id:DEMO_ORG,p_start_date:'2026-07-01',p_end_date:'2026-07-31',p_accrual:caseId==='C17'}};
  if(['C19','C26'].includes(caseId))roles.stats={rpc:'copilot_invoice_stats_v1',args:{p_organization_id:DEMO_ORG,p_billing_month:period}};
  return roles;
}
function validatePayload(role,payload,id) {
  if(role==='stats') {
    requireFixture(exact(payload,ROLE_KEYS.stats) && ROLE_KEYS.stats.every(k=>numeric(payload[k])) && Number.isInteger(payload.total_count) && payload.total_count>=0);
    requireFixture(id==='C19'?ROLE_KEYS.stats.every(k=>payload[k]===0):payload.total_count>0 && payload.total_remaining>0);
    return;
  }
  requireFixture(Array.isArray(payload) && (id==='C15'?payload.length===0:payload.length>0));
  if(role==='invoice')requireFixture(payload.length<=2000);
  for(const row of payload) {
    requireFixture(exact(row,ROLE_KEYS[role]) && UUID.test(row.building_id) && text(row.building_name));
    if(role==='invoice') {
      requireFixture(UUID.test(row.id) && UUID.test(row.room_id) && text(row.room_name) && (row.invoice_number===null || text(row.invoice_number)));
      requireFixture(row.billing_month==='2026-07' && numeric(row.total_amount) && row.total_amount>0 && text(row.status)
        && !['PAID','PARTIAL_PAID','CANCELLED','CANCELED'].includes(row.status));
    } else {
      requireFixture(row.month==='2026-07-01' && typeof row.is_virtual==='boolean' && ['revenue','expense','net'].every(k=>numeric(row[k])));
      // Compare the actual JSON numeric representation; never round away drift.
      requireFixture(exactDifference(row.revenue,row.expense,row.net));
    }
  }
  const identities=payload.map(r=>role==='invoice'?r.id:r.building_id);
  const labels=payload.map(r=>role==='invoice'?(r.invoice_number??r.id.slice(0,8)):r.building_name);
  requireFixture(new Set(identities).size===payload.length && new Set(labels).size===payload.length);
}
export function bindFinancialReadScenario(scenario,input) {
  requireFixture(Object.hasOwn(FINANCIAL_READ_CASES,scenario?.id) && scenario.oracle===FINANCIAL_READ_CASES[scenario.id] && scenario.prompt===PROMPTS[scenario.id]);
  requireFixture(input?.organizationId===DEMO_ORG && typeof input.actorDigest==='string' && HASH.test(input.actorDigest));
  requireFixture(origin(input.appOrigin) && origin(input.apiOrigin));
  const expected=financialReadRequests(scenario.id);
  requireFixture(exact(input.roles,Object.keys(expected)));
  const roles={},boundRoles={};
  for(const [role,request] of Object.entries(expected)) {
    const actual=input.roles[role];
    requireFixture(exact(actual,['request','payload']) && exact(actual.request,['rpc','args']) && actual.request.rpc===request.rpc && sameFinancialArgs(actual.request.args,request.args));
    validatePayload(role,actual.payload,scenario.id);
    const rows=role==='stats'?[actual.payload]:actual.payload;
    const facts=rows.map(row=>Object.fromEntries(ROLE_KEYS[role].map(k=>[k,row[k]])));
    roles[role]={rpc:request.rpc,argsDigest:digest(request.args),responseDigest:digest(actual.payload),factDigest:digest({organizationId:DEMO_ORG,actorDigest:input.actorDigest,facts}),schemaDigest:digest(ROLE_KEYS[role]),rowCount:rows.length,shape:role==='stats'?'object':'array',readiness:['C15','C19'].includes(scenario.id)?'empty':'positive',...(role==='pnl'?{basis:request.args.p_accrual?'accrual':'cash'}:{}),...(role==='stats'?{responseKeyOrder:Object.keys(actual.payload)}:{})};
    boundRoles[role]={request,payload:actual.payload};
  }
  const attestation={kind:'financial-read',organizationId:DEMO_ORG,actorDigest:input.actorDigest,appOrigin:input.appOrigin,apiOrigin:input.apiOrigin,roles};
  return {prompt:scenario.prompt,organizationId:DEMO_ORG,actorDigest:input.actorDigest,appOrigin:input.appOrigin,apiOrigin:input.apiOrigin,roles:boundRoles,attestation,bindingDigest:digest(attestation)};
}
export function financialRoleDigest(attestation) {
  return digest(Object.fromEntries(Object.keys(attestation.roles).sort().map(role=>[role,attestation.roles[role].responseDigest])));
}
/** Evidence schema validates request/schema/readiness independently of receipt hashes. */
export function validFinancialReadAttestation(id,f,actorDigest) {
  if(!Object.hasOwn(FINANCIAL_READ_CASES,id) || !exact(f,['kind','organizationId','actorDigest','appOrigin','apiOrigin','roles']) || f.kind!=='financial-read' || f.organizationId!==DEMO_ORG || f.actorDigest!==actorDigest || !HASH.test(actorDigest) || !origin(f.appOrigin) || !origin(f.apiOrigin))return false;
  const requests=financialReadRequests(id);
  if(!exact(f.roles,Object.keys(requests)))return false;
  return Object.entries(requests).every(([role,request])=>{
    const r=f.roles[role],empty=['C15','C19'].includes(id);
    if(!exact(r,['rpc','argsDigest','responseDigest','factDigest','schemaDigest','rowCount','shape','readiness',...(role==='pnl'?['basis']:[]),...(role==='stats'?['responseKeyOrder']:[])]) || r.rpc!==request.rpc || r.argsDigest!==digest(request.args) || r.schemaDigest!==digest(ROLE_KEYS[role]) || !['responseDigest','factDigest'].every(k=>typeof r[k]==='string' && HASH.test(r[k])) || r.shape!==(role==='stats'?'object':'array') || r.readiness!==(empty?'empty':'positive') || !Number.isInteger(r.rowCount) || (role==='stats'?r.rowCount!==1:empty?r.rowCount!==0:r.rowCount<=0) || (role==='invoice' && r.rowCount>2000) || (role==='pnl' && r.basis!==(request.args.p_accrual?'accrual':'cash')))return false;
    if(role==='stats' && (!Array.isArray(r.responseKeyOrder) || r.responseKeyOrder.length!==ROLE_KEYS.stats.length || new Set(r.responseKeyOrder).size!==ROLE_KEYS.stats.length || !r.responseKeyOrder.every(k=>ROLE_KEYS.stats.includes(k))))return false;
    if(empty) {
      const payload=role==='stats'?Object.fromEntries(r.responseKeyOrder.map(k=>[k,0])):[];
      const rebound=bindFinancialReadScenario({id,oracle:FINANCIAL_READ_CASES[id],prompt:PROMPTS[id]},{organizationId:DEMO_ORG,actorDigest,appOrigin:f.appOrigin,apiOrigin:f.apiOrigin,roles:{[role]:{request,payload}}});
      return r.responseDigest===rebound.attestation.roles[role].responseDigest && r.factDigest===rebound.attestation.roles[role].factDigest;
    }
    return true;
  });
}
