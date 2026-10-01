// Chuyển thẻ nháp đã kiểm sang dữ liệu ghi:
//   - Công ty ⇒ đúng hình `CreateIncomeExpenseInput` cho `useCreateIncomeExpense` → writer
//     `create_income_expense_v1` (bộ máy chi quyết Đã duyệt/Chờ duyệt như phiếu lập tay).
//   - Cá nhân ⇒ các dòng `personal_transactions`.
//
// Luật tiền (có property test): tổng tiền giữ nguyên; mỗi dòng số lượng 1, đơn giá = số tiền
// ("2 bóng đèn 120k" là TỔNG 120k, không nhân); dòng nào cũng có kỳ áp dụng (thiếu kỳ thì v1
// bị bỏ qua và phiếu rơi sang đường compat luôn Chờ duyệt, không qua bộ máy chi); chỉ gửi ảnh
// https; khoá chống trùng cố định theo thẻ để gửi lại y nguyên không sinh phiếu đôi.
// Kiểu đầu ra khai cục bộ cho thư viện thuần; hook nhận nó sẽ được TypeScript so khớp.

import { MAX_DESCRIPTION, MAX_NAME, MAX_PAYER_NAME, type DraftLine, type QuickDraft } from "./draft";

export interface CompanyVoucherItem {
  income_expense_type_id: string;
  description: string | null;
  quantity: 1;
  unit_price: number;
  start_date: string;
  end_date: string;
}

export interface CompanyVoucherInput {
  type: "EXPENSE";
  name: string;
  building_id: string;
  room_id: string | null;
  tenant_id: null;
  contract_id: null;
  payer_name: string | null;
  receive_bank_account: null;
  receive_bank_name: null;
  account_id: string;
  voucher_date: string;
  business_result_accounting: null;
  attachments: string[];
  repeat_cycle: "NONE";
  repeat_infinity: false;
  repeat_count: 0;
  repeat_auto_approve: true;
  items: CompanyVoucherItem[];
  idempotency_key: string;
}

export interface PersonalEntryValues {
  type: "EXPENSE";
  amount: number;
  txn_date: string;
  category: string | null;
  description: string | null;
}

/** Regex khoá chống trùng của writer v1. */
const SERVER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

export function idempotencyKeyFor(draftId: string): string {
  const key = `qe-${draftId.replace(/[^A-Za-z0-9-]/g, "")}`;
  if (!SERVER_KEY_RE.test(key)) throw new Error("Mã thẻ nháp không dùng được làm khoá chống trùng.");
  return key;
}

const clean = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, max) : null;
};

export function toCreateIncomeExpenseInput(d: QuickDraft): CompanyVoucherInput {
  if (d.mode !== "company") throw new Error("Khoản cá nhân không ghi thành phiếu chi công ty.");
  if (!d.buildingId || !d.accountId) throw new Error("Thẻ chưa đủ toà nhà và sổ quỹ.");
  const items = d.lines.map((l): CompanyVoucherItem => {
    if (!l.categoryId) throw new Error("Thẻ còn dòng chưa có hạng mục.");
    return {
      income_expense_type_id: l.categoryId,
      description: clean(l.description, MAX_DESCRIPTION),
      quantity: 1,
      unit_price: l.amount,
      start_date: l.periodStart ?? d.date,
      end_date: l.periodEnd ?? d.date,
    };
  });
  return {
    type: "EXPENSE",
    name: clean(d.name, MAX_NAME) ?? clean(d.lines[0]?.description, MAX_NAME) ?? "Chi nhanh",
    building_id: d.buildingId,
    room_id: d.roomId,
    tenant_id: null,
    contract_id: null,
    payer_name: clean(d.vendor, MAX_PAYER_NAME),
    receive_bank_account: null,
    receive_bank_name: null,
    account_id: d.accountId,
    voucher_date: d.date,
    business_result_accounting: null,
    attachments: d.attachmentUrls.filter((u) => /^https:\/\//.test(u)),
    repeat_cycle: "NONE",
    repeat_infinity: false,
    repeat_count: 0,
    repeat_auto_approve: true,
    items,
    idempotency_key: idempotencyKeyFor(d.id),
  };
}

/** Cá nhân: mỗi danh mục một khoản (cộng tiền, nối mô tả) — một bill đi chợ không thành 10 dòng. */
export function toPersonalTransactionValues(d: QuickDraft): PersonalEntryValues[] {
  if (d.mode !== "personal") throw new Error("Khoản công ty không ghi vào ví cá nhân.");
  const groups = new Map<string, { category: string | null; amount: number; parts: string[] }>();
  for (const l of d.lines) {
    const category = clean(l.personalCategory, 100);
    const key = category ?? "";
    const g = groups.get(key) ?? { category, amount: 0, parts: [] };
    g.amount += l.amount;
    const part = clean(l.description, MAX_DESCRIPTION);
    if (part) g.parts.push(part);
    groups.set(key, g);
  }
  const base = clean(d.name, MAX_NAME);
  return [...groups.values()].map((g) => {
    const joined = g.parts.join("; ");
    const description = joined ? (base ? `${base}: ${joined}` : joined) : base;
    return {
      type: "EXPENSE",
      amount: g.amount,
      txn_date: d.date,
      category: g.category,
      description: description ? description.slice(0, MAX_DESCRIPTION) : null,
    };
  });
}

export interface PlacedLine {
  buildingId: string | null;
  roomId: string | null;
  line: DraftLine;
}

/** Một tin nhiều khoản: khác toà hoặc khác phòng ⇒ phiếu riêng (room_id ở cấp phiếu). */
export function groupByPlace(items: PlacedLine[]): Array<{ buildingId: string | null; roomId: string | null; lines: DraftLine[] }> {
  const groups = new Map<string, { buildingId: string | null; roomId: string | null; lines: DraftLine[] }>();
  for (const it of items) {
    const key = `${it.buildingId ?? ""}|${it.roomId ?? ""}`;
    const g = groups.get(key) ?? { buildingId: it.buildingId, roomId: it.roomId, lines: [] };
    g.lines.push(it.line);
    groups.set(key, g);
  }
  return [...groups.values()];
}
