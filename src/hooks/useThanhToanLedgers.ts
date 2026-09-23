import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';

/**
 * SỔ THEO DÕI của trang Thanh toán: cọc đã thu. Khác các hạng mục phí: đây
 * không phải nút "đóng tiền theo kỳ" mà là nơi xem phiếu đã có, phiếu đang treo.
 *
 * Hai sổ cũ "chi thanh lý" và "thưởng Sale" (01/08/2026) đã gỡ 23/09/2026: từ
 * 21/09 chúng nằm trong khu "Hợp đồng & quyết toán" (contract-settlement/, đọc
 * qua useContractSettlement) và không còn màn nào đọc hai hook cũ.
 *
 * Nguồn dữ liệu đọc thẳng bảng qua RLS (không qua hàm SECURITY DEFINER) — sau
 * sự cố lẫn tổ chức 01/08, đọc qua RLS là đường ĐÃ được chứng minh chốt đúng
 * ranh giới tổ chức; hàm definer mới là đường từng hở.
 */

const monthRange = (period: string) => {
  // period 'YYYY-MM' → [đầu tháng, đầu tháng sau)
  const from = `${period}-01`;
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: next };
};

// ── CỌC ĐÃ THU ────────────────────────────────────────────────────────────

export interface DepositLedgerRow {
  id: string;
  code: string | null;
  amount: number;
  voucherDate: string | null;
  approvalStatus: string;
  /** POSTED = tiền THẬT đã vào két · NOT_APPLICABLE = ghi nhận sổ ảo · khác = chờ. */
  postingStatus: string | null;
  buildingName: string;
  roomName: string | null;
  contractNumber: string | null;
  accountName: string | null;
}

export const useDepositLedger = (period: string, enabled = true) =>
  useQuery({
    queryKey: ['tt-deposit-ledger', period],
    enabled: enabled && !!period,
    queryFn: async (): Promise<DepositLedgerRow[]> => {
      const { from, to } = monthRange(period);
      // `!inner` để chỉ lấy phiếu CÓ dòng cọc; phiếu thu thường không dính vào.
      // 31/08 (audit P2-02): fetchAllRows vá cap-1000, cùng khuôn F8.
      const data = await fetchAllRows<{
        id: string;
        code: string | null;
        total_amount: number | string | null;
        voucher_date: string | null;
        approval_status: string;
        posting_status: string | null;
        buildings: { name: string } | null;
        rooms: { name: string } | null;
        contracts: { contract_number: string } | null;
        accounts: { name: string } | null;
        income_expense_items: { accounting_class: string }[];
      }>(
        (f, t) => supabase
          .from('income_expenses')
          .select(`
            id, code, total_amount, voucher_date, approval_status, posting_status,
            buildings:building_id ( name ),
            rooms:room_id ( name ),
            contracts:contract_id ( contract_number ),
            accounts:account_id ( name ),
            income_expense_items!inner ( accounting_class )
          `)
          .eq('type', 'INCOME')
          .eq('income_expense_items.accounting_class', 'DEPOSIT')
          .is('deleted_at', null)
          .neq('approval_status', 'CANCELLED')
          .gte('voucher_date', from)
          .lt('voucher_date', to)
          .order('voucher_date', { ascending: false })
          .order('id', { ascending: true })
          .range(f, t),
        { label: 'thanh-toan.depositLedger' },
      );
      if (data === null) throw new Error('Lỗi tải sổ cọc đã thu — thử lại.');
      // !inner nhân bản phiếu theo số dòng cọc — gộp lại theo id.
      const seen = new Map<string, DepositLedgerRow>();
      for (const r of data) {
        if (seen.has(r.id)) continue;
        seen.set(r.id, {
          id: r.id,
          code: r.code ?? null,
          amount: Number(r.total_amount) || 0,
          voucherDate: r.voucher_date ?? null,
          approvalStatus: r.approval_status,
          postingStatus: r.posting_status ?? null,
          buildingName: r.buildings?.name ?? '—',
          roomName: r.rooms?.name ?? null,
          contractNumber: r.contracts?.contract_number ?? null,
          accountName: r.accounts?.name ?? null,
        });
      }
      return [...seen.values()];
    },
  });

/** Tổng hợp nhanh cho thẻ thống kê của mục Cọc đã thu. */
export const useDepositLedgerSummary = (rows: DepositLedgerRow[] | undefined) =>
  useMemo(() => {
    const list = rows ?? [];
    const sum = (f: (r: DepositLedgerRow) => boolean) =>
      list.filter(f).reduce((s, r) => s + r.amount, 0);
    return {
      total: list.length,
      posted: sum((r) => r.postingStatus === 'POSTED'),
      postedN: list.filter((r) => r.postingStatus === 'POSTED').length,
      virtual: sum((r) => r.postingStatus === 'NOT_APPLICABLE'),
      virtualN: list.filter((r) => r.postingStatus === 'NOT_APPLICABLE').length,
      pending: sum((r) => r.approvalStatus !== 'APPROVED'),
      pendingN: list.filter((r) => r.approvalStatus !== 'APPROVED').length,
    };
  }, [rows]);
