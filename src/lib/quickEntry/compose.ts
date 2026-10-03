// Ghép các mảnh của src/lib/quickEntry thành THẺ NHÁP cho trang "Báo chi nhanh".
//
//   draftsFromText — tin nhắn / bản chữ giọng nói ⇒ thẻ (tách khoản, ngày/kỳ, toà/phòng, hạng
//                    mục), nhóm theo toà + phòng ⇒ mỗi nhóm một phiếu.
//   draftFromBill  — kết quả AI đọc ảnh hoá đơn ⇒ một thẻ.
//   enrichFromAi   — AI bổ sung cho thẻ từ chữ: CHỈ điền ô còn trống.
//   applyAiCategories — như trên, chỉ hạng mục (câu lệnh rút gọn khi thẻ chỉ còn thiếu hạng mục).
//
// AI chỉ điền ô còn TRỐNG (số tiền 0, toà null, kỳ null). Hai ô luôn có giá trị nên cần khoá riêng:
// `touched` (người dùng đã sửa — không gì được đè) và `locked` (ngày nói rõ trong chữ; hạng mục
// theo cụm phí/mã khách hàng/luật categoryRules). Hạng mục đoán theo trùng từ là đoán yếu nên AI
// được thay.
// ID toà/hạng mục luôn do bộ dò cục bộ tra.

import { normalizeForParse } from "./amount";
import { segmentMessage, type Segment } from "./segment";
import { findDateHint, findPeriodHint } from "./dateWords";
import { resolveBuildingMention, resolveBuildingRoom, type ResolveRefs, type ResolveResult } from "./resolve";
import { canonicalizeSpoken, canonicalizeSpokenRooms } from "./spokenBuilding";
import { suggestCategory, type CategoryRef } from "./categorySuggest";
import { groupByPlace } from "./convert";
import { MAX_DESCRIPTION, type DraftLine, type DraftMode, type QuickDraft } from "./draft";
import { MAX_PROMPT_CATEGORIES } from "./prompt";
import type { AiItem, AiResult } from "./aiSchema";

export type DraftFlag =
  | "missing_amount"
  | "small_amount"
  | "ambiguous_amount"
  | "building_choice"
  /** Toà chỉ ĐOÁN từ lời đọc (số nhà trơ — máy chép mất tên đường — hoặc chỉ tên đường): gợi ý để bấm. */
  | "building_guess"
  | "check_total"
  /** Người dùng gõ dòng "tổng …" khác cộng các dòng. */
  | "total_mismatch"
  /** Một dòng bằng đúng tổng các dòng khác — có thể là dòng tổng viết kiểu lạ ("… cộng 320k"). */
  | "maybe_total";

export interface DraftState {
  draft: QuickDraft;
  touched: string[];
  locked: string[];
  flags: DraftFlag[];
  buildingCandidates: string[];
  source: "text" | "photo";
  /** Đoạn câu dựng nên thẻ (rỗng với thẻ ảnh) — AI bổ sung gọi RIÊNG từng thẻ bằng chuỗi này, vì thẻ
   *  gom theo toà/phòng nên thứ tự dòng giữa các thẻ không trùng thứ tự câu. */
  sourceText: string;
}

export interface ComposeContext {
  /** "YYYY-MM-DD" giờ VN. */
  today: string;
  mode: DraftMode;
  refs: ResolveRefs;
  /** Hạng mục chi dùng được — ĐÚNG danh sách (và thứ tự) đã gửi AI. */
  categories: CategoryRef[];
  /** Danh mục ví cá nhân — đúng danh sách đã gửi AI ở chế độ cá nhân. */
  personalCategories?: string[];
  newId: () => string;
  defaultAccountFor: (buildingId: string | null) => string | null;
}

const EDGE_PUNCT = /^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g;
const tidy = (s: string): string => s.replace(/\s+/g, " ").replace(EDGE_PUNCT, "").trim();

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

function nameOf(lines: DraftLine[]): string {
  return lines
    .map((l) => l.description)
    .filter(Boolean)
    .join("; ")
    .slice(0, 120);
}

/** Tên phiếu: bill có cửa hàng thì lấy tên cửa hàng, còn lại ghép mô tả các dòng. */
function nameFor(source: DraftState["source"], vendor: string | null, lines: DraftLine[]): string {
  return source === "photo" && vendor ? vendor.slice(0, 120) : nameOf(lines);
}

/** "cN" ⇒ phần tử thứ N của danh sách đã gửi AI (trong trần prompt). */
function fromIndex<T>(code: string | null, list: readonly T[]): T | null {
  if (!code) return null;
  const n = Number(code.slice(1));
  if (!Number.isInteger(n) || n < 1 || n > Math.min(list.length, MAX_PROMPT_CATEGORIES)) return null;
  return list[n - 1] ?? null;
}

const emptyResolve: ResolveResult = {
  building: null,
  buildingCandidates: [],
  buildingGuessed: false,
  room: null,
  roomMentioned: false,
  buildingWide: false,
  feeCategory: null,
};

export function draftsFromText(text: string, ctx: ComposeContext): DraftState[] {
  const all = segmentMessage(text);
  if (all.length === 0) return [];
  // Dòng "tổng …" đứng riêng chỉ để đối chiếu, không thành khoản chi. Tin CHỈ có dòng tổng ⇒ nó
  // chính là khoản (không bỏ số tiền duy nhất người dùng gõ).
  const segments = all.some((s) => !s.isTotal) ? all.filter((s) => !s.isTotal) : all;
  const declaredTotal = segments === all ? null : ([...all].reverse().find((s) => s.isTotal)?.amount?.value ?? null);
  // Vị trí đoạn câu tính trên bản NFC + chữ thường. Hạ chữ thường không đổi độ dài với chữ Việt ⇒ cắt
  // bản NFC gốc đúng các vị trí đó để giữ chữ hoa người dùng gõ ("Bóng LED"). Lệch độ dài (ký tự lạ
  // như "İ") ⇒ dùng bản chữ thường cho chắc.
  const nfc = (text ?? "").normalize("NFC");
  const keepCase = nfc.length === normalizeForParse(text ?? "").length;
  const casedText = (seg: Segment): string => (keepCase ? nfc.slice(seg.textStart, seg.textEnd) : seg.text);
  const company = ctx.mode === "company";
  const date = findDateHint(text, ctx.today);
  const period = findPeriodHint(text, ctx.today);
  const msg = company ? resolveBuildingRoom(text, ctx.refs) : emptyResolve;

  interface Item {
    text: string;
    buildingId: string | null;
    roomId: string | null;
    line: DraftLine;
    flags: DraftFlag[];
    candidates: string[];
    guessed: boolean;
    lockCategory: boolean;
  }

  const items: Item[] = segments.map((seg) => {
    const place = company ? resolveBuildingRoom(seg.text, ctx.refs) : emptyResolve;
    const buildingId = place.building?.id ?? msg.building?.id ?? null;
    // Phòng nói một lần cho cả tin chỉ áp cho khoản KHÔNG tự nhắc phòng nào. (Tin đã ra được
    // phòng thì cả tin chỉ nhắc đúng một toà, nên khoản thừa hưởng luôn cùng toà với phòng đó.)
    const roomId = place.room?.id ?? (place.roomMentioned ? null : msg.room?.id ?? null);
    const fromPlace = place.buildingCandidates.length > 0;
    const candidates = buildingId ? [] : fromPlace ? place.buildingCandidates : msg.buildingCandidates;
    const guessed = candidates.length > 0 && (fromPlace ? place.buildingGuessed : msg.buildingGuessed);

    const segText = casedText(seg);
    let description = segText;
    if (seg.amount) {
      const a = seg.amount.candidate.start - seg.textStart;
      const b = seg.amount.candidate.end - seg.textStart;
      description = `${segText.slice(0, a)} ${segText.slice(b)}`;
    }
    description = tidy(description);
    // Toà/phòng đọc bằng lời ("một lẻ hai Lê Văn Thọ, phòng ba lẻ một") ⇒ ghi như khi gõ ("102LVT, phòng 301").
    if (company) {
      description = canonicalizeSpoken(description, ctx.refs.buildings);
      if (buildingId) description = canonicalizeSpokenRooms(description, ctx.refs.rooms.filter((r) => r.building_id === buildingId));
    }

    const suggestion = company
      ? suggestCategory(ctx.categories, description, { feeCategory: place.feeCategory ?? msg.feeCategory })
      : null;

    const flags: DraftFlag[] = [];
    if (!seg.amount) flags.push("missing_amount");
    else {
      if (seg.amount.warning === "small_amount") flags.push("small_amount");
      if (seg.amount.ambiguous) flags.push("ambiguous_amount");
    }

    return {
      text: tidy(segText),
      buildingId: company ? buildingId : null,
      roomId: company ? roomId : null,
      line: {
        description,
        amount: seg.amount?.value ?? 0,
        // Gợi ý yếu của luật dòng tiền (nội bộ / hoàn cọc thiếu neo chắc) KHÔNG điền sẵn: AI chọn; AI null /
        // lỗi thì ô trống và người dùng phải chọn — điền sẵn mà lưu luôn là khoản chi thật thành INTERNAL.
        categoryId: suggestion && suggestion.reason !== "rule_weak" ? suggestion.id : null,
        personalCategory: null,
        periodStart: period?.start ?? null,
        periodEnd: period?.end ?? null,
      },
      flags,
      candidates,
      guessed,
      // Đoán yếu (trùng chữ) ⇒ điền nhưng không khoá: AI được thay.
      lockCategory: suggestion !== null && suggestion.reason !== "name_overlap" && suggestion.reason !== "rule_weak",
    };
  });

  const groups = company
    ? groupByPlace(items.map((it) => ({ buildingId: it.buildingId, roomId: it.roomId, line: it.line })))
    : [{ buildingId: null, roomId: null, lines: items.map((it) => it.line) }];
  // Tổng gõ là tổng CẢ TIN (mọi thẻ) — lệch thì mọi thẻ của tin đều nhắc kiểm lại.
  const sumAll = items.reduce((s, it) => s + it.line.amount, 0);
  const totalMismatch = declaredTotal !== null && sumAll !== declaredTotal;
  // Lưới an toàn cho dòng tổng viết kiểu lạ: một dòng (trong ≥3 dòng) bằng đúng tổng các dòng còn lại
  // (2a = cộng tất cả). KHÔNG tự bỏ — khoản thật cũng có thể trùng tổng — chỉ nhắc kiểm lại. Người dùng
  // đã gõ dòng tổng và tổng đó khớp ⇒ không nhắc.
  const maybeTotal =
    declaredTotal !== sumAll &&
    items.length >= 3 &&
    items.some((it) => it.line.amount > 0 && it.line.amount * 2 === sumAll);

  return groups.map((g) => {
    const members = items.filter((it) => g.lines.includes(it.line));
    const candidates = unique(members.flatMap((m) => m.candidates));
    const flags = unique(members.flatMap((m) => m.flags));
    if (!g.buildingId && candidates.length > 0 && company) {
      // Ứng viên chỉ là đoán (có thể một) ⇒ nhắc "nghe giống"; nhiều toà nhắc rõ ⇒ nhắc chọn.
      if (members.some((m) => m.guessed)) flags.push("building_guess");
      else if (candidates.length > 1) flags.push("building_choice");
    }
    if (totalMismatch) flags.push("total_mismatch");
    if (maybeTotal) flags.push("maybe_total");
    const locked: string[] = [];
    if (date) locked.push("date");
    g.lines.forEach((l, i) => {
      if (members.find((m) => m.line === l)?.lockCategory) locked.push(`lines.${i}.categoryId`);
    });
    return {
      draft: {
        id: ctx.newId(),
        mode: ctx.mode,
        date: date?.date ?? ctx.today,
        name: nameOf(g.lines),
        vendor: null,
        buildingId: g.buildingId,
        roomId: g.roomId,
        accountId: company ? ctx.defaultAccountFor(g.buildingId) : null,
        attachmentUrls: [],
        lines: g.lines,
      },
      touched: [],
      locked,
      flags,
      buildingCandidates: g.buildingId ? [] : candidates,
      source: "text" as const,
      sourceText: members.map((m) => m.text).join("; "),
    };
  });
}

/** Phòng nhắc theo chuỗi AI, chỉ trong toà đã chọn. */
function roomFromMention(mention: string | null, buildingId: string, refs: ResolveRefs): string | null {
  if (!mention) return null;
  const rooms = refs.rooms.filter((r) => r.building_id === buildingId);
  return resolveBuildingRoom(`phòng ${mention}`, { buildings: [], rooms }).room?.id ?? null;
}

function lineCategory(item: AiItem | undefined, description: string, feeCategory: string | null, ctx: ComposeContext): string | null {
  const mapped = fromIndex(item?.category ?? null, ctx.categories);
  if (mapped) return mapped.id;
  const s = suggestCategory(ctx.categories, description, { feeCategory });
  // Ảnh bill không có lượt AI sau ⇒ gợi ý yếu của luật dòng tiền để trống cho người dùng chọn.
  return s && s.reason !== "rule_weak" ? s.id : null;
}

/**
 * Kỳ AI đọc chỉ dùng khi đủ HAI đầu, đầu ≤ cuối, và là thẻ công ty: thẻ chỉ có nút bỏ kỳ khi kỳ đủ
 * hai đầu, nên kỳ hỏng sẽ làm thẻ không lưu được mà cũng không có ô nào để sửa. Ví cá nhân không có kỳ.
 */
function aiPeriod(ai: AiResult, company: boolean): { periodStart: string; periodEnd: string } | null {
  if (!company || !ai.period_start || !ai.period_end || ai.period_start > ai.period_end) return null;
  return { periodStart: ai.period_start, periodEnd: ai.period_end };
}

/** Thẻ MỘT dòng mà AI tách nhiều món: dòng đó là cả tin — tiền = tổng AI (hoặc cộng mọi món, kể cả
 *  dòng âm); hạng mục chỉ nhận khi mọi món có tiền cùng một hạng mục. */
function mergedItem(ai: AiResult): AiItem {
  const sum = ai.items.reduce((s, i) => s + (i.amount_vnd ?? 0), 0);
  const cats = unique(ai.items.filter((i) => (i.amount_vnd ?? 0) > 0).map((i) => i.category));
  return {
    desc: ai.items.map((i) => i.desc).join("; "),
    amount_vnd: ai.total_vnd ?? (sum > 0 ? sum : null),
    category: cats.length === 1 ? cats[0] : null,
    confidence: Math.min(...ai.items.map((i) => i.confidence)),
  };
}

export function draftFromBill(ai: AiResult, ctx: ComposeContext): DraftState {
  const company = ctx.mode === "company";
  const priced = ai.items.filter((i) => (i.amount_vnd ?? 0) > 0);
  const sum = priced.reduce((s, i) => s + (i.amount_vnd ?? 0), 0);
  // Dòng âm (giảm giá, voucher) không thành dòng phiếu nhưng làm số thực trả nhỏ hơn cộng các món:
  // AI không đọc được tổng ⇒ thực trả = cộng mọi dòng kể cả dòng âm; có dòng âm là luôn bắt kiểm lại.
  const discount = ai.items.reduce((s, i) => s + Math.min(0, i.amount_vnd ?? 0), 0);
  const paid = ai.total_vnd ?? (discount < 0 ? sum + discount : null);
  const fee = company && ai.customer_code ? resolveBuildingRoom(ai.customer_code, ctx.refs) : emptyResolve;
  const buildingId = company
    ? resolveBuildingMention(ai.building_mention, ctx.refs.buildings) ?? fee.building?.id ?? null
    : null;
  const period = aiPeriod(ai, company) ?? { periodStart: null, periodEnd: null };
  const flags: DraftFlag[] = [];

  const build = (description: string, amount: number, item: AiItem | undefined): DraftLine => ({
    description: description.slice(0, MAX_DESCRIPTION),
    amount,
    categoryId: company ? lineCategory(item, description, fee.feeCategory, ctx) : null,
    personalCategory: company ? null : fromIndex(item?.category ?? null, ctx.personalCategories ?? []),
    ...period,
  });

  let lines: DraftLine[];
  if (priced.length === 0) {
    lines = [build(ai.vendor ?? "", ai.total_vnd ?? 0, undefined)];
    if (!ai.total_vnd) flags.push("missing_amount");
  } else if (discount < 0 || (paid && sum !== paid)) {
    // Ship, giảm giá, làm tròn… ⇒ ghi đúng số thực trả, liệt kê món trong mô tả, bắt kiểm lại.
    const sameCategory = unique(priced.map((i) => i.category)).length === 1 ? priced[0] : undefined;
    const amount = paid && paid > 0 ? paid : 0;
    lines = [build(priced.map((i) => i.desc).join("; "), amount, sameCategory)];
    flags.push("check_total");
    if (amount === 0) flags.push("missing_amount");
  } else {
    lines = priced.map((i) => build(i.desc, i.amount_vnd ?? 0, i));
  }

  return {
    draft: {
      id: ctx.newId(),
      mode: ctx.mode,
      date: ai.date && ai.date <= ctx.today ? ai.date : ctx.today,
      name: nameFor("photo", ai.vendor, lines),
      vendor: ai.vendor,
      buildingId,
      roomId: buildingId ? roomFromMention(ai.room_mention, buildingId, ctx.refs) : null,
      accountId: company ? ctx.defaultAccountFor(buildingId) : null,
      attachmentUrls: [],
      lines,
    },
    touched: [],
    locked: [],
    flags,
    buildingCandidates: [],
    source: "photo",
    sourceText: "",
  };
}

export function markTouched(state: DraftState, path: string): DraftState {
  return state.touched.includes(path) ? state : { ...state, touched: [...state.touched, path] };
}

/**
 * Bỏ dòng i. Dấu "đã sửa/đã khoá" lưu theo CHỈ SỐ dòng nên phải dồn chỉ số các dòng sau và bỏ dấu của
 * dòng bị xoá — không thì dấu rơi sang dòng khác: AI về sau đè hạng mục người dùng đã chọn ở dòng bị
 * dồn lên, hoặc ô chưa ai sửa lại bị coi là đã sửa.
 */
/** Dấu "đã bỏ dòng": câu gốc (`sourceText`) không còn khớp các dòng ⇒ AI không ghép theo chỉ số nữa. */
export const LINES_EDITED = "lines";

export function removeLineAt(state: DraftState, i: number): DraftState {
  const shift = (paths: string[]) =>
    paths.flatMap((p) => {
      const m = /^lines\.(\d+)(\..*)?$/.exec(p);
      if (!m) return [p];
      const k = Number(m[1]);
      if (k === i) return [];
      return [k > i ? `lines.${k - 1}${m[2] ?? ""}` : p];
    });
  const touched = shift(state.touched);
  return {
    ...state,
    draft: { ...state.draft, lines: state.draft.lines.filter((_, j) => j !== i) },
    touched: touched.includes(LINES_EDITED) ? touched : [...touched, LINES_EDITED],
    locked: shift(state.locked),
  };
}

/**
 * Thẻ không có ô "tên phiếu": tên luôn dựng lại từ nội dung đang hiện (cùng luật lúc dựng thẻ), để
 * sửa mô tả hay cửa hàng trên thẻ không để lại tên cũ trên phiếu. Không đổi gì ⇒ trả đúng object cũ.
 */
export function syncName(state: DraftState): DraftState {
  const name = nameFor(state.source, state.draft.vendor, state.draft.lines);
  return name === state.draft.name ? state : { ...state, draft: { ...state.draft, name } };
}

/**
 * Kết quả câu lệnh rút gọn (buildCategoryOnlyMessages) ⇒ hạng mục từng dòng, cùng luật "chỉ điền ô
 * trống/đoán yếu" như enrichFromAi. Lệch số dòng (người dùng thêm/bỏ dòng trong lúc chờ) ⇒ bỏ cả kết quả.
 */
export function applyAiCategories(state: DraftState, codes: ReadonlyArray<string | null>, ctx: ComposeContext): DraftState {
  if (state.draft.mode !== "company" || state.touched.includes(LINES_EDITED)) return state;
  if (codes.length !== state.draft.lines.length) return state;
  const free = (path: string) => !state.touched.includes(path) && !state.locked.includes(path);
  let changed = false;
  const lines = state.draft.lines.map((l, i) => {
    const mapped = fromIndex(codes[i], ctx.categories);
    if (!mapped || mapped.id === l.categoryId || !free(`lines.${i}.categoryId`)) return l;
    changed = true;
    return { ...l, categoryId: mapped.id };
  });
  return changed ? { ...state, draft: { ...state.draft, lines } } : state;
}

export function enrichFromAi(state: DraftState, ai: AiResult, ctx: ComposeContext): DraftState {
  // Người dùng đã bỏ dòng: AI đọc câu GỐC nên ghép theo chỉ số/gộp món sẽ rót tiền sai dòng.
  if (state.touched.includes(LINES_EDITED)) return state;
  const company = state.draft.mode === "company";
  const free = (path: string) => !state.touched.includes(path) && !state.locked.includes(path);
  const lines = state.draft.lines;
  const merged = lines.length === 1 && ai.items.length > 1 ? mergedItem(ai) : undefined;
  const pairOf = (i: number): AiItem | undefined =>
    ai.items.length === lines.length ? ai.items[i] : lines.length === 1 ? merged : undefined;
  const period = aiPeriod(ai, company);

  const nextLines = lines.map((l, i) => {
    const item = pairOf(i);
    const next = { ...l };
    if (item) {
      // Chỉ nhận số DƯƠNG: dòng âm của AI (giảm giá) không bao giờ thành tiền của một dòng chi.
      if (l.amount <= 0 && item.amount_vnd && item.amount_vnd > 0 && free(`lines.${i}.amount`)) next.amount = item.amount_vnd;
      if (company) {
        const mapped = fromIndex(item.category, ctx.categories);
        if (mapped && free(`lines.${i}.categoryId`)) next.categoryId = mapped.id;
      } else {
        const mapped = fromIndex(item.category, ctx.personalCategories ?? []);
        if (mapped && free(`lines.${i}.personalCategory`)) next.personalCategory = mapped;
      }
    }
    if (period && l.periodStart === null && free(`lines.${i}.period`)) {
      next.periodStart = period.periodStart;
      next.periodEnd = period.periodEnd;
    }
    return next;
  });

  const draft: QuickDraft = { ...state.draft, lines: nextLines };
  if (company && !draft.buildingId && free("buildingId")) {
    const id =
      resolveBuildingMention(ai.building_mention, ctx.refs.buildings) ??
      (ai.customer_code ? resolveBuildingRoom(ai.customer_code, ctx.refs).building?.id ?? null : null);
    if (id) {
      draft.buildingId = id;
      if (!draft.accountId && free("accountId")) draft.accountId = ctx.defaultAccountFor(id);
      if (!draft.roomId) draft.roomId = roomFromMention(ai.room_mention, id, ctx.refs);
    }
  }
  if (ai.date && ai.date <= ctx.today && free("date")) draft.date = ai.date;
  if (!draft.vendor && ai.vendor && free("vendor")) draft.vendor = ai.vendor;

  const flags = state.flags.filter(
    (f) => f !== "missing_amount" && !((f === "building_choice" || f === "building_guess") && draft.buildingId),
  );
  if (nextLines.some((l) => l.amount <= 0)) flags.push("missing_amount");
  return { ...state, draft, flags, buildingCandidates: draft.buildingId ? [] : state.buildingCandidates };
}
