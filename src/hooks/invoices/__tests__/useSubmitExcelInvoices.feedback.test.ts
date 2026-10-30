import {beforeEach,describe,expect,it,vi} from 'vitest';
// One hook instance per case, retaining the same ref throughout submit.
vi.mock('react', async original => ({
 ...await original<typeof import('react')>(),
 useRef: <T,>(initial: T) => ({current: initial}),
}));
const io=vi.hoisted(()=>({create:vi.fn(),insert:vi.fn(),options:vi.fn(),payload:vi.fn(),recover:vi.fn()}));
vi.mock('@/hooks/useInvoices',()=>({useCreateInvoice:(options:unknown)=>{io.options(options);return {mutateAsync:io.create,isPending:false};}}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'org-1'})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>({insert:io.insert})}}));
vi.mock('@/lib/excelInvoiceRows',async original=>({...await original<typeof import('@/lib/excelInvoiceRows')>(),buildInvoiceFormData:()=>io.payload()}));
vi.mock('@/lib/meter-capture/service',async original=>({...await original<typeof import('@/lib/meter-capture/service')>(),readSavedMeterInvoiceRequest:io.recover}));
import {useSubmitExcelInvoices} from '../useExcelInvoiceData';
import type {ExcelRowData,SubmitContext} from '@/lib/excelInvoiceRows';
const row={contract_id:'c1',room_name:'P101',meter_id:'m1',current_reading:120,prev_reading:100,elec_service_id:'s1'} as ExcelRowData;
const ctx={toDate:'2026-09-30',billingMonth:'2026-09'} as SubmitContext;
beforeEach(()=>{vi.clearAllMocks();io.insert.mockResolvedValue({error:null});io.payload.mockImplementation(()=>({items:[]}));io.recover.mockResolvedValue(null);});
describe('tạo hoá đơn nhiều bước',()=>{
 it('giữ dấu chỉ số đã ghi khi tạo hoá đơn thất bại',async()=>{io.create.mockRejectedValue({code:'23505',message:'idx_invoices_unique_contract_billing'});const result=await useSubmitExcelInvoices().submit([row],ctx);expect(result.rows[0]).toMatchObject({contractId:'c1',readingSaved:true,outcomeUnknown:false});expect(result.rows[0].error).toContain('Đã lưu chỉ số');expect(result.ok).toBe(0);expect(io.options).toHaveBeenCalledWith({silent:true});});
 it('đồng hồ QR/ảnh từ chối chỉ số tay (55000) thì không tạo hoá đơn, tránh tính trùng kỳ sau',async()=>{io.insert.mockResolvedValue({error:{code:'55000',message:'Meter uses QR capture; approve or correct a reading through capture review'}});const result=await useSubmitExcelInvoices().submit([row],ctx);expect(io.create).not.toHaveBeenCalled();expect(result.rows[0]).toMatchObject({readingSaved:false});expect(result.rows[0].error).toContain('QR/ảnh');expect(result.ok).toBe(0);});
 it('giữ mã hoá đơn đã tạo khi chỉ số lỗi',async()=>{io.insert.mockResolvedValue({error:{code:'42501',message:'private table'}});io.create.mockResolvedValue({id:'invoice-1'});const result=await useSubmitExcelInvoices().submit([row],ctx);expect(result.rows[0]).toMatchObject({invoiceId:'invoice-1',readingSaved:false});expect(result.readingFails).toEqual(['P101']);});
 it('malformed receipt là chưa xác nhận, không báo thành công',async()=>{io.create.mockResolvedValue({});const result=await useSubmitExcelInvoices().submit([row],ctx);expect(result.rows[0]).toMatchObject({readingSaved:true,outcomeUnknown:true});expect(result.ok).toBe(0);expect(result.fail).toBe(1);});
 it('nguồn đã duyệt chỉ liên kết, không chèn lại chỉ số; retry giữ khóa sau remount',async()=>{
  io.payload.mockImplementation(()=>({items:[{meter_source:{endReadingId:'reading'}}]}));io.create.mockResolvedValue({id:'invoice-1'});
  const first=await useSubmitExcelInvoices().submit([row],ctx);const second=await useSubmitExcelInvoices().submit([row],ctx);
  expect(first.rows[0]).toMatchObject({invoiceId:'invoice-1',readingSaved:true});expect(second.ok).toBe(1);
  expect(io.insert).not.toHaveBeenCalled();
  expect(io.create.mock.calls[0][0].meter_capture_request_id).toBe(io.create.mock.calls[1][0].meter_capture_request_id);
 });
 it('nguồn bị server từ chối không báo đã ghi hoặc khóa dòng; sửa rồi gửi lại được',async()=>{
  io.payload.mockImplementation(()=>({items:[{meter_source:{endReadingId:'reading'}}]}));
  io.create.mockRejectedValueOnce({code:'PT409',message:'source changed'}).mockResolvedValueOnce({id:'invoice-1'});
  const hook=useSubmitExcelInvoices();const first=await hook.submit([row],ctx);const second=await hook.submit([row],ctx);
  expect(first.rows[0]).toMatchObject({readingSaved:false,supportRecoveryPending:false});expect(second.ok).toBe(1);expect(io.insert).not.toHaveBeenCalled();
 });
 it('timeout đối chiếu biên nhận trước, không tạo tiếp khi server đã lưu',async()=>{
  io.payload.mockImplementation(()=>({items:[{meter_source:{endReadingId:'reading'}}]}));io.create.mockRejectedValueOnce(new TypeError('network error'));
  const hook=useSubmitExcelInvoices();await hook.submit([row],ctx);io.recover.mockResolvedValueOnce({id:'invoice-1',invoice_number:'HD1'});
  const second=await hook.submit([row],ctx);expect(second.recovered[0]).toMatchObject({invoiceNumber:'HD1',matchesCurrentIntent:true});
  expect(io.create).toHaveBeenCalledTimes(1);expect(io.insert).not.toHaveBeenCalled();
 });
});
