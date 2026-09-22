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
//
// ── D4 PHẢI GIỮ LẠI HẠNG MỤC NÀO ĐÃ KHỚP ────────────────────────────────────
// Bản trước chỉ lấy `income_expense_id` của D4 rồi vứt hạng mục, nên hàm phân
// loại không còn gì để dựa vào và kết thúc bằng `return 'refund'` trần. Hai
// phiếu THẬT PC2606169 / PC2608091 mang hạng mục HHMG nhưng thiếu
// `commission_kind` vì thế bị xếp vào Hoàn khách và KHÔNG BAO GIỜ được tra căn
// cứ hoa hồng. Giờ D4 đọc cả `income_expense_type_id`, dựng map
// `voucherId → tập loại hạng mục`, rồi `resolveSettlementKind` quyết định.
//
// ── CĂN CỨ SỐ TIỀN ≠ GHI CHÚ TỰ SINH ────────────────────────────────────────
// `get_period_commissions` (căn cứ SỐ TIỀN theo kỳ ký) chạy được cho phiếu
// HHMG thủ công. `get_commission_voucher_facts_v1` (ghi chú chi tiết tự sinh)
// thì KHÔNG — nó đòi `commission_kind` broker/sale. Hook này chỉ gọi cái thứ
// nhất và KHÔNG bịa `commission_kind` để ép cái thứ hai chạy.
// =============================================================================

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/supabaseFetchAll';
import { hydrateIncomeExpenseSupplements } from '@/hooks/income-expenses/supplements';
import {
  resolveSettlementKind, settlementTypeMatches,
  type SettlementKind, type SettlementKindResolution,
} from '@/lib/settlementTypes';
import {
  CAN_CU_HOAN_TRA_KHI_MO_PHIEU,
  detectIssues, settlementStatusOf, supplementPending,
  type BasisState, type PeriodScope, type PostingReadState,
  type SettlementRow, type SettlementRowKind,
} from '@/lib/contractSettlement';

export interface UseContractSettlementArgs {
  organizationId: string | null | undefined;
  buildingIds: string[];
  /** 'YYYY-MM'. Kỳ THAM CHIẾU duy nhất: nhãn OLD_PERIOD và mốc của 'prior'. */
  period: string;
  /**
   * Phạm vi kỳ. Mặc định 'all'.
   *
   * ⚠ Phạm vi CHỈ quyết định bộ lọc NGÀY, không bao giờ quyết định trạng thái.
   * Bản trước ánh xạ "Mọi kỳ" sang một chế độ vừa bỏ lọc ngày vừa CẮT
   * CANCELLED/POSTED ngay trong truy vấn — nên bộ lọc trạng thái của giao diện
   * chạy trên một tập đã bị xén mất hai nhóm, và "Mọi kỳ" không phải mọi kỳ
   * cũng không phải mọi trạng thái.
   */
  scope?: PeriodScope;
  enabled?: boolean;
}

// Từ vựng ba ngả sống ở lớp thuần (`contractSettlement.ts`) vì giao diện phải
// GIẢI THÍCH được nó bằng chữ — xem `lyDoChuaXacMinhNgayChi`.
export type { PostingReadState };

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
  /** Ghi chú gốc — nguồn của khối "Ghi chú gốc của phiếu" trong modal. */
  notes: string | null;
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
  /**
   * ⚠ ĐỌC VỀ NHƯNG KHÔNG DÙNG LÀM NGÀY CHI. Đây là dấu thời gian HỆ THỐNG GHI.
   * Đo thật 22/09/2026 trên 1000 phiếu chi đã ghi sổ có bút toán hiệu lực: 856
   * phiếu cột này NULL, và 20 trong 144 phiếu còn lại LỆCH với `posted_on` (một
   * phiếu lệch hai tháng). Ngày chi lấy ở `docNgayGhiSo`.
   */
  posted_at_v2: string | null;
  /** Bút toán HIỆU LỰC của phiếu. Nguồn duy nhất để tra `posted_on`. */
  active_posting_id_v2: string | null;
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
const nhanBienDong = (kind: SettlementRowKind, origin: 'contract' | 'reservation'): string => {
  // Chưa biết loại thì cũng chưa biết biến động — nói "Ký mới" cho đẹp bảng là
  // bịa một sự kiện chưa hề xác nhận.
  if (kind === 'unknown') return '—';
  if (kind === 'refund') return origin === 'reservation' ? 'Kết thúc giữ chỗ' : 'Thanh lý';
  if (kind === 'bonus') return origin === 'reservation' ? 'Từ giữ chỗ' : 'Ký mới';
  return 'Ký mới';
};

const COT = [
  'id', 'code', 'organization_id', 'building_id', 'room_id', 'contract_id',
  'total_amount', 'voucher_date', 'system_source', 'commission_kind', 'notes',
  'payer_name', 'receive_bank_name', 'receive_bank_account', 'account_id',
  'posting_mode', 'approval_status', 'posting_status',
  'review_state', 'review_reason', 'review_version', 'approval_version',
  'posting_version', 'maker_user_id', 'posted_at_v2', 'active_posting_id_v2',
  'attachments',
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

/**
 * Áp bộ lọc chung cho mọi truy vấn phiếu.
 *
 * ── LUẬT: TRUY VẤN LỌC NGÀY, KHÔNG LỌC TRẠNG THÁI ──────────────────────────
 * Trạng thái là việc của lớp mặt; cắt nó ở đây làm mọi bộ lọc/thẻ số phía trên
 * chạy trên một tập thiếu mà không ai nhìn thấy chỗ thiếu.
 *
 * ── VÌ SAO 'current' KHÔNG KẸP `voucher_date` ──────────────────────────────
 * Kỳ của phiếu ĐÃ CHI xét theo `posted_on` của bút toán — một cột KHÔNG nằm
 * trên bảng này. Kẹp `voucher_date` trước rồi mới đi tìm `posted_on` là đúng
 * cái bẫy đang sửa: phiếu lập tháng 8 mà chi tháng 9 biến mất khỏi kỳ 9. Không
 * có mốc nào an toàn, nên 'current' đọc cả tập rồi lọc bằng hàm thuần ở client.
 *
 * 'prior' thì kẹp được: Tồn Cũ theo định nghĩa chỉ gồm việc CHƯA XONG, mà việc
 * chưa xong luôn xét theo `voucher_date` — nên `lt` là phép THU HẸP đúng nghĩa,
 * không thể bỏ sót dòng nào thuộc phạm vi.
 */
const apDieuKienChung = (
  q: LocBuilder,
  a: { organizationId: string; buildingIds: string[]; scope: PeriodScope; period: string },
) => {
  let r = q
    .eq('organization_id', a.organizationId)
    .eq('type', 'EXPENSE')
    .is('deleted_at', null)
    .in('building_id', a.buildingIds);
  if (a.scope === 'prior') r = r.lt('voucher_date', `${a.period}-01`);
  return r.order('voucher_date', { ascending: false }).order('id', { ascending: true });
};

// ═══════════════════════════════════════════════════════════════════════════
// SEAM NGÀY GHI SỔ — ĐÚNG MỘT CHỖ TRONG CẢ KHU NÀY BIẾT NGÀY CHI TỪ ĐÂU RA
//
// Mọi thứ khác (read model, hàm thuần lọc kỳ, thẻ số, bảng, modal) chỉ thấy
// `SettlementRow.postedOn`. Muốn đổi nguồn — ví dụ sau này có một RPC đọc
// riêng cho người không giữ sổ — thì thay thân hàm này là xong, không đụng
// tới bất cứ chỗ nào khác.
//
// Hôm nay nguồn là RLS BÌNH THƯỜNG: nối `income_expenses.active_posting_id_v2`
// sang `income_expense_postings`. Bảng đó có ĐÚNG MỘT policy SELECT cho
// `authenticated` (`finance_v2_postings_select_custodian`,
// 20260723110000_finance_v2_rls_canary.sql:73-75) đòi route đọc CANONICAL và
// binding CUSTODIAN đang hiệu lực trên ĐÚNG sổ quỹ đó.
//
// Đo thật 22/09/2026 trên org THẬT:
//   chủ công ty (người dùng màn này): 1139 phiếu chi POSTED · 0 dòng bút toán
//   tài khoản hệ thống              : 1139 phiếu chi POSTED · 3324 dòng
//
// Nên hàm này KHÔNG được ném khi đọc rỗng và KHÔNG được đi đường quyền cao hơn.
// Nó trả về trạng thái đọc, còn lớp trên hiện "chưa xác minh" / "Chưa đủ dữ
// liệu". Tuyệt đối không lùi về `posted_at_v2` (xem chú thích của cột đó).
// ═══════════════════════════════════════════════════════════════════════════

interface NgayGhiSo {
  state: PostingReadState;
  /** `voucherId → posted_on`. Thiếu khoá = chưa xác minh được, KHÔNG phải 0. */
  theoPhieu: Map<string, string>;
}

async function docNgayGhiSo(
  organizationId: string,
  list: readonly VoucherRow[],
): Promise<NgayGhiSo> {
  const theoPhieu = new Map<string, string>();
  // Chỉ phiếu ĐÃ GHI SỔ mới có ngày chi. Phiếu hoàn tác/không ghi quỹ/chờ chi
  // xét kỳ theo ngày phiếu và KHÔNG mang nhãn ngày chi.
  const canTra = list.filter((v) => v.posting_status === 'POSTED' && !!v.active_posting_id_v2);
  const ids = [...new Set(canTra.map((v) => v.active_posting_id_v2!))];
  if (ids.length === 0) return { state: true, theoPhieu };

  const dong = await fetchAllRows<{ id: string; posted_on: string | null }>(
    (f, t) => (supabase.from('income_expense_postings')
      .select('id, organization_id, posted_on') as unknown as LocBuilder)
      .eq('organization_id', organizationId)
      .in('id', ids)
      .order('id', { ascending: true })
      .range(f, t) as never,
    { label: 'cs.postings' },
  );
  // ⚠ null = đọc HỎNG. Không ném: mất bút toán chỉ làm ngày chi chưa xác minh,
  // còn ném thì cả bảng khoản chi biến mất vì một thứ phụ.
  if (dong === null) return { state: false, theoPhieu };

  const theoButToan = new Map<string, string>();
  for (const p of dong) if (p.posted_on) theoButToan.set(p.id, p.posted_on);
  for (const v of canTra) {
    const d = theoButToan.get(v.active_posting_id_v2!);
    if (d) theoPhieu.set(v.id, d);
  }
  return { state: theoButToan.size === ids.length ? true : 'partial', theoPhieu };
}

/**
 * Một dòng căn cứ hoa hồng của `get_period_commissions`.
 *
 * ⚠ PHẢI giữ `tierPercent` cạnh `expectedAmount`. RPC tính
 * `ROUND(rent_price * COALESCE(tier.rate, 0) / 100)`, nên TOÀ CHƯA CẤU HÌNH BẬC
 * cũng ra `expected_amount = 0` — không phân biệt được với bậc 0% hợp lệ nếu
 * chỉ nhìn số tiền. Mất phân biệt này là biến "thiếu cấu hình" thành "căn cứ
 * hợp lệ bằng 0đ", tức báo khớp/lệch dựa trên một con số không có thật.
 */
interface CanCuHoaHong {
  expectedAmount: number;
  /** `null` = RPC không trả bậc nào ⇒ toà chưa cấu hình bậc cho hợp đồng này. */
  tierPercent: number | null;
}

/**
 * Số từ PostgREST, giữ được số 0 và phân biệt với "không có".
 * `Number(null)` là 0 — dùng thẳng nó ở đây là xoá mất ca thiếu bậc.
 */
const soHoacNull = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Kết quả một lượt đọc: danh sách phiếu + hạng mục kế toán của từng phiếu. */
interface KetQuaDocPhieu {
  list: VoucherRow[];
  /**
   * `voucherId → các loại hạng mục thuộc khu này` (đã khử trùng).
   * Khoá là UUID phiếu; các phiếu trong `list` đều đã lọc theo
   * `organization_id`, nên tra map này không bao giờ vượt ranh giới công ty.
   */
  itemKinds: Record<string, SettlementKind[]>;
  /** Ngày ghi sổ đọc qua seam `docNgayGhiSo`. */
  postedOn: Map<string, string>;
  postingRead: PostingReadState;
}

export function useContractSettlement(a: UseContractSettlementArgs) {
  const enabled = (a.enabled ?? true) && !!a.organizationId && a.buildingIds.length > 0;
  const scope: PeriodScope = a.scope ?? 'all';
  const typeMap = useSettlementTypeMap(a.organizationId, enabled);

  const vouchers = useQuery({
    queryKey: [
      'contract-settlement', 'vouchers', a.organizationId, scope, a.period,
      [...a.buildingIds].sort(), [...(typeMap.data?.keys() ?? [])].sort(),
    ],
    enabled: enabled && !!typeMap.data,
    queryFn: async (): Promise<KetQuaDocPhieu> => {
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

      // D4 trước: lấy id phiếu có hạng mục thuộc khu này, VÀ GIỮ LẠI hạng mục
      // nào đã khớp — không có nó thì không phân loại được phiếu thủ công.
      const typeIds = [...(typeMap.data?.keys() ?? [])];
      let idsTheoHangMuc: string[] = [];
      const itemKinds: Record<string, SettlementKind[]> = {};
      if (typeIds.length > 0) {
        const items = await fetchAllRows<{
          income_expense_id: string; income_expense_type_id: string | null;
        }>(
          (f, t) => supabase
            .from('income_expense_items')
            .select('income_expense_id, income_expense_type_id')
            // Tiebreaker `id` là bắt buộc để phân trang không sót/trùng ở ranh
            // giới trang: một phiếu nhiều item ⇒ `income_expense_id` KHÔNG duy
            // nhất, sắp một mình nó là thứ tự không ổn định.
            .order('income_expense_id', { ascending: true })
            .order('id', { ascending: true })
            .in('income_expense_type_id', typeIds)
            .range(f, t),
          { label: 'contract-settlement.items' },
        );
        if (items === null) throw new Error('Không đọc được hạng mục của phiếu — thử lại.');
        const gom = new Map<string, Set<SettlementKind>>();
        for (const r of items) {
          // Hạng mục ngoài khu này (typeMap không có) BỎ QUA — nó không đổi
          // loại của phiếu. Bộ lọc `.in(...)` phía server đã chặn, đây là hàng
          // rào thứ hai để map không bao giờ chứa loại lạ.
          const kind = r.income_expense_type_id
            ? typeMap.data?.get(r.income_expense_type_id) : undefined;
          if (!kind) continue;
          const s = gom.get(r.income_expense_id) ?? new Set<SettlementKind>();
          s.add(kind);
          gom.set(r.income_expense_id, s);
        }
        idsTheoHangMuc = [...gom.keys()];
        for (const [id, s] of gom) itemKinds[id] = [...s];
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
      const list = [...theoId.values()];

      const ngay = await docNgayGhiSo(a.organizationId!, list);
      return { list, itemKinds, postedOn: ngay.theoPhieu, postingRead: ngay.state };
    },
  });

  /**
   * Phân loại MỘT LẦN cho cả hook: tập kỳ ký cần tra căn cứ và các dòng hiển
   * thị phải dùng cùng một kết quả, nếu không thì "phiếu ở nhóm Hoa hồng" và
   * "phiếu được tra căn cứ hoa hồng" là hai tập khác nhau.
   */
  const phanLoai = useMemo(() => {
    const m = new Map<string, SettlementKindResolution>();
    const kinds = vouchers.data?.itemKinds ?? {};
    for (const v of vouchers.data?.list ?? []) {
      m.set(v.id, resolveSettlementKind({
        commissionKind: v.commission_kind,
        systemSource: v.system_source,
        itemKinds: kinds[v.id] ?? [],
      }));
    }
    return m;
  }, [vouchers.data]);

  /**
   * Căn cứ hoa hồng — tra theo KỲ CỦA NGÀY KÝ hợp đồng, không phải kỳ phiếu.
   *
   * Tập đầu vào lấy theo KẾT QUẢ PHÂN LOẠI, không theo `commission_kind` thô:
   * phiếu HHMG thủ công cũng phải được tra căn cứ như phiếu có dấu nguồn.
   */
  const kyKyHopDong = useMemo(() => {
    const s = new Set<string>();
    for (const v of vouchers.data?.list ?? []) {
      if (phanLoai.get(v.id)?.kind === 'commission' && v.contracts?.signed_date) {
        s.add(v.contracts.signed_date.slice(0, 7));
      }
    }
    return [...s].sort();
  }, [vouchers.data, phanLoai]);

  const canCuHoaHong = useQuery({
    queryKey: ['contract-settlement', 'commission-basis', kyKyHopDong, [...a.buildingIds].sort()],
    enabled: enabled && kyKyHopDong.length > 0,
    queryFn: async (): Promise<Map<string, CanCuHoaHong>> => {
      // ⚠ `get_period_commissions` lọc theo NGÀY KÝ hợp đồng, còn danh sách lọc
      // theo NGÀY PHIẾU. Hợp đồng ký tháng 8 mà phiếu lập tháng 9 thì gọi kỳ 9
      // không tìm thấy căn cứ. Nên gọi đúng các kỳ có mặt trong tập hợp đồng.
      const m = new Map<string, CanCuHoaHong>();
      for (const ky of kyKyHopDong) {
        const { data, error } = await supabase.rpc('get_period_commissions', {
          p_period_month: ky, p_building_ids: a.buildingIds,
        });
        if (error) throw new Error(error.message);
        const dong = (data ?? []) as {
          contract_id?: string | null;
          expected_amount?: number | string | null;
          tier_percent?: number | string | null;
        }[];
        for (const r of dong) {
          // CHỈ lấy theo HỢP ĐỒNG. `voucher_id`/`status` của reader này là một
          // phiếu nào đó cùng hợp đồng nó tự chọn (ORDER BY … LIMIT 1) —
          // KHÔNG được dùng thay UUID/trạng thái của phiếu đang xem.
          if (r.contract_id) {
            m.set(r.contract_id, {
              expectedAmount: Number(r.expected_amount) || 0,
              tierPercent: soHoacNull(r.tier_percent),
            });
          }
        }
      }
      return m;
    },
  });

  /** Ghi chú bổ sung — chỉ phiếu CHỜ DUYỆT mới cần biết có treo yêu cầu không. */
  const idsChoDuyet = useMemo(
    () => (vouchers.data?.list ?? []).filter((v) => v.approval_status === 'UNAPPROVED').map((v) => v.id),
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
    const vs = vouchers.data?.list;
    if (!vs) return [];
    const treo = ghiChu.data;
    const basisHH = canCuHoaHong.data;
    const ngayGhiSo = vouchers.data?.postedOn ?? new Map<string, string>();

    const basisOf = (v: VoucherRow, kind: SettlementRowKind): BasisState => {
      if (kind === 'unknown') {
        // Chưa biết loại thì chưa biết phải đối chiếu với công thức nào. Nói
        // "không áp dụng" là kết luận sớm; để 'not-found' (cảnh báo, không chặn).
        return { kind: 'not-found', reason: 'Chưa xác định loại nên chưa tra được căn cứ' };
      }
      if (kind === 'bonus') return { kind: 'not-applicable' };
      if (kind === 'refund') {
        // Số phải hoàn THẬT do `preview_termination_refund_v1` tính (đối chiếu
        // cọc thực thu). RPC đó đắt nên chỉ gọi khi mở modal — ở danh sách để
        // 'not-found', và 'not-found' KHÔNG chặn làn.
        return { kind: 'not-found', reason: CAN_CU_HOAN_TRA_KHI_MO_PHIEU };
      }
      // commission
      // ⚠ PHẢI xét lỗi TRƯỚC `!basisHH`: query lỗi thì `data` cũng undefined,
      // đảo lại là biến "không ai biết số đúng" thành cảnh báo xám "Đang tra
      // căn cứ" rồi thả phiếu về làn chờ duyệt. Có ca ghim thứ tự này.
      if (canCuHoaHong.isError) {
        return { kind: 'unavailable', reason: 'Không đọc được bậc hoa hồng' };
      }
      if (!basisHH) return { kind: 'not-found', reason: 'Đang tra căn cứ' };
      if (!v.contract_id) return { kind: 'not-found', reason: 'Phiếu chưa gắn hợp đồng' };
      const canCu = basisHH.get(v.contract_id);
      if (!canCu) {
        return { kind: 'not-found', reason: 'Không tìm thấy hợp đồng trong kỳ ký' };
      }
      if (canCu.tierPercent === null) {
        // RPC trả 0đ vì không khớp bậc nào (COALESCE(rate, 0)). Đó là THIẾU
        // CẤU HÌNH, không phải căn cứ — đem 0đ đi so là báo lệch/khớp giả.
        return {
          kind: 'not-found',
          reason: 'Toà chưa cấu hình bậc hoa hồng cho hợp đồng này',
        };
      }
      const amount = Number(v.total_amount) || 0;
      return canCu.expectedAmount === amount
        ? { kind: 'matched', amount: canCu.expectedAmount }
        : { kind: 'mismatch', amount: canCu.expectedAmount };
    };

    return vs.map((v) => {
      const pl = phanLoai.get(v.id);
      const kind: SettlementRowKind = pl?.kind ?? 'unknown';
      const base: Omit<SettlementRow, 'issues'> = {
        key: `${kind}:${v.id}`,
        kind,
        kindSource: pl?.signal ?? 'none',
        kindConflict: pl?.conflict ?? false,
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
        // Ba cột THÔ cho khối ghi chú/căn cứ của modal. Chép nguyên, KHÔNG suy
        // ra từ `kind`: phiếu HHMG tạo tay phải giữ `commissionKind === null`
        // thì `SettlementVoucherDetails` mới biết là không được gọi RPC ghi chú
        // tự sinh (nó đòi broker/sale) và phải nói thẳng ra điều đó.
        notes: v.notes ?? null,
        systemSource: v.system_source ?? null,
        commissionKind: v.commission_kind ?? null,
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
        // Ngày chi NGHIỆP VỤ, đọc qua seam `docNgayGhiSo`. Thiếu khoá ⇒ null ⇒
        // "ngày chi chưa xác minh". KHÔNG lùi về `posted_at_v2`.
        postedOn: v.posting_status === 'POSTED' ? (ngayGhiSo.get(v.id) ?? null) : null,
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
  }, [vouchers.data, phanLoai, ghiChu.data, canCuHoaHong.data, canCuHoaHong.isError, a.period]);

  return {
    rows,
    /**
     * Đọc bút toán tới đâu. `'partial'`/`false` KHÔNG phải lỗi của cả bảng —
     * chỉ những con số DỰA VÀO ngày chi mới phải nói "Chưa đủ dữ liệu".
     */
    postingRead: vouchers.data?.postingRead ?? true,
    isLoading:
      typeMap.isLoading || vouchers.isLoading ||
      (idsChoDuyet.length > 0 && ghiChu.isLoading) ||
      (kyKyHopDong.length > 0 && canCuHoaHong.isLoading),
    isError: typeMap.isError || vouchers.isError || ghiChu.isError,
    error: typeMap.error ?? vouchers.error ?? ghiChu.error ?? null,
    refetch: vouchers.refetch,
  };
}
