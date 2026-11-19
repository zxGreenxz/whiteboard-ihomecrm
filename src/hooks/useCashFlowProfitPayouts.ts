// Cột "Trong đó: chi chia lợi nhuận" của báo cáo dòng tiền (D2.12) — đọc
// public.cashbook_cash_flow_profit_payout_v1 (migration 20261115145954): cùng năm, cùng phạm vi toà, cùng
// 12 tháng + 4 quý với useCashFlowReport. Số là PHẦN của "Chi ra" (chi lợi nhuận cổ đông + lương điều hành
// đã rời sổ thật), không cộng thêm. KHÔNG gồm phần lợi nhuận đầu tư trả trong phiếu lương của cổ đông kiêm
// nhân viên (phiếu nguồn salary.*): máy chủ phân loại theo phiếu, phiếu lương không vào cột.
//
// Hook riêng vì useCashFlowReport nằm trọn trong vùng Hermes parity (cash-flow-external-report) — Hermes không
// đọc cột này. Máy chủ đòi quyền dòng tiền + một trong distribute / lock / view_building_totals TOÀN công ty;
// thiếu ⇒ 42501 (màn hình ẩn cột, không báo lỗi).

import { useQuery } from '@tanstack/react-query';
import { useOrganization } from '@/contexts/OrganizationContext';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { classifyDbError, isRetryable } from '@/lib/contracts/errors';
import { financialReadNumber, financialReadRows } from '@/lib/financialReadValidation';
import { fetchAllRows } from '@/lib/supabaseFetchAll';

export interface CashFlowProfitPayoutRow {
  organization_id: string;
  /** null = chuỗi toàn công ty; có toà khi phạm vi theo toà. */
  building_id: string | null;
  /** `YYYY-MM` hoặc `YYYY-Qn`. */
  period: string;
  shareholder_payout: number;
  manager_payout: number;
}

/** Đọc chặt một trang kết quả: sai công ty / toà / kỳ, trùng kỳ, số thiếu hay âm ⇒ lỗi (không bao giờ hiện 0). */
export function readCashFlowProfitPayoutRows(
  data: unknown[] | null | undefined,
  context: { organizationId: string; year: number; buildingId?: string },
): CashFlowProfitPayoutRow[] {
  const periodPattern = new RegExp(`^${context.year}-(?:0[1-9]|1[0-2]|Q[1-4])$`);
  const seen = new Set<string>();
  return financialReadRows(data).map((value) => {
    const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    if (
      row.organization_id !== context.organizationId ||
      (row.building_id !== null && typeof row.building_id !== 'string') ||
      (context.buildingId && row.building_id !== context.buildingId) ||
      typeof row.period !== 'string' || !periodPattern.test(row.period)
    ) {
      throw new TypeError('Chưa đọc được đúng phạm vi phần chi chia lợi nhuận của dòng tiền.');
    }
    const key = JSON.stringify([row.building_id, row.period]);
    if (seen.has(key)) throw new TypeError('Phần chi chia lợi nhuận của dòng tiền có kỳ bị trùng.');
    seen.add(key);
    const shareholder = financialReadNumber(row.shareholder_payout);
    const manager = financialReadNumber(row.manager_payout);
    if (shareholder < 0 || manager < 0) throw new TypeError('Phần chi chia lợi nhuận của dòng tiền không được âm.');
    return {
      organization_id: context.organizationId,
      building_id: row.building_id as string | null,
      period: row.period,
      shareholder_payout: shareholder,
      manager_payout: manager,
    };
  });
}

/** Gộp theo tháng (bỏ dòng quý của máy chủ, như bảng dòng tiền) — cổ đông + lương điều hành. */
export function monthlyProfitPayouts(rows: readonly CashFlowProfitPayoutRow[]): number[] {
  const months = Array.from({ length: 12 }, () => 0);
  for (const row of rows) {
    if (row.period.includes('-Q')) continue;
    const month = Number(row.period.slice(5, 7)) - 1;
    months[month] = (months[month] ?? 0) + row.shareholder_payout + row.manager_payout;
  }
  return months;
}

export function useCashFlowProfitPayouts(year: number, buildingId?: string, options?: { enabled?: boolean }) {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    // Gốc "cash-flow-by-day": mọi thao tác thu chi, hoàn tác và sổ tổng đã làm mới gốc này.
    queryKey: ['cash-flow-by-day', 'profit-payout', selectedOrganizationId, year, buildingId ?? null],
    enabled: !!selectedOrganizationId && options?.enabled !== false,
    // 42501 (không có quyền) thử lại cũng vậy: chỉ thử lại khi máy chủ bận.
    retry: (failureCount, error) => failureCount < 1 && isRetryable(classifyDbError(error)),
    meta: { errorDisplay: 'inline', label: 'chi chia lợi nhuận trong dòng tiền' },
    queryFn: async (): Promise<CashFlowProfitPayoutRow[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');
      if (!selectedOrganizationId) throw new Error('Chưa chọn tổ chức để xem dòng tiền.');
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new TypeError('Năm báo cáo dòng tiền không hợp lệ.');
      const organizationId = selectedOrganizationId;
      const data = await fetchAllRows<unknown>(
        (from, to) => supabase.rpc('cashbook_cash_flow_profit_payout_v1', {
          p_organization_id: organizationId,
          p_year: year,
          p_building_ids: buildingId ? [buildingId] : undefined,
        })
          .order('building_id', { ascending: true, nullsFirst: true })
          .order('period', { ascending: true })
          .range(from, to),
        { label: 'cash-flow-profit-payout' },
      );
      return readCashFlowProfitPayoutRows(data, { organizationId, year, buildingId });
    },
  });
}
