// Dịch nhật ký thay đổi của phiếu thu/chi (app_private.income_expense_change_log,
// đọc qua public.get_voucher_change_log_v1) sang tiếng người.
//
// Người đọc màn này là kế toán / chủ nhà, không phải lập trình viên: họ cần
// thấy "Ghi chú: (trống) → MOI", "Số tiền: 500.000 đ → 600.000 đ", chứ không
// phải `{"notes": null}` hay tên cột `payer_name`. Module này CỐ Ý thuần tuý
// (không React, không supabase) để test chạy thẳng ở môi trường node.

import type { VoucherChangeLogEntry } from "@/hooks/income-expenses/flexMutations";

/** Nhãn tiếng Việt của cột. Cột KHÔNG có trong bảng này bị coi là kỹ thuật. */
const COLUMN_LABELS: Record<string, string> = {
  // income_expenses
  name: "Tên phiếu",
  code: "Mã phiếu",
  type: "Loại phiếu",
  total_amount: "Số tiền",
  voucher_date: "Ngày thu/chi",
  notes: "Ghi chú",
  payer_name: "Người nhận/trả",
  account_id: "Sổ quỹ",
  building_id: "Toà nhà",
  room_id: "Phòng",
  tenant_id: "Khách thuê",
  contract_id: "Hợp đồng",
  invoice_id: "Hoá đơn",
  attachments: "Đính kèm",
  approval_status: "Trạng thái duyệt",
  approved_at: "Mốc duyệt",
  approved_by: "Người duyệt",
  posting_status: "Trạng thái ghi sổ",
  posting_mode: "Cách ghi sổ",
  review_state: "Trạng thái xem xét",
  cancellation_kind: "Kiểu huỷ",
  deleted_at: "Mốc xoá",
  verified_at: "Mốc đã kiểm",
  verified_by: "Người kiểm",
  verified_note: "Ghi chú kiểm",
  repeat_cycle: "Chu kỳ lặp",
  repeat_remaining: "Số kỳ còn lại",
  repeat_next_date: "Kỳ kế tiếp",
  business_result_accounting: "Tính vào KQKD",
  kqkd_amount: "Phần tính KQKD",
  receive_bank_name: "Ngân hàng nhận",
  receive_bank_account: "Số tài khoản nhận",
  shareholder_id: "Cổ đông",
  system_source: "Nguồn hệ thống",
  has_restricted_item: "Có hạng mục hạn chế",
  // income_expense_items
  income_expense_type_id: "Hạng mục",
  description: "Diễn giải",
  quantity: "Số lượng",
  unit_price: "Đơn giá",
  amount: "Thành tiền",
  start_date: "Từ ngày",
  end_date: "Đến ngày",
};

/** Cột tiền — in theo định dạng Việt Nam kèm "đ". */
const MONEY_COLUMNS = new Set([
  "total_amount",
  "amount",
  "unit_price",
  "kqkd_amount",
]);

/** Cột ngày thuần (không giờ). */
const DATE_COLUMNS = new Set([
  "voucher_date",
  "start_date",
  "end_date",
  "repeat_next_date",
]);

/** Cột mốc thời gian (có giờ). */
const TIMESTAMP_COLUMNS = new Set([
  "approved_at",
  "deleted_at",
  "verified_at",
  "created_at",
  "cancelled_at",
]);

/** Giá trị enum → chữ hiển thị (khớp badge trạng thái đang dùng ở danh sách). */
const ENUM_LABELS: Record<string, Record<string, string>> = {
  type: { INCOME: "Phiếu thu", EXPENSE: "Phiếu chi" },
  approval_status: {
    UNAPPROVED: "Chờ duyệt",
    APPROVED: "Đã ghi nhận",
    CANCELLED: "Đã huỷ",
  },
  posting_status: {
    UNPOSTED: "Chưa ghi sổ",
    POSTED: "Đã ghi sổ",
    REVERSED: "Đã hoàn tác",
    NOT_APPLICABLE: "Không ghi sổ",
  },
  posting_mode: { CASHBOOK: "Ghi vào sổ quỹ", NON_CASH: "Bút toán không tiền" },
  review_state: {
    PENDING: "Chờ xem xét",
    CHANGES_REQUESTED: "Yêu cầu sửa lại",
    DISPUTED: "Đang tranh chấp",
    RESOLVED: "Đã xử lý xong",
  },
  cancellation_kind: {
    CANCELLED_UNPOSTED: "Huỷ khi chưa ghi sổ",
    CANCELLED_AFTER_POSTING: "Huỷ sau khi đã ghi sổ",
  },
  repeat_cycle: {
    NONE: "Không lặp",
    WEEK: "Hàng tuần",
    MONTH: "Hàng tháng",
    QUARTER: "Hàng quý",
    YEAR: "Hàng năm",
  },
};

export const EMPTY_VALUE_TEXT = "(trống)";

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * "2026-07-30" là ngày THUẦN — `new Date()` đọc nó là nửa đêm UTC, máy ở múi
 * giờ âm sẽ hiển thị lùi một ngày. Đảo chuỗi bằng tay, không đụng Date.
 */
const formatDateOnly = (value: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

const formatTimestamp = (value: string): string => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** Mốc thời gian của một dòng nhật ký (public — dialog dùng lại). */
export const formatLogMoment = (value: string | null | undefined): string =>
  value ? formatTimestamp(value) : EMPTY_VALUE_TEXT;

export const formatMoney = (value: number): string =>
  `${value.toLocaleString("vi-VN")} đ`;

/** Một giá trị thô trong jsonb before/after → chuỗi đọc được. */
export const formatCellValue = (column: string, raw: unknown): string => {
  if (raw === null || raw === undefined) return EMPTY_VALUE_TEXT;

  if (Array.isArray(raw)) {
    if (raw.length === 0) return EMPTY_VALUE_TEXT;
    if (column === "attachments") return `${raw.length} tệp`;
    return raw.map((x) => formatCellValue(column, x)).join(", ");
  }

  if (typeof raw === "boolean") return raw ? "Có" : "Không";

  if (typeof raw === "object") return JSON.stringify(raw);

  const text = String(raw);
  if (text === "") return EMPTY_VALUE_TEXT;

  const enumMap = ENUM_LABELS[column];
  if (enumMap && enumMap[text]) return enumMap[text];

  if (MONEY_COLUMNS.has(column)) {
    const n = Number(text);
    if (Number.isFinite(n)) return formatMoney(n);
  }
  if (DATE_COLUMNS.has(column)) return formatDateOnly(text);
  if (TIMESTAMP_COLUMNS.has(column)) return formatTimestamp(text);

  return text;
};

export interface FieldChange {
  column: string;
  label: string;
  before: string;
  after: string;
  /** Cột không có nhãn tiếng Việt — vẫn hiện (nhật ký không được giấu), nhưng xếp sau. */
  technical: boolean;
}

export interface HumanChangeEntry {
  at: string;
  atText: string;
  actorName: string;
  /** "Phiếu" hoặc "Hạng mục". */
  scopeLabel: string;
  /** Câu mô tả gọn: "DEMO Kế Toán sửa phiếu". */
  headline: string;
  changes: FieldChange[];
}

const SCOPE_LABELS: Record<string, string> = {
  VOUCHER: "Phiếu",
  ITEM: "Hạng mục",
};

const OP_VERBS: Record<string, string> = {
  INSERT: "thêm",
  UPDATE: "sửa",
  DELETE: "xoá",
};

const CREATED_MARKER = "*created*";
const DELETED_MARKER = "*deleted*";

const labelOf = (column: string) => COLUMN_LABELS[column];

const sortChanges = (a: FieldChange, b: FieldChange) => {
  if (a.technical !== b.technical) return a.technical ? 1 : -1;
  return a.label.localeCompare(b.label, "vi");
};

/** Dịch một dòng nhật ký thô thành cấu trúc để render. */
export const humanizeChangeEntry = (
  entry: VoucherChangeLogEntry,
): HumanChangeEntry => {
  const scopeLabel = SCOPE_LABELS[entry.scope] ?? entry.scope;
  const verb = OP_VERBS[entry.op] ?? entry.op.toLowerCase();
  const actorName = entry.actor_name?.trim() || "Hệ thống";

  const cols = entry.cols ?? [];
  const isCreate = entry.op === "INSERT" || cols.includes(CREATED_MARKER);
  const isDelete = entry.op === "DELETE" || cols.includes(DELETED_MARKER);

  // INSERT/DELETE ghi NGUYÊN dòng: liệt kê hết là một bức tường cột kỹ thuật.
  // Chỉ nêu những cột có nhãn và có giá trị — đủ để hiểu "đã thêm/xoá cái gì".
  const source = isCreate ? entry.after : isDelete ? entry.before : null;
  const columns =
    source !== null
      ? Object.keys(source).filter(
          (c) => labelOf(c) !== undefined && source[c] !== null && source[c] !== "",
        )
      : cols.filter((c) => c !== CREATED_MARKER && c !== DELETED_MARKER);

  const changes: FieldChange[] = columns.map((column) => {
    const label = labelOf(column);
    return {
      column,
      label: label ?? column,
      before: isCreate
        ? EMPTY_VALUE_TEXT
        : formatCellValue(column, entry.before?.[column] ?? null),
      after: isDelete
        ? EMPTY_VALUE_TEXT
        : formatCellValue(column, entry.after?.[column] ?? null),
      technical: label === undefined,
    };
  });
  changes.sort(sortChanges);

  return {
    at: entry.at,
    atText: formatLogMoment(entry.at),
    actorName,
    scopeLabel,
    headline: `${actorName} ${verb} ${scopeLabel.toLowerCase()}`,
    changes,
  };
};

export const humanizeChangeLog = (
  entries: VoucherChangeLogEntry[] | null | undefined,
): HumanChangeEntry[] => (entries ?? []).map(humanizeChangeEntry);

/** Giải thích kiểu huỷ cho người không rành kế toán. */
export const CANCELLATION_KIND_TEXT: Record<
  string,
  { label: string; hint: string }
> = {
  CANCELLED_UNPOSTED: {
    label: "Huỷ khi chưa ghi sổ",
    hint: "Phiếu chưa từng đụng tồn quỹ nên huỷ không làm thay đổi số dư sổ nào.",
  },
  CANCELLED_AFTER_POSTING: {
    label: "Huỷ sau khi đã ghi sổ",
    hint: "Tiền đã trừ thẳng khỏi tồn quỹ ngay lúc huỷ; bút toán gốc vẫn nằm trong lịch sử sổ.",
  },
};

export const cancellationKindText = (kind: string | null | undefined) =>
  (kind && CANCELLATION_KIND_TEXT[kind]) || null;
