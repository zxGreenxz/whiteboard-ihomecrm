// Điều phối trang "Báo chi nhanh": tin nhắn/ảnh ⇒ thẻ nháp ⇒ AI bổ sung ⇒ lưu.
//
//   Chữ  — bộ đọc máy dựng thẻ NGAY; thẻ nào còn mơ hồ mới gọi AI, mỗi thẻ một lượt bằng chính đoạn câu
//          của nó (thẻ gom theo toà/phòng nên không đắp được một kết quả AI cho cả tin). AI về muộn chỉ
//          điền ô người dùng chưa sửa. Thẻ công ty đủ tiền + toà, chỉ thiếu hạng mục ⇒ câu lệnh rút gọn
//          chỉ hỏi hạng mục (onlyCategoriesMissing).
//   Ảnh  — nén vừa ngân sách proxy ⇒ AI đọc ⇒ một thẻ. AI hỏng vẫn ra thẻ trống để nhập tay. Ảnh khoản
//          công ty giữ lại để tải lên làm chứng từ khi lưu; ảnh khoản cá nhân bỏ ngay.
//   Lưu  — tải ảnh MỘT lần (URL giữ trên thẻ), khoá chống trùng theo id thẻ, chặn bấm hai lần; ví cá
//          nhân nhớ số khoản đã ghi để gửi lại không ghi trùng.
//   AI tắt / không quyền / hết lượt (hoặc lỗi liên tục) ⇒ tắt AI cho phiên này; nhập tay luôn chạy.
//   Thẻ chưa lưu được giữ qua lần tải lại trang (feedStorage), theo người + công ty.

import { useCallback, useEffect, useRef, useState } from "react";
import { makeCopilotFetch, newTaskId } from "@/copilot/copilotConfig";
import { compressImage } from "@/lib/imageCompress";
import { PERSONAL_CATEGORIES } from "@/lib/personalCategories";
import type { AiResult } from "@/lib/quickEntry/aiSchema";
import { encodeWithinBudget } from "@/lib/quickEntry/billImage";
import type { CardStatus } from "@/lib/quickEntry/cardStatus";
import {
  applyAiCategories,
  draftFromBill,
  draftsFromText,
  enrichFromAi,
  LINES_EDITED,
  syncName,
  type ComposeContext,
  type DraftState,
} from "@/lib/quickEntry/compose";
import { validateDraft, type DraftMode } from "@/lib/quickEntry/draft";
import { classifyAiError, type AiErrorView } from "@/lib/quickEntry/errors";
import { deserializeCards, draftsKey, otherUsersKeys, serializeCards } from "@/lib/quickEntry/feedStorage";
import {
  buildCategoryOnlyMessages,
  buildQuickEntryMessages,
  MAX_PROMPT_CATEGORIES,
  type PromptCategory,
} from "@/lib/quickEntry/prompt";
import { resolveBuildingRoom } from "@/lib/quickEntry/resolve";
import {
  readCategoriesWithAi,
  readWithAi,
  transcribeAudio,
  type AiCategories,
  type AiRead,
  type TranscribeResult,
} from "./quickEntryAi";
import { rememberAccount, type QuickEntryRefs } from "./useQuickEntryRefs";
import { useQuickEntrySave, type SaveOutcome } from "./useQuickEntrySave";
import type { RecordedAudio } from "./useVoiceRecorder";

const AI_TIMEOUT_MS = 60_000;
const STT_TIMEOUT_MS = 45_000;
/** Lỗi tạm thời liền nhau tới mức này thì thôi gọi AI trong phiên (tránh mỗi tin một lần chờ lỗi). */
const MAX_AI_FAILURES = 3;

const EMPTY_AI: AiResult = {
  items: [],
  total_vnd: null,
  date: null,
  vendor: null,
  building_mention: null,
  room_mention: null,
  customer_code: null,
  period_start: null,
  period_end: null,
};

const NOTHING_FOUND = "Chưa thấy khoản chi nào trong câu này. Thử: “sơn 300k” hoặc “102LVT bóng đèn 60k”.";
const BUILDING_HINT = "Câu có nhắc toà nhà. Nếu là chi của công ty, chuyển sang “Công ty” rồi gửi lại.";
const AI_STOPPED = "AI lỗi liên tục nên tạm nhập tay trong phiên này. Tải lại trang để thử AI lại.";

export interface FeedMessage {
  id: string;
  kind: "text" | "photo" | "restored";
  text: string | null;
  previewUrl: string | null;
  cardIds: string[];
  reading: boolean;
  note: string | null;
  /** Lần đọc AI gần nhất của tin chữ hỏng vì lỗi tạm thời ⇒ hiện nút "Thử AI lại". */
  aiRetry: boolean;
}

export interface FeedCard {
  id: string;
  state: DraftState;
  status: CardStatus;
  /** Mô hình AI đã đọc thẻ (null = chỉ bộ đọc máy). */
  aiModel: string | null;
  /** Ảnh khoản công ty, tải lên khi lưu. Khoản cá nhân luôn null. */
  photo: File | null;
  previewUrl: string | null;
  personalDone: number;
}

interface Feed {
  scope: string | null;
  messages: FeedMessage[];
  cards: Record<string, FeedCard>;
}

/**
 * Thẻ còn chỗ cho AI giúp: thiếu tiền; công ty thiếu toà hoặc hạng mục chưa chắc; cá nhân thiếu danh
 * mục. Hạng mục "chắc" = khoá theo cụm phí/mã khách hàng (`locked`) hoặc người dùng tự chọn (`touched`).
 */
export function needsAi(s: DraftState): boolean {
  // Đã bỏ dòng ⇒ câu gốc không còn khớp các dòng, AI không ghép vào thẻ nữa (enrichFromAi) — đừng gọi.
  if (s.touched.includes(LINES_EDITED)) return false;
  const d = s.draft;
  if (d.lines.some((l) => !(l.amount > 0))) return true;
  if (d.mode === "company") {
    const settled = (i: number) => s.locked.includes(`lines.${i}.categoryId`) || s.touched.includes(`lines.${i}.categoryId`);
    return !d.buildingId || d.lines.some((l, i) => !l.categoryId || !settled(i));
  }
  return d.lines.some((l) => !l.personalCategory);
}

/**
 * Thẻ công ty đã đủ tiền + toà, chỉ còn hạng mục chưa chắc ⇒ hỏi AI bằng câu lệnh RÚT GỌN (chỉ hạng
 * mục — đo 02/10/2026: nhanh hơn câu lệnh đầy đủ ~0,7 giây, không kém chính xác).
 */
export function onlyCategoriesMissing(s: DraftState): boolean {
  const d = s.draft;
  return d.mode === "company" && !!d.buildingId && d.lines.length > 0 && d.lines.every((l) => l.amount > 0) && needsAi(s);
}

const editable = (c: FeedCard) => c.status.kind === "draft" || c.status.kind === "rejected";

function statusOf(out: SaveOutcome): CardStatus {
  if (out.kind === "saved") return { kind: "saved", code: out.code, approvalStatus: out.approvalStatus, message: out.message };
  return { kind: out.kind, message: out.message };
}

const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

const timeout = (ms: number): AbortSignal | undefined =>
  typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Không đọc được ảnh."));
    reader.readAsDataURL(blob);
  });
}

function objectUrl(file: File): string | null {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(file);
  } catch {
    // Môi trường không tạo được URL xem trước ⇒ thẻ chỉ thiếu ảnh nhỏ; ảnh vẫn gửi AI đọc và vẫn
    // tải lên làm chứng từ khi lưu (đi bằng File, không bằng URL này).
  }
  return url;
}

export function useQuickEntryFeed(opts: {
  refs: QuickEntryRefs;
  userId: string | null;
  today: string;
  /** Mô hình người dùng TỰ chọn trên trang (id gửi máy chủ); vắng ⇒ máy chủ dùng chuỗi vận hành đặt. */
  models?: { stt?: string; read?: string };
}) {
  const { refs, userId, today } = opts;
  const orgId = refs.orgId;
  const scope = userId && orgId ? draftsKey(userId, orgId) : null;
  const save = useQuickEntrySave();
  // Đọc lựa chọn MỚI NHẤT lúc gọi (đổi ô chọn giữa chừng thì lần gọi kế dùng ngay, không dựng lại hàm).
  const modelsRef = useRef(opts.models);
  modelsRef.current = opts.models;

  const [feed, setFeed] = useState<Feed>({ scope: null, messages: [], cards: {} });
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const [aiOff, setAiOff] = useState<AiErrorView | null>(null);
  const aiOffRef = useRef<AiErrorView | null>(null);
  const [voiceOff, setVoiceOff] = useState<AiErrorView | null>(null);
  const failures = useRef({ read: 0, voice: 0 });
  const inflight = useRef(new Set<string>());
  const urls = useRef(new Set<string>());

  // Mở trang / đổi công ty: dọn nháp của người khác trên máy, nạp nháp của chính mình.
  useEffect(() => {
    if (!scope || !userId) return;
    let restored: ReturnType<typeof deserializeCards> = [];
    try {
      for (const k of otherUsersKeys(Object.keys(localStorage), userId)) localStorage.removeItem(k);
      restored = deserializeCards(localStorage.getItem(scope), Date.now());
    } catch {
      // trình duyệt chặn lưu trữ ⇒ bắt đầu trống
    }
    const cards: Record<string, FeedCard> = {};
    for (const c of restored) {
      cards[c.state.draft.id] = {
        id: c.state.draft.id,
        state: c.state,
        status: c.status,
        aiModel: null,
        photo: null,
        previewUrl: null,
        personalDone: c.personalDone,
      };
    }
    const messages: FeedMessage[] = restored.length
      ? [
          {
            id: crypto.randomUUID(),
            kind: "restored",
            text: null,
            previewUrl: null,
            cardIds: Object.keys(cards),
            reading: false,
            note: "Các thẻ chưa lưu từ lần trước.",
            aiRetry: false,
          },
        ]
      : [];
    setFeed({ scope, messages, cards });
  }, [scope, userId]);

  // Ghi nháp sau mỗi thay đổi (chỉ khi nháp đang hiện đúng là của người + công ty hiện tại).
  useEffect(() => {
    if (!feed.scope || feed.scope !== scope) return;
    const list = Object.values(feed.cards).map((c) => ({ state: c.state, status: c.status, personalDone: c.personalDone }));
    try {
      const raw = serializeCards(list, Date.now());
      if (raw) localStorage.setItem(feed.scope, raw);
      else localStorage.removeItem(feed.scope);
    } catch {
      // đầy bộ nhớ / bị chặn ⇒ bỏ qua, trang vẫn chạy
    }
  }, [feed, scope]);

  useEffect(() => {
    const created = urls.current;
    return () => {
      for (const u of created) URL.revokeObjectURL(u);
    };
  }, []);

  const patchCard = useCallback((id: string, fn: (c: FeedCard) => FeedCard) => {
    setFeed((f) => (f.cards[id] ? { ...f, cards: { ...f.cards, [id]: fn(f.cards[id]) } } : f));
  }, []);
  const patchMessage = useCallback((id: string, fn: (m: FeedMessage) => FeedMessage) => {
    setFeed((f) => ({ ...f, messages: f.messages.map((m) => (m.id === id ? fn(m) : m)) }));
  }, []);
  const addEntry = useCallback((message: FeedMessage, cards: FeedCard[]) => {
    setFeed((f) => ({
      ...f,
      messages: [...f.messages, message],
      cards: { ...f.cards, ...Object.fromEntries(cards.map((c) => [c.id, c])) },
    }));
  }, []);

  // Hai đường AI chạy trên hai nhà cung cấp (đọc: 9router; giọng: OpenRouter) nên tắt RIÊNG: một bên
  // hỏng không kéo bên kia. Chỉ "không có quyền" và "hết lượt" tắt cả hai — máy chủ xét chung.
  const offRead = useCallback((e: AiErrorView) => {
    aiOffRef.current = e;
    setAiOff(e);
  }, []);
  const offVoice = useCallback((e: AiErrorView) => setVoiceOff(e), []);
  const noteAiError = useCallback(
    (e: AiErrorView, channel: "read" | "voice") => {
      const both = e.kind === "not_permitted" || e.kind === "daily_cap";
      if (both || e.kind === "disabled") {
        if (both || channel === "read") offRead(e);
        if (both || channel === "voice") offVoice(e);
        return;
      }
      failures.current[channel] += 1;
      if (failures.current[channel] >= MAX_AI_FAILURES) {
        const off: AiErrorView = { ...e, message: AI_STOPPED };
        if (channel === "read") offRead(off);
        else offVoice(off);
      }
    },
    [offRead, offVoice],
  );

  const fetchImpl = useCallback(
    (input: string, init: RequestInit) => makeCopilotFetch("quick_entry", newTaskId("qe"), orgId)(input, init),
    [orgId],
  );

  const ctxFor = (mode: DraftMode): ComposeContext => ({
    today,
    mode,
    refs: refs.resolveRefs,
    categories: refs.categories,
    personalCategories: [...PERSONAL_CATEGORIES],
    newId: () => crypto.randomUUID(),
    defaultAccountFor: refs.defaultAccountFor,
  });

  const promptCategories = (ctx: ComposeContext): PromptCategory[] =>
    ctx.categories.map((c) => ({ name: c.name, group: c.category, note: c.description, keywords: c.keywords }));

  const askAi = async (ctx: ComposeContext, input: { text?: string; imageDataUrl?: string }): Promise<AiRead> => {
    const company = ctx.mode === "company";
    const categories = company ? promptCategories(ctx) : (ctx.personalCategories ?? []).map((name) => ({ name }));
    const messages = buildQuickEntryMessages({
      today: ctx.today,
      mode: ctx.mode,
      categories,
      buildingCodes: company ? refs.buildings.map((b) => b.code).filter((c): c is string => !!c) : [],
      text: input.text ?? null,
      imageDataUrl: input.imageDataUrl ?? null,
    });
    try {
      const r = await readWithAi({
        messages,
        categoryCount: categories.length,
        fetchImpl,
        signal: timeout(AI_TIMEOUT_MS),
        model: modelsRef.current?.read,
      });
      // Thu hẹp bằng `in`: tsconfig.app.json không bật strictNullChecks nên `r.ok` không thu hẹp được.
      if ("error" in r) noteAiError(r.error, "read");
      else failures.current.read = 0;
      return r;
    } catch {
      const error = classifyAiError({ status: 0, code: null });
      noteAiError(error, "read");
      return { ok: false, error };
    }
  };

  /** Câu lệnh rút gọn: chỉ hạng mục cho từng dòng của một thẻ công ty. */
  const askCategories = async (ctx: ComposeContext, lines: string[]): Promise<AiCategories> => {
    const categories = promptCategories(ctx);
    try {
      const r = await readCategoriesWithAi({
        messages: buildCategoryOnlyMessages({ categories, lines }),
        categoryCount: Math.min(categories.length, MAX_PROMPT_CATEGORIES),
        lineCount: lines.length,
        fetchImpl,
        signal: timeout(AI_TIMEOUT_MS),
        model: modelsRef.current?.read,
      });
      if ("error" in r) noteAiError(r.error, "read");
      else failures.current.read = 0;
      return r;
    } catch {
      const error = classifyAiError({ status: 0, code: null });
      noteAiError(error, "read");
      return { ok: false, error };
    }
  };

  const submitText = async (text: string, mode: DraftMode): Promise<void> => {
    const ctx = ctxFor(mode);
    const states = draftsFromText(text, ctx);
    const messageId = crypto.randomUUID();
    const mentionsBuilding =
      mode === "personal" && refs.canCompany && resolveBuildingRoom(text, refs.resolveRefs).building !== null;
    const cards: FeedCard[] = states.map((s) => ({
      id: s.draft.id,
      state: s,
      status: { kind: "draft" },
      aiModel: null,
      photo: null,
      previewUrl: null,
      personalDone: 0,
    }));
    const targets = aiOffRef.current ? [] : states.filter(needsAi);
    addEntry(
      {
        id: messageId,
        kind: "text",
        text,
        previewUrl: null,
        cardIds: cards.map((c) => c.id),
        reading: targets.length > 0,
        note: states.length === 0 ? NOTHING_FOUND : mentionsBuilding ? BUILDING_HINT : null,
        aiRetry: false,
      },
      cards,
    );
    if (targets.length > 0) await enrichCards(messageId, ctx, targets);
  };

  /** AI bổ sung cho các thẻ của một tin chữ — mỗi thẻ một lượt bằng đoạn câu của nó. */
  const enrichCards = async (messageId: string, ctx: ComposeContext, targets: DraftState[]): Promise<void> => {
    const outcome: { error: AiErrorView | null } = { error: null };
    await Promise.all(
      targets.map(async (s) => {
        if (onlyCategoriesMissing(s)) {
          const lineCount = s.draft.lines.length;
          const r = await askCategories(ctx, s.draft.lines.map((l) => l.description));
          if ("error" in r) {
            outcome.error = r.error;
            return;
          }
          const model = r.model ?? "AI";
          patchCard(s.draft.id, (c) => {
            if (!editable(c) || c.state.draft.lines.length !== lineCount) return c;
            const next = applyAiCategories(c.state, r.value, ctx);
            return next === c.state ? c : { ...c, state: next, aiModel: model };
          });
          return;
        }
        const r = await askAi(ctx, { text: s.sourceText });
        if ("error" in r) {
          outcome.error = r.error;
          return;
        }
        const model = r.model ?? "AI";
        patchCard(s.draft.id, (c) => {
          if (!editable(c)) return c;
          // AI không đổi được gì (vd thẻ đã bỏ/thêm dòng trong lúc đọc) ⇒ không gắn nhãn "AI đọc".
          const next = syncName(enrichFromAi(c.state, r.value, ctx));
          return next === c.state ? c : { ...c, state: next, aiModel: model };
        });
      }),
    );
    const error = outcome.error;
    patchMessage(messageId, (m) => ({
      ...m,
      reading: false,
      note: error ? error.message : m.note,
      aiRetry: !!error && error.retryable,
    }));
  };

  /** Nút "Thử AI lại" của tin chữ: chỉ đọc lại thẻ còn sửa được và còn chỗ cho AI giúp. */
  const retryAi = async (messageId: string): Promise<void> => {
    const message = feedRef.current.messages.find((m) => m.id === messageId);
    if (!message || message.kind !== "text" || message.reading || aiOffRef.current) return;
    const targets = message.cardIds
      .map((id) => feedRef.current.cards[id])
      .filter((c): c is FeedCard => !!c && editable(c) && needsAi(c.state))
      .map((c) => c.state);
    patchMessage(messageId, (m) => ({ ...m, note: null, aiRetry: false, reading: targets.length > 0 }));
    if (targets.length === 0) return;
    await enrichCards(messageId, ctxFor(targets[0].draft.mode), targets);
  };

  const submitPhoto = async (file: File, mode: DraftMode): Promise<void> => {
    const ctx = ctxFor(mode);
    const messageId = crypto.randomUUID();
    const previewUrl = objectUrl(file);
    if (previewUrl) urls.current.add(previewUrl);
    addEntry({ id: messageId, kind: "photo", text: null, previewUrl, cardIds: [], reading: true, note: null, aiRetry: false }, []);

    let result = EMPTY_AI;
    let model: string | null = null;
    let note: string | null = aiOffRef.current?.message ?? null;
    if (!aiOffRef.current) {
      const encoded = await encodeWithinBudget((step) => compressImage(file, { maxEdge: step.maxEdge, quality: step.quality }));
      if (!encoded) {
        note = classifyAiError({ status: 413, code: "payload_too_large" }).message;
      } else {
        let dataUrl: string | null = null;
        try {
          dataUrl = await blobToDataUrl(encoded.blob);
        } catch {
          note = classifyAiError({ status: 0, code: null }).message;
        }
        if (dataUrl) {
          const r = await askAi(ctx, { imageDataUrl: dataUrl });
          if ("error" in r) {
            note = r.error.message;
          } else {
            result = r.value;
            model = r.model ?? "AI";
          }
        }
      }
    }

    const state = draftFromBill(result, ctx);
    const card: FeedCard = {
      id: state.draft.id,
      state,
      status: { kind: "draft" },
      aiModel: model,
      photo: mode === "company" ? file : null,
      previewUrl,
      personalDone: 0,
    };
    setFeed((f) => ({
      ...f,
      cards: { ...f.cards, [card.id]: card },
      messages: f.messages.map((m) => (m.id === messageId ? { ...m, reading: false, note, cardIds: [card.id] } : m)),
    }));
  };

  const saveCard = async (id: string): Promise<void> => {
    if (inflight.current.has(id)) return;
    const card = feedRef.current.cards[id];
    if (!card) return;
    const kind = card.status.kind;
    if (kind !== "draft" && kind !== "rejected" && kind !== "unknown") return;
    if (kind !== "unknown" && !validateDraft(card.state.draft).ok) return;
    inflight.current.add(id);
    try {
      patchCard(id, (c) => ({ ...c, status: { kind: "saving" } }));
      let draft = card.state.draft;
      if (draft.mode === "company" && card.photo && draft.attachmentUrls.length === 0) {
        try {
          const url = await save.uploadPhoto(card.photo, draft.id);
          draft = { ...draft, attachmentUrls: [url] };
          const uploaded = draft;
          patchCard(id, (c) => ({ ...c, state: { ...c.state, draft: uploaded } }));
        } catch (e) {
          patchCard(id, (c) => ({ ...c, status: { kind: "rejected", message: messageOf(e, "Chưa tải được ảnh chứng từ. Thử lại.") } }));
          return;
        }
      }
      // Cá nhân: ghi tiến độ vào thẻ (và nháp lưu máy) sau TỪNG khoản — tải lại trang giữa vòng thì lần
      // gửi lại bỏ qua đúng số khoản đã ghi, không ghi lặp.
      const progress = (done: number) => patchCard(id, (c) => ({ ...c, personalDone: done }));
      const out =
        draft.mode === "company" ? await save.saveCompany(draft) : await save.savePersonal(draft, card.personalDone, progress);
      patchCard(id, (c) => ({ ...c, status: statusOf(out), personalDone: draft.mode === "personal" ? out.done : c.personalDone }));
      if (out.kind === "saved" && draft.mode === "company") rememberAccount(orgId, draft.accountId);
    } finally {
      inflight.current.delete(id);
    }
  };

  const changeCard = useCallback(
    (id: string, next: DraftState) => {
      patchCard(id, (c) => (editable(c) ? { ...c, state: next, status: c.status.kind === "rejected" ? { kind: "draft" } : c.status } : c));
    },
    [patchCard],
  );

  const discardCard = useCallback((id: string) => {
    setFeed((f) => {
      if (!f.cards[id]) return f;
      const cards = { ...f.cards };
      delete cards[id];
      const messages = f.messages
        .map((m) => (m.cardIds.includes(id) ? { ...m, cardIds: m.cardIds.filter((x) => x !== id) } : m))
        .filter((m) => m.cardIds.length > 0 || m.reading || (m.kind === "text" && m.note === NOTHING_FOUND));
      return { ...f, cards, messages };
    });
  }, []);

  const transcribe = async (audio: RecordedAudio): Promise<TranscribeResult> => {
    const r = await transcribeAudio({ audio, fetchImpl, signal: timeout(STT_TIMEOUT_MS), model: modelsRef.current?.stt });
    if ("error" in r) noteAiError(r.error, "voice");
    else failures.current.voice = 0;
    return r;
  };

  return {
    messages: feed.messages,
    cards: feed.cards,
    /** AI ĐỌC (9router) đã tắt cho phiên — thẻ chỉ còn bộ đọc máy + nhập tay. */
    aiOff,
    voiceOff,
    submitText,
    submitPhoto,
    saveCard,
    changeCard,
    discardCard,
    retryAi,
    /** null ⇒ CHÉP GIỌNG (OpenRouter) đã tắt cho phiên — mic gợi ý dùng mic trên bàn phím. */
    transcribe: voiceOff ? null : transcribe,
  };
}
