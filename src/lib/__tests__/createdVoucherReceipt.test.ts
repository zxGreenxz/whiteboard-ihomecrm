import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({from:vi.fn(),read:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:h.from}}));
import {readCreatedVoucherReceipt} from '../createdVoucherReceipt';
import {createdVoucherFeedback} from '../voucherFeedback';
beforeEach(()=>{vi.clearAllMocks();const b={select:()=>b,eq:()=>b,maybeSingle:h.read};h.from.mockReturnValue(b);});
it('E16 phiếu phí chờ duyệt không báo đã chi dù RPC tên pay',async()=>{
 h.read.mockResolvedValue({data:{approval_status:'UNAPPROVED',posting_status:'UNPOSTED'},error:null});
 const r=await readCreatedVoucherReceipt({voucher_id:'v1',code:'PC01'});
 expect(createdVoucherFeedback(r)).toMatchObject({kind:'success',message:expect.stringContaining('chờ duyệt, chưa ghi nhận')});
});
it('E16 trạng thái POSTED mới xác nhận ghi thu chi',async()=>{
 h.read.mockResolvedValue({data:{approval_status:'APPROVED',posting_status:'POSTED'},error:null});
 expect(createdVoucherFeedback(await readCreatedVoucherReceipt({voucher_id:'v1',code:'PC01'})).message).toContain('ghi nhận thu/chi vào sổ quỹ');
});
it('đọc lại lỗi vẫn giữ receipt ID và cảnh báo kiểm tra, không biến thành tạo lỗi hoặc đã chi',async()=>{
 h.read.mockRejectedValue(new TypeError('Failed to fetch'));
 const r=await readCreatedVoucherReceipt({voucher_id:'v1',code:'PC01'});
 expect(r.id).toBe('v1');expect(createdVoucherFeedback(r).kind).toBe('warning');
});
it('không có receipt ID: kết quả chưa xác nhận',async()=>{
 await expect(readCreatedVoucherReceipt(null)).rejects.toBeInstanceOf(TypeError);
 expect(h.from).not.toHaveBeenCalled();
});
