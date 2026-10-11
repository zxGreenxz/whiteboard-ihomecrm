import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: h.rpc } }));
import { interveneCommission } from '../commissionIntervention';
import { isCommissionVoucher } from '@/lib/commissionIntervention';

beforeEach(() => h.rpc.mockReset().mockResolvedValue({ data: { changed: true }, error: null }));
describe('Can thiệp hoa hồng', () => {
  it.each(['', '      ', 'ngắn', 'a'.repeat(2001)])('không gửi lệnh khi lý do không hợp lệ: %s', async reason => {
    await expect(interveneCommission('v1', 'ASSIGN_MANAGER', reason, { manager_id: 'm1' })).rejects.toThrow(/lý do/);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each(['ASSIGN_MANAGER', 'ANNOTATE', 'UNAPPROVE', 'RESTORE'] as const)('truyền đúng giai đoạn %s cùng lý do người nhập', async stage => {
    await interveneCommission('v1', stage, '  Sửa theo biên bản đối chiếu  ', { expected_approval_version: 7 });
    expect(h.rpc).toHaveBeenCalledWith('intervene_commission_v1', {p_voucher_id:'v1', p_stage:stage, p_reason:'Sửa theo biên bản đối chiếu',p_payload:{expected_approval_version:7}});
  });
  it('giữ nguyên lỗi quyền hoặc phiên bản và không quay về writer cũ', async () => {
    const error = { code: 'PT409', message: 'Tải lại phiếu' };
    h.rpc.mockResolvedValue({ data: null, error });
    await expect(interveneCommission('v1', 'RESTORE', 'Khôi phục sau đối chiếu', {})).rejects.toBe(error);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('nhận diện cả phiếu hợp đồng và hoa hồng cũ qua hạng mục', () => {
    expect(isCommissionVoucher({type:'EXPENSE',system_source:'contract.commission'})).toBe(true);
    expect(isCommissionVoucher({type:'EXPENSE',items:[{type_name:'Hoa hồng môi giới'}]})).toBe(true);
    expect(isCommissionVoucher({type:'EXPENSE',items:[{type_name:'Sửa điện'}]})).toBe(false);
  });
});
