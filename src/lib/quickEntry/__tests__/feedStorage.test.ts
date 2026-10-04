import { describe, expect, it } from "vitest";
import {
  DRAFT_TTL_MS,
  UNKNOWN_AFTER_RELOAD,
  deserializeCards,
  draftsKey,
  otherUsersKeys,
  serializeCards,
  type StoredCard,
} from "../feedStorage";
import type { DraftState } from "../compose";
import type { CardStatus } from "../cardStatus";

const NOW = Date.UTC(2026, 9, 1, 3, 0, 0);

const card = (over: { status?: CardStatus; source?: "text" | "photo"; mode?: "company" | "personal"; urls?: string[]; done?: number } = {}): StoredCard => {
  const state: DraftState = {
    draft: {
      id: `id-${Math.random().toString(36).slice(2)}`,
      mode: over.mode ?? "company", transactionType:"EXPENSE",
      date: "2026-10-01",
      name: "sơn",
      vendor: null,
      buildingId: "b102",
      roomId: null,
      accountId: "acc1",
      attachmentUrls: over.urls ?? [],
      lines: [{ description: "sơn", amount: 300_000, categoryId: "t1", personalCategory: null, periodStart: null, periodEnd: null }],
    },
    touched: ["lines.0.amount"],
    locked: [],
    flags: [],
    buildingCandidates: [],
    source: over.source ?? "text",
    sourceText: "sơn 300k",
  };
  return { state, status: over.status ?? { kind: "draft" }, personalDone: over.done ?? 0 };
};

describe("feedStorage — giữ thẻ qua lần tải lại trang", () => {
  it("thẻ đang sửa: lưu rồi đọc lại y nguyên (kể cả ô đã sửa)", () => {
    const c = card();
    expect(deserializeCards(serializeCards([c], NOW), NOW + 60_000)).toEqual([c]);
  });

  it("quá 48 giờ ⇒ bỏ", () => {
    const raw = serializeCards([card()], NOW);
    expect(deserializeCards(raw, NOW + DRAFT_TTL_MS - 1)).toHaveLength(1);
    expect(deserializeCards(raw, NOW + DRAFT_TTL_MS + 1)).toEqual([]);
  });

  it("đang lưu lúc tải lại ⇒ thành 'chưa rõ' (khoá, chỉ gửi lại y nguyên); bị từ chối ⇒ về nháp", () => {
    const saving = card({ status: { kind: "saving" } });
    const rejected = card({ status: { kind: "rejected", message: "Sổ khoá" } });
    const [a, b] = deserializeCards(serializeCards([saving, rejected], NOW), NOW);
    expect(a.status).toEqual({ kind: "unknown", message: UNKNOWN_AFTER_RELOAD });
    expect(b.status).toEqual({ kind: "draft" });
  });

  it("thẻ VÍ đang lưu lúc tải lại ⇒ lời báo không hứa 'máy chủ chống trùng' (ví không có khoá) và trỏ về Ví", () => {
    const [a] = deserializeCards(serializeCards([card({ mode: "personal", status: { kind: "saving" } })], NOW), NOW);
    expect(a.status.kind).toBe("maybe_saved");
    expect(a.status.message).not.toContain("máy chủ");
    expect(a.status.message).toContain("Ví cá nhân");
  });

  it("giữ 'chưa rõ' và 'có thể đã lưu' cùng số khoản cá nhân đã ghi; bỏ thẻ đã lưu", () => {
    const unknown = card({ mode: "personal", status: { kind: "unknown", message: "x" }, done: 1 });
    const maybe = card({ status: { kind: "maybe_saved", message: "y" } });
    const saved = card({ status: { kind: "saved", code: "PC1" } });
    const back = deserializeCards(serializeCards([unknown, maybe, saved], NOW), NOW);
    expect(back.map((c) => c.status.kind)).toEqual(["maybe_saved", "maybe_saved"]);
    expect(back[0].personalDone).toBe(1);
  });

  it("thẻ ảnh công ty CHƯA tải ảnh ⇒ không giữ (giữ lại sẽ lưu phiếu thiếu chứng từ); đã tải ⇒ giữ", () => {
    const notUploaded = card({ source: "photo" });
    const uploaded = card({ source: "photo", urls: ["https://cdn.test/a.jpg"], status: { kind: "unknown", message: "x" } });
    const personalPhoto = card({ source: "photo", mode: "personal" });
    const back = deserializeCards(serializeCards([notUploaded, uploaded, personalPhoto], NOW), NOW);
    expect(back.map((c) => c.state.draft.id)).toEqual([uploaded.state.draft.id, personalPhoto.state.draft.id]);
  });

  it("không còn gì để giữ ⇒ null (xoá khoá lưu)", () => {
    expect(serializeCards([], NOW)).toBeNull();
    expect(serializeCards([card({ status: { kind: "saved" } })], NOW)).toBeNull();
  });

  it("dữ liệu hỏng/khác phiên bản ⇒ bỏ qua, không ném lỗi", () => {
    expect(deserializeCards(null, NOW)).toEqual([]);
    expect(deserializeCards("{", NOW)).toEqual([]);
    expect(deserializeCards(JSON.stringify({ v: 2, savedAt: NOW, cards: [card()] }), NOW)).toEqual([]);
    const good = card();
    const mixed = JSON.stringify({ v: 1, savedAt: NOW, cards: [{ foo: 1 }, null, good, { ...good, state: { ...good.state, draft: { ...good.state.draft, lines: "x" } } }] });
    expect(deserializeCards(mixed, NOW)).toEqual([good]);
  });

  it("khoá theo người + công ty; dọn khoá của NGƯỜI KHÁC trên cùng máy", () => {
    expect(draftsKey("u1", "o1")).toBe("ihome:quick-entry:drafts:u1:o1");
    const keys = [draftsKey("u1", "o1"), draftsKey("u1", "o2"), draftsKey("u2", "o1"), "ihome:quick-entry:last-account:o1", "khac"];
    expect(otherUsersKeys(keys, "u1")).toEqual([draftsKey("u2", "o1")]);
  });
});
