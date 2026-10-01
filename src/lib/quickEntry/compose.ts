// Ghép các mảnh của src/lib/quickEntry thành THẺ NHÁP cho trang "Báo chi nhanh".
//
//   draftsFromText — tin nhắn / bản chữ giọng nói ⇒ thẻ (tách khoản, ngày/kỳ, toà/phòng, hạng
//                    mục), nhóm theo toà + phòng ⇒ mỗi nhóm một phiếu.
//   draftFromBill  — kết quả AI đọc ảnh hoá đơn ⇒ một thẻ.
//   enrichFromAi   — AI bổ sung cho thẻ từ chữ: CHỈ điền ô còn trống.
//
// AI chỉ điền ô còn TRỐNG (số tiền 0, toà null, kỳ null). Hai ô luôn có giá trị nên cần khoá riêng:
// `touched` (người dùng đã sửa — không gì được đè) và `locked` (ngày nói rõ trong chữ; hạng mục
// theo cụm phí/mã khách hàng). Hạng mục đoán theo trùng từ là đoán yếu nên AI được thay.
// ID toà/hạng mục luôn do bộ dò cục bộ tra.

import { segmentMessage } from "./segment";
import { findDateHint, findPeriodHint } from "./dateWords";
import { resolveBuildingMention, resolveBuildingRoom, type ResolveRefs, type ResolveResult } from "./resolve";
import { suggestCategory, type CategoryRef } from "./categorySuggest";
import { groupByPlace } from "./convert";
import { MAX_DESCRIPTION, type DraftLine, type DraftMode, type QuickDraft } from "./draft";
import { MAX_PROMPT_CATEGORIES } from "./prompt";
import type { AiItem, AiResult } from "./aiSchema";

export type DraftFlag = "missing_amount" | "small_amount" | "ambiguous_amount" | "building_choice" | "check_total";

export interface DraftState {
  draft: QuickDraft;
  touched: string[];
  locked: string[];
  flags: DraftFlag[];
  buildingCandidates: string[];
  source: "text" | "photo";
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
  room: null,
  roomMentioned: false,
  buildingWide: false,
  feeCategory: null,
};

export function draftsFromText(text: string, ctx: ComposeContext): DraftState[] {
  const segments = segmentMessage(text);
  if (segments.length === 0) return [];
  const company = ctx.mode === "company";
  const date = findDateHint(text, ctx.today);
  const period = findPeriodHint(text, ctx.today);
  const msg = company ? resolveBuildingRoom(text, ctx.refs) : emptyResolve;

  interface Item {
    buildingId: string | null;
    roomId: string | null;
    line: DraftLine;
    flags: DraftFlag[];
    candidates: string[];
    lockCategory: boolean;
  }

  const items: Item[] = segments.map((seg) => {
    const place = company ? resolveBuildingRoom(seg.text, ctx.refs) : emptyResolve;
    const buildingId = place.building?.id ?? msg.building?.id ?? null;
    // Phòng nói một lần cho cả tin chỉ áp cho khoản KHÔNG tự nhắc phòng nào. (Tin đã ra được
    // phòng thì cả tin chỉ nhắc đúng một toà, nên khoản thừa hưởng luôn cùng toà với phòng đó.)
    const roomId = place.room?.id ?? (place.roomMentioned ? null : msg.room?.id ?? null);
    const candidates = buildingId ? [] : place.buildingCandidates.length ? place.buildingCandidates : msg.buildingCandidates;

    let description = seg.text;
    if (seg.amount) {
      const a = seg.amount.candidate.start - seg.textStart;
      const b = seg.amount.candidate.end - seg.textStart;
      description = `${seg.text.slice(0, a)} ${seg.text.slice(b)}`;
    }
    description = tidy(description);

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
      buildingId: company ? buildingId : null,
      roomId: company ? roomId : null,
      line: {
        description,
        amount: seg.amount?.value ?? 0,
        categoryId: suggestion?.id ?? null,
        personalCategory: null,
        periodStart: period?.start ?? null,
        periodEnd: period?.end ?? null,
      },
      flags,
      candidates,
      lockCategory: suggestion !== null && suggestion.reason !== "name_overlap",
    };
  });

  const groups = company
    ? groupByPlace(items.map((it) => ({ buildingId: it.buildingId, roomId: it.roomId, line: it.line })))
    : [{ buildingId: null, roomId: null, lines: items.map((it) => it.line) }];

  return groups.map((g) => {
    const members = items.filter((it) => g.lines.includes(it.line));
    const candidates = unique(members.flatMap((m) => m.candidates));
    const flags = unique(members.flatMap((m) => m.flags));
    if (!g.buildingId && candidates.length > 1 && company) flags.push("building_choice");
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
  return suggestCategory(ctx.categories, description, { feeCategory })?.id ?? null;
}

export function draftFromBill(ai: AiResult, ctx: ComposeContext): DraftState {
  const company = ctx.mode === "company";
  const priced = ai.items.filter((i) => (i.amount_vnd ?? 0) > 0);
  const sum = priced.reduce((s, i) => s + (i.amount_vnd ?? 0), 0);
  const fee = company && ai.customer_code ? resolveBuildingRoom(ai.customer_code, ctx.refs) : emptyResolve;
  const buildingId = company
    ? resolveBuildingMention(ai.building_mention, ctx.refs.buildings) ?? fee.building?.id ?? null
    : null;
  const period = { periodStart: ai.period_start, periodEnd: ai.period_end };
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
  } else if (ai.total_vnd && sum !== ai.total_vnd) {
    // Ship, giảm giá, làm tròn… ⇒ ghi đúng số thực trả, liệt kê món trong mô tả, bắt kiểm lại.
    const sameCategory = unique(priced.map((i) => i.category)).length === 1 ? priced[0] : undefined;
    lines = [build(priced.map((i) => i.desc).join("; "), ai.total_vnd, sameCategory)];
    flags.push("check_total");
  } else {
    lines = priced.map((i) => build(i.desc, i.amount_vnd ?? 0, i));
  }

  return {
    draft: {
      id: ctx.newId(),
      mode: ctx.mode,
      date: ai.date && ai.date <= ctx.today ? ai.date : ctx.today,
      name: ai.vendor ? ai.vendor.slice(0, 120) : nameOf(lines),
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
  };
}

export function markTouched(state: DraftState, path: string): DraftState {
  return state.touched.includes(path) ? state : { ...state, touched: [...state.touched, path] };
}

export function enrichFromAi(state: DraftState, ai: AiResult, ctx: ComposeContext): DraftState {
  const company = state.draft.mode === "company";
  const free = (path: string) => !state.touched.includes(path) && !state.locked.includes(path);
  const lines = state.draft.lines;
  const pairOf = (i: number): AiItem | undefined =>
    ai.items.length === lines.length ? ai.items[i] : lines.length === 1 ? ai.items[0] : undefined;

  const nextLines = lines.map((l, i) => {
    const item = pairOf(i);
    const next = { ...l };
    if (item) {
      if (l.amount <= 0 && item.amount_vnd && free(`lines.${i}.amount`)) next.amount = item.amount_vnd;
      if (company) {
        const mapped = fromIndex(item.category, ctx.categories);
        if (mapped && free(`lines.${i}.categoryId`)) next.categoryId = mapped.id;
      } else {
        const mapped = fromIndex(item.category, ctx.personalCategories ?? []);
        if (mapped && free(`lines.${i}.personalCategory`)) next.personalCategory = mapped;
      }
    }
    if (ai.period_start && ai.period_end && l.periodStart === null && free(`lines.${i}.period`)) {
      next.periodStart = ai.period_start;
      next.periodEnd = ai.period_end;
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

  const flags = state.flags.filter((f) => f !== "missing_amount" && !(f === "building_choice" && draft.buildingId));
  if (nextLines.some((l) => l.amount <= 0)) flags.push("missing_amount");
  return { ...state, draft, flags, buildingCandidates: draft.buildingId ? [] : state.buildingCandidates };
}
