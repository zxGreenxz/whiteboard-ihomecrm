// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'user-1'})}));
import {importContractBatch,readContractImportPending,type ContractImportSteps} from '../contractImportWorkflow';
import type {ContractImportRow} from '../contractExcelHelpers';
const scope={userId:'user-1',organizationId:'org-1',buildingId:'building-1'};
const row=(source_row:number,price=5000000):ContractImportRow=>({source_row,room_name:'101',customer_name:'Khách bí mật',customer_phone:'0900000000',signed_date:'2026-09-01',start_date:'2026-10-01',end_date:'2027-10-01',rent_price:price,payment_cycle:'MONTHLY',deposit:5000000,notes:'Ghi chú bí mật'});
function steps(){return {customer:vi.fn().mockResolvedValue({id:'customer-1',created:false}),contract:vi.fn().mockResolvedValue({id:'contract-1',roomId:'room-1'}),link:vi.fn().mockResolvedValue(undefined),occupy:vi.fn().mockResolvedValue(undefined),verify:vi.fn().mockResolvedValue(true),verifyCustomer:vi.fn().mockResolvedValue(true)} satisfies ContractImportSteps;}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);localStorage.clear();localStorage.setItem('ihomecrm.selectedOrganizationId',scope.organizationId);});afterEach(()=>vi.unstubAllGlobals());
it('blocks unknown INSERT and retains real rows across new guard instances and a changed payload',async()=>{
 const writer=steps();writer.contract.mockRejectedValue(new TypeError('Failed to fetch'));
 const first=await importContractBatch([row(9),row(12)],scope,writer,vi.fn());expect(first.pending).toBe(true);expect(first.canCorrect).toBe(false);expect(first.errors.map(e=>e.row)).toEqual([9,12]);expect(writer.contract).toHaveBeenCalledOnce();
 expect(readContractImportPending(scope)?.errors.map(e=>e.row)).toEqual([9,12]);
 await importContractBatch([row(9,6000000)],scope,writer,vi.fn());expect(writer.contract).toHaveBeenCalledOnce();
 expect(Object.values(localStorage).join(' ')).not.toMatch(/Khách bí mật|0900000000|Ghi chú bí mật/);
});
it('keeps a partial contract ID after relation failure and never treats absent links as rollback',async()=>{
 const writer=steps();writer.link.mockRejectedValue({code:'42501',message:'permission denied'});writer.verify.mockResolvedValue(false);
 const first=await importContractBatch([row(9)],scope,writer,vi.fn());expect(first.createdIds).toEqual([{row:9,id:'contract-1'}]);
 expect(readContractImportPending(scope)?.createdIds).toEqual(first.createdIds);
 await importContractBatch([row(9)],scope,writer,vi.fn());expect(writer.contract).toHaveBeenCalledOnce();expect(writer.link).toHaveBeenCalledOnce();expect(writer.occupy).not.toHaveBeenCalled();
});
it('allows correction after a confirmed zero-write rejection',async()=>{
 const writer=steps();writer.contract.mockRejectedValueOnce({code:'23514',message:'check violation'});
 const first=await importContractBatch([row(9)],scope,writer,vi.fn());expect(first.pending).toBe(false);expect(first.canCorrect).toBe(true);expect(readContractImportPending(scope)).toBeNull();
 const second=await importContractBatch([row(9,6000000)],scope,writer,vi.fn());expect(second.success).toBe(1);expect(second.pending).toBe(false);expect(writer.contract).toHaveBeenCalledTimes(2);
});
it('retries only a known rejected source row after positively verifying prior created records',async()=>{
 const writer=steps();writer.contract.mockResolvedValueOnce({id:'contract-first',roomId:'room-1'}).mockRejectedValueOnce({code:'23514',message:'check violation'}).mockResolvedValueOnce({id:'contract-second',roomId:'room-2'});
 const first=await importContractBatch([row(9),row(12)],scope,writer,vi.fn());expect(first.createdIds).toEqual([{row:9,id:'contract-first'}]);expect(first.canCorrect).toBe(true);expect(first.pending).toBe(true);
 const second=await importContractBatch([row(9),row(12,6000000)],scope,writer,vi.fn());expect(second.createdIds).toEqual([{row:9,id:'contract-first'},{row:12,id:'contract-second'}]);expect(writer.contract).toHaveBeenCalledTimes(3);expect(writer.contract.mock.calls[2][0].source_row).toBe(12);expect(readContractImportPending(scope)).toBeNull();
});
it('does not skip a changed successful row or clear pending after denied verification',async()=>{
 const writer=steps();writer.contract.mockResolvedValueOnce({id:'contract-first',roomId:'room-1'}).mockRejectedValueOnce({code:'23514',message:'check violation'});
 await importContractBatch([row(9),row(12)],scope,writer,vi.fn());
 await importContractBatch([row(9,9000000),row(12)],scope,writer,vi.fn());expect(writer.contract).toHaveBeenCalledTimes(2);
 writer.verify.mockRejectedValue({code:'42501',message:'permission denied'});await importContractBatch([row(9),row(12)],scope,writer,vi.fn());expect(writer.contract).toHaveBeenCalledTimes(2);expect(readContractImportPending(scope)?.createdIds[0].id).toBe('contract-first');
});
it('reuses a confirmed new customer for a rejected contract instead of duplicating the customer',async()=>{
 const writer=steps();writer.customer.mockResolvedValueOnce({id:'customer-new',created:true}).mockImplementation(async(_row,priorId)=>({id:priorId??'unexpected-new',created:false}));writer.contract.mockRejectedValueOnce({code:'23514',message:'check violation'});
 const first=await importContractBatch([row(9)],scope,writer,vi.fn());expect(first.customerIds).toEqual([{row:9,id:'customer-new'}]);expect(first.pending).toBe(true);
 const second=await importContractBatch([row(9,6000000)],scope,writer,vi.fn());expect(second.success).toBe(1);expect(writer.customer.mock.calls[1][1]).toBe('customer-new');expect(writer.verifyCustomer).toHaveBeenCalledWith('customer-new',expect.objectContaining({source_row:9}));
});
