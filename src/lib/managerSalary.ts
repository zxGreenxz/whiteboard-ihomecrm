import type { SalarySourceMeta } from '@/lib/rentSupportSalary';
// Bảng lương quản lý — kiểu dữ liệu + hàm thuần (testable).
// Quy tắc thưởng nằm ở RPC salary_work_ledger; các hàm ở đây chỉ TỔNG HỢP
// các dòng ledger + cấu hình thành đối tượng cho UI (giống salCalc trong design kit).

export type SalItemType = "JOB" | "DAY_BONUS" | "CONTRACT" | "CASH";

// `type` chứ không phải `interface` — xem ghi chú ở ProfitCloseAdjustmentPayload:
// chỉ type alias mới gán được vào `Json` khi hàng ledger đi làm tham số RPC.
export type SalLedgerRow = {
  staff_id: string;
  item_type: SalItemType;
  source_id: string | null;
  occurred_date: string; // yyyy-mm-dd (local)
  day_label: string; // 'CN' | 'Lễ' | ''
  content: string;
  place: string;
  job_type_name: string | null;
  is_repair: boolean;
  is_contract: boolean;
  base_amount: number;
  weekend_amount: number;
  after_amount: number;
  cash_amount: number | null;
  has_photo: boolean | null;
  bonus_amount: number | null;
  reason: string;
  excluded?: boolean; // chủ đánh dấu việc này không tính thưởng (jobs.exclude_from_salary)
}

export interface SalBonusLine {
  icon: string;
  label: string;
  note?: string | null;
  amount: number;
}

export interface SalAdjustment {
  id?: string;
  icon: string;
  label: string;
  amount: number; // có dấu: trừ = âm
  note?: string | null;
  source?: string;
  /** Dòng sinh từ khoản định kỳ (id "rec:<khoản>") — không sửa/xoá như Thưởng/Trừ tay. */
  recurring?: SalRecurringRef;
}

export interface SalRecurringRef {
  itemId: string;
  category: "ALLOWANCE" | "SUPPLEMENTARY";
  buildingId: string | null;
  buildingName: string | null;
}

/** Số ghi đè đang áp cho một dòng (super admin / chủ công ty sửa tay). */
export interface SalAppliedOverride {
  computed: number;
  amount: number;
  reason: string;
  byName: string | null;
  at: string;
}

export interface SalInvestBy { b: string; amount: number; }
export interface SalCommissionItem {
  itemIds?: string[];
  support?: SalarySourceMeta;
  label: string;
  amount: number;
  approved: boolean;
  voucherId?: string;
  /**
   * Tiền của phiếu đã/sẽ ra khỏi một SỔ QUỸ THẬT (phiếu không nằm ở sổ ảo "Hoa hồng
   * QL chờ trả lương"). Vẫn cộng vào thu nhập, nhưng salCalc trừ khỏi thực nhận để
   * không chuyển lần hai. 0/không có = trả qua lương. Ghi đè số tiền (sale:<id>) kéo
   * theo số này (applySalaryExtras) ⇒ dòng sổ thật KHÔNG BAO GIỜ đổi tiền chuyển,
   * chỉ đổi thu nhập; muốn trả thêm qua lương thì thêm khoản Thưởng.
   */
  paidElsewhere?: number;
  /** Tên sổ thật đã/sẽ chi (hiển thị "Đã chi từ sổ X"). */
  paidFrom?: string | null;
  /** Phiếu đã được gán quản lý nhận (ô QL) — không còn dựa vào khớp tên. */
  assigned?: boolean;
  /** approval_version lúc tải — gửi kèm khi gán QL để server từ chối nếu phiếu vừa đổi. */
  version?: number;
  /** Chỉ có ở commissionFlagged: phần của kỳ này đã tính vào lương người khác. */
  includedElsewhere?: { staffId: string; period: string } | null;
}
export interface SalAdvanceItem { date: string; label: string; amount: number; }
export interface SalStats { jobs: number; repairs: number; afterHour: number; workdays: number; streak: number; }
export interface SalTrendPoint { label: string; gross: number; takehome: number; paidOn?: string; current?: boolean; }

export interface SalManager {
  id: string;
  name: string;
  short: string;
  alias: string;
  role: string;
  initials: string;
  tone: "primary" | "info";
  workdays: number;
  base: number;
  roomRent: number;
  incomeGoal: number;
  bonusAuto: SalBonusLine[];
  adjustments: SalAdjustment[];
  investment: number;
  investmentBy: SalInvestBy[];
  investmentLocked: boolean;
  commission: number;
  // Mọi phiếu hoa hồng của quản lý trong tháng — cả đã duyệt lẫn chờ duyệt (migration
  // 20260927155251). Phiếu ở sổ thật mang `paidElsewhere` (thu nhập có, tiền chuyển không).
  commissionItems: SalCommissionItem[];
  // Phiếu khớp người này nhưng phần của kỳ này ĐÃ tính vào lương người khác (dấu chốt lương)
  // → hiện gạch, không cộng. Rỗng với tháng đã chốt.
  commissionFlagged: SalCommissionItem[];
  advance: number;
  advanceItems: SalAdvanceItem[];
  roomRentItems: SalAdvanceItem[];
  // Hoá đơn tiền phòng (tháng T+1) mà khoản "Tiền phòng" khấu trừ vào — dùng để
  // khi TRẢ LƯƠNG tự tạo phiếu thu gạch nợ (cấn trừ vào lương). null nếu tháng
  // chưa có hoá đơn (dùng default_room_rent) hoặc quản lý không ở phòng ưu đãi.
  roomRentInvoice: {
    invoiceId: string;
    roomId: string | null;
    buildingId: string | null;
    contractId: string | null;
    amount: number; // = tiền phòng khấu trừ (total_amount hoá đơn)
    remaining: number;
  } | null;
  paid: number;
  stats: SalStats;
  trend: SalTrendPoint[];
  status: "DRAFT" | "LOCKED";
  salaryMonthlyId: string | null;
  ledger: SalLedgerRow[];
  calc?: SalCalcResult;
  // Số ĐÃ ĐÓNG BĂNG của kỳ chốt (salary_monthly). null khi kỳ chưa chốt. Các trường
  // live ở trên (investment, advance, commissionItems…) có thể trôi sau khi chốt.
  frozen?: { base: number; investment: number; commission: number; advance: number } | null;
  /** Tổ chức của cấu hình lương — khoá gọi RPC khoản định kỳ / ghi đè. */
  organizationId?: string | null;
  /** Số ghi đè đang áp, theo khoá dòng (base, streak, job:…, rec:…, sale:…, dh:…). */
  overrides?: Record<string, SalAppliedOverride>;
}

export interface SalCalcResult {
  autoSum: number;
  adjSum: number;
  bonus: number;
  gross: number;
  takehome: number;
}

// Tên gọi (given name) = từ cuối trong họ tên tiếng Việt: "Quách Cao Phú Hiển" → "Hiển".
export function firstName(full: string): string {
  const parts = (full || "").trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : full || "";
}

export function initialsOf(short: string): string {
  return (short || "?").charAt(0).toUpperCase();
}

// Gộp các dòng ledger thành "thưởng tự động" (3 nhóm: việc theo loại, ngày CN/Lễ, HĐ).
export function buildBonusAuto(ledger: SalLedgerRow[], requirePhoto = false): SalBonusLine[] {
  const lines: SalBonusLine[] = [];

  // (1) JOB gộp theo loại việc — chỉ tính dòng đủ điều kiện (bonus_amount > 0).
  // BỎ việc ký HĐ (is_contract) ra khỏi nhóm này — gộp riêng ở mục (3).
  const jobGroups = new Map<string, { count: number; total: number; per: number }>();
  for (const r of ledger) {
    if (r.item_type !== "JOB") continue;
    if (r.is_contract) continue;
    const eligible = (r.bonus_amount ?? 0) > 0;
    if (!eligible) continue; // thiếu ảnh / không tính → bỏ khỏi tổng thưởng
    const key = r.job_type_name || "Việc";
    const g = jobGroups.get(key) || { count: 0, total: 0, per: r.base_amount || 0 };
    g.count += 1;
    g.total += r.bonus_amount ?? 0;
    g.per = r.base_amount || g.per;
    jobGroups.set(key, g);
  }
  for (const [name, g] of jobGroups) {
    lines.push({
      icon: "Wrench",
      label: name,
      note: `${g.count} việc × ${fmtPlain(g.per)}`,
      amount: g.total,
    });
  }

  // (2) DAY_BONUS — ngày CN/Lễ có sửa chữa
  const dayRows = ledger.filter((r) => r.item_type === "DAY_BONUS");
  if (dayRows.length) {
    const total = dayRows.reduce((s, r) => s + (r.bonus_amount ?? 0), 0);
    const per = dayRows[0].weekend_amount || 0;
    lines.push({
      icon: "CalendarCheck",
      label: "CN/Lễ có sửa chữa",
      note: `${dayRows.length} ngày × ${fmtPlain(per)}`,
      amount: total,
    });
  }

  // (3) Ký HĐ ngoài giờ / CN / lễ — từ VIỆC loại checkin (is_contract, đủ điều kiện)
  // + (legacy) dòng CONTRACT của snapshot cũ. icon "FileClock" → chốt vào contract_bonus.
  const contractRows = ledger.filter(
    (r) =>
      r.item_type === "CONTRACT" ||
      (r.item_type === "JOB" && r.is_contract && (r.bonus_amount ?? 0) > 0),
  );
  if (contractRows.length) {
    const total = contractRows.reduce((s, r) => s + (r.bonus_amount ?? 0), 0);
    const per = contractRows[0].after_amount || contractRows[0].base_amount || 0;
    lines.push({
      icon: "FileClock",
      label: "Ký HĐ ngoài giờ / CN / lễ",
      note: `${contractRows.length} HĐ × ${fmtPlain(per)}`,
      amount: total,
    });
  }

  void requirePhoto; // photo gate đã áp ở RPC (bonus_amount=0 khi thiếu ảnh)
  return lines;
}

// v5 KHÔNG nuốt thưởng việc — hai nguồn tiền chạy SONG SONG (chủ quyết 27/08/2026):
// chuyên cần + chuỗi là tiền "đi làm đều", thưởng việc theo rule cũ là tiền "làm thêm".
// Trước đây nhánh v5 gán đè bonusAuto = [chuỗi] nên 1.820.000đ tiền việc của kỳ 7/2026
// biến mất khỏi bảng lương trong khi bảng kê vẫn hiện đủ từng dòng kèm số tiền — bảng kê
// hứa tiền, bảng lương không trả. Trần 8,5tr của v5 từ đây chỉ áp cho HAI QUỸ chuyên cần
// + chuỗi (v5_month_money tự kẹp), không áp cho tổng lương.
// Dòng chuỗi đứng ĐẦU để popover đọc từ khoản lớn xuống khoản nhỏ.
export function mergeV5Bonus(jobLines: SalBonusLine[], streakAmount: number): SalBonusLine[] {
  const lines: SalBonusLine[] = [];
  if (streakAmount > 0) {
    lines.push({ icon: "Flame", label: "Thưởng chuỗi (v5)", note: "mốc chuỗi đã đạt", amount: streakAmount });
  }
  return lines.concat(jobLines);
}

// Tách contract_bonus khỏi work_bonus khi đóng băng tháng. Icon "FileClock" = ký HĐ
// ngoài giờ/CN/lễ, do buildBonusAuto gắn ở mục (3); mọi dòng khác (chuỗi Flame, việc
// Wrench, ngày CalendarCheck) thuộc work_bonus. Gom về một chỗ vì useLockSalaryMonth
// lặp đúng biểu thức này ở hai nhánh (canonical + fallback legacy) — thêm dòng thưởng
// mới mà quên một nhánh là lệch sổ giữa hai đường ghi.
export function contractBonusOf(bonusAuto: SalBonusLine[]): number {
  return (bonusAuto || []).filter((b) => b.icon === "FileClock").reduce((s, b) => s + b.amount, 0);
}

export function computeStats(ledger: SalLedgerRow[]): Omit<SalStats, "streak"> {
  const jobs = ledger.filter((r) => r.item_type === "JOB").length;
  const repairs = ledger.filter((r) => r.item_type === "JOB" && r.is_repair).length;
  // Cú đêm / HĐ ngoài giờ: việc ký HĐ (checkin) đủ điều kiện thưởng + (legacy) dòng CONTRACT.
  const afterHour = ledger.filter(
    (r) =>
      r.item_type === "CONTRACT" ||
      (r.item_type === "JOB" && r.is_contract && (r.bonus_amount ?? 0) > 0),
  ).length;
  const days = new Set(
    ledger.filter((r) => r.item_type !== "DAY_BONUS").map((r) => r.occurred_date)
  );
  return { jobs, repairs, afterHour, workdays: days.size };
}

// Chuỗi ngày liên tục gần nhất có hoạt động (việc/HĐ), tính lùi từ ngày làm gần nhất.
export function computeStreak(ledger: SalLedgerRow[]): number {
  const days = Array.from(
    new Set(ledger.filter((r) => r.item_type !== "DAY_BONUS").map((r) => r.occurred_date))
  ).sort();
  if (!days.length) return 0;
  let streak = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const cur = new Date(days[i] + "T00:00:00");
    const prev = new Date(days[i - 1] + "T00:00:00");
    const diff = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    if (diff === 1) streak++;
    else break;
  }
  return streak;
}

// Tổng lương từ công thức (giống salCalc trong design kit).
export function salCalc(
  m: Pick<SalManager, "base" | "investment" | "commission" | "advance" | "roomRent"> & {
    bonusAuto?: SalBonusLine[];
    adjustments?: SalAdjustment[];
    commissionItems?: SalCommissionItem[];
  }
): SalCalcResult {
  const autoSum = (m.bonusAuto || []).reduce((s, a) => s + a.amount, 0);
  const adjSum = (m.adjustments || []).reduce((s, a) => s + a.amount, 0);
  const bonus = autoSum + adjSum;
  const gross = m.base + bonus + m.investment + m.commission;
  // Hoa hồng đã/sẽ chi từ sổ thật: là thu nhập (có trong gross) nhưng tiền đã ra từ
  // sổ đó — trừ như tiền ứng, kẻo chuyển lần hai qua lương.
  const paidElsewhere = commissionPaidElsewhere(m.commissionItems);
  const takehome = gross - m.advance - m.roomRent - paidElsewhere;
  return { autoSum, adjSum, bonus, gross, takehome };
}

/**
 * Hạng mục có phải hoa hồng không — CÙNG luật với server
 * (app_private.ie_has_commission_item_v1): category 'HOA HỒNG' hoặc tên chứa
 * "hoa hồng"/"hoa hông"/"hhmg".
 */
export function isCommissionType(t: { category?: string | null; name?: string | null }): boolean {
  return String(t.category || "").toUpperCase() === "HOA HỒNG" || /hoa h[ồô]ng|hhmg/i.test(String(t.name || ""));
}

/** Dòng mô tả ngắn cho một phiếu hoa hồng — dùng chung mọi màn lương. */
export function commissionItemNote(c: SalCommissionItem, locked: boolean): string {
  if(c.support?.part) return `Đã giữ hỗ trợ ${fmtPlain(Number(c.support.part.withheld))}đ · thực nhận ${fmtPlain(Number(c.support.part.net))}đ${locked ? ' · đã chốt' : ''}`;
  const book = c.paidFrom || "sổ quỹ khác";
  const fromBook = (c.paidElsewhere || 0) > 0;
  if (locked) return fromBook ? `đã chốt · đã chi từ sổ ${book}` : "đã chốt cùng bảng lương";
  if (!fromBook) return c.approved ? "đã duyệt · trả qua lương" : "chờ duyệt · trả qua lương khi chốt";
  return c.approved ? `đã chi từ sổ ${book} — không chuyển lại` : `chưa gán QL — khi duyệt chi từ sổ ${book}`;
}

/** Dòng mô tả cho phiếu mà phần kỳ này đã tính vào lương người khác (commissionFlagged). */
export function commissionFlaggedNote(c: SalCommissionItem): string {
  const p = c.includedElsewhere?.period;
  return `đã tính vào lương người khác kỳ ${p ? p.slice(5, 7) + "/" + p.slice(0, 4) : "này"} — không cộng lại`;
}

/** Tổng hoa hồng đã/sẽ chi từ sổ quỹ thật (không trả qua lương). */
export function commissionPaidElsewhere(items: SalCommissionItem[] | undefined): number {
  return (items || []).reduce((s, c) => s + (c.paidElsewhere || 0), 0);
}

/** Một dòng meta từ salary_commission_meta_v1 (migration 20260927155251). */
export interface CommissionVoucherMeta {
  voucher_id: string;
  manager_id: string | null;
  account_id: string | null;
  account_name: string | null;
  on_manager_book: boolean | null;
  included_staff_id: string | null;
  included_period: string | null;
}

/** Một phiếu hoa hồng đã gộp các dòng item trong tháng. */
export interface CommissionVoucherRow {
  itemIds?: string[];
  support?: SalarySourceMeta;
  id: string;
  name: string;
  status: string; // approval_status
  amount: number;
  payerName: string;
  version?: number;
}

/**
 * Chia phiếu hoa hồng của tháng cho từng quản lý (phương án A, chốt 27/09/2026):
 *  - Quản lý nhận = liên kết ô QL (meta.manager_id) nếu có, còn không thì khớp tên
 *    người nhận (payer_name) với biệt danh / tên gọi như trước.
 *  - Dấu "đã tính vào lương" khoá theo (phiếu, kỳ) và meta chỉ trả dấu của kỳ đang xem
 *    (salary_commission_meta_v1(ids, kỳ)) ⇒ dấu của NGƯỜI KHÁC → flagged (gạch). Nhánh
 *    "kỳ khác" chỉ còn là lưới an toàn nếu meta trả nhầm kỳ.
 *  - Còn lại vào items, cả đã duyệt lẫn chờ duyệt. Phiếu ở sổ ảo quản lý → trả qua
 *    lương; ở sổ thật → paidElsewhere = số gốc (thu nhập có, tiền chuyển không).
 */
export function classifyCommissionVouchers(
  vouchers: CommissionVoucherRow[],
  meta: Map<string, CommissionVoucherMeta>,
  aliasToStaff: Map<string, string>,
  staffIds: Set<string>,
  periodMonth: string,
): Map<string, { items: SalCommissionItem[]; flagged: SalCommissionItem[] }> {
  const out = new Map<string, { items: SalCommissionItem[]; flagged: SalCommissionItem[] }>();
  for (const v of vouchers) {
    const mt = meta.get(v.id);
    const linked = mt?.manager_id && staffIds.has(mt.manager_id) ? mt.manager_id : null;
    // Phiếu đã gán cho một quản lý KHÁC (ngoài danh sách tháng này) thì không được
    // rơi về khớp tên — liên kết thắng tên.
    if(v.support && (v.support.state!=='READY' || !v.support.part || v.support.part.period_month!==periodMonth || Number(v.support.part.net)!==v.amount || v.itemIds?.length!==1 || v.itemIds[0]!==v.support.part.item_id || (linked && linked!==v.support.staff_id))) throw new Error('Nguồn hoa hồng đã đổi hoặc cần đối chiếu trước khi tính lương.');
    const staff = v.support ? (v.support.staff_id && staffIds.has(v.support.staff_id) ? v.support.staff_id : null) : linked ?? (mt?.manager_id ? null : aliasToStaff.get(v.payerName.trim().toLowerCase()) ?? null);
    if (!staff) continue;
    const entry = out.get(staff) || { items: [], flagged: [] };
    const onBook = !!mt?.on_manager_book;
    const item: SalCommissionItem = {
      label: v.name,
      itemIds:v.itemIds,support:v.support,
      amount: v.amount,
      approved: v.status === "APPROVED",
      voucherId: v.id,
      version: v.version,
      assigned: !!linked,
      paidElsewhere: onBook ? 0 : v.amount,
      paidFrom: onBook ? null : mt?.account_name ?? null,
    };
    const inc = mt?.included_staff_id && mt.included_period
      ? { staffId: mt.included_staff_id, period: mt.included_period.slice(0, 10) }
      : null;
    if (inc && (inc.staffId !== staff || inc.period !== periodMonth)) {
      entry.flagged.push({ ...item, includedElsewhere: inc });
    } else {
      entry.items.push(item);
    }
    out.set(staff, entry);
  }
  return out;
}

// Số gọn không hậu tố (cho note "18 việc × 30.000").
function fmtPlain(n: number): string {
  return Math.round(n).toLocaleString("vi-VN");
}

// ===== Tháng hiển thị bảng lương cho NHÂN VIÊN (self-view) =====
// Mặc định "lùi tháng theo chốt lương": hiện tháng TRƯỚC cho tới khi tháng trước
// được CHỐT (LOCKED), rồi mới nhảy sang tháng hiện tại. Admin có thể ghi đè
// hiện/ẩn từng tháng (overrides 'YYYY-MM' → bool).

export function ymOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftYm(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map((x) => parseInt(x, 10));
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Mốc auto: tháng trước nếu CHƯA chốt, tháng hiện tại nếu tháng trước đã chốt.
export function autoStaffYm(curYm: string, prevLocked: boolean): string {
  return prevLocked ? curYm : shiftYm(curYm, -1);
}

// Một tháng có hiển thị cho nhân viên không: override (admin) ưu tiên; nếu không
// có override thì hiện mọi tháng ≤ mốc auto (so sánh chuỗi 'YYYY-MM' hợp lệ).
export function isStaffMonthVisible(
  ym: string,
  autoYm: string,
  overrides: Record<string, boolean>,
): boolean {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, ym)) return !!overrides[ym];
  return ym <= autoYm;
}

// Tháng MỚI NHẤT nhân viên được xem (quét lùi tối đa `back` tháng từ tháng hiện tại).
export function latestVisibleStaffYm(
  curYm: string,
  autoYm: string,
  overrides: Record<string, boolean>,
  back = 13,
): string {
  let m = curYm;
  for (let i = 0; i <= back; i++) {
    if (isStaffMonthVisible(m, autoYm, overrides)) return m;
    m = shiftYm(m, -1);
  }
  return autoYm;
}

// Engine lương áp cho MỘT kỳ. v5 chỉ đúng từ tháng có dữ liệu chấm công v5
// (`system_v5.effective_from`); tháng trước mốc đó phải rơi về legacy — nếu không
// v5_month_money trả 0 và màn lương mất trắng lương cứng lẫn thưởng việc.
export function resolveSalaryEngine(cfg: any, periodMonth: string): "legacy" | "v5" {
  if (cfg?.system_v5?.salary_engine !== "v5") return "legacy";
  const from = cfg?.system_v5?.effective_from;
  if (from && periodMonth && periodMonth < String(from)) return "legacy";
  return "v5";
}

// Chú thích cho dòng bảng kê KHÔNG có thưởng (hiện dưới số 0₫ ở cột Thưởng).
// null = dòng có thưởng bình thường / dòng CASH → không cần chú thích.
// Chỉ nói "thiếu ảnh" khi quy tắc bắt buộc ảnh ĐANG BẬT và đúng là thiếu ảnh;
// mọi lý do khác (chủ loại khỏi thưởng, checkin trong giờ…) chỉ ghi "Không tính".
export function zeroBonusReason(r: SalLedgerRow, requirePhoto = false): string | null {
  if (r.bonus_amount == null) return null;
  if ((r.bonus_amount ?? 0) > 0) return null;
  if (requirePhoto && r.item_type === "JOB" && r.has_photo === false) return "Thiếu ảnh — chưa tính";
  return "Không tính";
}

// Dòng bảng kê CHẮC CHẮN không bao giờ có thưởng vì sai điều kiện ngay từ đầu:
// việc ký HĐ (checkin) hoàn thành TRONG GIỜ — quy tắc chỉ thưởng khi sau
// afterHourMark hoặc CN/Lễ. Hiện ra chỉ gây nhiễu nên ẩn khỏi bảng kê.
// KHÔNG ẩn dòng chủ tự tay loại (excluded) — phải thấy mới bấm "Tính lại" được.
export function isUnqualifiedContractRow(r: SalLedgerRow): boolean {
  return (
    r.item_type === "JOB" &&
    !!r.is_contract &&
    (r.bonus_amount ?? 0) === 0 &&
    !r.excluded
  );
}

// Kỳ MẶC ĐỊNH nhân viên thấy khi mở "Lương của tôi" (chính sách 2026-07-20):
// vào thẳng THÁNG HIỆN TẠI, muốn xem kỳ cũ thì bấm lùi.
// Trước đây mặc định lùi 1 tháng cho tới khi tháng trước được CHỐT — hệ quả là
// nhân viên không xem được lương tháng đang chạy của chính mình.
// Admin vẫn chặn/mở từng tháng qua staffMonths (override luôn thắng).
export function staffCeilingYm(curYm: string, overrides: Record<string, boolean>): string {
  return latestVisibleStaffYm(curYm, curYm, overrides);
}
