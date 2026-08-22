import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';

// Ngưỡng làm tròn: chênh cọc < 10.000đ coi như đủ (khớp PREVIOUS_DEBT_ROUND_THRESHOLD).
export const DEPOSIT_SHORTFALL_THRESHOLD = 10000;

const nn = (v: unknown) => Number(v) || 0;

// Tổng cọc đang giữ theo toà — RPC SQL aggregate (miễn nhiễm cap-1000). Thay cho
// client-reduce trên danh sách HĐ (hụt tổng khi ACTIVE > 1000).
export interface HeldDepositBuildingAgg {
  building_id: string;
  building_name: string;
  contractCount: number;
  expected: number;
  held: number;
  shortfallAll: number; // Σ max(0,remaining) mọi HĐ
  shortfallShort: number; // Σ max(0,remaining) chỉ HĐ SHORT
  fullCount: number;
  shortCount: number; // chỉ state SHORT
  firstInvoiceCount: number;
}

export function useHeldDepositSummary(
  buildingIds?: string[],
  threshold: number = DEPOSIT_SHORTFALL_THRESHOLD,
) {
  return useQuery({
    queryKey: ['deposit-dashboard', 'held-summary', buildingIds ?? [], threshold],
    queryFn: async (): Promise<HeldDepositBuildingAgg[]> => {
      const { data, error } = await supabase.rpc('get_held_deposit_summary', {
        p_building_ids: buildingIds && buildingIds.length ? buildingIds : undefined,
        p_threshold: threshold,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r): HeldDepositBuildingAgg => ({
        building_id: r.building_id,
        building_name: r.building_name ?? '—',
        contractCount: nn(r.contract_count),
        expected: nn(r.expected),
        held: nn(r.held),
        shortfallAll: nn(r.shortfall_all),
        shortfallShort: nn(r.shortfall_short),
        fullCount: nn(r.full_count),
        shortCount: nn(r.short_count),
        firstInvoiceCount: nn(r.first_invoice_count),
      }));
    },
  });
}

export interface RefundForfeitSummary {
  refundTotal: number;
  refundCount: number;
  forfeitTotal: number;
  forfeitCount: number;
}

/**
 * Số liệu hoàn/bỏ cọc lấy TỪ SERVER (`get_refund_forfeit_summary`), theo đúng
 * QUYẾT ĐỊNH CỦA CHỦ 30/07/2026 — xem §1ter.1 của
 * `docs/superpowers/plans/2026-07-30-danh-gia-2-plan-thu-tien-v2.md`.
 *
 * Chủ chốt: ô KPI "Đã hoàn cọc" phải là TIỀN THẬT ĐÃ RA KHỎI KÉT, tức gồm CẢ
 * phiếu hoàn không nối được hồ sơ thanh lý:
 *
 *     linkedTotal   4.302.000đ /  2 phiếu (2 hồ sơ)  ← phần khớp đúng BẢNG bên dưới
 *     orphanTotal  23.737.100đ /  8 phiếu            ← đã ghi sổ, KHÔNG có hồ sơ thanh lý
 *     ──────────────────────────────────────────────
 *     refundTotal  28.039.100đ / 10 phiếu            ← KPI
 *
 * ⚠ HAI ĐƠN VỊ, ĐỪNG TRỘN. `linkedCount` đếm HỒ SƠ THANH LÝ; `orphanCount` và
 * `refundCount` đếm PHIẾU. Số PHIẾU của phần nối được hồ sơ là `linkedVoucherCount`
 * (khoá SQL `refund_voucher_count`). Hôm nay hai số trùng nhau (2 hồ sơ mang đúng
 * 2 phiếu) nên "2 + 8 = 10" vẫn ra đúng dù sai đơn vị — nó vỡ ngay lần đầu một hồ
 * sơ mang 2 phiếu hoàn (hình thái CÓ THẬT, xem ghi chú bộ đôi phiếu trùng số bên
 * dưới). Đối chiếu đúng:
 *     tiền  : linkedTotal        + orphanTotal  === refundTotal
 *     phiếu : linkedVoucherCount + orphanCount  === refundCount
 *
 * `orphanTotal` PHẢI được hiện thành một dòng cảnh báo cạnh ô KPI. Không hiện thì
 * KPI lại lệch bảng lần nữa — lần này theo chiều khai thừa so với bảng.
 */
export interface RefundForfeitServerSummary extends RefundForfeitSummary {
  /** Phần nối được hồ sơ thanh lý = tổng cột của bảng bên dưới. */
  linkedTotal: number;
  /** Số HỒ SƠ thanh lý có phiếu hoàn đã ghi sổ (KHÔNG phải số phiếu). */
  linkedCount: number;
  /** Số PHIẾU hoàn đã ghi sổ nối được hồ sơ — cùng đơn vị với orphanCount/refundCount. */
  linkedVoucherCount: number;
  /** Đã ghi sổ nhưng không có hồ sơ thanh lý ⇒ bảng không thể hiện. Phải cảnh báo. */
  orphanTotal: number;
  orphanCount: number;
  /** Đã tạo phiếu hoàn nhưng CHƯA ghi sổ ⇒ "chờ chi", không phải "đã hoàn". */
  pendingTotal: number;
  pendingCount: number;
  /**
   * Tách ô KPI: phần thật sự là CỌC và phần KHÔNG PHẢI cọc (hoàn tiền thừa /
   * hoàn tiền phòng ngày khách không ở). Phiếu `termination.refund` CỐ Ý mang
   * mọi khoản trả lại khách, nên nhãn "Đã hoàn cọc" một mình sẽ nói quá.
   *
   * Đẳng thức bảo đảm theo cấu trúc ở SQL:
   *   refundDepositTotal        + refundNonDepositTotal        === refundTotal
   *   pendingDepositTotal       + pendingNonDepositTotal       === pendingTotal
   */
  refundDepositTotal: number;
  refundNonDepositTotal: number;
  pendingDepositTotal: number;
  pendingNonDepositTotal: number;
  /** Công thức GENERATED cũ, CHỈ để đối chiếu lịch sử. Không phải tiền phải trả. */
  netSettlementTotal: number;
  /** `refund_amount` âm = khách còn nợ. Không được hiện "Đã hoàn 0đ". */
  customerDebtTotal: number;
  customerDebtCount: number;
}

/**
 * NGUỒN SỰ THẬT của ô KPI "Đã hoàn cọc" trên /deposits (Slice −1 · §−1.7 +
 * quyết định của chủ 30/07 · §1ter.1). ĐỪNG thay bằng client-reduce.
 *
 * Hàm SQL `get_refund_forfeit_summary` (bản Slice −1) lái `refund_total` bằng
 * PHIẾU HOÀN ĐÃ GHI SỔ (`system_source='termination.refund'`, APPROVED,
 * `posting_status='POSTED'`, `active_posting_id_v2` khác NULL) thay cho cột
 * GENERATED `contract_terminations.refund_amount` — cột đó từng làm ô KPI nói
 * 8.290.000đ / 3 lần vì cộng cả hồ sơ chưa có phiếu nào vào sổ.
 *
 * Vì sao KHÔNG tính bằng `summarizeRefundForfeit()` trên các dòng của bảng: bảng
 * đi từ `contract_terminations`, nên nó chỉ thấy được `linkedTotal`
 * (4.302.000đ / 2). 8 phiếu hoàn còn lại (23.737.100đ) đã ra khỏi két mà KHÔNG
 * có dòng thanh lý nào ⇒ lấy tổng bảng làm KPI là khai THIẾU 23,7 triệu, đúng
 * phương án chủ đã bác. Bù lại, `orphanTotal` PHẢI được hiện thành một dòng
 * cảnh báo cạnh ô KPI (DepositsPage đang làm) để KPI và bảng đối chiếu được:
 * `linkedTotal + orphanTotal === refundTotal`.
 */
export function useRefundForfeitSummary(buildingIds?: string[]) {
  return useQuery({
    queryKey: ['deposit-dashboard', 'refund-forfeit-summary', buildingIds ?? []],
    queryFn: async (): Promise<RefundForfeitServerSummary> => {
      const { data, error } = await supabase.rpc('get_refund_forfeit_summary', {
        p_building_ids: buildingIds && buildingIds.length ? buildingIds : undefined,
      });
      if (error) throw error;
      const d = (data ?? {}) as any;
      return {
        // Tiền thật đã ra két (gồm cả phiếu không nối hồ sơ) — §1ter.1.
        refundTotal: nn(d.refund_total),
        refundCount: nn(d.refund_count),
        forfeitTotal: nn(d.forfeit_total),
        forfeitCount: nn(d.forfeit_count),
        linkedTotal: nn(d.refund_linked_total),
        linkedCount: nn(d.refund_linked_count),          // HỒ SƠ
        linkedVoucherCount: nn(d.refund_voucher_count),  // PHIẾU
        orphanTotal: nn(d.refund_posted_orphan_total),
        orphanCount: nn(d.refund_posted_orphan_count),
        pendingTotal: nn(d.refund_pending_total),
        pendingCount: nn(d.refund_pending_count),
        // Server cũ (chưa apply 20260822113000) không có bốn khoá này ⇒ nn() cho
        // 0, và UI chỉ hiện dòng tách khi tổng hai phần khớp refundTotal. Nhờ vậy
        // FE mới chạy trên server cũ thì im lặng bỏ qua, không hiện số sai.
        refundDepositTotal: nn(d.refund_deposit_total),
        refundNonDepositTotal: nn(d.refund_non_deposit_total),
        pendingDepositTotal: nn(d.refund_pending_deposit_total),
        pendingNonDepositTotal: nn(d.refund_pending_non_deposit_total),
        netSettlementTotal: nn(d.refund_net_settlement_total),
        customerDebtTotal: nn(d.customer_debt_total),
        customerDebtCount: nn(d.customer_debt_count),
      };
    },
  });
}

export type HeldDepositState = 'FULL' | 'SHORT' | 'FIRST_INVOICE';

export interface HeldDepositRow {
  contract_id: string;
  contract_number: string | null;
  building_id: string;
  building_name: string;
  room_name: string;
  customer_name: string;
  total_deposit: number;
  deposit_paid: number;
  deposit_remaining: number;
  deposit_debt_mode: string | null;
  deposit_topup_due_date: string | null;
  state: HeldDepositState;
}

export interface BuildingDepositSummary {
  building_id: string;
  building_name: string;
  contractCount: number;
  expected: number; // Σ total_deposit
  held: number; // Σ deposit_paid (cọc đang giữ)
  shortfall: number; // Σ deposit_remaining
  fullCount: number;
  shortCount: number;
}

export type RefundForfeitKind = 'REFUND' | 'FORFEIT';

// ─────────────────────────────────────────────────────────────────────────────
// "ĐÃ HOÀN" = TIỀN ĐÃ RA KHỎI KÉT, không phải cờ trên contract_terminations.
//
// Vì sao phải đổi (Slice −1 · §−1.7): `approve_contract_termination_v1` chạy MỘT
// lệnh `update contract_terminations set status='COMPLETED', refund_date = now()`
// TRƯỚC khi insert phiếu chi, và phiếu đó ra đời `approval_status='UNAPPROVED'`
// với `account_id` NULL (chưa ai chọn sổ quỹ). Nên `status='COMPLETED'` và
// `refund_date` do CÙNG một câu lệnh đặt, và cả hai đều KHÔNG chứng minh được
// đồng nào đã rời két. Luật cũ `!!refund_date || status === 'COMPLETED'` vì thế
// bịa ra tick xanh.
//
// Đo thật 30/07/2026: trong 11 termination dạng trả phòng, **7 dòng** hiện tick
// xanh "Đã hoàn" mà KHÔNG có phiếu nào vào sổ (PC2607001/8/10 UNAPPROVED +
// UNPOSTED, `account_id` NULL), và **2 dòng hiện sai số theo HAI CHIỀU ngược
// nhau**: HĐ `69cdb5dc` net quyết toán 2.428.500 vs phiếu POSTED `PC2607119`
// 1.450.000 (−978.500); HĐ `06440526` net 2.352.000 vs phiếu POSTED `PC2607104`
// 2.852.000 (+500.000).
//
// Luật mới: "Đã hoàn" ⇔ tồn tại phiếu chi `system_source='termination.refund'`,
// `approval_status='APPROVED'`, `posting_status='POSTED'` và CÒN bút toán hiệu
// lực (`active_posting_id_v2` không NULL). Ba điều kiện đều cần thiết trên dữ
// liệu thật: phiếu bị đảo mang `posting_status='REVERSED'`, còn prod đang có 1
// phiếu `POSTED` mà `approval_status='CANCELLED'` và 3 phiếu `POSTED` không còn
// bút toán hiệu lực.
// ─────────────────────────────────────────────────────────────────────────────
export const TERMINATION_REFUND_SOURCE = 'termination.refund';

/** Một phiếu hoàn cọc ĐÃ VÀO SỔ (đã lọc sẵn ở tầng query). */
export interface PostedRefundVoucher {
  contract_id: string;
  code: string | null;
  amount: number;
}

/** Tổng tiền hoàn đã vào sổ của MỘT hợp đồng. */
export interface PostedRefundAgg {
  total: number;
  count: number;
  codes: string[];
}

/**
 * Gộp phiếu hoàn theo `contract_id` — KHÔNG join row-per-voucher.
 *
 * Bắt buộc gộp: prod có hợp đồng mang HAI phiếu hoàn cùng số tiền, nên mọi
 * reader correlate kiểu 1-phiếu-1-dòng sẽ trả 2 dòng cho 1 termination. Khoá
 * `contract_id` an toàn vì `idx_terminations_unique_contract` là UNIQUE
 * (1 hợp đồng ↔ tối đa 1 dòng thanh lý).
 */
export function indexPostedRefunds(
  vouchers: PostedRefundVoucher[],
): Map<string, PostedRefundAgg> {
  const map = new Map<string, PostedRefundAgg>();
  for (const v of vouchers) {
    if (!v.contract_id) continue;
    let agg = map.get(v.contract_id);
    if (!agg) {
      agg = { total: 0, count: 0, codes: [] };
      map.set(v.contract_id, agg);
    }
    agg.total += nn(v.amount);
    agg.count += 1;
    if (v.code) agg.codes.push(v.code);
  }
  return map;
}

export interface RefundForfeitRow {
  id: string;
  contract_id: string;
  contract_number: string | null;
  building_id: string;
  building_name: string;
  room_name: string;
  customer_name: string;
  termination_date: string;
  termination_type: string;
  kind: RefundForfeitKind;
  total_deposit: number;
  total_deductions: number;
  /**
   * `contract_terminations.refund_amount` — cột GENERATED, là **net quyết toán
   * LỊCH SỬ** (cọc ghi trên HĐ − khấu trừ ghi trên hồ sơ), KHÔNG phải số phải
   * trả khách. Ca `69cdb5dc` cho thấy rõ: 2.428.500 = 3.500.000 cọc *chưa bao
   * giờ thu* − 1.071.500 cấn cọc *chưa bao giờ vào sổ* (phiếu `PC2607118` đã
   * CANCELLED nhưng `early_termination_fee` vẫn nuôi công thức GENERATED).
   * Âm = khách còn nợ thêm sau khi mất cọc.
   */
  settlement_net: number;
  status: string;
  /** Σ phiếu hoàn ĐÃ VÀO SỔ của hợp đồng này (đồng). */
  posted_refund: number;
  posted_refund_count: number;
  posted_refund_codes: string[];
  /** true ⇔ có ít nhất 1 phiếu hoàn đã vào sổ. Không đọc `refund_date` nữa. */
  refund_done: boolean;
  /**
   * `settlement_net − posted_refund` khi net > 0: >0 = hồ sơ nói phải hoàn mà
   * két chưa chi đủ; <0 = két chi nhiều hơn hồ sơ. Dùng để hiện cảnh báo lệch,
   * KHÔNG dùng để sửa dữ liệu.
   */
  refund_drift: number;
}

function repName(contractCustomers: any[] | undefined | null): string {
  const list = contractCustomers ?? [];
  const rep = list.find((cc: any) => cc.is_representative);
  return (
    rep?.customer?.full_name ||
    list[0]?.customer?.full_name ||
    'Khách hàng'
  );
}

/**
 * Cọc đang giữ theo HĐ đang hiệu lực (ACTIVE) — nguồn sự thật đủ/thiếu cọc.
 * Trả về từng dòng HĐ; trang tự gộp theo toà nhà.
 */
export function useHeldDeposits() {
  return useQuery({
    queryKey: ['deposit-dashboard', 'held'],
    queryFn: async (): Promise<HeldDepositRow[]> => {
      // PAGED: danh sách HĐ ACTIVE có thể > 1000 → phân trang kẻo bảng bị cắt.
      const data = await fetchAllRows<any>(
        (from, to) => supabase
          .from('contracts')
          .select(`
            id, contract_number, total_deposit, deposit_paid, deposit_remaining,
            deposit_debt_mode, deposit_topup_due_date,
            room:rooms!contracts_room_id_fkey (
              id, name,
              building:buildings!rooms_building_id_fkey ( id, name )
            ),
            contract_customers!contract_customers_contract_id_fkey (
              is_representative,
              customer:customers!contract_customers_customer_id_fkey ( full_name )
            )
          `)
          .in('status', ['ACTIVE'])
          .is('deleted_at', null)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'deposits.held' },
      );
      if (data === null) throw new Error('Lỗi tải danh sách cọc đang giữ');

      return data.map((c: any): HeldDepositRow => {
        const total = Number(c.total_deposit) || 0;
        const paid = Number(c.deposit_paid) || 0;
        const remaining =
          c.deposit_remaining != null ? Number(c.deposit_remaining) : total - paid;
        const isShort = remaining >= DEPOSIT_SHORTFALL_THRESHOLD;
        const state: HeldDepositState = !isShort
          ? 'FULL'
          : c.deposit_debt_mode === 'FIRST_INVOICE'
            ? 'FIRST_INVOICE'
            : 'SHORT';
        return {
          contract_id: c.id,
          contract_number: c.contract_number ?? null,
          building_id: c.room?.building?.id ?? '',
          building_name: c.room?.building?.name ?? '—',
          room_name: c.room?.name ?? '—',
          customer_name: repName(c.contract_customers),
          total_deposit: total,
          deposit_paid: paid,
          deposit_remaining: remaining,
          deposit_debt_mode: c.deposit_debt_mode ?? null,
          deposit_topup_due_date: c.deposit_topup_due_date ?? null,
          state,
        };
      });
    },
  });
}

/** Gộp các dòng cọc đang giữ theo toà nhà. */
export function summarizeByBuilding(rows: HeldDepositRow[]): BuildingDepositSummary[] {
  const map = new Map<string, BuildingDepositSummary>();
  for (const r of rows) {
    const key = r.building_id || r.building_name;
    let s = map.get(key);
    if (!s) {
      s = {
        building_id: r.building_id,
        building_name: r.building_name,
        contractCount: 0,
        expected: 0,
        held: 0,
        shortfall: 0,
        fullCount: 0,
        shortCount: 0,
      };
      map.set(key, s);
    }
    s.contractCount += 1;
    s.expected += r.total_deposit;
    s.held += r.deposit_paid;
    s.shortfall += Math.max(0, r.deposit_remaining);
    if (r.state === 'FULL') s.fullCount += 1;
    else s.shortCount += 1;
  }
  return Array.from(map.values()).sort((a, b) =>
    a.building_name.localeCompare(b.building_name, 'vi'),
  );
}

/**
 * Hoàn cọc / Bỏ cọc — hồ sơ lấy từ contract_terminations (KHÔNG dựa
 * deposits.status vì RPC thanh lý không set REFUNDED/FORFEITED), còn **sự thật
 * về tiền** lấy từ phiếu chi đã vào sổ. FORFEIT = bỏ cọc; còn lại = hoàn cọc.
 *
 * Hai query chạy song song trong CÙNG một queryFn (không phải hai hook) để bảng
 * và ô KPI luôn đọc một ảnh chụp dữ liệu, không bao giờ lệch pha nhau.
 */
export function useDepositRefundsForfeits() {
  return useQuery({
    queryKey: ['deposit-dashboard', 'refunds-forfeits'],
    queryFn: async (): Promise<RefundForfeitRow[]> => {
      // PAGED cả hai nhánh: thanh lý và phiếu hoàn đều tích luỹ mãi → phân trang
      // (order + id tiebreaker). CỐ Ý KHÔNG select `refund_date` nữa: nó do cùng
      // câu UPDATE với status='COMPLETED' đặt ra nên không nói được gì về tiền.
      const [data, vouchers] = await Promise.all([
        fetchAllRows<any>(
          (from, to) => supabase
            .from('contract_terminations')
            .select(`
              id, contract_id, termination_date, termination_type,
              total_deposit, total_deductions, refund_amount, status,
              contract:contracts!contract_terminations_contract_id_fkey (
                contract_number,
                room:rooms!contracts_room_id_fkey (
                  name,
                  building:buildings!rooms_building_id_fkey ( id, name )
                ),
                contract_customers!contract_customers_contract_id_fkey (
                  is_representative,
                  customer:customers!contract_customers_customer_id_fkey ( full_name )
                )
              )
            `)
            .order('termination_date', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
          { label: 'deposits.refundsForfeits' },
        ),
        fetchAllRows<any>(
          (from, to) => supabase
            .from('income_expenses')
            .select('id, code, contract_id, total_amount')
            .eq('type', 'EXPENSE')
            .eq('system_source', TERMINATION_REFUND_SOURCE)
            .eq('approval_status', 'APPROVED')
            .eq('posting_status', 'POSTED')
            .not('active_posting_id_v2', 'is', null)
            .not('contract_id', 'is', null)
            .is('deleted_at', null)
            .order('id', { ascending: true })
            .range(from, to),
          { label: 'deposits.postedRefundVouchers' },
        ),
      ]);
      if (data === null) throw new Error('Lỗi tải danh sách hoàn/bỏ cọc');
      // FAIL-CLOSED: nếu không đọc được phiếu thì THROW, tuyệt đối không coi là
      // "chưa có phiếu hoàn" — đó lại là một tuyên bố sai về tiền.
      if (vouchers === null) {
        throw new Error('Lỗi tải phiếu hoàn cọc đã vào sổ — chưa thể kết luận đã hoàn hay chưa');
      }

      const posted = indexPostedRefunds(
        vouchers.map((v: any): PostedRefundVoucher => ({
          contract_id: v.contract_id,
          code: v.code ?? null,
          amount: nn(v.total_amount),
        })),
      );

      return data.map((t: any): RefundForfeitRow => {
        const kind: RefundForfeitKind =
          t.termination_type === 'FORFEIT' ? 'FORFEIT' : 'REFUND';
        const agg = posted.get(t.contract_id) ?? { total: 0, count: 0, codes: [] };
        const settlementNet = nn(t.refund_amount);
        return {
          id: t.id,
          contract_id: t.contract_id,
          contract_number: t.contract?.contract_number ?? null,
          building_id: t.contract?.room?.building?.id ?? '',
          building_name: t.contract?.room?.building?.name ?? '—',
          room_name: t.contract?.room?.name ?? '—',
          customer_name: repName(t.contract?.contract_customers),
          termination_date: t.termination_date,
          termination_type: t.termination_type,
          kind,
          total_deposit: nn(t.total_deposit),
          total_deductions: nn(t.total_deductions),
          settlement_net: settlementNet,
          status: t.status,
          posted_refund: agg.total,
          posted_refund_count: agg.count,
          posted_refund_codes: agg.codes,
          refund_done: agg.count > 0,
          refund_drift: settlementNet > 0 ? settlementNet - agg.total : 0,
        };
      });
    },
  });
}

/**
 * TỔNG CỘT của bảng "Hoàn / Bỏ cọc" — **không phải** ô KPI "Đã hoàn cọc".
 *
 * Cộng trên `rows` (đã phân trang đủ, không bị cap-1000). Vì `rows` đi từ
 * `contract_terminations`, `refundTotal` ở đây CHỈ là phần phiếu hoàn nối được
 * hồ sơ thanh lý — nó phải bằng `useRefundForfeitSummary().linkedTotal`, chứ
 * KHÔNG bằng `refundTotal` của server (server còn cộng phiếu mồ côi, xem §1ter.1
 * và JSDoc của `useRefundForfeitSummary`).
 *
 * - `refundTotal/refundCount`: chỉ đếm tiền **đã vào sổ**; hồ sơ chưa có phiếu
 *   không được tính là "đã hoàn".
 * - `forfeitTotal/forfeitCount`: giữ nguyên nghĩa cũ (Σ cọc gốc của hồ sơ bỏ
 *   cọc) — đúng bằng tổng cột "Cọc gốc" lọc theo dòng bỏ cọc của bảng, và đây
 *   VẪN là nguồn của ô KPI "Đã bỏ cọc". Việc cọc bỏ đã thực sự vào doanh thu hay
 *   chưa là phạm vi khác, chưa đổi ở slice này.
 */
export function summarizeRefundForfeit(rows: RefundForfeitRow[]): RefundForfeitSummary {
  let refundTotal = 0;
  let refundCount = 0;
  let forfeitTotal = 0;
  let forfeitCount = 0;
  for (const r of rows) {
    if (r.kind === 'FORFEIT') {
      forfeitTotal += r.total_deposit;
      forfeitCount += 1;
    } else {
      refundTotal += r.posted_refund;
      if (r.refund_done) refundCount += 1;
    }
  }
  return { refundTotal, refundCount, forfeitTotal, forfeitCount };
}
