// Ô tích "Theo hạng mục" + ô tìm trên đầu khung Khoản thu / Khoản chi của Báo cáo LN (chủ chốt 28/10/2026).
//
// CHỈ là lớp xem: lọc danh sách SAU khi trang đã tính tổng, tỷ trọng và các số đưa vào thanh kiểm chứng (thanh đó
// đòi tổng thẻ = Σ dòng hiện + phần ẩn — đưa số đã lọc vào là báo lệch oan). Không đổi một con số nào; desktop
// (ProfitDistributionReport) và điện thoại (ProfitDistributionMobile) dùng chung.
import { rowCategoryAmounts, type InvoiceAmountParts } from '@/lib/invoiceAmountParts';
import { AMOUNT_SEARCH_TOLERANCE, isRoomCodeQuery } from '@/lib/roomCodeSearch';

/** Bỏ dấu + thường hoá + gọn khoảng trắng: "Hoá Đơn  301" ≈ "hoa don 301". */
export function foldVi(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // thường hoá TRƯỚC khi thay đ→d: đảo lại sẽ bỏ sót Đ hoa (U+0110)
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ProfitRowSearch =
  | { mode: 'none' }
  /** room: tên phòng đã foldVi. */
  | { mode: 'room'; room: string }
  /** amount: số tiền ±AMOUNT_SEARCH_TOLERANCE; digits: chuỗi số để khớp cả chữ (vd "1392" của toà 1392QT). */
  | { mode: 'amount'; amount: number; digits: string }
  | { mode: 'text'; tokens: string[] };

/**
 * Cùng thứ tự ưu tiên ô tìm Thu chi (resolveSearch trong roomCodeSearch.ts): mã phòng có thật → số tiền ±5.000đ →
 * chữ (tên/mã phiếu, hạng mục, phòng, toà). Lọc trên dữ liệu đã tải nên "phòng có thật" = có dòng mang phòng đó.
 * Khác Thu chi một chỗ: số 1–3 chữ số không trùng phòng nào thì tìm như CHỮ (vd "331" trong "331PHI") vì số tiền
 * thật luôn ≥ 4 chữ số; số ≥ 4 chữ số khớp số tiền HOẶC chữ chứa số đó.
 */
export function resolveProfitRowSearch(
  raw: string,
  roomNames: Iterable<string | null | undefined>,
): ProfitRowSearch {
  const trimmed = raw.trim();
  if (!trimmed) return { mode: 'none' };
  if (isRoomCodeQuery(trimmed)) {
    const want = foldVi(trimmed);
    for (const name of roomNames) if (name && foldVi(name) === want) return { mode: 'room', room: want };
  }
  const digits = trimmed.replace(/[\s.,đdĐ]/g, '');
  if (/^\d{4,}$/.test(digits)) return { mode: 'amount', amount: Number(digits), digits };
  const tokens = foldVi(trimmed).split(' ').filter(Boolean);
  return tokens.length > 0 ? { mode: 'text', tokens } : { mode: 'none' };
}

/** Một dòng đưa vào bộ lọc xem — mỗi trang tự chuyển dòng của nó sang dạng này. */
export interface ProfitViewRow {
  key: string;
  /** Hạng mục của dòng — ĐÚNG tên đưa vào "Theo hạng mục" (categorySharesOf). */
  name: string;
  amount: number;
  isNote?: boolean;
  room?: string | null;
  /** Chữ người dùng có thể gõ để tìm: mô tả đang hiện, tên phiếu, mã phiếu, hạng mục, phòng, toà. */
  texts: readonly (string | null | undefined)[];
}

const haystackOf = (row: ProfitViewRow): string => foldVi(row.texts.filter(Boolean).join(' '));

export function matchesProfitRowSearch(row: ProfitViewRow, search: ProfitRowSearch): boolean {
  switch (search.mode) {
    case 'none':
      return true;
    case 'room':
      // tìm theo phòng giữ cả dòng ghi chú của phòng đó (trống, chưa thu…)
      return foldVi(row.room) === search.room;
    case 'amount':
      return (
        (!row.isNote && Math.abs(row.amount - search.amount) <= AMOUNT_SEARCH_TOLERANCE) ||
        haystackOf(row).includes(search.digits)
      );
    case 'text': {
      const haystack = haystackOf(row);
      return search.tokens.every((t) => haystack.includes(t));
    }
  }
}

/** Đã tích hạng mục ⇒ dòng phải thuộc ÍT NHẤT một mục đã tích (dòng ghi chú không thuộc mục nào nên ẩn). */
export function rowInCategories(
  row: ProfitViewRow,
  selected: ReadonlySet<string>,
  parts?: ReadonlyMap<string, InvoiceAmountParts>,
): boolean {
  if (selected.size === 0) return true;
  return rowCategoryAmounts(row, parts).some((c) => selected.has(c.name));
}

export interface ProfitViewFilter {
  search: string;
  categories: ReadonlySet<string>;
}

export interface ProfitViewResult<T> {
  rows: T[];
  /** Đang có ô tìm hoặc ô tích ⇒ hiện thanh "Đang lọc". */
  active: boolean;
  /** Số khoản thật (bỏ dòng ghi chú) còn lại. */
  count: number;
  /** Σ số tiền các khoản còn lại. */
  total: number;
  /** Σ phần thuộc các hạng mục đã tích của các khoản còn lại (khoản thu theo hoá đơn chỉ cộng phần đó). */
  selectedAmount: number;
}

export function filterProfitRows<T>(
  rows: readonly T[],
  toView: (row: T) => ProfitViewRow,
  filter: ProfitViewFilter,
  parts?: ReadonlyMap<string, InvoiceAmountParts>,
): ProfitViewResult<T> {
  const views = rows.map(toView);
  const search = resolveProfitRowSearch(filter.search, views.map((v) => v.room));
  const active = search.mode !== 'none' || filter.categories.size > 0;
  if (!active) {
    const real = views.filter((v) => !v.isNote);
    return {
      rows: [...rows],
      active,
      count: real.length,
      total: real.reduce((s, v) => s + v.amount, 0),
      selectedAmount: 0,
    };
  }
  const out: T[] = [];
  let count = 0;
  let total = 0;
  let selectedAmount = 0;
  rows.forEach((row, i) => {
    const v = views[i];
    if (!v || !matchesProfitRowSearch(v, search) || !rowInCategories(v, filter.categories, parts)) return;
    out.push(row);
    if (v.isNote) return;
    count += 1;
    total += v.amount;
    for (const c of rowCategoryAmounts(v, parts)) if (filter.categories.has(c.name)) selectedAmount += c.amount;
  });
  return { rows: out, active, count, total, selectedAmount };
}

/** Bật/tắt một hạng mục (trả tập mới, không sửa tập cũ). */
export function toggleCategorySelection(selected: ReadonlySet<string>, name: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** Bỏ các hạng mục không còn trong danh sách mới (đổi tháng/toà); không bỏ gì ⇒ trả lại ĐÚNG tập cũ. */
export function pruneCategorySelection(
  selected: ReadonlySet<string>,
  names: Iterable<string>,
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const present = new Set(names);
  const kept = [...selected].filter((n) => present.has(n));
  return kept.length === selected.size ? selected : new Set(kept);
}

/**
 * Dữ liệu đổi (tháng/toà/chế độ): bỏ hạng mục không còn ở từng bên. `null` = tên hạng mục bên đó CHƯA chốt (đang tải,
 * phần tách hoá đơn còn là số của lần trước, lỗi) ⇒ giữ nguyên ô đã tích. Không đổi gì ⇒ trả lại ĐÚNG object cũ.
 */
export function pruneSideSelections<K extends string>(
  picked: Readonly<Record<K, ReadonlySet<string>>>,
  names: Readonly<Record<K, readonly string[] | null>>,
): Readonly<Record<K, ReadonlySet<string>>> {
  let next: Record<K, ReadonlySet<string>> | null = null;
  for (const side of Object.keys(picked) as K[]) {
    const list = names[side];
    if (list === null) continue;
    const kept = pruneCategorySelection(picked[side], list);
    if (kept !== picked[side]) (next ??= { ...picked })[side] = kept;
  }
  return next ?? picked;
}

export const NO_CATEGORIES: ReadonlySet<string> = new Set<string>();
