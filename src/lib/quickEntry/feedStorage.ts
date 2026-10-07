// Giữ thẻ nháp của trang "Báo chi nhanh" qua lần tải lại (iPhone hay tải lại trang sau khi mở camera;
// rớt mạng giữa lúc lưu). Chỉ là tiện ích theo máy — trang vẫn chạy đúng khi không đọc/ghi được.
//
// Thẻ đáng giữ: còn sửa được, hoặc chưa rõ kết quả lưu (phải gửi lại Y NGUYÊN — cùng id thẻ ⇒ cùng
// khoá chống trùng). Thẻ ảnh công ty chưa tải ảnh thì KHÔNG giữ: File không lưu được, giữ lại sẽ thành
// phiếu thiếu chứng từ mà người dùng không hay. Khoá theo người + công ty; khoá của người khác trên
// cùng máy được dọn mỗi lần mở trang.

import type { DraftState } from "./compose";
import type { CardStatus, CardStatusKind } from "./cardStatus";
import { quickDraftSchema } from './draft';

export const DRAFTS_PREFIX = "ihome:quick-entry:drafts:";
export const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;
export const UNKNOWN_AFTER_RELOAD =
  "Trang đã tải lại khi thẻ đang lưu nên chưa rõ đã lưu chưa. Bấm “Gửi lại y nguyên” — máy chủ tự chống trùng — hoặc kiểm tra trước.";
const UNKNOWN_AFTER_RELOAD_PERSONAL =
  "Trang đã tải lại khi đang lưu. Gửi lại y nguyên với cùng mã yêu cầu để xác nhận trong Ví cá nhân.";

export interface StoredCard {
  state: DraftState;
  status: CardStatus;
  /** Số khoản ví cá nhân đã chắc chắn ghi — gửi lại thì bỏ qua chừng đó. */
  personalDone: number;
}

interface Stored {
  v: 1;
  savedAt: number;
  cards: StoredCard[];
}

const KEEP: ReadonlySet<CardStatusKind> = new Set(["draft", "rejected", "unknown", "maybe_saved", "saving"]);

export const draftsKey = (userId: string, orgId: string): string => `${DRAFTS_PREFIX}${userId}:${orgId}`;

function keepable(c: StoredCard): boolean {
  if (!KEEP.has(c.status.kind)) return false;
  const d = c.state.draft;
  return c.state.source === "text" || d.mode === "personal" || d.attachmentUrls.length > 0;
}

function onReload(c: StoredCard): CardStatus {
  // Upload precedes prepare. A missing File is recoverable evidence, not an unknown money write.
  if(c.state.draft.mode==='personal'&&c.state.draft.personalAttachmentPending&&c.status.kind==='saving')return {kind:'draft'};
  if(c.state.draft.mode==='personal' && !c.state.draft.personalProtocol && (c.personalDone>0||['saving','unknown','maybe_saved'].includes(c.status.kind)))return {kind:'maybe_saved',message:`Nháp cũ đã xác nhận ${c.personalDone} khoản; phần còn lại chưa rõ. Mở Ví cá nhân đối chiếu chứng từ trước khi tạo phần còn thiếu. Không tự gửi lại nháp này.`};
  if (c.status.kind === "saving") {
    return { kind: "unknown", message: c.state.draft.mode === "personal" ? UNKNOWN_AFTER_RELOAD_PERSONAL : UNKNOWN_AFTER_RELOAD };
  }
  if (c.status.kind === "rejected") return { kind: "draft" };
  return c.status;
}

/** null ⇒ không còn gì để giữ (trang xoá khoá lưu). */
export function serializeCards(cards: StoredCard[], now: number): string | null {
  const kept = cards.filter(keepable).map((c) => ({ ...c, status: onReload(c) }));
  if (kept.length === 0) return null;
  const stored: Stored = { v: 1, savedAt: now, cards: kept };
  return JSON.stringify(stored);
}

const isStringArray = (x: unknown): boolean => Array.isArray(x) && x.every((s) => typeof s === "string");

function isStoredCard(x: unknown): x is StoredCard {
  if (!x || typeof x !== "object") return false;
  const c = x as Partial<StoredCard>;
  const s = c.state as Partial<DraftState> | undefined;
  const d = s?.draft;
  return (
    Number.isSafeInteger(c.personalDone) && (c.personalDone ?? -1)>=0 &&
    typeof c.status?.kind === "string" &&
    KEEP.has(c.status.kind) &&
    !!d &&
    quickDraftSchema.safeParse(d).success &&
    typeof d.id === "string" &&
    (d.mode === "company" || d.mode === "personal") &&
    Array.isArray(d.lines) &&
    isStringArray(d.attachmentUrls) &&
    isStringArray(s?.touched) &&
    isStringArray(s?.locked) &&
    Array.isArray(s?.flags) &&
    isStringArray(s?.buildingCandidates) &&
    typeof s?.sourceText === "string"
  );
}

export function deserializeCards(raw: string | null, now: number): StoredCard[] {
  if (!raw) return [];
  let parsed: Partial<Stored> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<Stored> | null;
  } catch {
    // Chuỗi lưu hỏng (ghi dở, sửa tay) ⇒ coi như không có nháp. Nháp chỉ là tiện ích theo máy:
    // mọi thẻ đã gửi máy chủ đều có khoá chống trùng riêng, mất nháp không sinh phiếu sai.
  }
  if (!parsed || parsed.v !== 1 || typeof parsed.savedAt !== "number" || !Array.isArray(parsed.cards)) return [];
  return parsed.cards.filter(isStoredCard).filter(c=>now-parsed.savedAt!<=DRAFT_TTL_MS||['unknown','maybe_saved','saving'].includes(c.status.kind)).map(c=>({...c,status:onReload(c),state:{...c.state,draft:{...c.state.draft,transactionType:c.state.draft.transactionType??'EXPENSE',...(c.state.draft.mode==='personal'&&c.personalDone===0&&['draft','rejected'].includes(c.status.kind)?{personalProtocol:1 as const}:{})}}}));
}

/** Khoá nháp của người dùng KHÁC trên cùng máy — dọn khi mở trang. */
export function otherUsersKeys(keys: string[], userId: string): string[] {
  const mine = `${DRAFTS_PREFIX}${userId}:`;
  return keys.filter((k) => k.startsWith(DRAFTS_PREFIX) && !k.startsWith(mine));
}
