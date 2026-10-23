// Ngày kết thúc khi gia hạn hợp đồng thêm N tháng: tính bằng hàm SQL dùng chung public.contract_renewal_end_date_v1
// (migration 20261022042822) — web và trợ lý Hermes cùng một luật (luật 17/10: công thức dùng ở ≥ 2 nơi đặt trong database).
// Ngày kết thúc là cuối tháng ⇒ cuối tháng đích; còn lại giữ số ngày, kẹp về cuối tháng. Hàm chưa có trong types sinh tự
// động cho tới khi migration được áp và gen:types chạy, nên dùng bộ gọi hẹp đúng một tên và đúng tham số.
import { supabase } from '@/integrations/supabase/client';
import { isCivilDate } from '@/lib/contractMoveOutNotice';

type RenewalEndDateRpc = (
  fn: 'contract_renewal_end_date_v1',
  args: { p_end_date: string; p_months: number },
) => PromiseLike<{ data: string | null; error: { message: string } | null }>;

/** Các nút gia hạn nhanh trong hộp Gia hạn (D-HĐ4). */
export const RENEWAL_QUICK_MONTHS = [6, 12] as const;

export async function fetchRenewalEndDate(endDate: string, months: number): Promise<string> {
  if (!isCivilDate(endDate) || !Number.isInteger(months) || months < 1 || months > 120) {
    throw new Error('Ngày kết thúc hoặc số tháng không hợp lệ');
  }
  const rpc = (supabase.rpc as unknown as RenewalEndDateRpc).bind(supabase);
  const { data, error } = await rpc('contract_renewal_end_date_v1', { p_end_date: endDate, p_months: months });
  if (error) throw new Error(error.message);
  if (typeof data !== 'string' || !isCivilDate(data)) throw new Error('Không tính được ngày kết thúc mới');
  return data;
}
