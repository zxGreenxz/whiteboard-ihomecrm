import { afterEach, describe, expect, it, vi } from 'vitest';
// Service gọi hàm SQL dùng chung tính ngày gia hạn: đúng tên + tham số, kiểm đầu vào trước khi gọi, kiểm đầu ra.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
import { fetchRenewalEndDate, RENEWAL_QUICK_MONTHS } from '../contractRenewalEndDate';

afterEach(() => rpc.mockReset());

describe('fetchRenewalEndDate', () => {
  it('calls the shared SQL rule with the exact name and arguments', async () => {
    rpc.mockResolvedValue({ data: '2027-08-31', error: null });
    await expect(fetchRenewalEndDate('2027-02-28', 6)).resolves.toBe('2027-08-31');
    expect(rpc).toHaveBeenCalledWith('contract_renewal_end_date_v1', { p_end_date: '2027-02-28', p_months: 6 });
    expect(RENEWAL_QUICK_MONTHS).toEqual([6, 12]);
  });
  it('refuses bad input without calling the database', async () => {
    for (const [endDate, months] of [['2027-02-30', 6], ['28/02/2027', 6], ['2027-02-28', 0], ['2027-02-28', 121], ['2027-02-28', 1.5]] as const)
      await expect(fetchRenewalEndDate(endDate, months)).rejects.toThrow('không hợp lệ');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('surfaces database errors and malformed results', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(fetchRenewalEndDate('2027-02-28', 6)).rejects.toThrow('permission denied');
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(fetchRenewalEndDate('2027-02-28', 6)).rejects.toThrow('Không tính được');
  });
});
