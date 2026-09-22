// =============================================================================
// contractLifecycle.ts — TOÁN THUẦN của dải "Vòng đời hợp đồng của phòng".
//
// KHÔNG I/O, KHÔNG `Date.now()`. Cùng luật với `contractSettlement.ts`: mọi thứ
// ở đây phải kiểm được bằng unit test, và "hôm nay" luôn là tham số truyền vào
// (`businessDate`) chứ không bao giờ là đồng hồ máy.
//
// ── VÌ SAO CÓ FILE NÀY: BA SỐ CỌC BỊ GỘP LÀM MỘT ────────────────────────────
// Bản cũ đọc `contracts.deposit_paid` rồi gọi nó là "Cọc đã đóng · thực thu",
// và tính "còn thiếu = total_deposit − deposit_paid".
//
// `deposit_paid` KHÔNG phải số tiền khách từng đưa. Định nghĩa sống của nó
// (`contract_deposit_paid_derived`) là TỔNG RÒNG các item DEPOSIT trên phiếu đã
// duyệt: phiếu thu cộng, phiếu chi trừ. Ca thật 401/32PVC (hợp đồng
// HĐT-046775/28102024): khách nộp 4.500.000 bằng phiếu thu PT2607068, nội bộ
// cấn 1.424.000, nên `deposit_paid` còn 3.076.000 — và màn hình tuyên bố
// "còn thiếu 1.424.000đ" về một người đã nộp đủ. Duyệt nốt phiếu hoàn
// 3.076.000 thì con số lại tụt tiếp.
//
// Nên ở đây BA SỐ LÀ BA SỐ, không bao giờ gộp:
//   grossCollected — tiền cọc khách TỪNG NỘP, kèm mã phiếu thu + ngày thu
//   netHeld        — cọc CÒN GIỮ (gross trừ các lần chi/cấn ra khỏi cọc)
//   settlementDeposit — số cọc CHỐT trong bản ghi thanh lý, một snapshot riêng
//
// ── NGUỒN ───────────────────────────────────────────────────────────────────
// Luật phân loại nguồn cọc chép từ `app_private.contract_deposit_sources_v1`
// (`supabase/migrations/20260908051659_invoice_deposit_classification.sql`,
// dòng 383–450). Hàm đó ở schema `app_private`, frontend KHÔNG gọi được — nên
// phải chép luật, và `src/lib/__tests__/contractLifecycle.test.ts` là chỗ khoá
// luật lại. Sửa SQL thì phải sửa cả hai.
//
// Thứ tự cư trú lấy từ projection `get_room_residence_segments_v1`, KHÔNG suy
// từ `contracts.room_id`, ngày ký hay `parent_contract_id` (Plan §3.2).
// =============================================================================

import { fmtMoney, fmtNgay } from '@/lib/contractSettlement';

// ═══════════════════════════════════════════════════════════════════════════
// 0. Hàng thô — đúng hình dạng dòng DB, để hook chỉ việc chuyền qua
// ═══════════════════════════════════════════════════════════════════════════

/** Một dòng của `get_room_residence_segments_v1`. */
export interface ResidenceSegmentRow {
  contract_id: string;
  contract_number: string | null;
  seg_index: number;
  room_id: string | null;
  room_name: string | null;
  from_date: string | null;
  to_date: string | null;
  source_path: string | null;
  transfer_id: string | null;
  trusted: boolean;
  diagnostic: string | null;
}

/** Khách trong embed `contract_customers ( customers ( full_name ) )`. */
export interface ContractCustomerRow {
  customers: { full_name: string | null } | null;
}

export interface LifecycleContractRow {
  id: string;
  organization_id: string | null;
  contract_number: string | null;
  room_id: string | null;
  status: string | null;
  signed_date: string | null;
  start_date: string | null;
  end_date: string | null;
  actual_end_date: string | null;
  total_deposit: number | null;
  rent_price: number | null;
  /** Đã phẳng sẵn (test), hoặc để trống và dùng `contract_customers`. */
  customer_name?: string | null;
  contract_customers?: ContractCustomerRow[] | null;
}

export interface TerminationRow {
  id: string;
  contract_id: string;
  organization_id: string | null;
  termination_date: string | null;
  termination_type: string | null;
  refund_amount: number | null;
  outstanding_debt: number | null;
  /** Cọc CHỐT tại quyết toán — snapshot riêng, không phải gross, không phải ròng. */
  total_deposit: number | null;
}

export interface DepositVoucherRow {
  id: string;
  code: string | null;
  organization_id: string | null;
  /** 'INCOME' | 'EXPENSE' — giữ thô như DB. */
  type: string | null;
  approval_status: string | null;
  posting_status: string | null;
  posting_mode: string | null;
  deleted_at: string | null;
  reversal_of_income_expense_id: string | null;
  account_id: string | null;
  system_source: string | null;
  voucher_date: string | null;
  created_at: string | null;
}

export interface DepositItemRow {
  id: string;
  income_expense_id: string;
  organization_id: string | null;
  accounting_class: string;
  amount: number | null;
  unit_price: number | null;
  quantity: number | null;
}

export interface PostingRow {
  id: string;
  organization_id: string | null;
  posting_subject_kind: string | null;
  posting_subject_id: string | null;
  event_kind: string | null;
  posting_generation: number | null;
  reversal_of_id: string | null;
  source_kind: string | null;
  legacy_provenance: unknown;
  account_id: string | null;
}

export interface InvoiceRow {
  id: string;
  contract_id: string | null;
  organization_id: string | null;
  status: string | null;
  deleted_at: string | null;
  paid_amount: number | null;
  total_amount: number | null;
  remaining_amount: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Chữ hiển thị — TRÍCH NGUYÊN VĂN từ mẫu thiết kế
//    (`mau thiet ke hopdong va quyet toan/…dc.html` dòng 346–396, 601–628)
// ═══════════════════════════════════════════════════════════════════════════

export const LANE_ROLE = {
  refund: 'Hợp đồng của phiếu hoàn',
  bonus: 'Hợp đồng phát sinh thưởng',
  commission: 'Hợp đồng tính hoa hồng',
  movement: 'Hợp đồng của biến động',
  before: 'Hợp đồng liền trước',
  after: 'Hợp đồng kế tiếp',
  /**
   * NGOÀI mẫu, và cố ý. `SettlementRow.kind` có giá trị 'unknown' (phiếu thủ
   * công chưa nhận được loại). Mẫu không có ca này nên nhánh cuối của nó rơi
   * vào 'Hợp đồng tính hoa hồng'; bê nguyên là đi gán bừa một loại cho phiếu
   * mà chính hệ thống đang nói "chưa biết". Chữ trung tính, đúng sự thật.
   */
  unknown: 'Hợp đồng của phiếu',
} as const;

export const LANE_TAG = {
  terminated: 'Đã thanh lý',
  current: 'HĐ hiện tại',
  renting: 'Đang thuê',
} as const;

/** Chữ dùng ở MỌI chỗ chưa chứng minh được. Không bao giờ thay bằng "0 đ". */
export const CHUA_DU_DU_LIEU = 'Chưa đủ dữ liệu';

/**
 * Mốc ngày NGHIỆP VỤ của hồ sơ đang mở: ngày phiếu hoặc ngày biến động.
 *
 * `homNay` là THAM SỐ BẮT BUỘC, cố ý không có mặc định. Mặc định duy nhất hợp
 * lý là "hôm nay", mà `new Date().toISOString()` là giờ UTC — trước 07:00 giờ
 * Việt Nam nó trả về HÔM QUA. Bắt caller truyền vào buộc họ đi qua
 * `vnTodayISO()`, và giữ file này thuần (không đọc đồng hồ).
 */
export function mocNgayNghiepVu(raw: string | null | undefined, homNay: string): string {
  return (raw ?? '').slice(0, 10) || homNay;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Nguồn cọc — phản chiếu app_private.contract_deposit_sources_v1
// ═══════════════════════════════════════════════════════════════════════════

export type DepositBucket = 'REAL_CASH' | 'RECOGNIZED_HISTORICAL' | 'EXCLUDED';

/** Phiếu này gắn với hợp đồng bằng đường nào. 'both' = trùng, chỉ tính MỘT LẦN. */
export type DepositReachVia = 'direct' | 'link' | 'both';

export interface DepositReach {
  contractId: string;
  voucherId: string;
  via: 'direct' | 'link';
}

export interface DepositSource {
  voucherId: string;
  code: string | null;
  direction: 'IN' | 'OUT';
  bucket: DepositBucket;
  excludeReason: string | null;
  /** Tổng các item DEPOSIT của phiếu. KHÔNG BAO GIỜ là `total_amount`. */
  amount: number;
  /** 0 khi bị loại; +amount cho phiếu thu; −amount cho phiếu chi. */
  signedAmount: number;
  accountId: string | null;
  isVirtual: boolean;
  systemSource: string | null;
  voucherDate: string | null;
  createdAt: string | null;
  reach: DepositReachVia;
}

export interface DepositSourceInput {
  organizationId: string;
  reaches: readonly DepositReach[];
  vouchers: readonly DepositVoucherRow[];
  items: readonly DepositItemRow[];
  virtualAccountIds: readonly string[];
}

/** `coalesce(it.amount, it.unit_price*it.quantity)` — y hệt SQL. */
export function depositItemAmount(it: DepositItemRow): number {
  if (it.amount !== null && it.amount !== undefined) return Number(it.amount) || 0;
  return (Number(it.unit_price) || 0) * (Number(it.quantity) || 0);
}

/**
 * Dựng danh sách nguồn cọc cho TỪNG hợp đồng.
 *
 * Bốn luật, chép từ SQL:
 *   1. CHỈ item `accounting_class='DEPOSIT'`. Phiếu hỗn hợp chỉ góp phần cọc.
 *   2. Phiếu không có item DEPOSIT nào thì KHÔNG phải nguồn cọc (SQL dùng
 *      `JOIN LATERAL … ON deposit_items.amount IS NOT NULL`).
 *   3. UNION direct + link ⇒ một phiếu tới được bằng hai đường vẫn tính MỘT lần.
 *   4. Loại xoá/huỷ/chưa duyệt/đảo; sổ ảo là GHI NHẬN LỊCH SỬ, không phải tiền thật.
 *
 * Thứ tự trả về ỔN ĐỊNH theo `(created_at, id)` — cùng ORDER BY của SQL, để hai
 * lần gọi cho cùng một danh sách.
 */
export function buildDepositSources(input: DepositSourceInput): Map<string, DepositSource[]> {
  const org = input.organizationId;
  const ao = new Set(input.virtualAccountIds);

  // Ranh giới công ty là hàng rào ĐẦU TIÊN, trước mọi phép cộng.
  const phieu = new Map<string, DepositVoucherRow>();
  for (const v of input.vouchers) {
    if (v.organization_id !== org) continue;
    phieu.set(v.id, v);
  }

  const cocTheoPhieu = new Map<string, number>();
  for (const it of input.items) {
    if (it.organization_id !== org) continue;
    if (it.accounting_class !== 'DEPOSIT') continue;
    if (!phieu.has(it.income_expense_id)) continue;
    cocTheoPhieu.set(
      it.income_expense_id,
      (cocTheoPhieu.get(it.income_expense_id) ?? 0) + depositItemAmount(it),
    );
  }

  /** contractId → voucherId → đường tới. Set để khử trùng direct+link. */
  const duong = new Map<string, Map<string, Set<'direct' | 'link'>>>();
  for (const r of input.reaches) {
    if (!phieu.has(r.voucherId)) continue;
    if (!cocTheoPhieu.has(r.voucherId)) continue; // không có item DEPOSIT
    const m = duong.get(r.contractId) ?? new Map<string, Set<'direct' | 'link'>>();
    const s = m.get(r.voucherId) ?? new Set<'direct' | 'link'>();
    s.add(r.via);
    m.set(r.voucherId, s);
    duong.set(r.contractId, m);
  }

  const out = new Map<string, DepositSource[]>();
  for (const [contractId, m] of duong) {
    const ds: DepositSource[] = [];
    for (const [voucherId, vias] of m) {
      const v = phieu.get(voucherId)!;
      const amount = cocTheoPhieu.get(voucherId) ?? 0;
      const isVirtual = !!v.account_id && ao.has(v.account_id);
      const { bucket, excludeReason } = phanLoaiNguonCoc(v, isVirtual);
      const direction: 'IN' | 'OUT' = v.type === 'INCOME' ? 'IN' : 'OUT';
      ds.push({
        voucherId,
        code: v.code,
        direction,
        bucket,
        excludeReason,
        amount,
        signedAmount: bucket === 'EXCLUDED' ? 0 : direction === 'IN' ? amount : -amount,
        accountId: v.account_id,
        isVirtual,
        systemSource: v.system_source,
        voucherDate: v.voucher_date,
        createdAt: v.created_at,
        reach: vias.size > 1 ? 'both' : [...vias][0],
      });
    }
    ds.sort((a, b) =>
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.voucherId.localeCompare(b.voucherId));
    out.set(contractId, ds);
  }
  return out;
}

/**
 * Thứ tự các nhánh dưới đây LÀ THỨ TỰ CỦA SQL, đừng sắp lại: một phiếu có thể
 * dính nhiều điều kiện cùng lúc và lý do hiện ra phải trùng với thứ DB nói.
 */
function phanLoaiNguonCoc(
  v: DepositVoucherRow,
  isVirtual: boolean,
): { bucket: DepositBucket; excludeReason: string | null } {
  if (v.deleted_at) return { bucket: 'EXCLUDED', excludeReason: 'đã xoá' };
  if (v.approval_status === 'CANCELLED') return { bucket: 'EXCLUDED', excludeReason: 'đã huỷ' };
  if (v.approval_status !== 'APPROVED') return { bucket: 'EXCLUDED', excludeReason: 'chưa duyệt' };
  if (v.reversal_of_income_expense_id) {
    return { bucket: 'EXCLUDED', excludeReason: 'phiếu đảo bút toán' };
  }
  if (v.posting_status === 'REVERSED') {
    return { bucket: 'EXCLUDED', excludeReason: 'đã đảo bút toán' };
  }
  if (isVirtual) return { bucket: 'RECOGNIZED_HISTORICAL', excludeReason: null };
  if (v.posting_status === 'POSTED') return { bucket: 'REAL_CASH', excludeReason: null };
  return { bucket: 'EXCLUDED', excludeReason: 'chưa ghi sổ' };
}

// ── Ba con số + chứng cứ ───────────────────────────────────────────────────

export interface DepositEvidence {
  voucherId: string;
  code: string | null;
  date: string | null;
  amount: number;
  direction: 'IN' | 'OUT';
  bucket: DepositBucket;
  verification: PostingVerification;
}

export interface DepositFigures {
  /** Tiền cọc khách TỪNG NỘP (tiền thật). Không bao giờ tụt khi cấn hay hoàn. */
  grossCollected: number;
  /** Tiền đã chi/cấn RA khỏi cọc (tiền thật). */
  offsetOut: number;
  /** Cọc CÒN GIỮ = gross − offsetOut. */
  netHeld: number;
  /** Ghi nhận lịch sử trên sổ ảo — TÁCH HẲN khỏi ba số trên. */
  historicalIn: number;
  historicalOut: number;
  historicalNet: number;
  /** Chứng từ nguồn: mã phiếu + ngày, để mốc cọc chứng minh được. */
  evidence: DepositEvidence[];
  /** Nguồn bị loại, kèm lý do — để nói được vì sao không cộng. */
  excluded: DepositSource[];
  /** Có khoản tiền thật chưa đối chiếu được bút toán. */
  hasUnverified: boolean;
}

export function summariseDeposit(
  sources: readonly DepositSource[],
  verifications: ReadonlyMap<string, { verification: PostingVerification; reason: string | null }>,
): DepositFigures {
  let grossCollected = 0, offsetOut = 0, historicalIn = 0, historicalOut = 0;
  let hasUnverified = false;
  const evidence: DepositEvidence[] = [];
  const excluded: DepositSource[] = [];

  for (const s of sources) {
    if (s.bucket === 'EXCLUDED') { excluded.push(s); continue; }
    const xacMinh = s.bucket === 'RECOGNIZED_HISTORICAL'
      ? 'not-applicable' as const
      : verifications.get(s.voucherId)?.verification ?? 'unverified';
    if (s.bucket === 'REAL_CASH') {
      if (s.direction === 'IN') grossCollected += s.amount; else offsetOut += s.amount;
      if (xacMinh !== 'verified') hasUnverified = true;
    } else {
      if (s.direction === 'IN') historicalIn += s.amount; else historicalOut += s.amount;
    }
    evidence.push({
      voucherId: s.voucherId, code: s.code, date: s.voucherDate,
      amount: s.amount, direction: s.direction, bucket: s.bucket, verification: xacMinh,
    });
  }

  return {
    grossCollected, offsetOut, netHeld: grossCollected - offsetOut,
    historicalIn, historicalOut, historicalNet: historicalIn - historicalOut,
    evidence, excluded, hasUnverified,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Đối chiếu POSTED với bút toán hiệu lực
//
// ⚠ ĐA SỐ NGƯỜI DÙNG KHÔNG ĐỌC ĐƯỢC BẢNG BÚT TOÁN. `income_expense_postings`
// chỉ có đúng một policy SELECT cho `authenticated`
// (`finance_v2_postings_select_custodian`, 20260723110000_finance_v2_rls_canary.sql)
// và nó đòi binding CUSTODIAN trên đúng sổ quỹ đó. Đo thật trên org THẬT hôm
// nay: tài khoản chủ công ty thấy 1139 phiếu chi đã ghi sổ nhưng 0 dòng posting.
//
// Nên "không đọc được bút toán" là một TRẠNG THÁI, không phải số 0: ghi
// CHƯA XÁC MINH, giữ nguyên trạng thái của chính phiếu, và tuyệt đối không đi
// tìm đường quyền cao hơn để bù.
// ═══════════════════════════════════════════════════════════════════════════

export type PostingVerification = 'verified' | 'unverified' | 'reversed' | 'not-applicable';

export interface PostingReadState { readable: boolean; reason?: string }

export interface PostingSubject {
  id: string;
  postingStatus: string | null;
  postingMode: string | null;
  /** Phiếu thuộc dải dữ liệu trước Finance v2 — thiếu bút toán là bình thường. */
  legacy?: boolean;
}

export function reconcilePostings(
  subjects: readonly PostingSubject[],
  postings: readonly PostingRow[],
  read: PostingReadState,
): Map<string, { verification: PostingVerification; reason: string | null }> {
  const out = new Map<string, { verification: PostingVerification; reason: string | null }>();

  // Bút toán bị đảo khi có dòng khác trỏ `reversal_of_id` về nó — đúng vị ngữ
  // mà writer dùng (20260723080000_finance_v2_delta_catchup.sql:351-358).
  const daDao = new Set(
    postings.map((p) => p.reversal_of_id).filter((x): x is string => !!x),
  );
  const theoPhieu = new Map<string, PostingRow[]>();
  for (const p of postings) {
    if (p.posting_subject_kind !== 'VOUCHER' || !p.posting_subject_id) continue;
    const ds = theoPhieu.get(p.posting_subject_id) ?? [];
    ds.push(p);
    theoPhieu.set(p.posting_subject_id, ds);
  }

  for (const s of subjects) {
    if (s.postingMode === 'NON_CASH' || s.postingStatus === 'NOT_APPLICABLE') {
      out.set(s.id, { verification: 'not-applicable', reason: null });
      continue;
    }
    if (!read.readable) {
      out.set(s.id, {
        verification: 'unverified',
        reason: read.reason ?? 'Không đủ quyền đọc bút toán để đối chiếu',
      });
      continue;
    }
    const ds = (theoPhieu.get(s.id) ?? []).filter((p) => p.event_kind === 'POSTING');
    const conHieuLuc = ds.filter((p) => !daDao.has(p.id));
    if (conHieuLuc.length > 0) {
      out.set(s.id, { verification: 'verified', reason: null });
      continue;
    }
    if (ds.length > 0) {
      out.set(s.id, { verification: 'reversed', reason: 'Bút toán đã bị đảo' });
      continue;
    }
    // Đọc được bảng mà không thấy dòng nào: có thể do RLS chỉ cho thấy sổ mình
    // giữ, có thể do đây là dữ liệu lịch sử chưa có bút toán kiểu mới. Cả hai
    // đều KHÔNG cho phép kết luận "đã là tiền thật".
    out.set(s.id, {
      verification: 'unverified',
      reason: s.legacy
        ? 'Dữ liệu lịch sử (legacy) chưa có bút toán hiệu lực để đối chiếu'
        : 'Không thấy bút toán hiệu lực — có thể do không đủ quyền đọc sổ quỹ',
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Đóng đoạn cư trú
//
// Chép hình dạng của lớp adapter đang chạy trong `get_room_cash_lifecycle_v1`
// (20260920194951_shared_room_lifecycle_rls.sql, CTE `seg_raw`/`seg`).
// ═══════════════════════════════════════════════════════════════════════════

export interface ClosedSegment {
  contractId: string;
  contractNumber: string | null;
  segIndex: number;
  roomId: string | null;
  roomName: string | null;
  fromDate: string | null;
  toDate: string | null;
  sourcePath: string | null;
  transferId: string | null;
  trusted: boolean;
  diagnostic: string | null;
}

const KET_THUC: ReadonlySet<string> = new Set(['TERMINATED', 'EXPIRED']);

/**
 * BIÊN KIỂM TRA cho kết quả `get_room_residence_segments_v1`.
 *
 * `supabase.rpc` trả `data: Json` — ép thẳng sang kiểu mong muốn là tự nhận
 * một lời hứa chưa ai kiểm. Ở màn tiền thì cái giá của lời hứa sai là một dòng
 * rác lọt vào chuỗi cư trú rồi đổi cả thứ tự lane.
 *
 * FAIL-CLOSED hai chỗ: dòng sai hình dạng bị LOẠI và ĐẾM (caller phải báo
 * thiếu dữ liệu, không im lặng), và `trusted` chỉ đúng khi DB nói đúng `true` —
 * giá trị lạ đọc thành KHÔNG tin cậy chứ không thành tin cậy.
 */
export interface SegmentParse { rows: ResidenceSegmentRow[]; rejected: number }

const chuoiHoacNull = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

export function parseResidenceSegments(raw: unknown): SegmentParse {
  if (!Array.isArray(raw)) return { rows: [], rejected: 0 };
  const rows: ResidenceSegmentRow[] = [];
  let rejected = 0;
  for (const r of raw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { rejected += 1; continue; }
    const o = r as Record<string, unknown>;
    const contractId = chuoiHoacNull(o.contract_id);
    const segIndex = Number(o.seg_index);
    if (!contractId || !Number.isFinite(segIndex)) { rejected += 1; continue; }
    rows.push({
      contract_id: contractId,
      contract_number: chuoiHoacNull(o.contract_number),
      seg_index: segIndex,
      room_id: chuoiHoacNull(o.room_id),
      room_name: chuoiHoacNull(o.room_name),
      from_date: chuoiHoacNull(o.from_date),
      to_date: chuoiHoacNull(o.to_date),
      source_path: chuoiHoacNull(o.source_path),
      transfer_id: chuoiHoacNull(o.transfer_id),
      trusted: o.trusted === true,
      diagnostic: chuoiHoacNull(o.diagnostic),
    });
  }
  return { rows, rejected };
}

/**
 * @param todayISO HÔM NAY, KHÔNG phải mốc nghiệp vụ của hồ sơ đang mở. Một
 * đoạn "kết thúc ở tương lai" là bất thường so với hôm nay; so với ngày của
 * một phiếu cũ thì MỌI đoạn đóng sau ngày đó đều thành "tương lai" và cả dải
 * bị bôi là không tin cậy trên dữ liệu hoàn toàn sạch.
 */
export function closeResidenceSegments(
  segments: readonly ResidenceSegmentRow[],
  contracts: readonly LifecycleContractRow[],
  todayISO: string,
): ClosedSegment[] {
  const hd = new Map(contracts.map((c) => [c.id, c]));
  return segments.map((s) => {
    const c = hd.get(s.contract_id);
    // `to_date` rỗng nghĩa là "không có mốc chuyển đi" — hợp đồng đã kết thúc
    // thì đóng tại ngày kết thúc thật. KHÔNG bịa ngày cho hợp đồng còn hiệu lực.
    const dong = s.to_date
      ?? c?.actual_end_date
      ?? (c && KET_THUC.has((c.status ?? '').toUpperCase()) ? c.end_date : null)
      ?? null;

    const truocNgayMo = !!s.from_date && !!dong && dong < s.from_date;
    const tuongLai = !!dong && dong > todayISO;

    return {
      contractId: s.contract_id,
      contractNumber: s.contract_number,
      segIndex: s.seg_index,
      roomId: s.room_id,
      roomName: s.room_name,
      fromDate: s.from_date,
      // Kẹp về ngày mở như SQL: đoạn 0 ngày, kèm cờ, chứ không âm thầm nhận.
      toDate: truocNgayMo ? s.from_date : dong,
      sourcePath: s.source_path,
      transferId: s.transfer_id,
      trusted: s.trusted && !truocNgayMo && !tuongLai,
      diagnostic: truocNgayMo
        ? 'SEGMENT_END_BEFORE_START'
        : tuongLai
          ? 'SEGMENT_END_IN_FUTURE'
          : s.diagnostic,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Tiền thuê / phí và nợ theo hoá đơn hiệu lực
// ═══════════════════════════════════════════════════════════════════════════

export interface InvoiceTotals { paid: number; debt: number }

const KHONG_HIEU_LUC: ReadonlySet<string> = new Set(['CANCELLED', 'DRAFT']);

/**
 * Hoá đơn KHÔNG chứa cọc (bảng `invoice_items` chỉ có RENT/SERVICE/PENALTY/
 * DISCOUNT/OTHER — không có loại DEPOSIT), nên mốc "Tiền thuê / phí đã đóng"
 * lấy từ đây là đã loại cọc theo cấu trúc chứ không nhờ lọc chuỗi.
 */
export function sumEffectiveInvoices(
  invoices: readonly InvoiceRow[],
  organizationId: string,
): Map<string, InvoiceTotals> {
  const out = new Map<string, InvoiceTotals>();
  for (const i of invoices) {
    if (i.organization_id !== organizationId) continue;
    if (i.deleted_at) continue;
    // Loại CANCELLED **và** DRAFT, y như projection anh em mà lớp đóng đoạn
    // của file này chép theo (20260920194951_shared_room_lifecycle_rls.sql:283).
    // Hoá đơn nháp của kỳ sau chưa phải nghĩa vụ: tính nó vào nợ là bịa ra một
    // khoản nợ cho hợp đồng không nợ đồng nào.
    if (KHONG_HIEU_LUC.has((i.status ?? '').toUpperCase())) continue;
    if (!i.contract_id) continue;
    const t = out.get(i.contract_id) ?? { paid: 0, debt: 0 };
    const paid = Number(i.paid_amount) || 0;
    const conLai = i.remaining_amount !== null && i.remaining_amount !== undefined
      ? Number(i.remaining_amount) || 0
      : (Number(i.total_amount) || 0) - paid;
    t.paid += paid;
    t.debt += conLai;
    out.set(i.contract_id, t);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Dựng lane
// ═══════════════════════════════════════════════════════════════════════════

export type LaneVoucherKind = 'refund' | 'commission' | 'bonus' | 'unknown';
export type LaneSubject =
  | { kind: 'voucher'; voucherKind: LaneVoucherKind }
  | { kind: 'movement' };

/**
 * Trạng thái đọc MỘT nguồn.
 *
 * ⚠ Nhánh `ok: true` khai `reason?: undefined` là CỐ Ý. Project bật
 * `strict: false` (xem tsconfig.app.json) nên `strictNullChecks` tắt, và khi
 * tắt thì TS KHÔNG thu hẹp union phân biệt bằng discriminant boolean — mọi
 * `r.ok ? … : r.reason` đều báo "Property 'reason' does not exist". Khai
 * `reason` ở cả hai nhánh làm thuộc tính luôn đọc được, mà vẫn CẤM truyền lý
 * do kèm trạng thái thành công (kiểu `undefined`).
 */
export type ReadState =
  | { ok: true; reason?: undefined }
  /**
   * Đọc KHÔNG lỗi nhưng THIẾU: biết chắc còn nguồn chưa nhìn thấy (vd
   * `contract_deposit_links` trỏ tới phiếu mà RLS của `income_expenses` giấu —
   * hai vị ngữ không tương đương). Khác `false` ở chỗ số đã đọc vẫn dùng được;
   * khác `true` ở chỗ KHÔNG được kết luận là đủ.
   */
  | { ok: 'partial'; reason: string }
  | { ok: false; reason: string };

export interface LifecycleReads {
  contracts: ReadState;
  segments: ReadState;
  transfers: ReadState;
  deposits: ReadState;
  invoices: ReadState;
  postings: ReadState;
}

/** Lý do đọc hỏng, hoặc `null` khi đọc được. Tránh phụ thuộc narrowing lồng. */
export const lyDoHong = (r: ReadState): string | null =>
  (r.ok === true ? null : r.reason ?? null);

/**
 * Trạng thái của một phần, suy từ trạng thái đọc nguồn.
 * `false` ⇒ lỗi; `'partial'` ⇒ thiếu dữ liệu (số đã có vẫn hiện); `true` ⇒ null
 * để caller xét tiếp các điều kiện riêng của phần đó.
 */
export const tuReadState = (r: ReadState): SectionStatus | null => {
  const ly = lyDoHong(r);
  if (ly === null) return null;
  return r.ok === false ? { kind: 'error', reason: ly } : { kind: 'insufficient', reason: ly };
};

export type SectionStatus =
  | { kind: 'sufficient' }
  | { kind: 'insufficient'; reason: string }
  | { kind: 'error'; reason: string };

export interface LaneStep {
  h: string;
  v: string;
  m: string;
  m2?: string;
  m2c?: string;
}

export interface Lane {
  contractId: string;
  contractNumber: string | null;
  customer: string;
  role: string;
  tag: string;
  target: boolean;
  steps: LaneStep[];
  /** Ba số cọc + chứng cứ. `null` = chưa chứng minh được, KHÁC HẲN số 0. */
  deposit: DepositFigures | null;
  /** Cọc chốt tại quyết toán — snapshot riêng. */
  settlementDeposit: number | null;
  terminatedAt: string | null;
  /** Nhịp cư trú TRÊN PHÒNG NÀY (đã đóng), không phải kỳ hạn hợp đồng. */
  segment: { fromDate: string | null; toDate: string | null } | null;
  trusted: boolean;
  diagnostics: string[];
}

export interface RoomState {
  kind: 'occupied' | 'vacant' | 'insufficient';
  contractId: string | null;
  contractNumber: string | null;
  customer: string | null;
  label: string;
}

export interface LifecycleStatus {
  lanes: SectionStatus;
  deposit: SectionStatus;
  rent: SectionStatus;
  postings: SectionStatus;
}

export interface LifecycleView {
  /** Mốc ngày nghiệp vụ đã dựng dải này — để caller gắn nhãn cho khớp. */
  businessDate: string;
  /** Hôm nay đã dùng để tính mốc 4 và phép kiểm tương lai. */
  todayISO: string;
  lanes: Lane[];
  target: Lane | null;
  roomState: RoomState;
  status: LifecycleStatus;
  diagnostics: string[];
}

export interface LaneInput {
  organizationId: string;
  roomId: string | null;
  targetContractId: string;
  subject: LaneSubject;
  /**
   * Mốc ngày NGHIỆP VỤ của hồ sơ đang mở (ngày phiếu / ngày biến động). Chỉ để
   * echo ra `LifecycleView` cho caller gắn nhãn — KHÔNG dùng làm "hôm nay".
   */
  businessDate: string;
  /**
   * HÔM NAY theo giờ Việt Nam. Tách hẳn khỏi `businessDate`: mốc 4 "Đến hôm
   * nay" và phép kiểm "đoạn kết thúc ở tương lai" đều đo theo mốc này.
   * Không bao giờ đọc đồng hồ trong file này — caller truyền vào.
   */
  todayISO: string;
  contracts: readonly LifecycleContractRow[];
  segments: readonly ResidenceSegmentRow[];
  terminations: readonly TerminationRow[];
  depositByContract: ReadonlyMap<string, DepositFigures>;
  invoiceByContract: ReadonlyMap<string, InvoiceTotals>;
  reads: LifecycleReads;
}

/**
 * Đọc THÀNH CÔNG mà RỖNG không phải là "đã chứng minh bằng 0".
 *
 * Hợp đồng CAM KẾT cọc > 0 mà không tìm ra nguồn nào — kể cả một nguồn bị loại
 * để giải thích — thì thứ ta biết là "chưa thấy", không phải "không có". Có thể
 * phiếu cọc nằm ngoài tầm RLS của người đang xem. Hiện "0 đ" ở đây là đúng
 * loại nói dối mà T2 sinh ra để diệt.
 *
 * Ngược lại: cam kết 0 ⇒ 0 là sự thật; và khi CÓ nguồn bị loại thì màn hình đã
 * nói được VÌ SAO bằng 0, nên 0 là một kết luận có căn cứ.
 */
export function cocChuaChungMinh(
  c: LifecycleContractRow,
  d: DepositFigures | null,
): boolean {
  if (!d) return true;
  const camKet = Number(c.total_deposit) || 0;
  return camKet > 0 && d.evidence.length === 0 && d.excluded.length === 0;
}

export function tenKhach(c: LifecycleContractRow): string {
  const phang = (c.customer_name ?? '').trim();
  if (phang) return phang;
  const noi = c.contract_customers?.find((x) => x.customers?.full_name)?.customers?.full_name;
  return (noi ?? '').trim() || 'Chưa có tên khách';
}

function vaiCuaDich(subject: LaneSubject): string {
  if (subject.kind === 'movement') return LANE_ROLE.movement;
  switch (subject.voucherKind) {
    case 'refund': return LANE_ROLE.refund;
    case 'bonus': return LANE_ROLE.bonus;
    case 'commission': return LANE_ROLE.commission;
    // 'unknown' KHÔNG rơi vào hoa hồng như mẫu — xem chú thích ở LANE_ROLE.
    default: return LANE_ROLE.unknown;
  }
}

export function buildLifecycleLanes(input: LaneInput): LifecycleView {
  const org = input.organizationId;
  const chanDoan: string[] = [];

  // Ranh giới công ty trước tiên.
  const hopDong = input.contracts.filter((c) => c.organization_id === org);
  const hdTheoId = new Map(hopDong.map((c) => [c.id, c]));

  const thanhLy = new Map<string, TerminationRow>();
  for (const t of input.terminations) {
    if (t.organization_id !== org) continue;
    if (!hdTheoId.has(t.contract_id)) continue;
    const cu = thanhLy.get(t.contract_id);
    // Nhiều bản ghi thì lấy bản MỚI NHẤT, giống truy vấn đang chạy.
    if (!cu || (t.termination_date ?? '') > (cu.termination_date ?? '')) {
      thanhLy.set(t.contract_id, t);
    }
  }

  // ── Đoạn cư trú TRÊN PHÒNG NÀY ───────────────────────────────────────────
  const daDong = closeResidenceSegments(
    input.segments.filter((s) => hdTheoId.has(s.contract_id)),
    hopDong,
    input.todayISO,
  ).filter((s) => !input.roomId || s.roomId === input.roomId);

  /** contractId → nhịp trên phòng này. Gia hạn giữ nguyên ID ⇒ vẫn MỘT mục. */
  const nhip = new Map<string, { fromDate: string | null; toDate: string | null; trusted: boolean; diagnostics: string[] }>();
  for (const s of [...daDong].sort((a, b) => a.segIndex - b.segIndex)) {
    const cu = nhip.get(s.contractId);
    if (!cu) {
      nhip.set(s.contractId, {
        fromDate: s.fromDate, toDate: s.toDate, trusted: s.trusted,
        diagnostics: s.diagnostic ? [s.diagnostic] : [],
      });
      continue;
    }
    if (s.fromDate && (!cu.fromDate || s.fromDate < cu.fromDate)) cu.fromDate = s.fromDate;
    cu.toDate = s.toDate;
    cu.trusted = cu.trusted && s.trusted;
    if (s.diagnostic && !cu.diagnostics.includes(s.diagnostic)) cu.diagnostics.push(s.diagnostic);
  }

  // Hợp đồng đích KHÔNG có đoạn nào trên phòng này vẫn phải hiện — người dùng
  // đang mở phiếu của nó. Nhưng phải nói rõ là chưa dựng được thứ tự.
  if (!nhip.has(input.targetContractId) && hdTheoId.has(input.targetContractId)) {
    nhip.set(input.targetContractId, {
      fromDate: null, toDate: null, trusted: false,
      diagnostics: ['SEGMENT_MISSING_FOR_TARGET'],
    });
  }

  const thuTu = [...nhip.entries()]
    .map(([contractId, n]) => ({ contractId, ...n }))
    .sort((a, b) => {
      const fa = a.fromDate ?? '', fb = b.fromDate ?? '';
      if (fa !== fb) return fa.localeCompare(fb);
      // Tiebreaker: ngày ký, rồi UUID — thứ tự phải ỔN ĐỊNH giữa hai lần dựng.
      const ca = hdTheoId.get(a.contractId), cb = hdTheoId.get(b.contractId);
      const sa = ca?.signed_date ?? '', sb = cb?.signed_date ?? '';
      return sa.localeCompare(sb) || a.contractId.localeCompare(b.contractId);
    });

  // ── Chồng lấn: hai hợp đồng cùng ở một phòng một lúc là dữ liệu bẩn ──────
  for (let i = 1; i < thuTu.length; i += 1) {
    const truoc = thuTu[i - 1], sau = thuTu[i];
    if (!sau.fromDate) continue;
    if (truoc.toDate === null || sau.fromDate < truoc.toDate) {
      chanDoan.push(
        `Đoạn cư trú chồng lấn: ${hdTheoId.get(truoc.contractId)?.contract_number ?? truoc.contractId}`
        + ` chưa đóng trước khi ${hdTheoId.get(sau.contractId)?.contract_number ?? sau.contractId} bắt đầu`,
      );
    }
  }

  const viTriDich = thuTu.findIndex((x) => x.contractId === input.targetContractId);

  const lanes: Lane[] = thuTu.map((x, i) => {
    const c = hdTheoId.get(x.contractId)!;
    const t = thanhLy.get(x.contractId) ?? null;
    const laDich = i === viTriDich;
    const cuoiChuoi = i === thuTu.length - 1;
    const daThanhLy = !!t;

    const coc = input.depositByContract.get(x.contractId) ?? null;
    const hoaDon = input.invoiceByContract.get(x.contractId) ?? null;

    return {
      contractId: x.contractId,
      contractNumber: c.contract_number,
      customer: tenKhach(c),
      role: laDich ? vaiCuaDich(input.subject) : i < viTriDich ? LANE_ROLE.before : LANE_ROLE.after,
      // Hợp đồng đã thanh lý KHÔNG BAO GIỜ là "HĐ hiện tại", kể cả khi đoạn thô
      // của nó chưa đóng (Plan §3.2 siết chặt hơn mẫu).
      tag: daThanhLy ? LANE_TAG.terminated : cuoiChuoi ? LANE_TAG.current : LANE_TAG.renting,
      target: laDich,
      steps: dungMoc({
        contract: c, termination: t, deposit: coc, invoice: hoaDon,
        todayISO: input.todayISO, isTarget: laDich, reads: input.reads,
      }),
      deposit: coc,
      settlementDeposit: t?.total_deposit ?? null,
      terminatedAt: t?.termination_date ?? null,
      segment: x.fromDate === null && x.toDate === null && x.diagnostics.includes('SEGMENT_MISSING_FOR_TARGET')
        ? null
        : { fromDate: x.fromDate, toDate: x.toDate },
      trusted: x.trusted,
      diagnostics: x.diagnostics,
    };
  });

  // ── Trạng thái từng phần ────────────────────────────────────────────────
  const khongTinCay = lanes.filter((l) => !l.trusted);
  const thieuDich = viTriDich < 0;

  const loiChuyen = lyDoHong(input.reads.transfers);
  const trangThaiLane: SectionStatus =
    tuReadState(input.reads.contracts)
    ?? tuReadState(input.reads.segments)
    ?? (loiChuyen
      ? { kind: 'insufficient', reason: `${loiChuyen} — chuỗi hợp đồng có thể thiếu` }
    : thieuDich
      ? { kind: 'insufficient', reason: 'Chưa đọc được hợp đồng của phiếu đang mở' }
    : chanDoan.length > 0
      ? { kind: 'insufficient', reason: chanDoan[0] }
    : khongTinCay.length > 0
      ? { kind: 'insufficient', reason: 'Lịch sử cư trú của phòng chưa đủ tin cậy' }
    : { kind: 'sufficient' });

  const thieuCoc = lanes.filter((l) => l.deposit === null);
  // Cam kết cọc > 0 mà không thấy nguồn nào ⇒ CHƯA CHỨNG MINH, dù lượt đọc
  // không hề lỗi. Đây là ca reviewer bắt được: đọc rỗng mà báo "đủ".
  const chuaChungMinh = lanes.filter((l) => {
    const c = hdTheoId.get(l.contractId);
    return !!c && l.deposit !== null && cocChuaChungMinh(c, l.deposit);
  });
  const trangThaiCoc: SectionStatus =
    tuReadState(input.reads.deposits)
    ?? (thieuCoc.length > 0
      ? { kind: 'insufficient', reason: 'Chưa đọc đủ nguồn cọc của mọi hợp đồng trong chuỗi' }
    : chuaChungMinh.length > 0
      ? {
          kind: 'insufficient',
          reason: `${chuaChungMinh.length} hợp đồng cam kết cọc nhưng không tìm thấy phiếu cọc nào`
            + ' — có thể nằm ngoài quyền xem của bạn',
        }
    : { kind: 'sufficient' });

  const trangThaiThue: SectionStatus =
    tuReadState(input.reads.invoices)
    ?? (lanes.some((l) => !input.invoiceByContract.has(l.contractId))
      ? { kind: 'insufficient', reason: 'Chưa đọc đủ hoá đơn của mọi hợp đồng trong chuỗi' }
    : { kind: 'sufficient' });

  const trangThaiButToan: SectionStatus =
    tuReadState(input.reads.postings)
    ?? (lanes.some((l) => l.deposit?.hasUnverified)
      ? { kind: 'insufficient', reason: 'Chưa đối chiếu được bút toán hiệu lực — cần quyền giữ sổ quỹ' }
    : { kind: 'sufficient' });

  // ── Tình trạng phòng ────────────────────────────────────────────────────
  // Đọc rỗng hay đọc lỗi KHÔNG BAO GIỜ được đọc thành "phòng trống".
  const cuoi = lanes[lanes.length - 1];
  const roomState: RoomState =
    trangThaiLane.kind !== 'sufficient' || !cuoi
      ? {
          kind: 'insufficient', contractId: null, contractNumber: null, customer: null,
          label: `${CHUA_DU_DU_LIEU} để kết luận tình trạng phòng`,
        }
      : cuoi.terminatedAt
        ? {
            kind: 'vacant', contractId: null, contractNumber: null, customer: null,
            label: 'Trống · chưa có hợp đồng mới',
          }
        : {
            kind: 'occupied', contractId: cuoi.contractId, contractNumber: cuoi.contractNumber,
            customer: cuoi.customer,
            label: `${cuoi.contractNumber ?? '—'} · ${cuoi.customer}`,
          };

  return {
    businessDate: input.businessDate,
    todayISO: input.todayISO,
    lanes,
    target: lanes.find((l) => l.target) ?? null,
    roomState,
    status: {
      lanes: trangThaiLane, deposit: trangThaiCoc,
      rent: trangThaiThue, postings: trangThaiButToan,
    },
    diagnostics: chanDoan,
  };
}

// ── Bốn mốc của một lane — chữ lấy nguyên văn từ mẫu ───────────────────────

function dungMoc(a: {
  contract: LifecycleContractRow;
  termination: TerminationRow | null;
  deposit: DepositFigures | null;
  invoice: InvoiceTotals | null;
  todayISO: string;
  isTarget: boolean;
  reads: LifecycleReads;
}): LaneStep[] {
  const c = a.contract;
  const t = a.termination;

  // ── Mốc 2: CHỖ SỬA CHÍNH ────────────────────────────────────────────────
  // Mẫu ghi `<ngày thu> · <mã phiếu thu>` — tức phải có NGUỒN CHỨNG MINH. Bản
  // cũ ghi "Cam kết X · còn thiếu Y" suy từ `deposit_paid`, và `deposit_paid`
  // là SỐ RÒNG SAU CẤN nên câu "còn thiếu" là bịa.
  const thu = a.deposit?.evidence.filter((e) => e.direction === 'IN' && e.bucket === 'REAL_CASH') ?? [];
  const chuaChungMinh = cocChuaChungMinh(c, a.deposit);
  const mocCoc: LaneStep = a.deposit === null || chuaChungMinh
    ? {
        h: 'Cọc đã đóng · thực thu',
        v: CHUA_DU_DU_LIEU,
        m: a.deposit === null
          ? lyDoHong(a.reads.deposits) ?? 'Chưa đọc được nguồn cọc của hợp đồng này'
          // Cam kết có, nguồn không — nói đúng cái ta biết, đừng in "0 đ".
          : `Hợp đồng cam kết ${fmtMoney(Number(c.total_deposit) || 0)} nhưng không tìm thấy`
            + ' phiếu cọc nào — có thể nằm ngoài quyền xem của bạn',
      }
    : {
        h: 'Cọc đã đóng · thực thu',
        v: fmtMoney(a.deposit.grossCollected),
        m: thu.length === 0
          ? 'Chưa có phiếu thu cọc nào chứng minh được'
          : thu.length === 1
            ? `${fmtNgay(thu[0].date)} · ${thu[0].code ?? 'chưa có mã phiếu'}`
            : `${fmtNgay(thu[0].date)} · ${thu[0].code ?? 'chưa có mã phiếu'} · +${thu.length - 1} phiếu thu`,
        // Cấn/chi ra khỏi cọc là MỘT SỐ KHÁC, và phải gọi đúng tên của nó.
        ...(a.deposit.offsetOut > 0
          ? {
              m2: `Cấn / chi từ cọc: ${fmtMoney(a.deposit.offsetOut)} · còn giữ ${fmtMoney(a.deposit.netHeld)}`,
              m2c: 'var(--ink-3)',
            }
          : a.deposit.historicalNet !== 0
            ? { m2: `Ghi nhận lịch sử (sổ ảo): ${fmtMoney(a.deposit.historicalNet)}`, m2c: 'var(--ink-3)' }
            : {}),
      };

  const mocThue: LaneStep = a.invoice === null
    ? {
        h: 'Tiền thuê / phí đã đóng',
        v: CHUA_DU_DU_LIEU,
        m: lyDoHong(a.reads.invoices) ?? 'Chưa đọc được hoá đơn của hợp đồng này',
      }
    : {
        h: 'Tiền thuê / phí đã đóng',
        v: fmtMoney(a.invoice.paid),
        m: `Không gồm cọc · giá thuê ${fmtMoney(Number(c.rent_price) || 0)}/tháng`,
      };

  const noSauQuyetToan = t?.outstanding_debt;
  const mocCuoi: LaneStep = t
    ? {
        h: `${t.termination_type === 'FORFEIT' ? 'Bỏ cọc' : 'Thanh lý'} · ${fmtNgay(t.termination_date)}`,
        v: `Quyết toán hoàn ${fmtMoney(Number(t.refund_amount) || 0)}`,
        m: noSauQuyetToan === null || noSauQuyetToan === undefined
          ? `Nợ sau quyết toán: ${CHUA_DU_DU_LIEU}`
          : `Nợ sau quyết toán: ${fmtMoney(Number(noSauQuyetToan))}`,
      }
    : {
        // HÔM NAY, không phải ngày phiếu: dán ngày quá khứ lên tổng hiện tại
        // là đổi một nhãn sai lấy một nhãn sai khác.
        h: `Đến hôm nay · ${fmtNgay(a.todayISO)}`,
        v: 'Đang thuê',
        m: 'Chưa thanh lý',
        ...(a.isTarget
          ? a.invoice === null
            ? { m2: `Nợ còn lại: ${CHUA_DU_DU_LIEU}`, m2c: 'var(--ink-3)' }
            : {
                m2: `Nợ còn lại: ${fmtMoney(a.invoice.debt)}`,
                m2c: a.invoice.debt > 0 ? 'var(--c-unpaid)' : 'var(--c-paid)',
              }
          : {}),
      };

  return [
    {
      h: 'Ký hợp đồng',
      v: fmtNgay(c.signed_date),
      m: `Thời hạn: ${fmtNgay(c.start_date)} – ${fmtNgay(c.end_date)}`,
    },
    mocCoc,
    mocThue,
    mocCuoi,
  ];
}
