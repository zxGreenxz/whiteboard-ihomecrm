import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';

/**
 * Ba SỔ THEO DÕI của trang Thanh toán (01/08/2026): chi thanh lý, thưởng Sale,
 * cọc đã thu. Khác các hạng mục phí: đây không phải nút "đóng tiền theo kỳ" mà
 * là nơi QUẢN LÝ phiếu — xem cái gì đã có, cái gì đang treo, rồi hành động.
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

// ── 1. HÀNG ĐỢI CHI THANH LÝ ─────────────────────────────────────────────────

export interface TerminationQueueRow {
  terminationId: string;
  contractId: string | null;
  contractNumber: string | null;
  buildingName: string;
  roomName: string;
  terminationDate: string | null;
  terminationType: string | null;
  totalDeposit: number;
  /** Net trên hồ sơ (GENERATED, có thể ÂM = khách còn nợ). Chỉ để hiển thị. */
  refundAmount: number;
  /** Phiếu hoàn đã có trên hợp đồng này (mọi nguồn termination.refund*). */
  refundVoucherCode: string | null;
  refundVoucherStatus: 'POSTED' | 'PENDING' | null;
  refundVoucherAmount: number | null;
}

export const useTerminationRefundQueue = (period: string, enabled = true) =>
  useQuery({
    queryKey: ['tt-termination-queue', period],
    enabled: enabled && !!period,
    queryFn: async (): Promise<TerminationQueueRow[]> => {
      const { from, to } = monthRange(period);
      // Vá F8 (audit 27/08): bản cũ không phân trang ⇒ dính cap-1000 của
      // PostgREST — kỳ nhiều thanh lý thì hàng đợi IM LẶNG thiếu dòng, và
      // `.in()` một phát cả nghìn id thì URL quá dài. fetchAllRows phân trang
      // fail-closed (lỗi → null → throw, KHÔNG coi là rỗng), `.in()` chia lô
      // ≤500 và MỌI lô phải thành công mới publish.
      const rows = await fetchAllRows<any>(
        (f, t) => supabase
          .from('contract_terminations')
          .select(`
            id, contract_id, termination_date, termination_type, total_deposit, refund_amount,
            contracts:contract_id (
              contract_number,
              rooms:room_id ( name, buildings:building_id ( name ) )
            )
          `)
          .gte('termination_date', from)
          .lt('termination_date', to)
          .order('termination_date', { ascending: false })
          .order('id', { ascending: true })
          .range(f, t),
        { label: 'thanh-toan.terminationQueue' },
      );
      if (rows === null) throw new Error('Lỗi tải hồ sơ thanh lý — không thể dựng hàng đợi');

      const contractIds = [...new Set(rows.map((r) => r.contract_id).filter(Boolean))] as string[];

      // Phiếu hoàn đã tồn tại — correlate theo contract_id (cách duy nhất hôm nay).
      const vouchers: any[] = [];
      for (let i = 0; i < contractIds.length; i += 500) {
        const chunk = contractIds.slice(i, i + 500);
        const { data: vs, error: ve } = await supabase
          .from('income_expenses')
          .select('contract_id, code, total_amount, approval_status, posting_status')
          .in('contract_id', chunk)
          .like('system_source', 'termination.refund%')
          .is('deleted_at', null)
          .neq('approval_status', 'CANCELLED');
        // Một lô lỗi = fail toàn query. Nuốt lô lỗi là tuyên bố sai "chưa có
        // phiếu hoàn" cho cả trăm hợp đồng.
        if (ve) throw new Error(ve.message);
        vouchers.push(...(vs ?? []));
      }
      const byContract = new Map<string, any>();
      for (const v of vouchers) {
        // Ưu tiên phiếu POSTED; chưa có thì lấy phiếu chờ duyệt.
        const cur = byContract.get(v.contract_id);
        if (!cur || (v.posting_status === 'POSTED' && cur.posting_status !== 'POSTED')) {
          byContract.set(v.contract_id, v);
        }
      }

      return rows.map((r) => {
        const v = r.contract_id ? byContract.get(r.contract_id) : null;
        return {
          terminationId: r.id,
          contractId: r.contract_id ?? null,
          contractNumber: r.contracts?.contract_number ?? null,
          buildingName: r.contracts?.rooms?.buildings?.name ?? '—',
          roomName: r.contracts?.rooms?.name ?? '—',
          terminationDate: r.termination_date ?? null,
          terminationType: r.termination_type ?? null,
          totalDeposit: Number(r.total_deposit) || 0,
          refundAmount: Number(r.refund_amount) || 0,
          refundVoucherCode: v?.code ?? null,
          refundVoucherStatus: v ? (v.posting_status === 'POSTED' ? 'POSTED' : 'PENDING') : null,
          refundVoucherAmount: v ? Number(v.total_amount) || 0 : null,
        };
      });
    },
  });

// ── 2. PHIẾU THƯỞNG SALE ─────────────────────────────────────────────────────

export interface SaleBonusRow {
  id: string;
  code: string | null;
  amount: number;
  voucherDate: string | null;
  approvalStatus: string;
  postingStatus: string | null;
  buildingName: string;
  roomName: string | null;
  contractNumber: string | null;
  /** true = phiếu sinh từ PHIẾU CỌC (chưa gắn hợp đồng lúc tạo). */
  fromDeposit: boolean;
}

export const useSaleBonusVouchers = (period: string, enabled = true) =>
  useQuery({
    queryKey: ['tt-sale-bonus', period],
    enabled: enabled && !!period,
    queryFn: async (): Promise<SaleBonusRow[]> => {
      const { from, to } = monthRange(period);
      // 31/08 (audit P2-02): cùng khuôn fetchAllRows như hàng đợi thanh lý (F8)
      // — vượt 1.000 phiếu/kỳ thì sổ không được im lặng thiếu dòng.
      const data = await fetchAllRows<{
        id: string;
        code: string | null;
        total_amount: number | string | null;
        voucher_date: string | null;
        approval_status: string;
        posting_status: string | null;
        notes: string | null;
        contract_id: string | null;
        buildings: { name: string } | null;
        rooms: { name: string } | null;
        contracts: { contract_number: string } | null;
      }>(
        (f, t) => supabase
          .from('income_expenses')
          .select(`
            id, code, total_amount, voucher_date, approval_status, posting_status, notes,
            contract_id,
            buildings:building_id ( name ),
            rooms:room_id ( name ),
            contracts:contract_id ( contract_number )
          `)
          .eq('commission_kind', 'sale')
          .is('deleted_at', null)
          .neq('approval_status', 'CANCELLED')
          .gte('voucher_date', from)
          .lt('voucher_date', to)
          .order('voucher_date', { ascending: false })
          .order('id', { ascending: true })
          .range(f, t),
        { label: 'thanh-toan.saleBonus' },
      );
      if (data === null) throw new Error('Lỗi tải sổ thưởng Sale — thử lại.');
      return data.map((r) => ({
        id: r.id,
        code: r.code ?? null,
        amount: Number(r.total_amount) || 0,
        voucherDate: r.voucher_date ?? null,
        approvalStatus: r.approval_status,
        postingStatus: r.posting_status ?? null,
        buildingName: r.buildings?.name ?? '—',
        roomName: r.rooms?.name ?? null,
        contractNumber: r.contracts?.contract_number ?? null,
        // Ghi chú của writer phiếu-cọc luôn mở đầu "Thưởng Sale theo phiếu cọc".
        fromDeposit: /theo phiếu cọc/i.test(r.notes ?? '') || r.contract_id == null,
      }));
    },
  });

// ── 3. CỌC ĐÃ THU ────────────────────────────────────────────────────────────

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
