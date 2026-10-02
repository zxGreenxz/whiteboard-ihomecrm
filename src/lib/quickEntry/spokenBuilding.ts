// Nhận ra TOÀ khi người dùng ĐỌC tên toà thay vì gõ mã — trang "Báo chi nhanh" (/chi-tieu).
//
// Mã toà ở công ty là "số nhà + chữ đầu tên đường" (102LVT = 102 Lê Văn Thọ). Người Việt đọc số nhà
// theo nhiều kiểu và máy chép giọng còn nghe lệch, nên bộ dò mã đúng chữ (resolve.ts) trượt hết:
//   "một lẻ hai Lê Văn Thọ", "một trăm lẻ hai LVT", "1 L 2 LVT", "một lá hai Lê Vân Thọ",
//   "một lẻ hai lọ VT", "bốn không năm PVB", "một ba chín hai QT"…
// Hàm ở đây sinh sẵn mọi cách đọc SỐ NHÀ của từng toà (đọc từng chữ số, đọc đủ "trăm/mươi", "lẻ"
// nghe thành "lá/lọ/là/L") rồi dò trong câu: số nhà khớp VÀ ngay sau là phần chữ của mã (chữ đầu
// của các từ, đánh vần, hoặc đúng tên đường lấy từ tên toà) ⇒ chắc chắn; chỉ có số nhà ở đầu câu,
// hoặc chỉ có tên đường ⇒ ĐOÁN, trang chỉ gợi ý để người dùng bấm chọn chứ không tự điền.
//
// So trên chuỗi "lỏng" (bỏ dấu, chữ thường — normalizeLoose) nên "Lê Vân Thọ" = "Lê Văn Thọ".
// Thuần, không I/O, không bao giờ ném lỗi.

import { normalizeLoose, splitAliases, type BuildingRef } from "../textMatch";

export interface LooseToken {
  s: string;
  start: number;
  end: number;
}

export interface SpokenHit {
  id: string;
  /** Vị trí trên chuỗi lỏng đã dò (gồm cả số nhà lẫn phần chữ). */
  start: number;
  end: number;
  /** strong = số nhà + chữ của mã/tên đường; weak = chỉ số nhà ở đầu câu hoặc chỉ tên đường. */
  strength: "strong" | "weak";
}

const TOKEN_RE = /[\p{L}\d]+/gu;

export function looseTokens(loose: string): LooseToken[] {
  return [...loose.matchAll(TOKEN_RE)].map((m) => ({ s: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

// ── Số đọc bằng lời ────────────────────────────────────────────────────────

/** Cách đọc từng chữ số (dạng lỏng). "tu" = tư, "lam" = lăm (chỉ đúng sau hàng chục nhưng người
 *  đọc từng chữ số vẫn hay nói "bốn tư", "một lăm"). */
const DIGIT: readonly string[][] = [
  ["0", "khong"],
  ["1", "mot"],
  ["2", "hai"],
  ["3", "ba"],
  ["4", "bon", "tu"],
  ["5", "nam", "lam"],
  ["6", "sau"],
  ["7", "bay"],
  ["8", "tam"],
  ["9", "chin"],
];

/** "lẻ"/"linh" đọc thay số 0 giữa số. Máy chép giọng hay nghe thành "lá", "lọ", "là", "lễ" (cùng dạng
 *  lỏng "la"/"lo"/"le") hoặc chữ "L" ("1 L 2"). */
const ZERO_FILLER = ["le", "linh", "la", "lo", "l"];
const HUNDRED = ["tram"];
const THOUSAND = ["nghin", "ngan"];
const TEN = ["muoi"];

/** Mỗi vị trí là tập từ chấp nhận. */
type Pattern = string[][];

const d = (n: number): string[] => DIGIT[n];
/** Hàng đơn vị đứng sau "mươi": mốt (=một ở dạng lỏng), tư, lăm/nhăm. */
const unitAfterTens = (n: number): string[] =>
  n === 4 ? ["bon", "tu", "4"] : n === 5 ? ["nam", "lam", "nham", "5"] : d(n);

function tensReadings(n: number): Pattern[] {
  if (n < 10) return [[d(n)]];
  const tens = Math.floor(n / 10);
  const unit = n % 10;
  if (tens === 1) return unit === 0 ? [[TEN]] : [[TEN, unitAfterTens(unit)]];
  if (unit === 0) return [[d(tens), [...TEN, "chuc"]]];
  return [[d(tens), TEN, unitAfterTens(unit)]];
}

function hundredsReadings(n: number): Pattern[] {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const head = [d(h), HUNDRED];
  if (rest === 0) return [head];
  if (rest < 10) return [[...head, ZERO_FILLER, d(rest)]];
  const out = tensReadings(rest).map((p) => [...head, ...p]);
  // Nói tắt: "một trăm hai" = 120, "hai trăm mốt" = 210.
  if (rest % 10 === 0) out.push([...head, unitAfterTens(rest / 10)]);
  return out;
}

/** Cách đọc đầy đủ "trăm/mươi/nghìn" của n (1…9999). */
function formalReadings(n: number): Pattern[] {
  if (n < 100) return tensReadings(n);
  if (n < 1000) return hundredsReadings(n);
  const k = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = [d(k), THOUSAND];
  if (rest === 0) return [head];
  if (rest >= 100) return hundredsReadings(rest).map((p) => [...head, ...p]);
  // 1005 = "một nghìn không trăm lẻ năm", 1050 = "một nghìn không trăm năm mươi".
  const tail = rest < 10 ? [[ZERO_FILLER, d(rest)]] : tensReadings(rest);
  return tail.map((p) => [...head, d(0), HUNDRED, ...p]);
}

/** Đọc từng chữ số: 102 = "một lẻ hai" / "một không hai" / "1 L 2"; 1392 = "một ba chín hai". */
function digitByDigit(num: string): Pattern {
  return [...num].map((ch, i) => {
    const n = Number(ch);
    return n === 0 && i > 0 && i < num.length - 1 ? [...d(0), ...ZERO_FILLER] : d(n);
  });
}

/** Mọi cách đọc số nhà `num` (chuỗi chữ số, không số 0 đầu). */
export function numberPatterns(num: string): Pattern[] {
  if (!/^[1-9]\d{0,3}$/.test(num)) return /^\d+$/.test(num) ? [[[num]]] : [];
  const out: Pattern[] = [[[num]], digitByDigit(num), ...formalReadings(Number(num))];
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = p.map((s) => s.join("|")).join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchPattern(tokens: LooseToken[], i: number, p: Pattern): number {
  for (let k = 0; k < p.length; k += 1) {
    const t = tokens[i + k];
    if (!t || !p[k].includes(t.s)) return -1;
  }
  return i + p.length;
}

/** Vị trí ngay sau cách đọc DÀI NHẤT của `num` bắt đầu ở token i; không khớp ⇒ -1. */
export function matchSpokenNumber(tokens: LooseToken[], i: number, num: string): number {
  let best = -1;
  for (const p of numberPatterns(num)) best = Math.max(best, matchPattern(tokens, i, p));
  return best;
}

// ── Phần chữ của mã ────────────────────────────────────────────────────────

const VOWEL_RE = /[aeiouy]/;

/**
 * Các token từ i "đánh" ra đúng chuỗi `letters` (vd "lvt")? Mỗi token góp: cả token (khi nó trùng
 * đoạn cần — "lvt", "vt", "l"), chữ cái đầu ("le van tho" ⇒ l·v·t; "lọ VT" ⇒ l + vt; "lờ vờ tờ"),
 * hoặc một chữ số khi mã có số ("80DS3": "đường số ba"). Trả vị trí ngay sau, không khớp ⇒ -1.
 */
export function matchLetters(tokens: LooseToken[], i: number, letters: string): number {
  const go = (j: number, pos: number): number => {
    if (pos === letters.length) return j;
    const t = tokens[j];
    if (!t) return -1;
    const rest = letters.slice(pos);
    // Cả token: chỉ khi token là cụm phụ âm/số (viết tắt) hoặc trùng nguyên phần còn lại ("red").
    if ((!VOWEL_RE.test(t.s) || t.s === rest) && rest.startsWith(t.s)) {
      const r = go(j + 1, pos + t.s.length);
      if (r >= 0) return r;
    }
    const want = letters[pos];
    if (/\d/.test(want)) {
      if (DIGIT[Number(want)].includes(t.s)) return go(j + 1, pos + 1);
      return -1;
    }
    if (t.s[0] === want && VOWEL_RE.test(t.s)) return go(j + 1, pos + 1);
    return -1;
  };
  return letters ? go(i, 0) : -1;
}

function matchWords(tokens: LooseToken[], i: number, words: string[]): number {
  for (let k = 0; k < words.length; k += 1) if (tokens[i + k]?.s !== words[k]) return -1;
  return i + words.length;
}

// ── Khoá dò của từng toà ───────────────────────────────────────────────────

interface SpokenKey {
  id: string;
  num: string | null;
  letters: string | null;
  /** Tên đường (dạng lỏng) lấy từ tên toà, chỉ khi chữ đầu của nó trùng phần chữ của mã. */
  street: string[] | null;
}

const NAME_PREFIX = new Set(["toa", "nha", "khu", "can"]);
const compact = (s: string | null | undefined): string => normalizeLoose(s).replace(/[^\p{L}\d]/gu, "");
const CODE_RE = /^([1-9]\d{0,3})([a-z][a-z0-9]*)$/;

/** "Toà 102 Lê Văn Thọ" ⇒ số "102" + các từ sau số. "102/30 Lê Văn Thọ, Gò Vấp" ⇒ "102" + "le van tho"
 *  (bỏ phần sau dấu phẩy đầu — thường là phường/quận). */
function splitName(name: string | null): { num: string | null; words: string[] } {
  const toks = looseTokens(normalizeLoose((name ?? "").split(",")[0])).map((t) => t.s);
  let i = 0;
  while (i < toks.length && NAME_PREFIX.has(toks[i])) i += 1;
  if (i >= toks.length || !/^[1-9]\d{0,3}$/.test(toks[i])) return { num: null, words: [] };
  const num = toks[i];
  i += 1;
  while (i < toks.length && /^\d+$/.test(toks[i])) i += 1; // "102/30" ⇒ bỏ "30"
  return { num, words: toks.slice(i).filter((w) => /^\p{L}+$/u.test(w)) };
}

/** Phần đầu của `words` có chữ đầu đúng bằng `letters` ("le van tho go vap" + "lvt" ⇒ le van tho). */
function streetFor(words: string[], letters: string | null): string[] | null {
  if (!letters || !/^[a-z]+$/.test(letters) || words.length < letters.length) return null;
  const head = words.slice(0, letters.length);
  return head.map((w) => w[0]).join("") === letters ? head : null;
}

function keysFor(b: BuildingRef): SpokenKey[] {
  const out: SpokenKey[] = [];
  const name = splitName(b.name);
  for (const alias of splitAliases(b.code)) {
    const m = CODE_RE.exec(compact(alias));
    if (!m) continue;
    const [, num, letters] = m;
    out.push({ id: b.id, num, letters, street: name.num === num ? streetFor(name.words, letters) : null });
  }
  if (name.num && !out.some((k) => k.num === name.num)) {
    // Tên có số nhà nhưng mã không theo kiểu "số + chữ": dùng chữ đầu tên đường làm phần chữ.
    const street = name.words.length >= 2 ? name.words.slice(0, Math.min(4, name.words.length)) : null;
    out.push({ id: b.id, num: name.num, letters: street ? street.map((w) => w[0]).join("") : null, street });
  }
  return out;
}

// ── Dò ─────────────────────────────────────────────────────────────────────

/** Từ đứng trước số nhà cho biết đó là toà ("nhà 102…", "ở 102…"). */
const PLACE_CUE = new Set(["nha", "toa", "o", "tai", "cho", "can"]);
/** Đứng ngay sau số ⇒ số đó là tiền hoặc số lượng, không phải số nhà. */
const NOT_ADDRESS_NEXT = new Set([
  "k", "nghin", "ngan", "ng", "trieu", "tr", "ty", "ti", "dong", "d", "vnd", "cu", "lit", "xi",
  "cai", "chiec", "con", "bong", "cuon", "bao", "thung", "hop", "goi", "lon", "chai", "bich", "tui",
  "bo", "cay", "tam", "thanh", "soi", "met", "m", "cm", "kg", "ky", "ki", "lang", "g", "nguoi", "lan",
  "ngay", "thang", "nam", "tuan", "gio", "phut", "h", "phong", "p", "ph", "tang", "lau", "tram", "muoi",
]);
/** "102 đường Lê Văn Thọ": bỏ qua chữ "đường" nằm giữa số và tên đường (trừ khi mã cần chữ "d"). */
const STREET_WORD = "duong";

/**
 * Mọi toà được nhắc bằng lời trong `loose` (chuỗi đã qua normalizeLoose). Một toà có thể vừa trúng
 * chắc vừa trúng đoán — người gọi gộp theo `strength`.
 */
export function findSpokenBuildings(loose: string, buildings: BuildingRef[]): SpokenHit[] {
  const tokens = looseTokens(loose);
  if (tokens.length === 0) return [];
  const keys = buildings.flatMap(keysFor);
  const hits: SpokenHit[] = [];
  const hit = (k: SpokenKey, i: number, end: number, strength: SpokenHit["strength"]) =>
    hits.push({ id: k.id, start: tokens[i].start, end: tokens[end - 1].end, strength });

  for (let i = 0; i < tokens.length; i += 1) {
    for (const k of keys) {
      if (k.num) {
        const j = matchSpokenNumber(tokens, i, k.num);
        if (j < 0) continue;
        const skip = tokens[j]?.s === STREET_WORD && k.letters?.[0] !== "d" ? j + 1 : j;
        const tail = Math.max(
          k.letters ? matchLetters(tokens, skip, k.letters) : -1,
          k.street ? matchWords(tokens, skip, k.street) : -1,
        );
        if (tail > 0) {
          hit(k, i, tail, "strong");
          continue;
        }
        const atHead = i === 0 || PLACE_CUE.has(tokens[i - 1].s);
        const next = tokens[j]?.s;
        // Số trơ (không có chữ của mã) chỉ là ĐOÁN, và chỉ khi đứng đầu câu/sau "nhà": "102 sơn" ổn;
        // "mua 102 cái", "102 nghìn", "102.000" thì không.
        if (atHead && (!next || (!NOT_ADDRESS_NEXT.has(next) && !/^\d/.test(next)))) hit(k, i, j, "weak");
      }
    }
    for (const k of keys) {
      // Chỉ nói tên đường ("nhà Lê Văn Thọ"): đoán — một đường có thể có nhiều toà (102LVT, 417LVT).
      if (!k.street || k.street.length < 2) continue;
      const end = matchWords(tokens, i, k.street);
      if (end > 0) hit(k, i, end, "weak");
    }
  }
  return hits;
}

export interface SpokenResolve {
  /** Đúng một toà trúng chắc. */
  building: string | null;
  /** Nhiều toà trúng chắc, hoặc (không toà nào chắc) các toà đoán — có thể chỉ một. */
  candidates: string[];
  /** Có ít nhất một ứng viên chỉ là đoán (số nhà trơ / tên đường). */
  guessed: boolean;
}

/** Gộp các lượt trúng thành kết luận: chắc + duy nhất ⇒ toà; còn lại ⇒ ứng viên để người dùng chọn. */
export function resolveSpokenBuilding(loose: string, buildings: BuildingRef[]): SpokenResolve {
  const hits = findSpokenBuildings(loose, buildings);
  const strong = [...new Set(hits.filter((h) => h.strength === "strong").map((h) => h.id))];
  if (strong.length === 1) return { building: strong[0], candidates: [], guessed: false };
  if (strong.length > 1) return { building: null, candidates: strong, guessed: false };
  const weak = [...new Set(hits.map((h) => h.id))];
  return { building: null, candidates: weak, guessed: weak.length > 0 };
}

/** Mã hiển thị của toà: bí danh đầu của `code`, không có thì tên. */
export function primaryCode(b: BuildingRef): string {
  return splitAliases(b.code)[0] ?? b.name ?? "";
}

/**
 * Thay cụm đọc tên toà (chỉ lượt trúng CHẮC) trong một đoạn chữ bằng mã toà: "một lẻ hai Lê Văn Thọ
 * mua bóng đèn" ⇒ "102LVT mua bóng đèn" — mô tả phiếu giống hệt khi gõ mã. Giữ nguyên chữ hoa/dấu của
 * phần còn lại; chuỗi có ký tự làm lệch độ dài khi bỏ dấu ⇒ trả nguyên văn.
 */
export function canonicalizeSpoken(text: string, buildings: BuildingRef[]): string {
  const nfc = (text ?? "").normalize("NFC");
  const loose = normalizeLoose(nfc);
  if (!nfc || loose.length !== nfc.length) return text;
  const hits = findSpokenBuildings(loose, buildings)
    .filter((h) => h.strength === "strong")
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let last = 0;
  for (const h of hits) {
    if (h.start < last) continue;
    const b = buildings.find((x) => x.id === h.id);
    if (!b) continue;
    out += nfc.slice(last, h.start) + primaryCode(b);
    last = h.end;
  }
  return last === 0 ? text : out + nfc.slice(last);
}

const ROOM_CUE = new Set(["phong", "p", "ph"]);

/**
 * Như canonicalizeSpoken nhưng cho SỐ PHÒNG đọc bằng lời sau chữ báo phòng: "phòng ba lẻ một" ⇒
 * "phòng 301". Chỉ thay khi khớp một phòng có thật trong `rooms` (người gọi truyền phòng của toà đã
 * nhận ra) và cách đọc dài ≥ 2 từ (một chữ số đứng riêng đã là số).
 */
export function canonicalizeSpokenRooms(text: string, rooms: Array<{ name: string | null; code: string | null }>): string {
  const nfc = (text ?? "").normalize("NFC");
  const loose = normalizeLoose(nfc);
  if (!nfc || loose.length !== nfc.length) return text;
  const nums = [
    ...new Set(
      rooms.flatMap((r) => [r.name, r.code]).map((s) => compact(s).replace(/^(phong|ph|p)(?=\d)/, "")).filter((k) => /^[1-9]\d{0,3}$/.test(k)),
    ),
  ];
  if (nums.length === 0) return text;
  const tokens = looseTokens(loose);
  let out = "";
  let last = 0;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (!ROOM_CUE.has(tokens[i].s)) continue;
    let best = -1;
    let bestNum = "";
    for (const num of nums) {
      const end = matchSpokenNumber(tokens, i + 1, num);
      if (end - (i + 1) >= 2 && end > best) {
        best = end;
        bestNum = num;
      }
    }
    if (best < 0) continue;
    out += nfc.slice(last, tokens[i + 1].start) + bestNum;
    last = tokens[best - 1].end;
    i = best - 1;
  }
  return last === 0 ? text : out + nfc.slice(last);
}
