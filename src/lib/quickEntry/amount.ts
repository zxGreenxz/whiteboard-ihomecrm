// Bộ đọc SỐ TIỀN tiếng Việt cho trang "Báo chi nhanh" (/chi-tieu).
//
// Nhận cả chữ gõ ("50k", "1tr2", "120.000đ") lẫn bản chữ từ giọng nói ("một trăm hai mươi
// nghìn", "một củ hai"). Thuần, không I/O — trang và test cùng gọi.
//
// Ba hạng ưu tiên khi một đoạn có nhiều số:
//   explicit — có đơn vị rõ ràng (k, nghìn, triệu, tr, tỷ, đ, đồng, vnd) hoặc phân nhóm "1.200.000";
//   slang    — đơn vị lóng (củ = triệu, lít/xị = trăm nghìn): "3 lít xăng 75k" thì 75k thắng;
//   bare     — số trần: dưới 1000 là NGHÌN (khớp `parseQuickAmount` của Tạo phiếu nhanh), từ
//              1000 trở lên là đồng.
// Số trần bị loại khi nó thực ra là số phòng/tháng/ngày/năm, mã dính chữ (102lvt, p301, 9h,
// x2), ngày giờ (25/9, 9:30) hoặc số lượng đứng trước danh từ đếm ("2 cái").

export type MoneyKind = "explicit" | "slang" | "bare";

export interface MoneyCandidate {
  /** Số đồng, nguyên dương. */
  value: number;
  kind: MoneyKind;
  /** Vị trí trên chuỗi `normalizeForParse(text)`. */
  start: number;
  end: number;
}

export interface AmountPick {
  value: number;
  kind: MoneyKind;
  /** Cùng hạng ưu tiên có hơn một số ⇒ thẻ nháp phải cho người dùng chọn lại. */
  ambiguous: boolean;
  /** Số trần nhỏ hơn 10.000đ — nhiều khả năng gõ thiếu "k". */
  warning: "small_amount" | null;
  candidate: MoneyCandidate;
}

/** Trần an toàn: 1.000 tỷ. Lớn hơn coi như đọc nhầm. */
export const MAX_AMOUNT_VND = 1_000_000_000_000;

/** Chuẩn hoá trước khi đọc: NFC + chữ thường. Vị trí trả về tính trên chuỗi này. */
export function normalizeForParse(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

type TokKind = "num" | "word" | "punct";
interface Tok {
  kind: TokKind;
  s: string;
  start: number;
  end: number;
}

const TOKEN_RE = /(\d+(?:[.,]\d+)*)|([\p{L}\p{M}]+)|(\S)/gu;

function tokenize(norm: string): Tok[] {
  const out: Tok[] = [];
  for (const m of norm.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    const kind: TokKind = m[1] !== undefined ? "num" : m[2] !== undefined ? "word" : "punct";
    out.push({ kind, s: m[0], start, end: start + m[0].length });
  }
  return out;
}

const attached = (a: Tok | undefined, b: Tok | undefined): boolean =>
  !!a && !!b && a.end === b.start;

interface UnitInfo {
  value: number;
  kind: Exclude<MoneyKind, "bare">;
  currency?: boolean;
  /** Chỉ nhận khi dính liền số ("50ng", "120000d") — đứng rời dễ là chữ khác. */
  attachedOnly?: boolean;
}

const UNITS: Record<string, UnitInfo> = {
  k: { value: 1e3, kind: "explicit" },
  nghìn: { value: 1e3, kind: "explicit" },
  ngàn: { value: 1e3, kind: "explicit" },
  nghin: { value: 1e3, kind: "explicit" },
  ngan: { value: 1e3, kind: "explicit" },
  ng: { value: 1e3, kind: "explicit", attachedOnly: true },
  tr: { value: 1e6, kind: "explicit" },
  triệu: { value: 1e6, kind: "explicit" },
  trieu: { value: 1e6, kind: "explicit" },
  tỷ: { value: 1e9, kind: "explicit" },
  tỉ: { value: 1e9, kind: "explicit" },
  ty: { value: 1e9, kind: "explicit" },
  đ: { value: 1, kind: "explicit", currency: true },
  d: { value: 1, kind: "explicit", currency: true, attachedOnly: true },
  đồng: { value: 1, kind: "explicit", currency: true },
  dong: { value: 1, kind: "explicit", currency: true },
  vnd: { value: 1, kind: "explicit", currency: true },
  vnđ: { value: 1, kind: "explicit", currency: true },
  củ: { value: 1e6, kind: "slang" },
  lít: { value: 1e5, kind: "slang" },
  lit: { value: 1e5, kind: "slang" },
  xị: { value: 1e5, kind: "slang" },
};

/** Phần lẻ không đơn vị sau một bậc: "1tr2" → 2 thành "200" nghìn; "1 lít 2" → "20" nghìn. */
const REMAINDER: Record<number, { pad: number; scale: number }> = {
  1e9: { pad: 3, scale: 1e6 },
  1e6: { pad: 3, scale: 1e3 },
  1e5: { pad: 2, scale: 1e3 },
  1e3: { pad: 3, scale: 1 },
};

const DIGIT_WORDS: Record<string, number> = {
  không: 0,
  một: 1,
  hai: 2,
  ba: 3,
  bốn: 4,
  năm: 5,
  sáu: 6,
  bảy: 7,
  bẩy: 7,
  tám: 8,
  chín: 9,
};
/** Biến âm chỉ đứng sau "mươi"/"mười": hai mươi MỐT, hai mươi TƯ, mười LĂM. */
const DIGIT_AFTER_TENS: Record<string, number> = { ...DIGIT_WORDS, mốt: 1, tư: 4, lăm: 5, nhăm: 5 };
/** Sau "trăm" nói tắt một chữ số = hàng chục: "trăm hai" = 120, "trăm mốt" = 110, "trăm tư" = 140. */
const DIGIT_AFTER_HUNDRED: Record<string, number> = { ...DIGIT_WORDS, mốt: 1, tư: 4 };

const HALF_WORDS = new Set(["rưỡi", "ruoi"]);
const FILLER_WORDS = new Set(["linh", "lẻ"]);

/** Từ đứng ngay trước khiến số trần sau nó là số phòng/ngày/mã, không phải tiền. */
const CUE_WORDS = new Set([
  "phòng", "phong", "p", "ph", "tầng", "lầu", "tháng", "ngày", "năm", "số", "lần", "mã", "kỳ",
  "đợt", "căn", "tòa", "toà", "toa", "nhà", "khu", "lô", "xe", "biển", "tuần", "lúc", "đơn",
]);

/** Danh từ đếm / đơn vị đo đứng ngay sau ⇒ số trần là SỐ LƯỢNG. */
const COUNT_NOUNS = new Set([
  "cái", "chiếc", "con", "bóng", "cuộn", "bao", "thùng", "hộp", "gói", "lon", "chai", "bịch",
  "túi", "bộ", "cây", "tấm", "thanh", "sợi", "mét", "m", "cm", "kg", "ký", "kí", "lạng", "g",
  "gam", "người", "phòng", "lần", "buổi", "ngày", "tháng", "năm", "tuần", "giờ", "phút",
  "tiếng", "h", "cặp", "đôi", "viên", "cuốn", "quyển", "tờ", "ổ", "khối", "xe", "suất", "phần",
  "ly", "cốc", "tô", "bát", "đĩa",
]);

const isWord = (t: Tok | undefined, ...ws: string[]): boolean =>
  !!t && t.kind === "word" && ws.includes(t.s);

// ── Nhóm 0–999 đọc bằng chữ ────────────────────────────────────────────────

interface Group {
  value: number;
  next: number;
  /** Có "trăm"/"mươi"/"mười"/"chục" — chữ số đứng trơ trọi thì không phải tiền nếu thiếu đơn vị. */
  magnitude: boolean;
  hundreds: boolean;
}

/** Chữ số 0–9: chữ, hoặc token số MỘT chữ số đứng trước "trăm"/"mươi"/"chục". */
function digitAt(toks: Tok[], j: number, allowNum: boolean): number | null {
  const t = toks[j];
  if (!t) return null;
  if (t.kind === "word" && t.s in DIGIT_WORDS) return DIGIT_WORDS[t.s];
  if (allowNum && t.kind === "num" && /^\d$/.test(t.s)) return Number(t.s);
  return null;
}

function parseTens(toks: Tok[], j: number): { value: number; next: number } | null {
  if (isWord(toks[j], "mười")) {
    const after = toks[j + 1];
    if (after?.kind === "word" && after.s in DIGIT_AFTER_TENS && after.s !== "không") {
      return { value: 10 + DIGIT_AFTER_TENS[after.s], next: j + 2 };
    }
    return { value: 10, next: j + 1 };
  }
  const d = digitAt(toks, j, true);
  if (d !== null && d > 0 && isWord(toks[j + 1], "mươi")) {
    const after = toks[j + 2];
    if (after?.kind === "word" && after.s in DIGIT_AFTER_TENS && after.s !== "không") {
      return { value: d * 10 + DIGIT_AFTER_TENS[after.s], next: j + 3 };
    }
    return { value: d * 10, next: j + 2 };
  }
  if (d !== null && isWord(toks[j + 1], "chục")) {
    if (toks[j + 2] && HALF_WORDS.has(toks[j + 2].s)) return { value: d * 10 + 5, next: j + 3 };
    return { value: d * 10, next: j + 2 };
  }
  return null;
}

function parseGroup(toks: Tok[], i: number): Group | null {
  const d0 = digitAt(toks, i, true);
  if (d0 !== null && isWord(toks[i + 1], "trăm")) {
    let value = d0 * 100;
    let j = i + 2;
    const t = toks[j];
    if (t && FILLER_WORDS.has(t.s)) {
      const d = digitAt(toks, j + 1, false);
      if (d !== null) {
        value += d;
        j += 2;
      }
    } else if (t && HALF_WORDS.has(t.s)) {
      value += 50;
      j += 1;
    } else {
      const tens = parseTens(toks, j);
      if (tens) {
        value += tens.value;
        j = tens.next;
      } else if (t?.kind === "word" && t.s in DIGIT_AFTER_HUNDRED && t.s !== "không") {
        value += DIGIT_AFTER_HUNDRED[t.s] * 10;
        j += 1;
      }
    }
    return { value, next: j, magnitude: true, hundreds: true };
  }
  const tens = parseTens(toks, i);
  if (tens) return { value: tens.value, next: tens.next, magnitude: true, hundreds: false };
  const w = digitAt(toks, i, false);
  if (w !== null) return { value: w, next: i + 1, magnitude: false, hundreds: false };
  return null;
}

// ── Một "lượng" trước đơn vị: số gõ hoặc nhóm chữ ──────────────────────────

interface Quantity {
  /** Tử số nguyên; giá trị = num / den. */
  num: number;
  den: number;
  next: number;
  /** Chuỗi chữ số gốc (giữ số 0 đầu, "05") — dùng cho phần lẻ "1tr05". */
  digits: string | null;
  grouped: boolean;
  decimal: boolean;
  fromWords: boolean;
  magnitude: boolean;
  hundreds: boolean;
}

const GROUPED_RE = /^\d{1,3}(?:[.,]\d{3})+$/;
const DECIMAL_RE = /^(\d+)[.,](\d{1,2})$/;

function parseQuantity(toks: Tok[], j: number): Quantity | null {
  const t = toks[j];
  if (!t) return null;
  if (t.kind === "word") {
    const g = parseGroup(toks, j);
    if (!g) return null;
    return {
      num: g.value, den: 1, next: g.next, digits: g.hundreds ? null : String(g.value),
      grouped: false, decimal: false, fromWords: true, magnitude: g.magnitude, hundreds: g.hundreds,
    };
  }
  if (t.kind !== "num") return null;
  // "2 trăm", "5 chục", "2 mươi" — chữ số gõ đứng trước bậc đọc bằng chữ.
  if (/^\d$/.test(t.s) && isWord(toks[j + 1], "trăm", "mươi", "chục")) {
    const g = parseGroup(toks, j);
    if (g) {
      return {
        num: g.value, den: 1, next: g.next, digits: g.hundreds ? null : String(g.value),
        grouped: false, decimal: false, fromWords: true, magnitude: true, hundreds: g.hundreds,
      };
    }
  }
  if (/^\d+$/.test(t.s)) {
    // Phân nhóm bằng dấu cách: "1 200 000" — chỉ nhận khi ≥2 nhóm 3 số, hoặc 1 nhóm rồi đơn vị tiền.
    if (t.s.length <= 3) {
      const groups: Tok[] = [];
      let k = j + 1;
      while (toks[k]?.kind === "num" && /^\d{3}$/.test(toks[k].s) && !attached(toks[k - 1], toks[k])) {
        groups.push(toks[k]);
        k += 1;
      }
      const currencyNext = toks[k]?.kind === "word" && UNITS[toks[k].s]?.currency === true;
      if (groups.length >= 2 || (groups.length === 1 && currencyNext)) {
        const s = t.s + groups.map((g) => g.s).join("");
        return {
          num: Number(s), den: 1, next: k, digits: null,
          grouped: true, decimal: false, fromWords: false, magnitude: false, hundreds: false,
        };
      }
    }
    return {
      num: Number(t.s), den: 1, next: j + 1, digits: t.s,
      grouped: false, decimal: false, fromWords: false, magnitude: false, hundreds: false,
    };
  }
  if (GROUPED_RE.test(t.s)) {
    return {
      num: Number(t.s.replace(/[.,]/g, "")), den: 1, next: j + 1, digits: null,
      grouped: true, decimal: false, fromWords: false, magnitude: false, hundreds: false,
    };
  }
  const dm = DECIMAL_RE.exec(t.s);
  if (dm) {
    const den = 10 ** dm[2].length;
    return {
      num: Number(dm[1]) * den + Number(dm[2]), den, next: j + 1, digits: null,
      grouped: false, decimal: true, fromWords: false, magnitude: false, hundreds: false,
    };
  }
  return null;
}

function readUnit(toks: Tok[], k: number): { info: UnitInfo; next: number } | null {
  const t = toks[k];
  if (!t || t.kind !== "word") return null;
  const info = UNITS[t.s];
  if (!info) return null;
  if (info.attachedOnly && !attached(toks[k - 1], t)) return null;
  return { info, next: k + 1 };
}

/** Phần lẻ không đơn vị sau bậc `unit`; null nếu không đọc được thành phần lẻ. */
function remainderValue(q: Quantity, unit: number): number | null {
  const rule = REMAINDER[unit];
  if (!rule || q.decimal || q.grouped) return null;
  if (q.hundreds) {
    if (unit < 1e3 || unit === 1e5 || q.num > 999) return null;
    return q.num * (unit / 1e3);
  }
  const digits = q.digits;
  if (!digits || digits.length > rule.pad) return null;
  return Number(digits.padEnd(rule.pad, "0")) * rule.scale;
}

interface Phrase {
  value: number;
  kind: MoneyKind;
  next: number;
}

function parsePhrase(toks: Tok[], i: number): Phrase | null {
  const first = parseQuantity(toks, i);
  if (!first) return null;
  const firstUnit = readUnit(toks, first.next);
  if (!firstUnit) {
    if (first.decimal) return null;
    if (first.grouped) return { value: first.num, kind: "explicit", next: first.next };
    if (first.fromWords && !first.magnitude) return null;
    if (first.num <= 0) return null;
    return { value: first.num < 1000 ? first.num * 1000 : first.num, kind: "bare", next: first.next };
  }

  let total = 0;
  let lastUnit = Number.POSITIVE_INFINITY;
  let kind: MoneyKind = firstUnit.info.kind;
  let j = i;
  let q: Quantity | null = first;
  let unit: { info: UnitInfo; next: number } | null = firstUnit;

  while (q && unit) {
    const u = unit.info;
    if (u.value >= lastUnit) break;
    if (u.currency) {
      if (q.decimal) return null;
      total += q.num;
      j = unit.next;
      kind = "explicit";
      lastUnit = 1;
      break;
    }
    // num/den * u.value — den ∈ {1, 10, 100}, u.value ≥ 1e3 ⇒ luôn nguyên.
    total += (q.num * u.value) / q.den;
    if (u.kind === "explicit") kind = "explicit";
    lastUnit = u.value;
    j = unit.next;
    if (toks[j] && HALF_WORDS.has(toks[j].s)) {
      total += u.value / 2;
      j += 1;
      break;
    }
    const nextQ = parseQuantity(toks, j);
    if (!nextQ) break;
    const nextUnit = readUnit(toks, nextQ.next);
    if (!nextUnit) {
      // Phần lẻ ("1tr2", "một triệu hai") — trừ khi nó là số lượng của danh từ đếm phía sau.
      if (isWord(toks[nextQ.next], ...COUNT_NOUNS)) break;
      const rem = remainderValue(nextQ, u.value);
      if (rem !== null) {
        total += rem;
        j = nextQ.next;
      }
      break;
    }
    q = nextQ;
    unit = nextUnit;
  }

  // "… nghìn đồng": đuôi đơn vị tiền sau cả cụm.
  if (lastUnit > 1) {
    const tail = readUnit(toks, j);
    if (tail?.info.currency) j = tail.next;
  }
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  return { value: total, kind, next: j };
}

/** Số trần này thực ra là phòng/ngày/mã/số lượng? */
function bareExcluded(toks: Tok[], startTok: number, endTok: number): boolean {
  const first = toks[startTok];
  const last = toks[endTok - 1];
  const before = toks[startTok - 1];
  const after = toks[endTok];

  // Dính chữ phía sau ("102lvt", "9h", "50kg"). Dính chữ phía trước ("p301", "x2") đã bị
  // `findMoneyCandidates` loại cho MỌI hạng.
  if (after?.kind === "word" && attached(last, after)) return true;
  // Ngày giờ: 25/9, 9:30, 25-9.
  if (before?.kind === "punct" && "/:-".includes(before.s) && attached(before, first)) return true;
  if (after?.kind === "punct" && "/:-".includes(after.s) && attached(last, after)) {
    const afterNext = toks[endTok + 1];
    if (afterNext?.kind === "num" && attached(after, afterNext)) return true;
  }
  if (after?.kind === "punct" && after.s === "%") return true;
  // Từ báo hiệu đứng ngay trước (cho phép một dấu chấm/gạch dính: "P.301").
  let cue = before;
  if (cue?.kind === "punct" && ".-".includes(cue.s) && attached(cue, first)) cue = toks[startTok - 2];
  if (cue?.kind === "word" && CUE_WORDS.has(cue.s)) return true;
  // Số lượng: "2 cái", "3 bóng".
  if (after?.kind === "word" && COUNT_NOUNS.has(after.s)) return true;
  return false;
}

/** Mọi số tiền trong câu, theo thứ tự xuất hiện. Không bao giờ ném lỗi. */
export function findMoneyCandidates(text: string): MoneyCandidate[] {
  const norm = normalizeForParse(text ?? "");
  const toks = tokenize(norm);
  const out: MoneyCandidate[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === "punct") {
      i += 1;
      continue;
    }
    const p = parsePhrase(toks, i);
    if (!p || p.next <= i) {
      i += 1;
      continue;
    }
    const excluded =
      (p.kind === "bare" && bareExcluded(toks, i, p.next)) ||
      (toks[i - 1]?.kind === "word" && attached(toks[i - 1], toks[i]));
    if (!excluded && p.value <= MAX_AMOUNT_VND) {
      out.push({ value: p.value, kind: p.kind, start: toks[i].start, end: toks[p.next - 1].end });
    }
    i = p.next;
  }
  return out;
}

const RANK: MoneyKind[] = ["explicit", "slang", "bare"];

/**
 * Số tiền của MỘT đoạn (một khoản chi): lấy hạng ưu tiên cao nhất có mặt, trong hạng đó lấy số
 * cuối; nhiều số cùng hạng ⇒ `ambiguous`. null khi không có số tiền nào.
 */
export function pickAmount(text: string): AmountPick | null {
  const all = findMoneyCandidates(text);
  for (const kind of RANK) {
    const same = all.filter((c) => c.kind === kind);
    if (same.length === 0) continue;
    const candidate = same[same.length - 1];
    return {
      value: candidate.value,
      kind,
      ambiguous: same.length > 1,
      warning: kind === "bare" && candidate.value < 10_000 ? "small_amount" : null,
      candidate,
    };
  }
  return null;
}
