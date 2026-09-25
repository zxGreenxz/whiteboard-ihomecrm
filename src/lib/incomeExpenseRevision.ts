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
  if (edits.length === 0) return null;
  return {
    count: edits.length,
    diff: diffRevisionSnapshots(edits[0].before_snapshot, edits[edits.length - 1].after_snapshot),
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
  if (before.account_id && (after.account_id ?? null) !== before.account_id) return true;
  return khoaTien(before.items) !== khoaTien(after.items);
}

export const REVISION_REASON_MIN = 8;
export const REVISION_REASON_MAX = 1000;

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

// ── Dịch lỗi ────────────────────────────────────────────────────────────────

const errorShape = z.object({ code: z.string().optional(), message: z.string().optional() });

/** Sửa phiếu vừa bị người khác sửa / duyệt với phiên bản cũ ⇒ phải tải lại. */
export function isStaleVersionError(error: unknown): boolean {
  const e = errorShape.safeParse(error);
  if (!e.success) return false;
  return (
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
