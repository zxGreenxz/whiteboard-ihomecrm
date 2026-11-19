// Bộ đọc nguyên tố cho payload jsonb của sổ tổng lợi nhuận (E1–E16).
//
// LUẬT: thiếu khoá, sai kiểu, số NaN/rỗng/chuỗi rác ⇒ ném `ProfitLedgerPayloadError` (một TypeError).
// KHÔNG BAO GIỜ đổi một số thiếu thành 0: màn hình tiền hiện 0 đ cho dữ liệu hỏng là nói dối.
// TypeError có chủ ý: với lệnh ghi, `hasUnconfirmedResponse` coi đó là "chưa rõ kết quả"
// (đã ghi nhưng đọc biên nhận hỏng) ⇒ khoá gửi lại, không lập trùng.
//
// Khoá "không áp dụng" của máy chủ là `null` (mọi khoá luôn có mặt — d1_doc_interface §2). Vì vậy
// các bộ đọc `opt*` nhận `null` nhưng KHÔNG nhận `undefined` (khoá vắng = payload lệch hợp đồng).

import { financialReadNumber, financialReadRows } from '@/lib/financialReadValidation';

export type PayloadRow = Record<string, unknown>;

export class ProfitLedgerPayloadError extends TypeError {
  constructor(readonly path: string) {
    super('Chưa đọc được đầy đủ số liệu sổ tổng lợi nhuận. Tải lại để kiểm tra.');
    this.name = 'ProfitLedgerPayloadError';
  }
}

export const fail = (path: string): never => {
  throw new ProfitLedgerPayloadError(path);
};

export function obj(value: unknown, path: string): PayloadRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(path);
  return value as PayloadRow;
}

export function optObj(value: unknown, path: string): PayloadRow | null {
  return value === null ? null : obj(value, path);
}

/** Chuỗi bắt buộc, khác rỗng (mã, id, tên trạng thái). */
export function str(value: unknown, path: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fail(path);
}

/** Chuỗi hoặc null (tên toà, mã phiếu, tên sổ…). */
export function optStr(value: unknown, path: string): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : fail(path);
}

export function bool(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : fail(path);
}

/** Số tiền bắt buộc — qua financialReadNumber (từ chối null/undefined/NaN/chuỗi rác/rỗng). */
export function money(value: unknown, path: string): number {
  try {
    return financialReadNumber(value);
  } catch {
    return fail(path);
  }
}

/** Số tiền có thể null (không áp dụng); khoá vắng vẫn là lỗi. */
export function optMoney(value: unknown, path: string): number | null {
  return value === null ? null : money(value, path);
}

/** Số đếm nguyên ≥ 0. */
export function count(value: unknown, path: string): number {
  const n = money(value, path);
  return Number.isSafeInteger(n) && n >= 0 ? n : fail(path);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Ngày 'YYYY-MM-DD' có thật. */
export function day(value: unknown, path: string): string {
  const text = str(value, path);
  const m = DAY.exec(text);
  if (!m) return fail(path);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
    ? text
    : fail(path);
}

export function optDay(value: unknown, path: string): string | null {
  return value === null ? null : day(value, path);
}

/** Kỳ 'YYYY-MM-01'. */
export function month(value: unknown, path: string): string {
  const text = day(value, path);
  return text.endsWith('-01') ? text : fail(path);
}

export function optMonth(value: unknown, path: string): string | null {
  return value === null ? null : month(value, path);
}

/** Thời điểm ISO có múi giờ (timestamptz) — chỉ cần đọc được. */
export function instant(value: unknown, path: string): string {
  const text = str(value, path);
  return Number.isFinite(Date.parse(text)) ? text : fail(path);
}

export function optInstant(value: unknown, path: string): string | null {
  return value === null ? null : instant(value, path);
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fail(path);
}

/** Mảng bắt buộc (null/thiếu là lỗi, không phải "không có dòng nào"). */
export function list<T>(value: unknown, path: string, map: (row: PayloadRow, path: string) => T): T[] {
  let rows: unknown[];
  try {
    rows = financialReadRows(value as unknown[] | null | undefined);
  } catch {
    return fail(path);
  }
  return rows.map((item, index) => map(obj(item, `${path}[${index}]`), `${path}[${index}]`));
}

export function strList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return fail(path);
  return value.map((item, index) => str(item, `${path}[${index}]`));
}

/** Danh sách chuỗi mà phần tử được phép null (vd mã phiếu chưa có). */
export function optStrList(value: unknown, path: string): (string | null)[] {
  if (!Array.isArray(value)) return fail(path);
  return value.map((item, index) => optStr(item, `${path}[${index}]`));
}

/** Hai số tiền bằng nhau tới đồng lẻ (số numeric của máy chủ đi qua số thực JS). */
export function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/** Không trùng khoá — danh sách sổ có id trùng là payload hỏng, không phải hai dòng. */
export function uniqueBy<T>(rows: T[], keyOf: (row: T) => string, path: string): T[] {
  return new Set(rows.map(keyOf)).size === rows.length ? rows : fail(path);
}
