import { describe, expect, it } from 'vitest';
import { classifySettlementPostingDate, readContractSettlement, settlementQueryKey, settlementSourceIdentity } from '../contractSettlementReader';
import type { SettlementRow, SettlementSourceRow, SettlementVoucherRow, VoucherSnapshot } from '../contractSettlement';
import { parseSettlementRow } from '../contractSettlement';
const scope = { organizationId: 'org', actorId: 'actor', scopeRevision: '1', buildingIds: ['b'], period: '2026-09', mode: 'all' as const, dateBasis: 'business' as const, filters: { period: '2026-09' } };
const row = (id: number): SettlementSourceRow => ({ rowType: 'source', rowKey: `s:${String(id).padStart(5,'0')}`, settlementKind: 'commission', sourceRef: {kind:'broker', organizationId:'org', contractId:`c${id}`}, organizationId:'org', buildingId:'b', roomId:null, roomName:null, contractId:`c${id}`, contractNumber:null, customerName:null, eventDate:'2026-08-31', recipient:{name:null,bankName:null,bankAccount:null}, basis:{kind:'COMMISSION',status:'AVAILABLE',amount:10,measuredAt:null,source:'tier',fingerprint:null,version:null,warning:null},createEligibility:{state:'unavailable',reasonCodes:['WRITER_PENDING']} });
const page = (rows: SettlementRow[], nextCursor: string | null = null, revision = 'r') => ({rows,nextCursor,revision,asOf:'2026-09-21T00:00:00Z'});
const voucher = (patch: Partial<VoucherSnapshot> = {}): SettlementVoucherRow => ({
 rowType:'voucher',rowKey:'voucher:v',voucherId:'v',voucherCode:'PC',settlementKind:'commission',sourceLink:{state:'verified',sourceRef:{kind:'broker',organizationId:'org',contractId:'c'}},basis:row(1).basis,
 snapshot:{state:'ready',value:{id:'v',code:'PC',organizationId:'org',buildingId:'b',roomId:null,roomName:null,contractId:'c',contractNumber:null,tenantId:null,customerName:null,totalAmount:10,type:'EXPENSE',payerName:null,receiveBankName:null,receiveBankAccount:null,accountId:null,approvalStatus:'APPROVED',postingStatus:'POSTED',postingMode:'CASHBOOK',reviewState:'PENDING',reviewReason:null,approvalVersion:1,postingVersion:1,reviewVersion:1,systemSource:null,activePostingId:'p',effectiveNetPaid:10,postedOn:'2026-09-01',voucherDate:'2026-08-31',sourceEventDate:'2026-08-31',makerUserId:null,flowOwnership:{state:'loading'},postingEvidence:{state:'ready',value:{activePostingId:'p',effectiveNetPaid:10,postedOn:'2026-09-01'}},notes:null,attachments:[],actionReadiness:{state:'loading'},...patch}}
});
describe('complete settlement reader', () => {
 it('backlog keeps already-arisen pending vouchers after an old header month',async()=>{
  const pending=voucher({approvalStatus:'UNAPPROVED',postingStatus:'UNPOSTED',activePostingId:null,effectiveNetPaid:0,postedOn:null,sourceEventDate:'2026-09-01'});
  const result=await readContractSettlement({...scope,mode:'backlog',period:'2026-08',filters:{period:'2026-08'}},async()=>page([pending]));
  expect(result.rows).toHaveLength(1);expect(result.totals?.pendingAmount).toBe(10);
 });
 it('posting period uses verified postedOn and business period uses source date',async()=>{
  for(const dateBasis of ['business','posting'] as const)for(const period of ['2026-08','2026-09']){
   const result=await readContractSettlement({...scope,mode:'period',dateBasis,period,filters:{period}},async()=>page([voucher()]));
   const matches=dateBasis==='posting'?period==='2026-09':period==='2026-08';
   expect(result.rows).toHaveLength(matches?1:0);expect(result.totals?.effectiveNetPaid).toBe(matches?10:0);
  }
 });
 it('posting filter excludes sources and known unposted/noncash vouchers',async()=>{
  const noCash={activePostingId:null,postedOn:null,effectiveNetPaid:0,postingEvidence:{state:'ready' as const,value:{activePostingId:null,postedOn:null,effectiveNetPaid:0}}};
  for(const item of [{...row(1),eventDate:'2026-09-01'},voucher({sourceEventDate:'2026-09-01',approvalStatus:'UNAPPROVED',postingStatus:'UNPOSTED',...noCash}),voucher({sourceEventDate:'2026-09-01',postingMode:'NON_CASH',postingStatus:'NOT_APPLICABLE',...noCash})]){
   const result=await readContractSettlement({...scope,mode:'period',dateBasis:'posting'},async()=>page([item]));expect(result.rows).toHaveLength(0);expect(result.totals?.effectiveNetPaid).toBe(0);
  }
 });
 it('classifies only pending cashless and verified non-cash evidence as known absence',()=>{
  expect(classifySettlementPostingDate(row(1))).toEqual({state:'known_none'});
  expect(classifySettlementPostingDate(voucher())).toEqual({state:'known_paid',postedOn:'2026-09-01'});
  const noCash={activePostingId:null,postedOn:null,effectiveNetPaid:0,postingEvidence:{state:'ready' as const,value:{activePostingId:null,postedOn:null,effectiveNetPaid:0}}};
  expect(classifySettlementPostingDate(voucher({...noCash,approvalStatus:'UNAPPROVED',postingStatus:'UNPOSTED'}))).toEqual({state:'known_none'});
  expect(classifySettlementPostingDate(voucher({...noCash,postingMode:'NON_CASH',postingStatus:'NOT_APPLICABLE'}))).toEqual({state:'known_none'});
  for(const patch of [{postingStatus:'UNPOSTED' as const},{postingStatus:'REVERSED' as const},{approvalStatus:'CANCELLED' as const,postingStatus:'UNPOSTED' as const}])expect(classifySettlementPostingDate(voucher({...noCash,...patch}))).toEqual({state:'unverified'});
 });
 it('keeps NULL status and contradictory nonpaid headers visible without totals',async()=>{
  const patches:Partial<VoucherSnapshot>[]=[{postingStatus:'UNPOSTED'},{approvalStatus:'CANCELLED'},{approvalStatus:'CANCELLED',postingStatus:'UNPOSTED'},{postingMode:'NON_CASH',postingStatus:'NOT_APPLICABLE'},{postingStatus:'REVERSED'},
   {postingStatus:'UNPOSTED',activePostingId:null,postedOn:null,effectiveNetPaid:0,postingEvidence:{state:'loading'}},
   {postingStatus:'UNPOSTED',activePostingId:null,postedOn:null,effectiveNetPaid:0,postingEvidence:{state:'ready',value:{activePostingId:null,postedOn:null,effectiveNetPaid:1}}}];
  const original=voucher();if(original.snapshot.state!=='ready')throw Error('Invalid test fixture');
  const nullStatus=parseSettlementRow({...original,snapshot:{state:'ready',value:{...original.snapshot.value,postingStatus:null}}});
  for(const item of [nullStatus,...patches.map(voucher)]){
   expect(classifySettlementPostingDate(item).state).toBe('unverified');
   const result=await readContractSettlement({...scope,mode:'period',dateBasis:'posting'},async()=>page([item]));expect(result.rows).toHaveLength(1);expect(result.partial).toBe(true);expect(result.totals).toBeNull();
  }
 });
 it('posting filter keeps unavailable or unverified posting detail visible without totals',async()=>{
  const unknown={...voucher(),snapshot:{state:'unavailable' as const,reason:'DENIED'}};
  for(const item of [unknown,voucher({postingEvidence:{state:'loading'}}),voucher({postingEvidence:{state:'ready',value:{activePostingId:'wrong',effectiveNetPaid:10,postedOn:'2026-09-01'}}})]){
   const result=await readContractSettlement({...scope,mode:'period',dateBasis:'posting'},async()=>page([item]));expect(result.rows).toHaveLength(1);expect(result.partial).toBe(true);expect(result.totals).toBeNull();
  }
 });
 it('keeps source identity stable across obligation versions and property order',()=>{
  expect(settlementSourceIdentity({kind:'termination_refund',organizationId:'org',terminationId:'t',obligationId:'o1',obligationVersion:1})).toBe(settlementSourceIdentity({terminationId:'t',organizationId:'org',kind:'termination_refund',obligationId:'o2',obligationVersion:2}));
 });
 it('preserves a known denied-detail voucher and withholds totals',async()=>{
  const result=await readContractSettlement(scope,async()=>page([{rowType:'voucher',rowKey:'voucher:v',voucherId:'v',voucherCode:'PC',settlementKind:'commission',sourceLink:{state:'verified',sourceRef:{kind:'broker',organizationId:'org',contractId:'c'}},snapshot:{state:'unavailable',reason:'DENIED'},basis:row(1).basis}]));
  expect(result.rows).toHaveLength(1);expect(result.partial).toBe(true);expect(result.totals).toBeNull();
 });
 it('rejects foreign-org source links even when snapshot is unavailable',async()=>{
  const result=await readContractSettlement(scope,async()=>page([{rowType:'voucher',rowKey:'voucher:v',voucherId:'v',voucherCode:'PC',settlementKind:'commission',sourceLink:{state:'verified',sourceRef:{kind:'broker',organizationId:'foreign',contractId:'c'}},snapshot:{state:'unavailable',reason:'DENIED'},basis:row(1).basis}]));
  expect(result.rows).toHaveLength(0);expect(result.error).toBe('SETTLEMENT_SCOPE_MISMATCH');
 });
 it('reads 1001 rows including final page and computes full totals', async () => {
  let calls=0; const result=await readContractSettlement(scope, async () => { calls++; return calls===1?page(Array.from({length:1000},(_,i)=>row(i)), 's:00999'):page([row(1000)]); });
  expect(calls).toBe(2); expect(result.rows).toHaveLength(1001); expect(result.totals?.sourceAmount).toBe(10010); expect(result.partial).toBe(false);
 });
 it('never publishes partial totals when later page fails', async () => {
  let calls=0; const result=await readContractSettlement(scope,async()=>{if(++calls===1)return page([row(1)],'s:00001');throw Error('denied');});
  expect(result.partial).toBe(true); expect(result.totals).toBeNull(); expect(result.error).toBeTruthy();
 });
 it.each(['duplicate','revision'])('rejects %s drift instead of fake snapshot',async(mode)=>{
  let calls=0;const result=await readContractSettlement(scope,async()=>++calls===1?page([row(1)],'s:00001'):page([row(mode==='duplicate'?1:2)],null,mode==='revision'?'changed':'r'));
  expect(result.partial).toBe(true); expect(result.totals).toBeNull();
 });
 it('applies period and filters before totals using source event calendar date',async()=>{
  const result=await readContractSettlement({...scope,mode:'period'},async()=>page([row(1),{...row(2),eventDate:'2026-09-01'}]));expect(result.rows).toHaveLength(1);expect(result.totals?.sourceAmount).toBe(10);
 });
 it('keys separate actor, scope, org and normalize building IDs',()=>{
  expect(settlementQueryKey({...scope,buildingIds:['b','a','b']})).toEqual(settlementQueryKey({...scope,buildingIds:['a','b']}));
  for(const patch of [{actorId:'other'},{organizationId:'other'},{scopeRevision:'2'},{dateBasis:'posting' as const}])expect(settlementQueryKey({...scope,...patch})).not.toEqual(settlementQueryKey(scope));
 });
});
