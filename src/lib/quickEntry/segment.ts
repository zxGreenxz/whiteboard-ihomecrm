// Tách MỘT tin nhắn báo chi thành nhiều KHOẢN ("bóng đèn 60k, ống nước 80k").
//
// Hai tầng:
//   1. Dấu ngăn tường minh: xuống dòng, ";", "+", "và", dấu phẩy không nằm giữa hai chữ số
//      ("1,2tr" giữ nguyên).
//   2. Câu nói liền không dấu ngăn (thường là bản chữ từ giọng nói): cắt giữa các số tiền
//      cùng hạng cao nhất. Câu mở đầu bằng số tiền ("60k bóng đèn 80k ống nước") ⇒ cắt
//      TRƯỚC mỗi số tiếp theo; ngược lại cắt SAU mỗi số. Số trần không dùng để cắt (dễ là số
//      lượng). Có chữ "tổng" trước một số ⇒ cả đoạn là một khoản với số tổng đó.
// Đoạn đứng riêng CHỈ gồm "tổng … <số tiền>" (sau dấu ngăn) được đánh dấu `isTotal` — dòng đối chiếu.
// Đoạn không có số tiền nhập vào đoạn liền trước (hoặc đoạn có tiền đầu tiên nếu nó đứng
// đầu) — "điện và nước 500k" là MỘT khoản.

import {
  findMoneyCandidates,
  normalizeForParse,
  pickAmount,
  type AmountPick,
  type MoneyCandidate,
  type MoneyKind,
} from "./amount";

export interface Segment {
  /** Đoạn trên chuỗi đã chuẩn hoá, bỏ khoảng trắng/dấu ngăn hai đầu. */
  text: string;
  /** Vị trí trên `normalizeForParse(message)`. */
  textStart: number;
  textEnd: number;
  /** Vị trí `amount.candidate` cũng tính trên cả tin nhắn. */
  amount: AmountPick | null;
  /**
   * Đoạn CHỈ gồm từ báo tổng + số tiền ("…, keo 20k, tổng 320k"): dòng tổng người gõ để đối chiếu,
   * không phải một khoản chi. Bộ dựng thẻ bỏ nó khỏi các dòng và so với tổng các dòng.
   */
  isTotal: boolean;
}

interface Range {
  start: number;
  end: number;
}

const SEPARATOR_RE = /\n|;|\+|(?<!\d),|,(?!\d)|\s+và\s+/gu;
const EDGE_RE = /[\s,;+.:\-–—]/u;
// Từ báo TỔNG. "cộng" đứng một mình là CỘNG THÊM ("sơn 300k cộng keo 20k", "cộng thêm tiền công")
// và "tong" không dấu có thể là "tông đơ" ⇒ không nằm trong danh sách.
const TOTAL_WORDS = "tổng cộng|tổng tiền|tổng số|tổng|tất cả|cộng lại|tong cong";
const TOTAL_CUE_RE = new RegExp(`(?:${TOTAL_WORDS})\\s*(?:là|hết|=)?\\s*:?\\s*$`, "u");
// Dòng tổng đứng riêng CHỈ gồm từ báo tổng + số tiền ("tổng 320k", "tổng cộng: 320.000đ", "tất cả hết
// 90k"). "tất cả đồ điện 500k", "tổng vệ sinh 800k" là tên khoản chi, không phải dòng tổng.
const TOTAL_LINE_HEAD_RE = new RegExp(`^(?:${TOTAL_WORDS})\\s*(?:là|hết|=)?\\s*:?\\s*$`, "u");
const TOTAL_LINE_TAIL_RE = /^\s*(?:đ|đồng|vnđ|vnd)?\s*[.!]?\s*$/u;
const RANK: MoneyKind[] = ["explicit", "slang", "bare"];

function trim(norm: string, r: Range): Range | null {
  let { start, end } = r;
  while (start < end && EDGE_RE.test(norm[start])) start += 1;
  while (end > start && EDGE_RE.test(norm[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
}

function splitBySeparators(norm: string): Range[] {
  const out: Range[] = [];
  let last = 0;
  for (const m of norm.matchAll(SEPARATOR_RE)) {
    const at = m.index ?? 0;
    const piece = trim(norm, { start: last, end: at });
    if (piece) out.push(piece);
    last = at + m[0].length;
  }
  const tail = trim(norm, { start: last, end: norm.length });
  if (tail) out.push(tail);
  return out;
}

function topRank(cands: MoneyCandidate[]): MoneyCandidate[] {
  for (const kind of RANK) {
    const same = cands.filter((c) => c.kind === kind);
    if (same.length) return same;
  }
  return [];
}

const precededByTotal = (text: string, c: MoneyCandidate): boolean => TOTAL_CUE_RE.test(text.slice(0, c.start));

/** Tầng 2: cắt một đoạn có nhiều số tiền cùng hạng (explicit/slang). */
function splitByAmounts(norm: string, piece: Range): Range[] {
  const text = norm.slice(piece.start, piece.end);
  const top = topRank(findMoneyCandidates(text));
  if (top.length < 2 || top[0].kind === "bare") return [piece];
  if (top.some((c, k) => k > 0 && precededByTotal(text, c))) return [piece];

  const amountFirst = top[0].start === 0;
  const cuts = amountFirst ? top.slice(1).map((c) => c.start) : top.slice(0, -1).map((c) => c.end);
  const out: Range[] = [];
  let from = 0;
  for (const cut of cuts) {
    const r = trim(norm, { start: piece.start + from, end: piece.start + cut });
    if (r) out.push(r);
    from = cut;
  }
  const r = trim(norm, { start: piece.start + from, end: piece.end });
  if (r) out.push(r);
  return out;
}

/** Số tiền của một khoản: có "tổng" thì lấy số tổng, không thì luật hạng của `pickAmount`. */
function pickSegmentAmount(norm: string, r: Range): AmountPick | null {
  const text = norm.slice(r.start, r.end);
  const shift = (c: MoneyCandidate): MoneyCandidate => ({ ...c, start: c.start + r.start, end: c.end + r.start });
  const all = findMoneyCandidates(text);
  const total = [...all].reverse().find((c) => precededByTotal(text, c));
  if (total) {
    return {
      value: total.value,
      kind: total.kind,
      ambiguous: false,
      warning: total.kind === "bare" && total.value < 10_000 ? "small_amount" : null,
      candidate: shift(total),
    };
  }
  const pick = pickAmount(text);
  return pick ? { ...pick, candidate: shift(pick.candidate) } : null;
}

/** Tách tin nhắn thành các khoản, theo thứ tự. Không bao giờ ném lỗi. */
export function segmentMessage(message: string): Segment[] {
  const norm = normalizeForParse(message ?? "");
  const pieces = splitBySeparators(norm).flatMap((p) => splitByAmounts(norm, p));

  const merged: Range[] = [];
  let pending: Range | null = null;
  for (const p of pieces) {
    const hasAmount = findMoneyCandidates(norm.slice(p.start, p.end)).length > 0;
    if (hasAmount) {
      merged.push(pending ? { start: pending.start, end: p.end } : { ...p });
      pending = null;
    } else if (merged.length > 0) {
      merged[merged.length - 1].end = p.end;
    } else {
      pending = pending ? { start: pending.start, end: p.end } : { ...p };
    }
  }
  if (merged.length === 0 && pending) merged.push(pending);

  return merged.map((r) => {
    const text = norm.slice(r.start, r.end);
    const amount = pickSegmentAmount(norm, r);
    const isTotal =
      amount !== null &&
      TOTAL_LINE_HEAD_RE.test(norm.slice(r.start, amount.candidate.start)) &&
      TOTAL_LINE_TAIL_RE.test(norm.slice(amount.candidate.end, r.end));
    return { text, textStart: r.start, textEnd: r.end, amount, isTotal };
  });
}
