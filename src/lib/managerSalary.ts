// Bảng lương quản lý — kiểu dữ liệu + hàm thuần (testable).
// Quy tắc thưởng nằm ở RPC salary_work_ledger; các hàm ở đây chỉ TỔNG HỢP
// các dòng ledger + cấu hình thành đối tượng cho UI (giống salCalc trong design kit).

export type SalItemType = "JOB" | "DAY_BONUS" | "CONTRACT" | "CASH";

export interface SalLedgerRow {
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
}

export interface SalInvestBy { b: string; amount: number; }
export interface SalCommissionItem { label: string; amount: number; approved: boolean; voucherId?: string; }
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
  commissionItems: SalCommissionItem[];
  // Phiếu hoa hồng ĐÃ DUYỆT (đã thanh toán) trong tháng → cảnh báo "!" cần kiểm tra
  // (lẽ ra phải còn nháp để chốt lương mới duyệt). Rỗng với tháng đã chốt.
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
  }
): SalCalcResult {
  const autoSum = (m.bonusAuto || []).reduce((s, a) => s + a.amount, 0);
  const adjSum = (m.adjustments || []).reduce((s, a) => s + a.amount, 0);
  const bonus = autoSum + adjSum;
  const gross = m.base + bonus + m.investment + m.commission;
  const takehome = gross - m.advance - m.roomRent;
  return { autoSum, adjSum, bonus, gross, takehome };
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
