import { describe, expect, it } from 'vitest';
import { buildSettlementEventLinks, settlementEventView } from '../contractSettlementEventLinks';
import type { SettlementBusinessEvent } from '../contractSettlementEventReader';
import type { SettlementSourceRow } from '../contractSettlement';

const event: SettlementBusinessEvent = { id:'contract:hd',sourceKind:'contract',sourceId:'hd',type:'sign',organizationId:'org',
 buildingId:'building',roomId:'room',roomName:'101',contractId:'hd',relatedContractId:null,sourceVoucherId:null,customerName:null,
 staffName:null,sourceCode:'HD',businessDate:'2026-09-01',origin:'contract',description:'Ký hợp đồng',notes:null,warning:null,
 links:{complete:true,vouchers:[]} };
const source: SettlementSourceRow = {rowType:'source',rowKey:'broker:hd',settlementKind:'commission',
 sourceRef:{kind:'broker',organizationId:'org',contractId:'hd'},organizationId:'org',buildingId:'building',roomId:'room',
 roomName:'101',contractId:'hd',contractNumber:'HD',customerName:null,eventDate:'2026-09-01',recipient:{name:null,bankName:null,bankAccount:null},
 basis:{kind:'COMMISSION',status:'AVAILABLE',amount:1000000,measuredAt:null,source:'source',fingerprint:null,version:null,warning:null},
 createEligibility:{state:'unavailable',reasonCodes:['ADAPTER_REQUIRED']} };
describe('event payment identities',()=>{
 it('includes an uncreated source instead of saying no expense and never chooses a first voucher',()=>{
  const links=buildSettlementEventLinks(event,[source],true);
  expect(links.complete).toBe(true);expect(links.values).toHaveLength(1);
  expect(links.values[0].selection).toEqual({kind:'source',sourceRef:source.sourceRef});
  expect(links.values[0].statusLabel).toBe('Chưa lập phiếu');
 });
 it('requires full source coverage and same organization/building',()=>{
  expect(buildSettlementEventLinks(event,[source],false).complete).toBe(false);
  expect(buildSettlementEventLinks(event,[{...source,organizationId:'other'}],true).values).toHaveLength(0);
  expect(buildSettlementEventLinks(event,[{...source,buildingId:'other'}],true).values).toHaveLength(0);
  expect(settlementEventView({...event,links:{complete:false,vouchers:[]}},[],true).links.state).toBe('unavailable');
 });
 it('keeps two explicit voucher identities and does not infer paid from approval',()=>{
  const row={...event,links:{complete:true,vouchers:[{id:'v1',code:'PC-1',amount:200,approvalStatus:'APPROVED' as const,reviewState:'PENDING' as const},
   {id:'v2',code:'PC-2',amount:300,approvalStatus:'UNAPPROVED' as const,reviewState:'CHANGES_REQUESTED' as const}]}};
  const links=buildSettlementEventLinks(row,[],true);
  expect(links.values.map(link=>link.selection)).toEqual([{kind:'voucher',voucherId:'v1'},{kind:'voucher',voucherId:'v2'}]);
  expect(links.values[0].statusLabel).toBe('Đã duyệt · đối chiếu chi');
 expect(links.values[1].statusLabel).toBe('Cần rà soát');
 });
 it('does not show disputed or resolved unapproved vouchers as pending approval when detailed snapshot is unavailable',()=>{
  for(const reviewState of ['DISPUTED','RESOLVED'] as const){
   const row={...event,links:{complete:true,vouchers:[{id:'v1',code:'PC-1',amount:200,approvalStatus:'UNAPPROVED' as const,reviewState}]}};
   expect(buildSettlementEventLinks(row,[],true).values[0].statusLabel).toBe('Cần đối chiếu');
  }
 });
});
