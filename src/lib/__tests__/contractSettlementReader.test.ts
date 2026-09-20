import { describe, expect, it } from 'vitest';
import { readContractSettlement, settlementQueryKey, settlementSourceIdentity } from '../contractSettlementReader';
import type { SettlementRow, SettlementSourceRow } from '../contractSettlement';
const scope = { organizationId: 'org', actorId: 'actor', scopeRevision: '1', buildingIds: ['b'], period: '2026-09', mode: 'all' as const, filters: { period: '2026-09' } };
const row = (id: number): SettlementSourceRow => ({ rowType: 'source', rowKey: `s:${String(id).padStart(5,'0')}`, settlementKind: 'commission', sourceRef: {kind:'broker', organizationId:'org', contractId:`c${id}`}, organizationId:'org', buildingId:'b', roomId:null, roomName:null, contractId:`c${id}`, contractNumber:null, customerName:null, eventDate:'2026-08-31', recipient:{name:null,bankName:null,bankAccount:null}, basis:{kind:'COMMISSION',status:'AVAILABLE',amount:10,measuredAt:null,source:'tier',fingerprint:null,version:null,warning:null},createEligibility:{state:'unavailable',reasonCodes:['WRITER_PENDING']} });
const page = (rows: SettlementRow[], nextCursor: string | null = null, revision = 'r') => ({rows,nextCursor,revision,asOf:'2026-09-21T00:00:00Z'});
describe('complete settlement reader', () => {
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
  for(const patch of [{actorId:'other'},{organizationId:'other'},{scopeRevision:'2'}])expect(settlementQueryKey({...scope,...patch})).not.toEqual(settlementQueryKey(scope));
 });
});
