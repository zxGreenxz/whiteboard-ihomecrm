// Hàng đợi "Cần xử lý" của trang Quản lý Cọc (handoff Claude Design · 2a/2b).
//
// VÌ SAO TÁCH RA KHỎI COMPONENT
//   Cái quyết định phiếu nào "gấp" là SO SÁNH NGÀY, và so sánh ngày trong repo
//   này đã có án lệ sai một kỳ vì đọc giờ máy (audit 2026-07-20, xem
//   `vnYmOf`). Gate `check-timezone-stability` chạy test của `src/lib` dưới
//   UTC / Asia/Ho_Chi_Minh / UTC+14 / UTC-11 và đòi kết quả giống hệt — nên mọi
//   phép tính ngày ở đây nhận `today` dạng chuỗi "YYYY-MM-DD" do người gọi
//   truyền vào (lấy bằng `vnTodayISO()`), tuyệt đối KHÔNG gọi `new Date()`.
//
// PHẠM VI
//   Hàng đợi chỉ chứa việc CÓ MỐC THỜI GIAN để mà gấp. Hợp đồng thiếu cọc mà
//   KHÔNG có ngày hẹn bổ sung thì không vào đây — nó không trễ hẹn nào cả, chỗ
//   của nó là sổ cọc đầy đủ (tab "Đủ / Thiếu cọc"). Nhét nó vào hàng đợi sẽ làm
//   hàng đợi dài mãi và mất luôn nghĩa "cần xử lý hôm nay".
import { diffDaysISO } from "@/lib/vnDate";
import type { HeldDepositRow } from "@/hooks/useDepositDashboard";
import type { ReservationDepositRow } from "@/hooks/useDeposits";

/** Số ngày tính là "sắp đến hạn" (nằm trong hàng đợi nhưng chưa trễ). */
export const DUE_SOON_DAYS = 7;

/** Chênh dưới mức này coi như đã đủ (khớp DEPOSIT_SHORTFALL_THRESHOLD). */
export const DEPOSIT_ROUNDING_THRESHOLD = 10_000;

export type DepositTaskKind =
  /** Phiếu giữ chỗ quá ngày phải ký hợp đồng — mất PHÒNG nếu bỏ quên. */
  | "HOLD_OVERDUE"
  /** Phiếu giữ chỗ quá hạn bổ sung cọc — khách có nguy cơ MẤT CỌC. */
  | "RESV_TOPUP_OVERDUE"
  /** Hợp đồng trễ ngày hẹn bổ sung cọc. */
  | "TOPUP_OVERDUE"
  /** Phiếu giữ chỗ sắp tới hạn bổ sung cọc mà chưa đủ. */
  | "RESV_TOPUP_DUE_SOON"
  /** Hợp đồng sắp tới ngày hẹn bổ sung cọc. */
  | "TOPUP_DUE_SOON"
  /** Phiếu giữ chỗ đã duyệt, còn hạn — việc là làm hợp đồng. */
  | "HOLD_READY"
  /** Phiếu giữ chỗ chờ duyệt. */
  | "PENDING_APPROVAL";

export type DepositTaskTone = "danger" | "warn" | "ok" | "pending";

export interface DepositTask {
  /** Khoá React — duy nhất trong toàn hàng đợi. */
  key: string;
  kind: DepositTaskKind;
  /** Tên phòng thô ("402"); component tự thêm tiền tố "P.". */
  roomName: string;
  buildingName: string;
  buildingId: string;
  roomId: string | null;
  /** Khách hàng / người nộp. */
  personName: string;
  /** Số tiền in đậm trên thẻ: còn thiếu (nợ cọc) hoặc tiền cọc (giữ chỗ). */
  amount: number;
  /** Đã thu / cần thu — chỉ có ở nhánh nợ cọc, null ở nhánh giữ chỗ. */
  paidAmount: number | null;
  expectedAmount: number | null;
  /** Mốc hạn ("YYYY-MM-DD") — hẹn bổ sung cọc, hoặc hạn phải làm hợp đồng. */
  dueDate: string | null;
  /** dueDate − today theo NGÀY. Âm = đã trễ. null khi không có mốc. */
  daysToDue: number | null;
  /** Số ngày đã giữ phòng (today − ngày lập phiếu) — chỉ nhánh giữ chỗ. */
  heldDays: number | null;
  code: string | null;
  contractId: string | null;
  voucherId: string | null;
}

export interface DepositTaskGroup {
  kind: DepositTaskKind;
  label: string;
  tone: DepositTaskTone;
  tasks: DepositTask[];
}

const GROUP_META: Record<DepositTaskKind, { label: string; tone: DepositTaskTone }> = {
  RESV_TOPUP_OVERDUE: { label: "QUÁ HẠN BỔ SUNG CỌC — NGUY CƠ MẤT CỌC", tone: "danger" },
  HOLD_OVERDUE: { label: "QUÁ HẠN LÀM HỢP ĐỒNG", tone: "danger" },
  TOPUP_OVERDUE: { label: "QUÁ HẠN HẸN BỔ SUNG CỌC", tone: "danger" },
  RESV_TOPUP_DUE_SOON: { label: "SẮP HẾT HẠN BỔ SUNG CỌC", tone: "warn" },
  TOPUP_DUE_SOON: { label: "SẮP ĐẾN HẠN", tone: "warn" },
  HOLD_READY: { label: "GIỮ CHỖ SẴN SÀNG KÝ HĐ", tone: "ok" },
  PENDING_APPROVAL: { label: "CHỜ DUYỆT", tone: "pending" },
};

/**
 * Thứ tự hiển thị — gấp nhất lên trước.
 *
 * "Quá hạn bổ sung cọc" đứng TRÊN "quá hạn làm hợp đồng" có chủ ý: lỡ mốc đầu
 * là khách MẤT TIỀN đã trả, lỡ mốc sau là chủ mất một phòng trống vài ngày.
 * Thiệt hại không cùng hạng, nên thứ tự đọc cũng không được cùng hạng.
 */
const GROUP_ORDER: DepositTaskKind[] = [
  "RESV_TOPUP_OVERDUE",
  "HOLD_OVERDUE",
  "TOPUP_OVERDUE",
  "RESV_TOPUP_DUE_SOON",
  "TOPUP_DUE_SOON",
  "HOLD_READY",
  "PENDING_APPROVAL",
];

export interface BuildWorkQueueInput {
  /** Hôm nay theo giờ VN, "YYYY-MM-DD" (dùng `vnTodayISO()`). */
  today: string;
  /** Hợp đồng đang hiệu lực (đã lọc toà nhà ở tầng gọi). */
  held: HeldDepositRow[];
  /** Phiếu cọc giữ chỗ (đã lọc toà nhà ở tầng gọi). */
  reservations: ReservationDepositRow[];
  /**
   * Kỳ hạn theo id phiếu (bảng `reservation_hold_deadlines`).
   *
   * Thiếu bản đồ này thì KHÔNG phiếu nào rơi vào nhóm quá hạn: không biết hạn
   * thì không được phép kết luận là đã trễ. Đo trên prod 21/08/2026: 23/24 phiếu
   * đang chạy không có hạn nào — suy bừa sẽ tô đỏ cả sổ cọc thật.
   */
  holdTerms?: Readonly<Record<string, ReservationHoldTerms>>;
  dueSoonDays?: number;
}

/** Kỳ hạn của một phiếu giữ chỗ (khớp `useReservationHoldDeadlines`). */
export interface ReservationHoldTerms {
  holdUntil: string | null;
  topupDueDate: string | null;
  depositTarget: number | null;
}

/** Sắp trong nhóm: trễ nhiều nhất trước, cùng mức trễ thì tiền lớn trước. */
function byUrgency(a: DepositTask, b: DepositTask): number {
  const da = a.daysToDue ?? Number.POSITIVE_INFINITY;
  const db = b.daysToDue ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return b.amount - a.amount;
}

export function buildDepositWorkQueue(input: BuildWorkQueueInput): DepositTaskGroup[] {
  const { today, held, reservations } = input;
  const holdTerms = input.holdTerms ?? {};
  const dueSoonDays = input.dueSoonDays ?? DUE_SOON_DAYS;

  const buckets = new Map<DepositTaskKind, DepositTask[]>(
    GROUP_ORDER.map((k) => [k, [] as DepositTask[]]),
  );
  const push = (kind: DepositTaskKind, task: DepositTask) => {
    buckets.get(kind)!.push(task);
  };

  // ── Hợp đồng còn thiếu cọc VÀ có ngày hẹn bổ sung ────────────────────────
  for (const r of held) {
    if (r.state === "FULL") continue;
    const due = r.deposit_topup_due_date;
    if (!due) continue;
    const days = diffDaysISO(due, today);
    if (days === null) continue;
    if (days > dueSoonDays) continue; // còn xa — để ở sổ cọc, không làm ồn hàng đợi
    push(days < 0 ? "TOPUP_OVERDUE" : "TOPUP_DUE_SOON", {
      key: `topup:${r.contract_id}`,
      kind: days < 0 ? "TOPUP_OVERDUE" : "TOPUP_DUE_SOON",
      roomName: r.room_name,
      buildingName: r.building_name,
      buildingId: r.building_id,
      roomId: null,
      personName: r.customer_name,
      amount: Math.max(0, r.deposit_remaining),
      paidAmount: r.deposit_paid,
      expectedAmount: r.total_deposit,
      dueDate: due,
      daysToDue: days,
      heldDays: null,
      code: r.contract_number,
      contractId: r.contract_id,
      voucherId: null,
    });
  }

  // ── Phiếu cọc giữ chỗ ────────────────────────────────────────────────────
  //
  // "Đã thu bao nhiêu" phải cộng theo PHÒNG, không theo phiếu: khách bổ sung
  // cọc bằng một PHIẾU THU MỚI trên cùng phòng, chứ không sửa phiếu cũ. Đọc mỗi
  // phiếu riêng lẻ thì một phòng đã thu đủ 5tr qua hai lần vẫn bị coi là còn
  // thiếu 3tr, và thẻ đỏ sẽ không bao giờ rời hàng đợi.
  const paidByRoom = new Map<string, number>();
  for (const v of reservations) {
    if (v.approval_status === "CANCELLED" || !v.room_id) continue;
    paidByRoom.set(v.room_id, (paidByRoom.get(v.room_id) ?? 0) + v.total_amount);
  }

  for (const v of reservations) {
    if (v.approval_status === "CANCELLED") continue;
    const terms = holdTerms[v.id];
    const holdUntil = terms?.holdUntil ?? null;
    const topupDue = terms?.topupDueDate ?? null;
    const target = terms?.depositTarget ?? null;

    const holdDays = holdUntil ? diffDaysISO(holdUntil, today) : null;
    const topupDays = topupDue ? diffDaysISO(topupDue, today) : null;

    const paid = v.room_id ? (paidByRoom.get(v.room_id) ?? v.total_amount) : v.total_amount;
    const shortfall = target === null ? 0 : target - paid;
    const conThieu = shortfall >= DEPOSIT_ROUNDING_THRESHOLD;

    // Thứ tự quyết định = thứ tự thiệt hại. Chưa duyệt thì việc cần làm là
    // DUYỆT, mọi mốc khác chưa có nghĩa.
    let kind: DepositTaskKind;
    let dueDate: string | null;
    let daysToDue: number | null;
    if (v.approval_status === "UNAPPROVED") {
      kind = "PENDING_APPROVAL";
      dueDate = null;
      daysToDue = null;
    } else if (conThieu && topupDays !== null && topupDays < 0) {
      kind = "RESV_TOPUP_OVERDUE";
      dueDate = topupDue;
      daysToDue = topupDays;
    } else if (holdDays !== null && holdDays < 0) {
      kind = "HOLD_OVERDUE";
      dueDate = holdUntil;
      daysToDue = holdDays;
    } else if (conThieu && topupDays !== null && topupDays <= dueSoonDays) {
      kind = "RESV_TOPUP_DUE_SOON";
      dueDate = topupDue;
      daysToDue = topupDays;
    } else {
      kind = "HOLD_READY";
      dueDate = holdUntil;
      daysToDue = holdDays;
    }

    const laTopup = kind === "RESV_TOPUP_OVERDUE" || kind === "RESV_TOPUP_DUE_SOON";
    push(kind, {
      key: `resv:${v.id}`,
      kind,
      roomName: v.room_name ?? "—",
      buildingName: v.building_name,
      buildingId: v.building_id,
      roomId: v.room_id,
      personName: v.payer_name ?? "—",
      // Thẻ thiếu cọc in đậm SỐ CÒN THIẾU (việc phải làm), thẻ khác in số cọc.
      amount: laTopup ? Math.max(0, shortfall) : v.total_amount,
      paidAmount: laTopup ? paid : null,
      expectedAmount: laTopup ? target : null,
      dueDate,
      daysToDue,
      heldDays: diffDaysISO(today, v.voucher_date),
      code: v.code,
      contractId: null,
      voucherId: v.id,
    });
  }

  return GROUP_ORDER.map((kind) => ({
    kind,
    label: GROUP_META[kind].label,
    tone: GROUP_META[kind].tone,
    tasks: buckets.get(kind)!.sort(byUrgency),
  })).filter((g) => g.tasks.length > 0);
}

/** Tổng số việc trong hàng đợi. */
export function countTasks(groups: DepositTaskGroup[]): number {
  return groups.reduce((s, g) => s + g.tasks.length, 0);
}

/**
 * Tiền viết tắt kiểu bản vẽ: 486.500.000 → "486,5tr", 2.000.000 → "2tr",
 * 1.200.000.000 → "1,2 tỷ". Chỉ dùng cho ô liếc nhanh — mọi chỗ nói CHÍNH XÁC
 * số tiền (bảng, ô KPI desktop) vẫn phải dùng `formatCurrency`.
 */
export function formatMoneyShort(amount: number | null | undefined): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const cut = (value: number, suffix: string) => {
    const rounded = Math.round(value * 10) / 10;
    const text = Number.isInteger(rounded)
      ? String(rounded)
      : String(rounded).replace(".", ",");
    return `${sign}${text}${suffix}`;
  };
  if (abs >= 1_000_000_000) return cut(abs / 1_000_000_000, " tỷ");
  if (abs >= 1_000_000) return cut(abs / 1_000_000, "tr");
  if (abs >= 1_000) return cut(abs / 1_000, "k");
  return `${sign}${Math.round(abs)}`;
}
