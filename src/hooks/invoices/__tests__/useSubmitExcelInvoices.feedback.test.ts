import {beforeEach,describe,expect,it,vi} from 'vitest';
// One hook instance per case, retaining the same ref throughout submit.
vi.mock('react', async original => ({
 ...await original<typeof import('react')>(),
 useRef: <T,>(initial: T) => ({current: initial}),
}));
const io=vi.hoisted(()=>({create:vi.fn(),insert:vi.fn(),options:vi.fn()}));
vi.mock('@/hooks/useInvoices',()=>({useCreateInvoice:(options:unknown)=>{io.options(options);return {mutateAsync:io.create,isPending:false};}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-1'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>({insert:io.insert})}}));
vi.mock('@/lib/excelInvoiceRows',async original=>({...await original<typeof import('@/lib/excelInvoiceRows')>(),buildInvoiceFormData:()=>({})}));
import {useSubmitExcelInvoices} from '../useExcelInvoiceData';
import type {ExcelRowData,SubmitContext} from '@/lib/excelInvoiceRows';
const row={contract_id:'c1',room_name:'P101',meter_id:'m1',current_reading:120,prev_reading:100,elec_service_id:'s1'} as ExcelRowData;
const ctx={toDate:'2026-09-30',billingMonth:'2026-09'} as SubmitContext;
beforeEach(()=>{vi.clearAllMocks();io.insert.mockResolvedValue({error:null});});
describe('tạo hoá đơn nhiều bước',()=>{
 it('giữ dấu chỉ số đã ghi khi tạo hoá đơn thất bại',async()=>{io.create.mockRejectedValue({code:'23505',message:'idx_invoices_unique_contract_billing'});const result=await useSubmitExcelInvoices().submit([row],ctx);expect(result.rows[0]).toMatchObject({contractId:'c1',readingSaved:true,outcomeUnknown:false});expect(result.rows[0].error).toContain('Đã lưu chỉ số');expect(result.ok).toBe(0);expect(io.options).toHaveBeenCalledWith({silent:true});});
 it('giữ mã hoá đơn đã tạo khi chỉ số lỗi',async()=>{io.insert.mockResolvedValue({error:{code:'42501',message:'private table'}});io.create.mockResolvedValue({id:'invoice-1'});const result=await useSubmitExcelInvoices().submit([row],ctx);expect(result.rows[0]).toMatchObject({invoiceId:'invoice-1',readingSaved:false});expect(result.readingFails).toEqual(['P101']);});
 it('malformed receipt là chưa xác nhận, không báo thành công',async()=>{io.create.mockResolvedValue({});const result=await useSubmitExcelInvoices().submit([row],ctx);expect(result.rows[0]).toMatchObject({readingSaved:true,outcomeUnknown:true});expect(result.ok).toBe(0);expect(result.fail).toBe(1);});
});
