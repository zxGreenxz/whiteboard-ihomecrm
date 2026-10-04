import {afterEach,expect,it,vi} from 'vitest';
const io=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:(config:unknown)=>config}));
vi.mock('@/integrations/supabase/client',()=>({supabase:io}));
import {useAccountingStandard} from '../useAccountingStandard';
import {createPersonalFinanceService} from '@/lib/personalFinance/service';
const owner='11111111-1111-4111-8111-111111111111';
afterEach(()=>io.rpc.mockReset());
it('không biến phản hồi ví cá nhân null thành ví rỗng',async()=>{
 io.rpc.mockResolvedValue({data:null,error:null});await expect(createPersonalFinanceService(io,owner).snapshot()).rejects.toThrow('Dữ liệu ví');
});
it('không biến phản hồi Chuẩn kế toán null thành danh sách tổ chức rỗng',async()=>{
 io.rpc.mockResolvedValue({data:null,error:null});await expect((useAccountingStandard() as unknown as {queryFn:()=>Promise<unknown>}).queryFn()).rejects.toThrow('Chưa xác nhận');
});
it.each(['update','delete'])('%s ví cá nhân cần biên nhận được xác nhận',async action=>{
 io.rpc.mockResolvedValue({data:null,error:null});const payload={action:`transaction.${action}`,id:owner,expected_version:3,data:action==='delete'?{}:{description:'Sửa ghi chú'}};
 await expect(createPersonalFinanceService(io,owner).mutate(owner,payload)).rejects.toMatchObject({outcomeUnknown:true});expect(io.rpc).toHaveBeenCalledWith('personal_finance_mutate',{p_request_key:owner,p_payload:payload});
});
