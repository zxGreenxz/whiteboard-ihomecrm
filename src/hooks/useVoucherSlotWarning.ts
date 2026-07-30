import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface VoucherSlotHit {
  voucherId: string;
  code: string;
  voucherName: string | null;
  totalAmount: number;
  matchedAmount: number;
  voucherDate: string | null;
  approvalStatus: string;
  createdAt: string;
  creatorName: string;
  typeNames: string;
}

interface Args {
  buildingId?: string | null;
  typeIds: string[];
  start?: string | null;
  end?: string | null;
  type: 'INCOME' | 'EXPENSE';
  /** Khi SỬA phiếu: loại chính nó ra kẻo tự cảnh báo về mình. */
  excludeId?: string | null;
  enabled?: boolean;
}

/**
 * "Ô này đã có phiếu nào chưa?" — cảnh báo TRƯỚC khi người thứ hai tạo trùng.
 *
 * VÌ SAO CẦN, và vì sao KHÔNG phải chống bấm đôi (đo prod 30/07/2026):
 * bấm đôi đã bị chặn từ trước — `create_income_expense_v1/v2` bắt buộc
 * idempotency key và claim vào `canonical_write_operations`; còn đường POST thẳng
 * bảng thì `authenticated` đã bị REVOKE INSERT. Phần CÒN HỞ là lỗi PHỐI HỢP:
 * hai người cùng trả một tháng, cách nhau nhiều ngày. Ca thật ở 405PVB —
 * PC2607077 52.500.000đ do "NG TÂM" tạo 02/07, rồi PC2607063 cùng số tiền do
 * "NATHAN" tạo 11/07. Không khoá nào bắt được, chỉ có CHO NGƯỜI TA THẤY.
 *
 * Chỉ cảnh báo, KHÔNG chặn: 20/24 ô trùng trên production có số tiền khác nhau
 * và đều hợp lệ.
 */
export const useVoucherSlotWarning = (a: Args) => {
  const typeIds = [...new Set(a.typeIds.filter(Boolean))].sort();
  const ready =
    (a.enabled ?? true) && !!a.buildingId && typeIds.length > 0 && !!a.start && !!a.end;

  return useQuery({
    queryKey: ['voucher-slot-warning', a.buildingId, typeIds, a.start, a.end, a.type, a.excludeId],
    enabled: ready,
    // Cảnh báo là tiện ích tức thời, không phải nguồn sự thật — giữ ngắn để lần
    // mở form sau thấy phiếu vừa được đồng nghiệp tạo.
    staleTime: 15_000,
    queryFn: async (): Promise<VoucherSlotHit[]> => {
      const { data, error } = await (supabase as any).rpc('get_voucher_slot_warning_v1', {
        p_building_id: a.buildingId,
        p_type_ids: typeIds,
        p_start: a.start,
        p_end: a.end,
        p_type: a.type,
        p_exclude_id: a.excludeId ?? null,
      });
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => ({
        voucherId: r.voucher_id,
        code: r.code,
        voucherName: r.voucher_name ?? null,
        totalAmount: Number(r.total_amount ?? 0),
        matchedAmount: Number(r.matched_amount ?? 0),
        voucherDate: r.voucher_date ?? null,
        approvalStatus: r.approval_status,
        createdAt: r.created_at,
        creatorName: r.creator_name ?? '(không rõ)',
        typeNames: r.type_names ?? '',
      }));
    },
  });
};
