// Đọc NGÀY phát sinh và KỲ THÁNG trong câu báo chi ("hôm qua", "25/9", "tiền điện tháng 9").
//
// `today` truyền từ ngoài (trang dùng `vnTodayISO()`), nên hàm thuần và test không phụ
// thuộc giờ máy. Luật chung: câu KHÔNG ghi năm thì không bao giờ tự ra ngày/kỳ tương lai —
// "3/10" gõ ngày 01/10 là 03/10 năm ngoái, "tháng 12" gõ tháng 10 là tháng 12 năm ngoái.
// Kỳ tháng quan trọng vì bộ máy chi tính trần điện nước theo kỳ của DÒNG phiếu.

import { addDaysISO } from "../vnDate";
import { normalizeLoose } from "../textMatch";
import { normalizeForParse } from "./amount";

export interface DateHint {
  /** "YYYY-MM-DD". */
  date: string;
  /** Vị trí trên chuỗi `normalizeForParse(text)`. */
  textStart: number;
  textEnd: number;
}

export interface PeriodHint {
  /** Ngày đầu kỳ "YYYY-MM-01". */
  start: string;
  /** Ngày cuối kỳ (ngày cuối tháng). */
  end: string;
  textStart: number;
  textEnd: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= lastDay(y, m);
}

function parseToday(today: string): { y: number; m: number; d: number } {
  const [y, m, d] = today.split("-").map(Number);
  return { y, m, d };
}

/**
 * Bản không dấu dùng để so chữ. Bỏ dấu tiếng Việt giữ nguyên độ dài chuỗi NFC
 * (mỗi chữ có dấu → đúng một chữ gốc) nên vị trí khớp trên hai chuỗi trùng nhau.
 */
function looseOf(norm: string): string {
  const loose = normalizeLoose(norm);
  return loose.length === norm.length ? loose : norm;
}

interface Hit<T> {
  value: T;
  index: number;
  length: number;
}

function earliest<T>(hits: Array<Hit<T> | null>): Hit<T> | null {
  let best: Hit<T> | null = null;
  for (const h of hits) if (h && (!best || h.index < best.index)) best = h;
  return best;
}

const B = "(?<![\\p{L}\\d])"; // không dính chữ/số phía trước
const RELATIVE: Array<[RegExp, number]> = [
  [new RegExp(`${B}(?:hom|sang|trua|chieu|toi|bua) nay(?![\\p{L}\\d])`, "u"), 0],
  [new RegExp(`${B}(?:hom|sang|trua|chieu|toi|bua|dem) qua(?![\\p{L}\\d])`, "u"), -1],
  [new RegExp(`${B}(?:hom|bua) kia(?![\\p{L}\\d])`, "u"), -2],
];
const NUMERIC_DATE = new RegExp(`${B}(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{4}|\\d{2}))?(?![\\p{L}\\d/-])`, "u");
// "ngày D" chỉ nhận có dấu: "ngay" không dấu còn nghĩa "ngay lập tức" ("trả ngay 5 nghìn").
const DAY_OF_MONTH = new RegExp(`${B}ngày (\\d{1,2})(?![\\p{L}\\d/-])`, "u");

/** Ngày phát sinh sớm nhất nhắc trong câu; null nếu không có. */
export function findDateHint(text: string, today: string): DateHint | null {
  const norm = normalizeForParse(text ?? "");
  const loose = looseOf(norm);
  const t = parseToday(today);

  const relative = RELATIVE.map(([re, offset]): Hit<string> | null => {
    const m = re.exec(loose);
    const date = m ? addDaysISO(today, offset) : null;
    return m && date ? { value: date, index: m.index, length: m[0].length } : null;
  });

  const numeric = ((): Hit<string> | null => {
    const m = NUMERIC_DATE.exec(norm);
    if (!m) return null;
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : t.y;
    if (!validYmd(y, mo, d)) return null;
    if (!m[3] && iso(y, mo, d) > today) {
      y -= 1;
      if (!validYmd(y, mo, d)) return null;
    }
    return { value: iso(y, mo, d), index: m.index, length: m[0].length };
  })();

  const dayOfMonth = ((): Hit<string> | null => {
    const m = DAY_OF_MONTH.exec(norm);
    if (!m) return null;
    const d = Number(m[1]);
    let y = t.y;
    let mo = t.m;
    if (validYmd(y, mo, d) && iso(y, mo, d) > today) {
      mo -= 1;
      if (mo === 0) {
        mo = 12;
        y -= 1;
      }
    }
    if (!validYmd(y, mo, d)) return null;
    return { value: iso(y, mo, d), index: m.index, length: m[0].length };
  })();

  const hit = earliest([...relative, numeric, dayOfMonth]);
  return hit ? { date: hit.value, textStart: hit.index, textEnd: hit.index + hit.length } : null;
}

const MONTH_NUMBER = new RegExp(`${B}(?:thang (\\d{1,2})(?:[/-](\\d{4}))?|t(\\d{1,2}))(?![\\p{L}\\d])`, "u");
const MONTH_RELATIVE: Array<[RegExp, number]> = [
  [new RegExp(`${B}thang nay(?![\\p{L}\\d])`, "u"), 0],
  [new RegExp(`${B}thang truoc(?![\\p{L}\\d])`, "u"), -1],
];

function monthPeriod(y: number, m: number): { start: string; end: string } {
  return { start: iso(y, m, 1), end: iso(y, m, lastDay(y, m)) };
}

/** Kỳ tháng nhắc trong câu ("tháng 9", "T9", "tháng trước"); null nếu không có. */
export function findPeriodHint(text: string, today: string): PeriodHint | null {
  const norm = normalizeForParse(text ?? "");
  const loose = looseOf(norm);
  const t = parseToday(today);

  const numbered = ((): Hit<{ start: string; end: string }> | null => {
    const m = MONTH_NUMBER.exec(loose);
    if (!m) return null;
    const mo = Number(m[1] ?? m[3]);
    if (mo < 1 || mo > 12) return null;
    let y = m[2] ? Number(m[2]) : t.y;
    if (!m[2] && (y > t.y || (y === t.y && mo > t.m))) y -= 1;
    return { value: monthPeriod(y, mo), index: m.index, length: m[0].length };
  })();

  const relative = MONTH_RELATIVE.map(([re, offset]): Hit<{ start: string; end: string }> | null => {
    const m = re.exec(loose);
    if (!m) return null;
    let y = t.y;
    let mo = t.m + offset;
    if (mo === 0) {
      mo = 12;
      y -= 1;
    }
    return { value: monthPeriod(y, mo), index: m.index, length: m[0].length };
  });

  const hit = earliest([numbered, ...relative]);
  return hit
    ? { start: hit.value.start, end: hit.value.end, textStart: hit.index, textEnd: hit.index + hit.length }
    : null;
}
