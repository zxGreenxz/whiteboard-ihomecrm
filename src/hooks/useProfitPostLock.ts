// =============================================================================
// useProfitPostLock — tháng đã chốt lợi nhuận + khoản "phát sinh sau chốt" (rà 21/10, F06;
// chủ chốt 22/10/2026). Nguồn: RPC public.profit_post_lock_vouchers_v1 (migration
// 20261022172918) — chỉ toà người gọi xem được (can_access_building), anon ⇒ 42501.
//
//  - useProfitPostLock: gói thô (toà×tháng đã chốt + phiếu tạo/duyệt sau lúc chốt).
//  - useProfitPostLockReport: Báo cáo LN một tháng — tách khoản sau chốt khỏi danh sách và
//    tổng, kèm phần engine phải trừ cho thanh kiểm chứng. Lỗi tải ⇒ KHÔNG tách (tổng giữ như
//    cũ) và trả câu cảnh báo để thanh kiểm chứng nêu ra, không im lặng.
// Lỗi THROW để màn báo; gói đi qua zod (src/lib/profitPostLock.ts): sai hình là lỗi.
// =============================================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  NO_ENGINE_EXCLUSIONS,
  engineExclusionsOf,
  postLockEntriesFor,
  postLockQueryRange,
  postLockWarnings,
  profitPostLockSchema,
  splitPostLock,
  type EngineExclusions,
  type PostLockAccrualLike,
  type PostLockRowLike,
  type PostLockVoucher,
  type ProfitPostLockData,
} from '@/lib/profitPostLock';

type LoiRpc = { code?: string; message: string; details?: string | null; hint?: string | null };

/**
 * Ranh giới kiểu cho RPC chưa có trong `types.ts` sinh tự động — migration 20261022172918
 * chưa lên production nên generator chưa thấy hàm này. Khi migration đã áp production và
 * `gen:types` chạy lại: đổi chỗ gọi sang `supabase.rpc('profit_post_lock_vouchers_v1', …)` có
 * kiểu và XOÁ hàm bọc này. Tên RPC vẫn là chuỗi viết thẳng tại nơi gọi.
 */
const goiRpcPhatSinhSauChot = (
  tenHam: string,
  args: Record<string, unknown>,
): PromiseLike<{ data: unknown; error: LoiRpc | null }> =>
  (supabase.rpc as unknown as (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: LoiRpc | null }>)(tenHam, args);

const KEY = 'profit-post-lock';

export const profitPostLockKeys = {
  all: [KEY] as const,
  range: (from: string, to: string, buildingIds: readonly string[] | null) =>
    [KEY, from, to, buildingIds ? [...buildingIds].sort().join(',') : 'ALL'] as const,
};

const MONTH_START = /^\d{4}-\d{2}-01$/;

/** from/to: 'YYYY-MM-01'. buildingIds: null = mọi toà người xem được; [] = không hỏi. */
export function useProfitPostLock(opts: {
  from: string | null | undefined;
  to: string | null | undefined;
  buildingIds: readonly string[] | null;
  enabled?: boolean;
}) {
  const { from, to, buildingIds, enabled = true } = opts;
  const valid =
    !!from && !!to && MONTH_START.test(from) && MONTH_START.test(to) && from <= to && (buildingIds === null || buildingIds.length > 0);
  return useQuery<ProfitPostLockData>({
    meta: { label: 'khoản phát sinh sau chốt', errorDisplay: 'inline' },
    queryKey: profitPostLockKeys.range(from ?? '', to ?? '', buildingIds),
    enabled: enabled && valid,
    queryFn: async () => {
      const { data, error } = await goiRpcPhatSinhSauChot('profit_post_lock_vouchers_v1', {
        p_from: from,
        p_to: to,
        p_building_ids: buildingIds ? [...buildingIds] : null,
      });
      if (error) throw error;
      return profitPostLockSchema.parse(data);
    },
    staleTime: 30_000,
  });
}

/**
 * Form phiếu: toà×tháng ĐÃ CHỐT của các toà (đang chọn + toà gốc khi sửa) trong khoảng tháng
 * phiếu chạm tới (`postLockFormMonths`). Khoảng > 36 tháng / chưa có toà ⇒ không hỏi (máy chủ
 * vẫn chặn khi lưu).
 */
export function useProfitLockedMonthsForForm(opts: {
  buildingIds: readonly (string | null | undefined)[];
  months: readonly string[];
  enabled: boolean;
}) {
  const idKey = opts.buildingIds.filter((x): x is string => !!x).sort().join('|');
  const ids = useMemo(() => [...new Set(idKey ? idKey.split('|') : [])], [idKey]);
  const range = postLockQueryRange(opts.months);
  return useProfitPostLock({
    from: range?.from,
    to: range?.to,
    buildingIds: ids,
    enabled: opts.enabled && !!range && ids.length > 0,
  });
}

export interface ProfitPostLockReport<R extends PostLockRowLike, A extends PostLockAccrualLike<R>> {
  /** Báo cáo tháng đã trừ khoản phát sinh sau chốt (hoặc nguyên bản khi chưa/không tách được). */
  accrual: A | undefined;
  /** Khoản (phiếu × tháng) đã tách khỏi tháng đã chốt mà trang có dòng. */
  entries: PostLockVoucher[];
  count: number;
  income: number;
  expense: number;
  /** Phần engine (fa_*) vẫn tính — trừ ra khi đối chiếu. */
  engineExclusions: EngineExclusions;
  /** Câu cảnh báo cho thanh kiểm chứng (có khoản sau chốt / không tải được). */
  warnings: string[];
  isLoading: boolean;
  isError: boolean;
}

/** ym: 'YYYY-MM'. Chỉ dùng ở chế độ dồn tích (theo kỳ) — `enabled` tắt thì trả nguyên bản. */
export function useProfitPostLockReport<R extends PostLockRowLike, A extends PostLockAccrualLike<R>>(opts: {
  ym: string;
  buildingIds: readonly string[];
  accrual: A | undefined;
  enabled: boolean;
}): ProfitPostLockReport<R, A> {
  const { ym, buildingIds, accrual, enabled } = opts;
  const month = `${ym}-01`;
  const query = useProfitPostLock({ from: month, to: month, buildingIds, enabled: enabled && buildingIds.length > 0 });
  const active = enabled && buildingIds.length > 0;
  const entries = useMemo(
    () => (active ? postLockEntriesFor(query.data, ym, buildingIds) : []),
    [active, query.data, ym, buildingIds],
  );
  const split = useMemo(() => (accrual ? splitPostLock<R, A>(accrual, entries) : null), [accrual, entries]);
  const engineExclusions = useMemo(
    () => (active && query.isSuccess ? engineExclusionsOf(entries) : NO_ENGINE_EXCLUSIONS),
    [active, query.isSuccess, entries],
  );
  const isError = active && query.isError;
  const warnings = useMemo(() => {
    if (isError) return ['Chưa tải được khoản phát sinh sau chốt — tháng đã chốt có thể đang cộng cả khoản phát sinh sau chốt'];
    return split ? postLockWarnings(split) : [];
  }, [isError, split]);
  return {
    accrual: split?.accrual ?? accrual,
    entries: split?.entries ?? [],
    count: split?.count ?? 0,
    income: split?.income ?? 0,
    expense: split?.expense ?? 0,
    engineExclusions,
    warnings,
    isLoading: active && query.isLoading,
    isError,
  };
}
