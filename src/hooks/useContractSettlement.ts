// =============================================================================
// useContractSettlement — READ MODEL của khu "Hợp đồng & quyết toán".
//
// ── DANH SÁCH DO PHIẾU DẪN DẮT ──────────────────────────────────────────────
// Chủ đã chốt: phiếu vào từ trang Thu chi, khu này chỉ rà soát → duyệt → chi.
// Vì thế nguồn sự thật của danh sách là bảng `income_expenses`, KHÔNG phải nguồn
// nghiệp vụ (hợp đồng, hồ sơ thanh lý). Nguồn nghiệp vụ chỉ cấp SỐ CĂN CỨ để
// đối chiếu, không sinh dòng nào.
//
// Đọc THẲNG bảng qua RLS — cùng đường mà trang Thu chi dùng. Không qua RPC
// SECURITY DEFINER: định nghĩa "phiếu tôi được xem" phải giống hệt ở hai trang,
// nếu không cùng một người sẽ thấy hai danh sách khác nhau.
//
// ── NHẬN PHIẾU BẰNG BỐN DẤU, KHÔNG PHẢI MỘT ─────────────────────────────────
// Đo org THẬT 21/09/2026: bộ lọc chỉ theo `system_source` / `commission_kind`
// bỏ sót 13 phiếu (3 đang chờ duyệt) — chúng do người dùng TẠO TAY bên Thu chi
// nên không mang dấu nguồn nào, chỉ nhận ra qua HẠNG MỤC KẾ TOÁN.
// Và hai dấu là HOẶC chứ không đi kèm: 34 phiếu có `commission_kind` mà
// `system_source` rỗng.
//
// ── VÌ SAO BỐN TRUY VẤN RỜI, KHÔNG PHẢI MỘT `.or()` ─────────────────────────
// PostgREST tách tham số của `.or()` bằng dấu PHẨY và hiểu dấu CHẤM là toán tử,
// nên `system_source.like.termination.refund*` rất dễ parse sai. Bốn truy vấn
// rời rồi gộp theo id ở client thì chậm hơn chút nhưng đúng và soi được.
// Đây cũng là khuôn `useThanhToanLedgers` đang dùng.
// =============================================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import { hydrateIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import { settlementTypeMatches, type SettlementKind } from '@/lib/settlementTypes';
import {
  detectIssues, settlementStatusOf, supplementPending,
  type BasisState, type SettlementRow,
} from '@/lib/contractSettlement';

/** Chế độ phạm vi. Mặc định 'open' — xem [Plan §3]. */
export type SettlementScope = 'open' | 'period';

export interface UseContractSettlementArgs {
  organizationId: string | null | undefined;
  buildingIds: string[];
  /** 'YYYY-MM'. Dùng cho nhãn OLD_PERIOD và cho chế độ 'period'. */
  period: string;
  scope?: SettlementScope;
  enabled?: boolean;
}

// ── Hình dạng dòng phiếu đọc về ─────────────────────────────────────────────
interface VoucherRow {
  id: string;
  code: string | null;
  organization_id: string;
  building_id: string | null;
  room_id: string | null;
  contract_id: string | null;
  total_amount: number | string | null;
  voucher_date: string | null;
  system_source: string | null;
  commission_kind: string | null;
  payer_name: string | null;
  receive_bank_name: string | null;
  receive_bank_account: string | null;
  account_id: string | null;
  posting_mode: string | null;
  approval_status: string | null;
  posting_status: string | null;
  review_state: string | null;
  review_reason: string | null;
  review_version: number | string | null;
  approval_version: number | string | null;
  posting_version: number | string | null;
  maker_user_id: string | null;
  posted_at_v2: string | null;
  attachments: unknown;
  buildings: { name: string } | null;
  rooms: { name: string } | null;
  accounts: { name: string | null } | null;
  contracts: {
    contract_number: string | null;
    signed_date: string | null;
    contract_customers: { customers: { full_name: string | null } | null }[] | null;
  } | null;
}

/**
 * Tên khách của phiếu. Ưu tiên người đầu tiên trong bảng nối; hợp đồng nhiều
 * người ở thì vẫn chỉ hiện một tên cho vừa dòng bảng.
 *
 * ⚠ Bản trước gán NHẦM `contract_number` vào đây, nên cột "Khách" hiện ra mã
 * hợp đồng. Đừng quay lại cách đó.
 */
const tenKhach = (v: VoucherRow): string => {
  const ten = v.contracts?.contract_customers?.find((x) => x.customers?.full_name)
    ?.customers?.full_name;
  return (ten ?? '').trim() || 'Chưa có tên khách';
};

/**
 * `attachments` là cột JSON nên hình dạng không được bảo đảm — lọc còn chuỗi
 * không rỗng. Đọc hỏng phải ra MẢNG RỖNG chứ không được ném: thiếu ảnh chỉ làm
 * phiếu ở lại làn rà soát, còn ném thì hỏng cả bảng.
 */
const docAnh = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

const nguonCua = (v: VoucherRow): 'contract' | 'reservation' =>
  (v.system_source ?? '').startsWith('reservation') ? 'reservation' : 'contract';

/** Biến động nào đã đẻ ra khoản chi này. Suy ra, không có cột nào lưu sẵn. */
const nhanBienDong = (kind: SettlementKind, origin: 'contract' | 'reservation'): string => {
  if (kind === 'refund') return origin === 'reservation' ? 'Kết thúc giữ chỗ' : 'Thanh lý';
  if (kind === 'bonus') return origin === 'reservation' ? 'Từ giữ chỗ' : 'Ký mới';
  return 'Ký mới';
};

const COT = [
  'id', 'code', 'organization_id', 'building_id', 'room_id', 'contract_id',
  'total_amount', 'voucher_date', 'system_source', 'commission_kind',
  'payer_name', 'receive_bank_name', 'receive_bank_account', 'account_id',
  'posting_mode', 'approval_status', 'posting_status',
  'review_state', 'review_reason', 'review_version', 'approval_version',
  'posting_version', 'maker_user_id', 'posted_at_v2', 'attachments',
  'buildings:building_id ( name )',
  'rooms:room_id ( name )',
  'accounts:account_id ( name )',
  // Tên khách lấy qua bảng nối `contract_customers` — `contracts` KHÔNG có cột
  // customer nào. Cột đại diện là `is_representative` (không phải `is_primary`).
  'contracts:contract_id ( contract_number, signed_date, contract_customers ( customers ( full_name ) ) )',
].join(', ');

/**
 * Loại thu chi của tổ chức, lọc còn những loại thuộc khu này.
 * Bảng nhỏ (đo thật: 209 dòng toàn hệ thống, 106 ở org THẬT) nên tải hết rồi
 * lọc bằng `settlementTypeMatches` ở client — không cần SQL khớp chuỗi.
 */
const useSettlementTypeMap = (organizationId: string | null | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['contract-settlement', 'types', organizationId],
    enabled: enabled && !!organizationId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Map<string, SettlementKind>> => {
      const { data, error } = await supabase
        .from('income_expense_types')
        .select('id, category, name')
        .eq('organization_id', organizationId!);
      if (error) throw new Error(error.message);
      const m = new Map<string, SettlementKind>();
      for (const t of data ?? []) {
        const kind = settlementTypeMatches(t.category, t.name);
        if (kind) m.set(t.id, kind);
      }
      return m;
    },
  });

/**
 * Chỉ những phương thức của PostgREST builder mà file này thật sự gọi.
 * Khai tối thiểu thay vì `any`: sai tên phương thức vẫn bị bắt lúc biên dịch.
 */
interface LocBuilder {
  eq(col: string, v: unknown): LocBuilder;
  neq(col: string, v: unknown): LocBuilder;
  is(col: string, v: null): LocBuilder;
  in(col: string, v: readonly unknown[]): LocBuilder;
  or(filter: string): LocBuilder;
  gte(col: string, v: unknown): LocBuilder;
  lt(col: string, v: unknown): LocBuilder;
  like(col: string, v: string): LocBuilder;
  order(col: string, o: { ascending: boolean }): LocBuilder;
  range(from: number, to: number): unknown;
}

/** Áp bộ lọc chung cho mọi truy vấn phiếu. */
const apDieuKienChung = (
  q: LocBuilder,
  a: { organizationId: string; buildingIds: string[]; scope: SettlementScope; period: string },
) => {
  let r = q
    .eq('organization_id', a.organizationId)
    .eq('type', 'EXPENSE')
    .is('deleted_at', null)
    .in('building_id', a.buildingIds);
  if (a.scope === 'period') {
    const [y, m] = a.period.split('-').map(Number);
    const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    r = r.gte('voucher_date', `${a.period}-01`).lt('voucher_date', to);
  } else {
    // 'open' = MỌI KỲ, chỉ việc chưa xong. Đo thật: 50/95 phiếu chờ duyệt nằm
    // ngoài tháng hiện tại — lọc một tháng là giấu mất hơn nửa việc.
    r = r.neq('approval_status', 'CANCELLED')
      .or('posting_status.is.null,posting_status.neq.POSTED');
  }
  return r.order('voucher_date', { ascending: false }).order('id', { ascending: true });
};

export function useContractSettlement(a: UseContractSettlementArgs) {
  const enabled = (a.enabled ?? true) && !!a.organizationId && a.buildingIds.length > 0;
  const scope: SettlementScope = a.scope ?? 'open';
  const typeMap = useSettlementTypeMap(a.organizationId, enabled);

  const vouchers = useQuery({
    queryKey: [
      'contract-settlement', 'vouchers', a.organizationId, scope, a.period,
      [...a.buildingIds].sort(), [...(typeMap.data?.keys() ?? [])].sort(),
    ],
    enabled: enabled && !!typeMap.data,
    queryFn: async (): Promise<VoucherRow[]> => {
      const chung = {
        organizationId: a.organizationId!, buildingIds: a.buildingIds, scope, period: a.period,
      };
      const goi = (build: (q: LocBuilder) => LocBuilder, label: string) =>
        fetchAllRows<VoucherRow>(
          (f, t) => build(apDieuKienChung(
            supabase.from('income_expenses').select(COT) as unknown as LocBuilder, chung,
          )).range(f, t) as never,
          { label },
        );

      // D4 trước: lấy id phiếu có hạng mục thuộc khu này.
      const typeIds = [...(typeMap.data?.keys() ?? [])];
      let idsTheoHangMuc: string[] = [];
      if (typeIds.length > 0) {
        const items = await fetchAllRows<{ income_expense_id: string }>(
          (f, t) => supabase
            .from('income_expense_items')
            .select('income_expense_id')
            .in('income_expense_type_id', typeIds)
            .order('income_expense_id', { ascending: true })
            .range(f, t),
          { label: 'contract-settlement.items' },
        );
        if (items === null) throw new Error('Không đọc được hạng mục của phiếu — thử lại.');
        idsTheoHangMuc = [...new Set(items.map((r) => r.income_expense_id))];
      }

      const [d1, d2, d3, d4] = await Promise.all([
        goi((q) => q.like('system_source', 'termination.refund%'), 'cs.d1'),
        goi((q) => q.like('system_source', 'reservation.refund%'), 'cs.d2'),
        goi((q) => q.in('commission_kind', ['broker', 'sale']), 'cs.d3'),
        idsTheoHangMuc.length
          ? goi((q) => q.in('id', idsTheoHangMuc), 'cs.d4')
          : Promise.resolve([] as VoucherRow[]),
      ]);

      // fetchAllRows trả null khi đọc hỏng — KHÔNG được coi là rỗng, vì rỗng
      // nghĩa là "không còn việc" và người dùng sẽ tưởng đã làm hết.
      if (d1 === null || d2 === null || d3 === null || d4 === null) {
        throw new Error('Không tải được danh sách khoản chi — thử lại.');
      }

      // Khử trùng theo id: một phiếu nhiều hạng mục chỉ ra MỘT dòng.
      const theoId = new Map<string, VoucherRow>();
      for (const r of [...d1, ...d2, ...d3, ...d4]) theoId.set(r.id, r);
      return [...theoId.values()];
    },
  });

  /** Căn cứ hoa hồng — tra theo KỲ CỦA NGÀY KÝ hợp đồng, không phải kỳ phiếu. */
  const kyKyHopDong = useMemo(() => {
    const s = new Set<string>();
    for (const v of vouchers.data ?? []) {
      if (v.commission_kind === 'broker' && v.contracts?.signed_date) {
        s.add(v.contracts.signed_date.slice(0, 7));
      }
    }
    return [...s].sort();
  }, [vouchers.data]);

  const canCuHoaHong = useQuery({
    queryKey: ['contract-settlement', 'commission-basis', kyKyHopDong, [...a.buildingIds].sort()],
    enabled: enabled && kyKyHopDong.length > 0,
    queryFn: async (): Promise<Map<string, number>> => {
      // ⚠ `get_period_commissions` lọc theo NGÀY KÝ hợp đồng, còn danh sách lọc
      // theo NGÀY PHIẾU. Hợp đồng ký tháng 8 mà phiếu lập tháng 9 thì gọi kỳ 9
      // không tìm thấy căn cứ. Nên gọi đúng các kỳ có mặt trong tập hợp đồng.
      const m = new Map<string, number>();
      for (const ky of kyKyHopDong) {
        const { data, error } = await supabase.rpc('get_period_commissions', {
          p_period_month: ky, p_building_ids: a.buildingIds,
        });
        if (error) throw new Error(error.message);
        const dong = (data ?? []) as { contract_id?: string | null; expected_amount?: number | string | null }[];
        for (const r of dong) {
          if (r.contract_id) m.set(r.contract_id, Number(r.expected_amount) || 0);
        }
      }
      return m;
    },
  });

  /** Ghi chú bổ sung — chỉ phiếu CHỜ DUYỆT mới cần biết có treo yêu cầu không. */
  const idsChoDuyet = useMemo(
    () => (vouchers.data ?? []).filter((v) => v.approval_status === 'UNAPPROVED').map((v) => v.id),
    [vouchers.data],
  );

  const ghiChu = useQuery({
    queryKey: ['contract-settlement', 'supplements', [...idsChoDuyet].sort()],
    enabled: enabled && idsChoDuyet.length > 0,
    queryFn: async (): Promise<Map<string, boolean>> => {
      // Helper sẵn có: chia lô 50 id, sắp created_at rồi id, và NÉM khi một lô
      // hỏng thay vì trả rỗng — đúng thứ ta cần.
      const withNotes = await hydrateIncomeExpenseSupplements(idsChoDuyet.map((id) => ({ id })));
      return new Map(withNotes.map((v) => [v.id, supplementPending(v.supplements)]));
    },
  });

  const rows = useMemo<SettlementRow[]>(() => {
    const vs = vouchers.data;
    if (!vs) return [];
    const types = typeMap.data ?? new Map<string, SettlementKind>();
    const treo = ghiChu.data;
    const basisHH = canCuHoaHong.data;

    const kindOf = (v: VoucherRow): SettlementKind => {
      // Thứ tự ưu tiên khi một phiếu dính nhiều dấu: D3 → D1/D2 → D4.
      if (v.commission_kind === 'broker') return 'commission';
      if (v.commission_kind === 'sale') return 'bonus';
      if ((v.system_source ?? '').startsWith('termination.refund')) return 'refund';
      if ((v.system_source ?? '').startsWith('reservation.refund')) return 'refund';
      // D4: không biết hạng mục nào của phiếu đã khớp nên suy theo dấu còn lại.
      // Tra ngược bằng typeMap cần đọc items lần nữa — để đợt sau nếu cần độ
      // chính xác cao hơn; hiện tại phiếu tạo tay đa số là hoàn khách.
      return 'refund';
    };

    const basisOf = (v: VoucherRow, kind: SettlementKind): BasisState => {
      if (kind === 'bonus') return { kind: 'not-applicable' };
      if (kind === 'refund') {
        // Số phải hoàn THẬT do `preview_termination_refund_v1` tính (đối chiếu
        // cọc thực thu). RPC đó đắt nên chỉ gọi khi mở modal — ở danh sách để
        // 'not-found', và 'not-found' KHÔNG chặn làn.
        return { kind: 'not-found', reason: 'Căn cứ hoàn khách tra khi mở phiếu' };
      }
      // commission
      if (canCuHoaHong.isError) {
        return { kind: 'unavailable', reason: 'Không đọc được bậc hoa hồng' };
      }
      if (!basisHH) return { kind: 'not-found', reason: 'Đang tra căn cứ' };
      if (!v.contract_id) return { kind: 'not-found', reason: 'Phiếu chưa gắn hợp đồng' };
      const expected = basisHH.get(v.contract_id);
      if (expected == null) {
        return { kind: 'not-found', reason: 'Không tìm thấy hợp đồng trong kỳ ký' };
      }
      const amount = Number(v.total_amount) || 0;
      return expected === amount
        ? { kind: 'matched', amount: expected }
        : { kind: 'mismatch', amount: expected };
    };

    return vs.map((v) => {
      const kind = kindOf(v);
      const base: Omit<SettlementRow, 'issues'> = {
        key: `${kind}:${v.id}`,
        kind,
        voucherId: v.id,
        voucherCode: v.code,
        contractId: v.contract_id,
        contractNumber: v.contracts?.contract_number ?? null,
        terminationId: null,
        roomId: v.room_id,
        buildingName: v.buildings?.name ?? '—',
        roomName: v.rooms?.name ?? null,
        customerName: tenKhach(v),
        recipientName: v.payer_name,
        amount: Number(v.total_amount) || 0,
        basis: basisOf(v, kind),
        status: settlementStatusOf(v.approval_status, v.posting_status),
        approvalStatus: v.approval_status,
        postingStatus: v.posting_status,
        postingMode: v.posting_mode,
        bankAccount: v.receive_bank_account,
        bankName: v.receive_bank_name,
        attachments: docAnh(v.attachments),
        hasAttachment: docAnh(v.attachments).length > 0,
        eventDate: v.voucher_date,
        origin: nguonCua(v),
        eventLabel: nhanBienDong(kind, nguonCua(v)),
        // posted_at_v2 chỉ có nghĩa khi đã ghi sổ; phiếu chưa chi có thể vẫn
        // mang giá trị cũ nếu từng bị đảo, nên chốt theo posting_status.
        paidDate: v.posting_status === 'POSTED' ? v.posted_at_v2 : null,
        bookName: v.posting_status === 'POSTED' ? (v.accounts?.name ?? null) : null,
        supplementPending: treo?.get(v.id) ?? false,
        reviewState: v.review_state,
        reviewVersion: Number(v.review_version ?? 1),
        approvalVersion: Number(v.approval_version ?? 1),
        postingVersion: Number(v.posting_version ?? 1),
        organizationId: v.organization_id,
        buildingId: v.building_id,
      };
      return { ...base, issues: detectIssues(base, a.period) };
    });
  }, [vouchers.data, typeMap.data, ghiChu.data, canCuHoaHong.data, canCuHoaHong.isError, a.period]);

  return {
    rows,
    isLoading:
      typeMap.isLoading || vouchers.isLoading ||
      (idsChoDuyet.length > 0 && ghiChu.isLoading) ||
      (kyKyHopDong.length > 0 && canCuHoaHong.isLoading),
    isError: typeMap.isError || vouchers.isError || ghiChu.isError,
    error: typeMap.error ?? vouchers.error ?? ghiChu.error ?? null,
    refetch: vouchers.refetch,
  };
}
