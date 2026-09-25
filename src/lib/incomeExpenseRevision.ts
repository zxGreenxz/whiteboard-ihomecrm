// Sửa phiếu thu chi Chờ duyệt có lưu vết (đợt 1, 25/09/2026).
//
// Máy chủ là nơi quyết định (public.revise_pending_income_expense_v1): quyền, loại
// phiếu, lý do, phiên bản. File này chỉ lo phần NGƯỜI ĐỌC:
//   - so hai ảnh chụp phiếu (before/after_snapshot) thành các dòng "trước → sau"
//     bằng tiếng Việt cho hộp Duyệt và lịch sử phiếu;
//   - đoán sớm khi nào phải gõ lý do (cùng luật với máy chủ) để hiện ô lý do;
//   - đoán nút "Sửa" có nên hiện không (hẹp hơn máy chủ: thà ẩn còn hơn bấm là lỗi);
//   - dịch mã lỗi thành câu người dùng hiểu.

import { z } from "zod";
import { formatVND } from "@/lib/utils";

// ── Ảnh chụp phiếu (app_private.ie_revision_snapshot_v1) ────────────────────

const refSchema = z.object({ id: z.string(), name: z.string().nullable().optional() }).nullable().optional();

export const revisionItemSchema = z.object({
  type_id: z.string(),
  type_name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  quantity: z.coerce.number(),
  unit_price: z.coerce.number(),
  amount: z.coerce.number().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
});
export type RevisionItem = z.infer<typeof revisionItemSchema>;

export const voucherSnapshotSchema = z
  .object({
    // Đổi Thu ↔ Chi thì máy chủ cấp mã mới đúng tiền tố (PT/PC).
    code: z.string().nullable().optional(),
    type: z.enum(["INCOME", "EXPENSE"]).optional(),
    name: z.string().optional(),
    voucher_date: z.string().nullable().optional(),
    building: refSchema,
    room: refSchema,
    tenant: refSchema,
    contract: z.object({ id: z.string(), code: z.string().nullable().optional() }).nullable().optional(),
    account: refSchema,
    payer_name: z.string().nullable().optional(),
    receive_bank_account: z.string().nullable().optional(),
    receive_bank_name: z.string().nullable().optional(),
    business_result_accounting: z.boolean().nullable().optional(),
    notes: z.string().nullable().optional(),
    attachments: z.array(z.string()).optional(),
    repeat: z
      .object({
        cycle: z.string().nullable().optional(),
        count: z.coerce.number().nullable().optional(),
        infinity: z.boolean().nullable().optional(),
        auto_approve: z.boolean().nullable().optional(),
      })
      .optional(),
    total_amount: z.coerce.number().optional(),
    items: z.array(revisionItemSchema).optional(),
    // Kind COLLECTION_METHOD (đổi hình thức thu của khoản thu hoá đơn).
    payment_method: z.string().optional(),
    amount: z.coerce.number().optional(),
    collection_date: z.string().nullable().optional(),
    invoice_number: z.string().nullable().optional(),
  })
  .passthrough();
export type VoucherSnapshot = z.infer<typeof voucherSnapshotSchema>;

export const incomeExpenseRevisionSchema = z.object({
  id: z.string(),
  income_expense_id: z.string(),
  revision_no: z.number(),
  kind: z.enum(["EDIT_PENDING", "COLLECTION_METHOD"]),
  actor_id: z.string(),
  actor_name: z.string(),
  reason: z.string().nullable(),
  changed_fields: z.array(z.string()),
  before_snapshot: voucherSnapshotSchema,
  after_snapshot: voucherSnapshotSchema,
  created_at: z.string(),
});
export type IncomeExpenseRevision = z.infer<typeof incomeExpenseRevisionSchema>;

export const reviseResultSchema = z.object({
  id: z.string(),
  changed: z.boolean(),
  replayed: z.boolean().optional(),
  revision_no: z.number().nullable().optional(),
  approval_version: z.number(),
  changed_fields: z.array(z.string()),
});
export type ReviseResult = z.infer<typeof reviseResultSchema>;

// ── Nhãn tiếng Việt ─────────────────────────────────────────────────────────

export const REVISION_FIELD_LABELS: Record<string, string> = {
  code: "Mã phiếu",
  type: "Loại phiếu",
  name: "Tên phiếu",
  voucher_date: "Ngày phiếu",
  building_id: "Toà nhà",
  room_id: "Phòng",
  tenant_id: "Khách thuê",
  contract_id: "Hợp đồng",
  account_id: "Sổ quỹ",
  payer_name: "Người nộp/nhận",
  receive_bank_account: "Số tài khoản nhận",
  receive_bank_name: "Ngân hàng nhận",
  business_result_accounting: "Tính kết quả kinh doanh",
  notes: "Ghi chú",
  attachments: "Ảnh chứng từ",
  repeat: "Lặp lại",
  items: "Hạng mục",
  payment_method: "Hình thức thu",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  TM: "Tiền mặt",
  TK: "Chuyển khoản",
  TT: "Thanh toán",
  CT: "Cấn trừ",
};

const REPEAT_LABELS: Record<string, string> = {
  WEEK: "Hằng tuần",
  MONTH: "Hằng tháng",
  QUARTER: "Hằng quý",
  YEAR: "Hằng năm",
};

export function revisionFieldLabel(field: string): string {
  return REVISION_FIELD_LABELS[field] ?? field;
}

function ngay(value: string | null | undefined): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
}

function chu(value: string | null | undefined): string {
  const s = (value ?? "").trim();
  return s.length ? s : "—";
}

function kqkd(value: boolean | null | undefined): string {
  if (value === true) return "Có";
  if (value === false) return "Không";
  return "Tự động";
}

function lap(repeat: VoucherSnapshot["repeat"]): string {
  const cycle = repeat?.cycle ?? "NONE";
  if (!cycle || cycle === "NONE") return "Không lặp";
  const base = REPEAT_LABELS[cycle] ?? cycle;
  return repeat?.infinity ? `${base}, không giới hạn` : `${base}, ${repeat?.count ?? 0} lần`;
}

/** Một dòng hạng mục cho người đọc: "Tiền phòng × 1 × 3.500.000 đ = 3.500.000 đ (01/09/2026–30/09/2026)". */
export function formatRevisionItem(item: RevisionItem): string {
  const ten = chu(item.type_name) + (item.description?.trim() ? ` (${item.description.trim()})` : "");
  const thanhTien = item.amount ?? item.quantity * item.unit_price;
  const ky = item.start_date || item.end_date ? ` · kỳ ${ngay(item.start_date)}–${ngay(item.end_date)}` : "";
  return `${ten} × ${item.quantity} × ${formatVND(item.unit_price)} = ${formatVND(thanhTien)}${ky}`;
}

export interface RevisionDiffRow {
  field: string;
  label: string;
  before: string[];
  after: string[];
}

type Field = { key: string; read: (s: VoucherSnapshot) => string[] };

const EDIT_FIELDS: Field[] = [
  { key: "type", read: (s) => [s.type === "INCOME" ? "Phiếu thu" : s.type === "EXPENSE" ? "Phiếu chi" : "—"] },
  // Ảnh chụp cũ (trước khi máy chủ ghi mã) không có khoá code ⇒ không so, khỏi báo "đổi" giả.
  { key: "code", read: (s) => [s.code === undefined ? "" : chu(s.code)] },
  { key: "name", read: (s) => [chu(s.name)] },
  { key: "voucher_date", read: (s) => [ngay(s.voucher_date)] },
  { key: "building_id", read: (s) => [chu(s.building?.name)] },
  { key: "room_id", read: (s) => [chu(s.room?.name)] },
  { key: "tenant_id", read: (s) => [chu(s.tenant?.name)] },
  { key: "contract_id", read: (s) => [chu(s.contract?.code)] },
  { key: "account_id", read: (s) => [chu(s.account?.name)] },
  { key: "payer_name", read: (s) => [chu(s.payer_name)] },
  { key: "receive_bank_account", read: (s) => [chu(s.receive_bank_account)] },
  { key: "receive_bank_name", read: (s) => [chu(s.receive_bank_name)] },
  { key: "business_result_accounting", read: (s) => [kqkd(s.business_result_accounting)] },
  { key: "notes", read: (s) => [chu(s.notes)] },
  { key: "attachments", read: (s) => [`${(s.attachments ?? []).length} ảnh`] },
  { key: "repeat", read: (s) => [lap(s.repeat)] },
  {
    key: "items",
    read: (s) => [
      ...(s.items ?? []).map(formatRevisionItem),
      `Tổng: ${formatVND(s.total_amount ?? 0)}`,
    ],
  },
];

const METHOD_FIELDS: Field[] = [
  { key: "payment_method", read: (s) => [PAYMENT_METHOD_LABELS[s.payment_method ?? ""] ?? chu(s.payment_method)] },
  { key: "account_id", read: (s) => [chu(s.account?.name)] },
];

/**
 * So hai ảnh chụp, trả các trường KHÁC nhau theo thứ tự hiển thị cố định.
 * Ảnh chứng từ so theo danh sách đường dẫn (không chỉ số lượng).
 */
export function diffRevisionSnapshots(
  before: VoucherSnapshot,
  after: VoucherSnapshot,
  kind: IncomeExpenseRevision["kind"] = "EDIT_PENDING",
): RevisionDiffRow[] {
  const fields = kind === "COLLECTION_METHOD" ? METHOD_FIELDS : EDIT_FIELDS;
  const rows: RevisionDiffRow[] = [];
  for (const f of fields) {
    const b = f.read(before);
    const a = f.read(after);
    const khac =
      f.key === "attachments"
        ? JSON.stringify(before.attachments ?? []) !== JSON.stringify(after.attachments ?? [])
        : JSON.stringify(b) !== JSON.stringify(a);
    if (khac) rows.push({ field: f.key, label: revisionFieldLabel(f.key), before: b, after: a });
  }
  return rows;
}

/**
 * "Trước khi sửa → hiện tại": ảnh TRƯỚC của lần sửa đầu so với ảnh SAU của lần
 * sửa cuối (chỉ tính các lần sửa phiếu chờ duyệt). null khi chưa sửa lần nào.
 */
export function summarizePendingRevisions(revisions: IncomeExpenseRevision[]): {
  count: number;
  diff: RevisionDiffRow[];
} | null {
  const edits = revisions
    .filter((r) => r.kind === "EDIT_PENDING")
    .sort((x, y) => x.revision_no - y.revision_no);
  const dau = edits[0];
  const cuoi = edits[edits.length - 1];
  if (!dau || !cuoi) return null;
  return {
    count: edits.length,
    diff: diffRevisionSnapshots(dau.before_snapshot, cuoi.after_snapshot),
  };
}

// ── Luật lý do (mirror revise_pending_income_expense_v1) ─────────────────────

export interface RevisableItem {
  income_expense_type_id: string;
  description?: string | null;
  quantity: number;
  unit_price: number;
  start_date?: string | null;
  end_date?: string | null;
}

export interface RevisableValues {
  type: "INCOME" | "EXPENSE";
  building_id: string;
  account_id: string | null;
  business_result_accounting: boolean | null;
  items: RevisableItem[];
}

function khoaTien(items: RevisableItem[]): string {
  return JSON.stringify(
    items
      .map((i) => [
        i.income_expense_type_id,
        i.start_date || null,
        i.end_date || null,
        Math.round(Number(i.unit_price) * 100) / 100,
        Math.trunc(Number(i.quantity)),
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/**
 * Có phải gõ lý do ≥ 8 ký tự không: đổi Thu/Chi, toà, KQKD, đổi sổ quỹ từ sổ này
 * sang sổ khác (chọn sổ lần đầu thì không), hoặc số/loại/đơn giá/kỳ của hạng mục
 * (sửa mô tả hạng mục thì không). Cùng luật với máy chủ; máy chủ vẫn là nơi chặn.
 */
export function requiresRevisionReason(before: RevisableValues, after: RevisableValues): boolean {
  if (before.type !== after.type) return true;
  if (before.building_id !== after.building_id) return true;
  if ((before.business_result_accounting ?? null) !== (after.business_result_accounting ?? null)) return true;
  if (accountChangeNeedsReason(before.account_id, after.account_id)) return true;
  return khoaTien(before.items) !== khoaTien(after.items);
}

export const REVISION_REASON_MIN = 8;
export const REVISION_REASON_MAX = 1000;

// ── Chỉ gửi đúng ô người dùng đã đổi ────────────────────────────────────────
//
// Form Sửa đổ phiếu vào rồi CHUẨN HOÁ vài ô lúc mở (tên ngân hàng gõ tay →
// tên trong danh sách, null → ""). Gửi nguyên form thì máy chủ thấy "đổi" ở
// những ô người dùng không hề chạm và ghi thành một lần sửa. Vì vậy so với ảnh
// chụp form NGAY SAU khi đổ phiếu vào, và chỉ gửi ô khác.

// Mọi khoá đều tuỳ chọn: kiểu suy từ zod của form để tuỳ chọn hết khi tsconfig
// tắt strictNullChecks; thiếu khoá = không có giá trị.
export interface RevisionFormValues {
  type?: "INCOME" | "EXPENSE";
  name?: string;
  building_id?: string;
  room_id?: string | null;
  tenant_id?: string | null;
  contract_id?: string | null;
  payer_name?: string | null;
  receive_bank_account?: string | null;
  receive_bank_name?: string | null;
  account_id?: string | null;
  voucher_date?: string;
  business_result_accounting?: boolean | null;
  attachments?: string[];
  repeat_cycle?: string;
  repeat_count?: number;
  repeat_infinity?: boolean;
  repeat_auto_approve?: boolean;
}

const PATCH_TEXT_KEYS = [
  "type",
  "name",
  "building_id",
  "room_id",
  "tenant_id",
  "contract_id",
  "payer_name",
  "receive_bank_account",
  "receive_bank_name",
  "account_id",
  "voucher_date",
] as const;

/** Chuỗi rỗng / toàn khoảng trắng = không có giá trị (máy chủ cũng NULLIF(btrim)). */
function giaTri(value: unknown): unknown {
  if (typeof value === "string") {
    const s = value.trim();
    return s === "" ? null : s;
  }
  return value ?? null;
}

function lapLai(v: RevisionFormValues): [string, number, boolean, boolean] {
  return [
    v.repeat_cycle || "NONE",
    Number(v.repeat_count ?? 0),
    !!v.repeat_infinity,
    v.repeat_auto_approve !== false,
  ];
}

/** Patch cho revise_pending_income_expense_v1: chỉ các khoá có giá trị khác lúc mở form. */
export function buildRevisionPatch(
  initial: RevisionFormValues,
  next: RevisionFormValues,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_TEXT_KEYS) {
    const truoc = giaTri(initial[key]);
    const sau = giaTri(next[key]);
    if (truoc !== sau) patch[key] = sau;
  }
  if ((initial.business_result_accounting ?? null) !== (next.business_result_accounting ?? null)) {
    patch.business_result_accounting = next.business_result_accounting ?? null;
  }
  if (JSON.stringify(initial.attachments ?? []) !== JSON.stringify(next.attachments ?? [])) {
    patch.attachments = next.attachments ?? [];
  }
  const lapTruoc = lapLai(initial);
  const lapSau = lapLai(next);
  if (JSON.stringify(lapTruoc) !== JSON.stringify(lapSau)) {
    // Bốn ô lặp đi cùng nhau: máy chủ tự tính số kỳ còn lại và ngày sinh kế tiếp.
    [patch.repeat_cycle, patch.repeat_count, patch.repeat_infinity, patch.repeat_auto_approve] = lapSau;
  }
  return patch;
}

function khoaHangMuc(items: RevisableItem[]): string {
  return JSON.stringify(
    items
      .map((i) => [
        i.income_expense_type_id,
        (i.description ?? "").trim() || null,
        Math.trunc(Number(i.quantity)),
        Math.round(Number(i.unit_price) * 100) / 100,
        i.start_date || null,
        i.end_date || null,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

/**
 * Hộp Duyệt (nhánh cũ) cho đổi sổ / ảnh ngay trước khi duyệt: patch sửa phiếu,
 * rỗng = không phải sửa. Đi qua cùng cửa sửa có lưu vết như form Sửa.
 */
export function approvalEditPatch(
  current: { account_id?: string | null; attachments?: string[] | null },
  next: { account_id?: string | null; attachments: string[] },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ((next.account_id || null) !== (current.account_id || null)) patch.account_id = next.account_id || null;
  if (JSON.stringify(current.attachments ?? []) !== JSON.stringify(next.attachments)) {
    patch.attachments = next.attachments;
  }
  return patch;
}

/** Đổi từ sổ này sang sổ khác thì phải có lý do; chọn sổ lần đầu thì không. */
export function accountChangeNeedsReason(
  currentAccountId: string | null | undefined,
  nextAccountId: string | null | undefined,
): boolean {
  return !!currentAccountId && (nextAccountId || null) !== currentAccountId;
}

/** Hạng mục có khác lúc mở form không (kể cả mô tả). Không khác ⇒ không gửi hạng mục. */
export function revisionItemsChanged(initial: RevisableItem[], next: RevisableItem[]): boolean {
  return khoaHangMuc(initial) !== khoaHangMuc(next);
}

// ── Nút "Sửa" hiện khi nào ───────────────────────────────────────────────────

/** Phiếu hệ thống sửa được (chỉ tiền của hạng mục đang có + sổ/ngày/người nhận/tên/ảnh). */
export const SYSTEM_REVISABLE_SOURCES = ["contract.commission", "termination.refund"] as const;

export interface RevisableVoucherLike {
  approval_status: string;
  posting_status?: string | null;
  system_source?: string | null;
  invoice_id?: string | null;
  shareholder_id?: string | null;
  deleted_at?: string | null;
}

/** Xấp xỉ HẸP của điều kiện máy chủ: Chờ duyệt, chưa ghi sổ, phiếu tay / hoa hồng / trả khách, không gắn hoá đơn, không chia lợi nhuận. */
export function canReviseVoucher(v: RevisableVoucherLike): boolean {
  if (v.approval_status !== "UNAPPROVED") return false;
  if (v.deleted_at) return false;
  if (v.posting_status === "POSTED") return false;
  if (v.invoice_id || v.shareholder_id) return false;
  if (v.system_source && !(SYSTEM_REVISABLE_SOURCES as readonly string[]).includes(v.system_source)) return false;
  return true;
}

export function isSystemRevisableVoucher(v: { system_source?: string | null }): boolean {
  return !!v.system_source && (SYSTEM_REVISABLE_SOURCES as readonly string[]).includes(v.system_source);
}

const FORFEIT_REVENUE_SOURCE = "termination.forfeit_revenue";

/**
 * Cây bút trên các mặt Thu chi (bảng, danh sách mobile, hộp chi tiết, trang chi tiết).
 * - Phiếu sửa được (canReviseVoucher) ⇒ "Sửa phiếu chờ duyệt".
 * - Phiếu doanh thu bỏ cọc chưa huỷ + super admin / chủ công ty ⇒ chế độ đổi cờ KQKD
 *   (giữ nguyên cửa riêng set_forfeit_voucher_kqkd_v1).
 * - Còn lại ẩn — kể cả "Sửa phiếu (Super Admin)" cho phiếu đã duyệt/đã huỷ trước đây
 *   (bấm vào cũng không lưu được; sửa phiếu đã duyệt để đợt 2).
 */
export function voucherEditAction(
  v: RevisableVoucherLike,
  viewer: { isAdmin: boolean; isCompanyOwner: boolean },
): { show: boolean; title: string } {
  if (canReviseVoucher(v)) return { show: true, title: "Sửa phiếu chờ duyệt" };
  if (
    v.system_source === FORFEIT_REVENUE_SOURCE &&
    v.approval_status !== "CANCELLED" &&
    (viewer.isAdmin || viewer.isCompanyOwner)
  ) {
    return { show: true, title: "Đổi cờ kết quả kinh doanh (phiếu bỏ cọc)" };
  }
  return { show: false, title: "" };
}

// ── Nhãn sự kiện nhật ký phiếu (income_expense_audit_log.action) ────────────

const AUDIT_ACTIONS: Record<string, { label: string; tone: "red" | "green" | "amber" | "blue" | "violet" | "zinc" }> = {
  CANCELLED: { label: "Huỷ phiếu", tone: "red" },
  RESTORED: { label: "Khôi phục", tone: "green" },
  APPROVED: { label: "Duyệt", tone: "green" },
  UNAPPROVED: { label: "Huỷ duyệt", tone: "amber" },
  REVISED: { label: "Sửa phiếu", tone: "amber" },
  COLLECTION_METHOD_CHANGED: { label: "Đổi hình thức thu", tone: "violet" },
  CASHBOOK_MOVED: { label: "Đổi sổ quỹ", tone: "blue" },
  MANUAL_LOG: { label: "Sửa nhanh", tone: "zinc" },
};

/** Nhãn + màu cho một dòng "Lịch sử thao tác". Hành động lạ ⇒ giữ nguyên mã, màu xám. */
export function auditActionLabel(action: string | null | undefined): {
  label: string;
  tone: "red" | "green" | "amber" | "blue" | "violet" | "zinc";
} {
  return AUDIT_ACTIONS[action ?? ""] ?? { label: action || "Thao tác", tone: "zinc" };
}

export const AUDIT_TONE_CLASSES: Record<ReturnType<typeof auditActionLabel>["tone"], string> = {
  red: "bg-red-100 text-red-700",
  green: "bg-green-100 text-green-700",
  amber: "bg-amber-100 text-amber-800",
  blue: "bg-sky-100 text-sky-700",
  violet: "bg-violet-100 text-violet-700",
  zinc: "bg-zinc-100 text-zinc-700",
};

// ── Dịch lỗi ────────────────────────────────────────────────────────────────

const errorShape = z.object({ code: z.string().optional(), message: z.string().optional() });

/** Sửa phiếu vừa bị người khác sửa / duyệt với phiên bản cũ ⇒ phải tải lại. */
export function isStaleVersionError(error: unknown): boolean {
  const e = errorShape.safeParse(error);
  if (!e.success) return false;
  // PT409 (HTTP 409) là mã cửa sửa/duyệt đợt 1 trả khi phiên bản lệch. Không dùng
  // 40001 phía máy chủ: PostgREST coi 40001 là xung đột tuần tự hoá và tự chạy lại
  // giao dịch mãi (đo TEST 25/09: treo 125 giây rồi 504). Vẫn nhận 40001 cho các
  // writer cũ còn dùng mã đó.
  return (
    e.data.code === "PT409" ||
    e.data.code === "40001" ||
    /approval_version mismatch/i.test(e.data.message ?? "")
  );
}

export function revisionErrorMessage(error: unknown): string {
  const e = errorShape.safeParse(error);
  if (!e.success) return "Chưa lưu được phiếu. Hãy thử lại.";
  if (isStaleVersionError(error)) return "Phiếu vừa được người khác sửa — tải lại để xem thay đổi.";
  const msg = (e.data.message ?? "").trim();
  // Máy chủ đã nói câu tiếng Việt cụ thể (lý do, quyền, khoá kỳ, loại phiếu…).
  if (msg) return msg.replace(/^\[[A-Z_]+\]\s*/, "");
  return "Chưa lưu được phiếu. Hãy thử lại.";
}

export function approvalErrorMessage(error: unknown): string {
  if (isStaleVersionError(error)) return "Phiếu vừa được sửa — tải lại để xem thay đổi trước khi duyệt.";
  const e = errorShape.safeParse(error);
  const msg = e.success ? (e.data.message ?? "").trim() : "";
  return msg ? msg.replace(/^\[[A-Z_]+\]\s*/, "") : "Không thể duyệt phiếu.";
}

/** Khoá gọi lại an toàn cho một lần bấm Lưu (8–200 ký tự ASCII). */
export function newRevisionIdempotencyKey(prefix = "ie-revise"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${rand}`;
}
