// @vitest-environment jsdom
import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({data:null as unknown,rpc:vi.fn(),from:vi.fn(),upload:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{rpc:h.rpc,from:h.from,storage:{from:()=>({upload:h.upload})}}}));
vi.mock('@tanstack/react-query',()=>({useQuery:(o:unknown)=>o,useMutation:(o:unknown)=>o,useQueryClient:()=>({invalidateQueries:vi.fn()})}));
vi.mock('@/lib/authSession',()=>({getSessionUser:async()=>({id:'u1'})}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:'o1'})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'u1'}})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),warning:vi.fn(),success:vi.fn(),info:vi.fn()}}));
import {useIncomeExpenseRevisions,useRevisionCounts} from '../revisions';
import {useIncomeExpenseHistory} from '../queries';
import {useFlexCancelEligibility,useVoucherChangeLog} from '../flexMutations';
import {useIncomeCancelEligibility} from '../incomeVoucherCancel';
import {useCancelIncomeExpenseBatch,useUpdateBatchAccount} from '../batch';
import {adoptVoucherAttachmentsAsEvidence,uploadFinanceEvidence} from '../financeV2Mutations';
beforeEach(()=>{
 vi.clearAllMocks();localStorage.clear();h.data=null;h.rpc.mockResolvedValue({data:null,error:null});
 h.from.mockImplementation(()=>{type QueryFixture={select:()=>QueryFixture;eq:()=>QueryFixture;in:()=>QueryFixture;order:()=>QueryFixture;neq:()=>QueryFixture;then:(done:(response:{data:unknown;error:null})=>unknown)=>Promise<unknown>};const b:QueryFixture={select:()=>b,eq:()=>b,in:()=>b,order:()=>b,neq:()=>b,then:done=>Promise.resolve({data:h.data,error:null}).then(done)};return b;});
});
it.each([()=>useIncomeExpenseRevisions('v1'),()=>useRevisionCounts(['v1']),()=>useIncomeExpenseHistory('v1'),()=>useFlexCancelEligibility(['v1']),()=>useIncomeCancelEligibility(['v1']),()=>useVoucherChangeLog('v1')])('nguồn lịch sử/điều kiện hủy null phải lỗi để UI không đọc như trống',async hook=>{
 await expect((hook() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();
});
it.each([()=>({hook:useCancelIncomeExpenseBatch(),input:'batch1'}),()=>({hook:useUpdateBatchAccount(),input:{batchId:'batch1',accountId:'a1',reason:'đổi sổ'}})])('đợt phiếu có nguồn links null không thành không có thay đổi',async entry=>{
 const {hook,input}=entry();await expect((hook as unknown as {mutationFn:(value:unknown)=>Promise<unknown>}).mutationFn(input)).rejects.toThrow();expect(h.rpc).not.toHaveBeenCalled();
});
it.each([null,{evidence_ids:[null],skipped:[]}])('nhận chứng từ thiếu receipt không được đi tiếp với []/ID sai %s',async data=>{
 h.rpc.mockResolvedValue({data,error:null});await expect(adoptVoucherAttachmentsAsEvidence('v1')).rejects.toThrow();
});

it.each([null,{evidence_id:'other',state:'FINALIZED'},{evidence_id:'e1',state:'UPLOADED'}])('upload finalize thiếu/sai receipt không trả ID cho ghi sổ: %s',async data=>{
 h.rpc.mockResolvedValueOnce({data:{evidence_id:'e1',bucket_id:'documents',object_name:'u1/file.png'},error:null}).mockResolvedValueOnce({data,error:null});
 h.upload.mockResolvedValue({data:{path:'u1/file.png'},error:null});
 await expect(uploadFinanceEvidence(new File(['x'],'receipt.png'),'o1')).resolves.toBeNull();
});
it('finalize đúng evidence và FINALIZED cho phép dùng đúng ID',async()=>{
 h.rpc.mockResolvedValueOnce({data:{evidence_id:'e1',bucket_id:'documents',object_name:'u1/file.png'},error:null}).mockResolvedValueOnce({data:{evidence_id:'e1',state:'FINALIZED'},error:null});
 h.upload.mockResolvedValue({data:{path:'u1/file.png'},error:null});
 await expect(uploadFinanceEvidence(new File(['x'],'receipt.png'),'o1')).resolves.toBe('e1');
});
it.each([()=>useFlexCancelEligibility(['v1']),()=>useIncomeCancelEligibility(['v1'])])('reason_code lạ không mở đường hủy từ dữ liệu chưa rõ',async hook=>{h.rpc.mockResolvedValue({data:[{id:'v1',eligible:false,reason_code:'FUTURE',mode:'MANUAL',blocking_voucher_code:null}],error:null});await expect((hook() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
it('nhật ký before/after phải là object hoặc null, không nhận JSON string',async()=>{h.rpc.mockResolvedValue({data:[{at:'2026-09-30',actor_id:null,actor_name:null,scope:'VOUCHER',op:'UPDATE',cols:[],before:'bad',after:null}],error:null});await expect((useVoucherChangeLog('v1') as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow();});
