// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AiRead } from "../quickEntryAi";
import type { AiResult } from "@/lib/quickEntry/aiSchema";
import { classifyAiError } from "@/lib/quickEntry/errors";

const h = vi.hoisted(() => ({
  readWithAi: vi.fn(),
  readCategoriesWithAi: vi.fn(),
  transcribeAudio: vi.fn(),
  uploadPhoto: vi.fn(),
  uploadPersonalPhoto: vi.fn(),
  saveCompany: vi.fn(),
  savePersonal: vi.fn(),
  pending: [] as Array<{ownerId:string;requestKey:string;payload:{action:string;rows:Array<{type:'EXPENSE';amount:number;txn_date:string;wallet_id:string;category_id:string;description:string;attachment_paths?:string[]}>}}>,
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/copilot/copilotConfig", () => ({ makeCopilotFetch: () => vi.fn(), newTaskId: () => "qe-test", QUICK_ENTRY_BASE: "https://proxy.test" }));
vi.mock("@/lib/imageCompress", () => ({ compressImage: async (f: File) => f }));
vi.mock("../quickEntryAi", () => ({
  readWithAi: h.readWithAi,
  readCategoriesWithAi: h.readCategoriesWithAi,
  transcribeAudio: h.transcribeAudio,
}));
vi.mock("../useQuickEntrySave", () => ({
  useQuickEntrySave: () => ({ uploadPhoto: h.uploadPhoto, uploadPersonalPhoto:h.uploadPersonalPhoto, saveCompany: h.saveCompany, savePersonal: h.savePersonal, pendingPersonalRequests:h.pending }),
}));

import { needsAi, onlyCategoriesMissing, useQuickEntryFeed } from "../useQuickEntryFeed";
import type { QuickEntryRefs } from "../useQuickEntryRefs";
import { draftsKey } from "@/lib/quickEntry/feedStorage";

const ORG = "org-1";
const USER = "user-1";
const refs = (over: Partial<QuickEntryRefs> = {}): QuickEntryRefs => ({
  orgId: ORG,
  loading: false,
  permissionsLoading:false, permissionsError:null, personalLoading:false, personalError:null, personalReady:true,
  personalPermissionsLoading:false,personalPermissionsError:null,companyPermissionsLoading:false,companyPermissionsError:null,
  personalWallets:[{id:'11111111-1111-4111-8111-111111111111',user_id:'user-1',version:1,name:'Tiền mặt',kind:'cash',icon:'wallet',hidden:false,is_default:true,opening_balance:0,balance:0}],
  personalCategories:[{id:'22222222-2222-4222-8222-222222222222',user_id:'user-1',version:1,name:'Ăn uống',type:'EXPENSE',hidden:false,icon:'utensils',color:'#123456',seed_key:null,legacy_name:null}],
  companyLoading:false,companyError:null,companyReady:true,
  canCompany: true,
  canPersonal: true,
  buildings: [{ id: "b102", name: "Toà 102", code: "102LVT", is_virtual: false, user_id: "u", managed: true }],
  rooms: [],
  categories: [
    { id: "t-vt", name: "Vật tư", category: "Bảo Trì", type: "expense", organization_id: ORG },
    { id: "t-an", name: "Ăn uống", category: "Khác", type: "expense", organization_id: ORG },
  ],
  cashbooks: [{ id: "acc1", label: "Quỹ 102" }],
  resolveRefs: { buildings: [{ id: "b102", name: "Toà 102", code: "102LVT" }], rooms: [], feeAccounts: [] },
  defaultAccountFor: (b) => (b ? "acc1" : null),
  ...over,
});

const ai = (over: Partial<AiResult> = {}): AiResult => ({
  items: [],
  total_vnd: null,
  date: null,
  vendor: null,
  building_mention: null,
  room_mention: null,
  customer_code: null,
  period_start: null,
  period_end: null,
  ...over,
});
const ok = (value: AiResult): AiRead => ({ ok: true, value, model: "9router:cx/gpt-6-luna(low)" });

const mount = (r: QuickEntryRefs = refs()) =>
  renderHook((p: { r: QuickEntryRefs }) => useQuickEntryFeed({ refs: p.r, userId: USER, today: "2026-10-01" }), {
    initialProps: { r },
  });
const cardsOf = (result: { current: ReturnType<typeof useQuickEntryFeed> }) => Object.values(result.current.cards);

describe("AI organization recovery", () => {
  it("missing company remains retryable after repeated attempts", async () => {
    h.readWithAi.mockResolvedValue({ ok: false, error: classifyAiError({ status: 400, code: "organization_required" }) });
    const { result } = mount();
    for (let i = 0; i < 4; i++) await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    expect(h.readWithAi).toHaveBeenCalledTimes(4);
    expect(result.current.aiOff).toBeNull();
    expect(result.current.transcribe).not.toBeNull();
  });

  it("restores AI when switching to another authorized company", async () => {
    h.readWithAi.mockResolvedValue({ ok: false, error: classifyAiError({ status: 403, code: "not_permitted" }) });
    const { result, rerender } = mount();
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    expect(result.current.transcribe).toBeNull();
    rerender({ r: refs({ orgId: "org-2" }) });
    expect(result.current.aiOff).toBeNull();
    expect(result.current.transcribe).not.toBeNull();
    h.readWithAi.mockResolvedValue(ok(ai()));
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    expect(h.readWithAi).toHaveBeenCalledTimes(2);
  });

  it("ignores an old company denial arriving after a switch", async () => {
    let finish!: (r: AiRead) => void;
    h.readWithAi.mockReturnValue(new Promise<AiRead>(r => { finish = r; }));
    const { result, rerender } = mount();
    let pending!: Promise<void>;
    act(() => { pending = result.current.submitText("102LVT sơn 300k", "company"); });
    rerender({ r: refs({ orgId: "org-2" }) });
    await act(async () => { finish({ ok: false, error: classifyAiError({ status: 403, code: "not_permitted" }) }); await pending; });
    expect(result.current.aiOff).toBeNull();
    expect(result.current.transcribe).not.toBeNull();
    expect(result.current.messages).toEqual([]);
  });
});

beforeEach(() => {
  localStorage.clear();
  for (const f of Object.values(h)) if(typeof f==='function')f.mockReset();
  h.pending=[];
  // Câu lệnh rút gọn (thẻ đủ tiền + toà, chỉ thiếu hạng mục) đi qua CÙNG bản giả readWithAi: các bài dưới
  // đặt kết quả/lỗi một chỗ, đếm lượt gọi một chỗ. Bài riêng của đường rút gọn tự đặt lại.
  h.readCategoriesWithAi.mockImplementation(async (opts: { lineCount: number }) => {
    const r = (await h.readWithAi(opts)) as AiRead;
    if ("error" in r) return r;
    return { ok: true, value: Array.from({ length: opts.lineCount }, (_, i) => r.value.items[i]?.category ?? null), model: r.model };
  });
});
afterEach(() => vi.useRealTimers());

it("manual company draft stays in company review and does not save on creation", async () => {
  const { result } = mount();
  let id: string | null = null;
  act(() => {
    id = result.current.addManual("company");
  });
  const card = cardsOf(result)[0];
  expect(card.id).toBe(id);
  expect(card.state.draft.mode).toBe("company");
  expect(card.state.draft.lines).toHaveLength(1);
  expect(h.saveCompany).not.toHaveBeenCalled();
  expect(h.savePersonal).not.toHaveBeenCalled();
  act(() =>
    result.current.changeCard(card.id, {
      ...card.state,
      draft: {
        ...card.state.draft,
        buildingId: "b102",
        accountId: "acc1",
        lines: [
          {
            ...card.state.draft.lines[0],
            amount: 300000,
            categoryId: "t-vt",
            description: "Vật tư",
          },
        ],
      },
    }),
  );
  h.saveCompany.mockResolvedValue({ kind: "saved", message: "Đã lưu" });
  await act(async () => {
    await result.current.saveCard(card.id);
  });
  expect(h.saveCompany).toHaveBeenCalled();
  expect(h.savePersonal).not.toHaveBeenCalled();
});
it("rejects manual company drafts when company create permission is unavailable", () => {
  const { result } = mount(refs({ canCompany: false }));
  act(() => {
    expect(result.current.addManual("company")).toBeNull();
  });
  expect(cardsOf(result)).toHaveLength(0);
});

it('new personal cards require selection when all cash wallets are hidden',async()=>{
 const r=refs();r.personalWallets[0].hidden=true;
 h.readWithAi.mockResolvedValue(ok(ai()));
 const {result}=mount(r);
 await act(async()=>{await result.current.submitText('cà phê 25k','personal');});
 expect(cardsOf(result)[0].state.draft.personalWalletId).toBeNull();
});

describe('wallet resolution through the feed',()=>{
 const walletRefs=()=>{const r=refs();const cash=r.personalWallets[0];r.personalWallets=[{...cash,id:'bank',name:'Tk939',kind:'bank',is_default:true},{...cash,is_default:false},{...cash,id:'sp',name:'Thẻ SP',kind:'other',is_default:false}];return r;};
 it('uses cash for a manual draft despite a bank default',()=>{
  const {result}=mount(walletRefs());act(()=>{result.current.addManual('personal');});
  expect(cardsOf(result)[0].state.draft.personalWalletId).toBe('11111111-1111-4111-8111-111111111111');
 });
 it('keeps caption and explicit wallet when the image says Grab',async()=>{
  h.readWithAi.mockResolvedValue(ok(ai({platform:'grab',items:[{desc:'GrabBike',amount_vnd:50000,category:'c1',confidence:1}]})));
  const {result}=mount(walletRefs());await act(async()=>result.current.submitPhoto(new File(['bill'],'grab.jpg',{type:'image/jpeg'}),'personal','ví Tk939'));
  expect(cardsOf(result)[0].state.sourceText).toBe('ví Tk939');
  expect(cardsOf(result)[0].state.draft.personalWalletId).toBe('bank');
 });
 it('late AI splitting retains manual wallet and gives every new card a separate request',async()=>{
  let finish!:(result:AiRead)=>void;h.readWithAi.mockReturnValue(new Promise<AiRead>(r=>{finish=r;}));
  const {result}=mount(walletRefs());let pending!:Promise<void>;
  act(()=>{pending=result.current.submitText('nhận tiền rồi đi xe','personal');});
  const card=cardsOf(result)[0];
  act(()=>result.current.changeCard(card.id,{...card.state,touched:['personalWalletId'],draft:{...card.state.draft,personalRequestKey:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',personalWalletId:'bank'}}));
  await act(async()=>{finish(ok(ai({items:[{desc:'nhận tiền',transactionType:'INCOME',amount_vnd:100000,category:null,confidence:1},{desc:'Grab',transactionType:'EXPENSE',platform:'grab',amount_vnd:50000,category:'c1',confidence:1}]})));await pending;});
  expect(cardsOf(result)).toHaveLength(2);
  expect(cardsOf(result).every(c=>c.state.draft.personalWalletId==='bank')).toBe(true);
  expect(new Set(cardsOf(result).map(c=>c.state.draft.personalRequestKey??c.id)).size).toBe(2);
 });
 it('does not refill an intentional null when wallet refs reload or a card was saved',async()=>{
  h.readWithAi.mockResolvedValue(ok(ai()));const r=walletRefs();r.personalWallets=r.personalWallets.filter(w=>w.id!=='sp');
  const {result,rerender}=mount(r);await act(async()=>result.current.submitText('Grab 50k','personal'));
  const card=cardsOf(result)[0];expect(card.state.draft.personalWalletId).toBeNull();
  rerender({r:{...r,personalWallets:[...r.personalWallets]}});
  expect(result.current.cards[card.id].state.draft.personalWalletId).toBeNull();
 });
});

describe("mô hình người dùng chọn trên trang", () => {
  it("ảnh và nội dung bổ sung đi cùng một lượt AI và một thẻ nháp", async () => {
    h.readWithAi.mockResolvedValue(ok(ai({ items: [{ desc: "Sửa điện", amount_vnd: 300_000, category: "c1", confidence: 0.9 }], building_mention: "102LVT" })));
    const { result } = mount();
    const file = new File(["image"], "bill.jpg", { type: "image/jpeg" });
    await act(async () => result.current.submitPhoto(file, "company", "  102LVT sửa điện  "));
    expect(h.readWithAi).toHaveBeenCalledTimes(1);
    const userMessage = h.readWithAi.mock.calls[0][0].messages.find((m: { role: string }) => m.role === "user");
    expect(userMessage.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("102LVT sửa điện") }),
      expect.objectContaining({ type: "image_url" }),
    ]));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ kind: "photo", text: "102LVT sửa điện", reading: false });
    expect(cardsOf(result)).toHaveLength(1);
    expect(cardsOf(result)[0].photo).toBe(file);
    expect(h.saveCompany).not.toHaveBeenCalled();
  });

  it("đọc chữ gửi mô hình đọc đã chọn; chép giọng gửi mô hình giọng đã chọn; đổi lựa chọn có hiệu lực ngay", async () => {
    h.readWithAi.mockResolvedValue(ok(ai()));
    h.transcribeAudio.mockResolvedValue({ ok: true, text: "sơn 300k", model: "openai/whisper-1" });
    const { result, rerender } = renderHook(
      (p: { models: { stt: string; read: string } }) =>
        useQuickEntryFeed({ refs: refs(), userId: USER, today: "2026-10-01", models: p.models }),
      { initialProps: { models: { stt: "openai/whisper-1", read: "cx/gpt-6.1-sol(high)" } } },
    );
    await act(async () => result.current.submitText("102LVT mua sơn", "company"));
    expect(h.readWithAi.mock.calls[0][0].model).toBe("cx/gpt-6.1-sol(high)");
    await act(async () => {
      await result.current.transcribe?.({ blob: new Blob(["a"]), mimeType: "audio/webm", format: "webm", seconds: 2 });
    });
    expect(h.transcribeAudio.mock.calls[0][0].model).toBe("openai/whisper-1");
    rerender({ models: { stt: "deepgram/nova-3", read: "cx/gpt-6-astra" } });
    await act(async () => result.current.submitText("102LVT mua keo", "company"));
    expect(h.readWithAi.mock.calls.at(-1)?.[0].model).toBe("cx/gpt-6-astra");
  });
});

describe("needsAi — chỉ gọi AI khi thẻ còn chỗ mơ hồ", () => {
  it("công ty: thiếu toà, thiếu tiền, hạng mục đoán yếu ⇒ cần; đủ và hạng mục chắc ⇒ không", async () => {
    h.readWithAi.mockResolvedValue(ok(ai()));
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT sửa ống nước 200k", "company"));
    const [c] = cardsOf(result);
    const strong = { ...c.state, locked: ["lines.0.categoryId"], draft: { ...c.state.draft, lines: [{ ...c.state.draft.lines[0], categoryId: "t-vt" }] } };
    expect(needsAi(strong)).toBe(false);
    expect(needsAi({ ...strong, locked: [] })).toBe(true);
    expect(needsAi({ ...strong, locked: [], touched: ["lines.0.categoryId"] })).toBe(false);
    expect(needsAi({ ...strong, draft: { ...strong.draft, buildingId: null } })).toBe(true);
    expect(needsAi({ ...strong, draft: { ...strong.draft, lines: [{ ...strong.draft.lines[0], amount: 0 }] } })).toBe(true);
  });

  it("thẻ đã bỏ dòng (dấu 'lines') ⇒ không gọi AI nữa — câu gốc không còn khớp các dòng", async () => {
    h.readWithAi.mockResolvedValue(ok(ai()));
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT mua sơn", "company"));
    const [c] = cardsOf(result);
    expect(needsAi(c.state)).toBe(true);
    expect(needsAi({ ...c.state, touched: [...c.state.touched, "lines"] })).toBe(false);
  });

  it("câu lệnh rút gọn chỉ cho thẻ đủ tiền + toà và không quá 20 dòng", async () => {
    h.readWithAi.mockResolvedValue(ok(ai()));
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    const [c] = cardsOf(result);
    expect(onlyCategoriesMissing(c.state)).toBe(true);
    const line = c.state.draft.lines[0];
    const many = { ...c.state, draft: { ...c.state.draft, lines: Array.from({ length: 21 }, () => ({ ...line })) } };
    expect(onlyCategoriesMissing(many)).toBe(false);
    expect(onlyCategoriesMissing({ ...c.state, draft: { ...c.state.draft, buildingId: null } })).toBe(false);
  });
});

describe("useQuickEntryFeed — tin chữ", () => {
  it("dựng thẻ ngay; AI bổ sung tiền + hạng mục bằng ĐOẠN CÂU của thẻ; gắn nhãn AI", async () => {
    h.readWithAi.mockResolvedValue(ok(ai({ items: [{ desc: "sơn", amount_vnd: 300_000, category: "c1", confidence: 0.9 }] })));
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT mua sơn", "company"));
    expect(h.readWithAi).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(h.readWithAi.mock.calls[0][0].messages);
    expect(sent).toContain("102LVT mua sơn");
    const [c] = cardsOf(result);
    expect(c.state.draft.lines[0]).toMatchObject({ amount: 300_000, categoryId: "t-vt" });
    expect(c.aiModel).toBe("9router:cx/gpt-6-luna(low)");
    expect(result.current.messages[0]).toMatchObject({ kind: "text", text: "102LVT mua sơn", reading: false });
  });

  it("thẻ đủ tiền + toà, chỉ thiếu hạng mục ⇒ câu lệnh RÚT GỌN theo mô tả từng dòng, kèm 'dùng cho'", async () => {
    h.readCategoriesWithAi.mockReset();
    h.readCategoriesWithAi.mockResolvedValue({ ok: true, value: ["c1"], model: "9router:cx/gpt-5.6-terra(low)" });
    const r = refs({
      categories: [
        { id: "t-vt", name: "Vật tư", category: "Bảo Trì", type: "expense", organization_id: ORG, description: "sơn, keo, ốc vít", keywords: ["sơn"] },
        { id: "t-an", name: "Ăn uống", category: "Khác", type: "expense", organization_id: ORG },
      ],
    });
    const { result } = renderHook(() =>
      useQuickEntryFeed({ refs: r, userId: USER, today: "2026-10-01", models: { read: "cx/gpt-5.6-terra(low)" } }),
    );
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    expect(h.readWithAi).not.toHaveBeenCalled();
    const call = h.readCategoriesWithAi.mock.calls[0][0];
    expect(call).toMatchObject({ lineCount: 1, categoryCount: 2, model: "cx/gpt-5.6-terra(low)" });
    const sent = JSON.stringify(call.messages);
    expect(sent).toContain("1. 102LVT sơn");
    expect(sent).toContain("dùng cho: sơn, keo, ốc vít");
    const [c] = cardsOf(result);
    expect(c.state.draft.lines[0]).toMatchObject({ amount: 300_000, categoryId: "t-vt" });
    expect(c.aiModel).toBe("9router:cx/gpt-5.6-terra(low)");
  });

  it("câu lệnh rút gọn về sau khi người dùng đã thêm dòng ⇒ bỏ kết quả", async () => {
    let resolve!: (v: unknown) => void;
    h.readCategoriesWithAi.mockReset();
    h.readCategoriesWithAi.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { result } = mount();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.submitText("102LVT sơn 300k", "company");
    });
    await waitFor(() => expect(cardsOf(result)).toHaveLength(1));
    const c = cardsOf(result)[0];
    const s = c.state;
    act(() =>
      result.current.changeCard(c.id, {
        ...s,
        draft: { ...s.draft, lines: [...s.draft.lines, { ...s.draft.lines[0], description: "keo", categoryId: null }] },
      }),
    );
    await act(async () => {
      resolve({ ok: true, value: ["c2"], model: "m" });
      await pending;
    });
    expect(cardsOf(result)[0].state.draft.lines.map((l) => l.categoryId)).toEqual([null, null]);
    expect(cardsOf(result)[0].aiModel).toBeNull();
  });

  it("AI về mà không đổi được gì trên thẻ (đã bỏ dòng trong lúc đọc) ⇒ KHÔNG gắn nhãn 'AI đọc'", async () => {
    let resolve!: (r: AiRead) => void;
    h.readWithAi.mockImplementationOnce(() => new Promise<AiRead>((r) => (resolve = r)));
    const { result } = mount();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.submitText("102LVT mua sơn", "company");
    });
    await waitFor(() => expect(cardsOf(result)).toHaveLength(1));
    const c = cardsOf(result)[0];
    act(() => result.current.changeCard(c.id, { ...c.state, touched: [...c.state.touched, "lines"] }));
    await act(async () => {
      resolve(ok(ai({ items: [{ desc: "sơn", amount_vnd: 300_000, category: "c1", confidence: 0.9 }] })));
      await pending;
    });
    expect(cardsOf(result)[0].aiModel).toBeNull();
    expect(cardsOf(result)[0].state.draft.lines[0].amount).toBe(0);
  });

  it("người dùng sửa ô trong lúc AI đang đọc ⇒ AI không đè ô đó", async () => {
    let resolve!: (r: AiRead) => void;
    h.readWithAi.mockReturnValue(new Promise<AiRead>((r) => (resolve = r)));
    const { result } = mount();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.submitText("102LVT sơn 300k", "company");
    });
    const [c] = cardsOf(result);
    act(() =>
      result.current.changeCard(c.id, {
        ...c.state,
        touched: ["lines.0.categoryId"],
        draft: { ...c.state.draft, lines: [{ ...c.state.draft.lines[0], categoryId: "t-an" }] },
      }),
    );
    await act(async () => {
      resolve(ok(ai({ items: [{ desc: "sơn", amount_vnd: 300_000, category: "c1", confidence: 0.9 }] })));
      await pending;
    });
    expect(cardsOf(result)[0].state.draft.lines[0].categoryId).toBe("t-an");
  });

  it("AI ĐỌC báo tắt (9router) ⇒ phiên này không gọi AI đọc nữa; GIỌNG NÓI (OpenRouter) vẫn dùng được", async () => {
    h.readWithAi.mockResolvedValue({ ok: false, error: classifyAiError({ status: 403, code: "quick_entry_disabled" }) });
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    expect(result.current.aiOff?.kind).toBe("disabled");
    expect(result.current.transcribe).not.toBeNull();
    await act(async () => result.current.submitText("102LVT keo 20k", "company"));
    expect(h.readWithAi).toHaveBeenCalledTimes(1);
    expect(cardsOf(result)).toHaveLength(2);
  });

  it("CHÉP GIỌNG báo tắt (thiếu khoá OpenRouter) ⇒ chỉ giọng nói tắt; AI đọc vẫn chạy", async () => {
    h.transcribeAudio.mockResolvedValue({ ok: false, error: classifyAiError({ status: 403, code: "quick_entry_disabled" }) });
    h.readWithAi.mockResolvedValue(ok(ai()));
    const { result } = mount();
    await act(async () => {
      await result.current.transcribe?.({ blob: new Blob(["a"]), mimeType: "audio/webm", format: "webm", seconds: 2 });
    });
    expect(result.current.transcribe).toBeNull();
    expect(result.current.aiOff).toBeNull();
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    expect(h.readWithAi).toHaveBeenCalledTimes(1);
  });

  it("chép giọng lỗi tạm ba lần liền ⇒ chỉ giọng nói tạm tắt, không đụng AI đọc", async () => {
    h.transcribeAudio.mockResolvedValue({ ok: false, error: classifyAiError({ status: 503, code: "quick_entry_all_failed" }) });
    const { result } = mount();
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await result.current.transcribe?.({ blob: new Blob(["a"]), mimeType: "audio/webm", format: "webm", seconds: 2 });
      });
    }
    expect(result.current.transcribe).toBeNull();
    expect(result.current.aiOff).toBeNull();
  });

  it("lỗi tạm thời ba lần liền ⇒ tạm tắt AI cho phiên", async () => {
    h.readWithAi.mockResolvedValue({ ok: false, error: classifyAiError({ status: 503, code: "quick_entry_all_failed" }) });
    const { result } = mount();
    for (const t of ["102LVT a 10k", "102LVT b 10k"]) await act(async () => result.current.submitText(t, "company"));
    expect(result.current.aiOff).toBeNull();
    await act(async () => result.current.submitText("102LVT c 10k", "company"));
    expect(result.current.aiOff).not.toBeNull();
  });

  it("lỗi tạm thời xen giữa lần thành công ⇒ đếm lại từ đầu, không tắt AI", async () => {
    const fail = { ok: false, error: classifyAiError({ status: 503, code: "quick_entry_all_failed" }) };
    h.readWithAi
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(ok(ai()))
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(fail);
    const { result } = mount();
    for (const t of ["102LVT a 10k", "102LVT b 10k", "102LVT c 10k", "102LVT d 10k", "102LVT e 10k"]) {
      await act(async () => result.current.submitText(t, "company"));
    }
    expect(result.current.aiOff).toBeNull();
  });

  it("lỗi tạm của đường đọc và đường giọng KHÔNG cộng dồn (2 + 1 ⇒ chưa tắt đường nào)", async () => {
    const fail = { ok: false, error: classifyAiError({ status: 503, code: "quick_entry_all_failed" }) };
    h.readWithAi.mockResolvedValue(fail);
    h.transcribeAudio.mockResolvedValue(fail);
    const { result } = mount();
    for (const t of ["102LVT a 10k", "102LVT b 10k"]) await act(async () => result.current.submitText(t, "company"));
    await act(async () => {
      await result.current.transcribe?.({ blob: new Blob(["a"]), mimeType: "audio/webm", format: "webm", seconds: 2 });
    });
    expect(result.current.aiOff).toBeNull();
    expect(result.current.transcribe).not.toBeNull();
  });

  it("nhận giọng báo hết lượt ⇒ tắt CẢ HAI đường (máy chủ đếm lượt chung)", async () => {
    h.transcribeAudio.mockResolvedValue({ ok: false, error: classifyAiError({ status: 429, code: "quick_entry_daily_cap" }) });
    const { result } = mount();
    await act(async () => {
      await result.current.transcribe?.({ blob: new Blob(["a"]), mimeType: "audio/webm", format: "webm", seconds: 2 });
    });
    expect(result.current.aiOff?.kind).toBe("daily_cap");
    expect(result.current.transcribe).toBeNull();
  });

  it("AI lỗi tạm thời ⇒ tin mời thử lại; thử lại thành công ⇒ điền hạng mục và hết lời mời", async () => {
    h.readWithAi
      .mockResolvedValueOnce({ ok: false, error: classifyAiError({ status: 0, code: null }) })
      .mockResolvedValueOnce(ok(ai({ items: [{ desc: "sơn", amount_vnd: 300_000, category: "c1", confidence: 0.9 }] })));
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    const msg = result.current.messages[0];
    expect(msg).toMatchObject({ aiRetry: true });
    expect(msg.note).toMatch(/Mất kết nối/);
    await act(async () => result.current.retryAi(msg.id));
    expect(h.readWithAi).toHaveBeenCalledTimes(2);
    // Thẻ đủ tiền + toà ⇒ câu lệnh rút gọn gửi mô tả dòng (câu đã bỏ số tiền).
    expect(JSON.stringify(h.readWithAi.mock.calls[1][0].messages)).toContain("1. 102LVT sơn");
    expect(cardsOf(result)[0].state.draft.lines[0].categoryId).toBe("t-vt");
    expect(result.current.messages[0]).toMatchObject({ aiRetry: false, note: null, reading: false });
  });

  it("AI bị tắt (không phải lỗi tạm thời) ⇒ không mời thử lại", async () => {
    h.readWithAi.mockResolvedValue({ ok: false, error: classifyAiError({ status: 403, code: "quick_entry_disabled" }) });
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    expect(result.current.messages[0].aiRetry).toBe(false);
  });

  it("người dùng đã tự chọn hạng mục trước khi thử lại ⇒ không gọi AI nữa", async () => {
    h.readWithAi.mockResolvedValueOnce({ ok: false, error: classifyAiError({ status: 0, code: null }) });
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    const c = cardsOf(result)[0];
    act(() =>
      result.current.changeCard(c.id, {
        ...c.state,
        touched: [...c.state.touched, "lines.0.categoryId"],
        draft: { ...c.state.draft, lines: [{ ...c.state.draft.lines[0], categoryId: "t-vt" }] },
      }),
    );
    await act(async () => result.current.retryAi(result.current.messages[0].id));
    expect(h.readWithAi).toHaveBeenCalledTimes(1);
  });

  it("câu không có khoản nào ⇒ chỉ có lời nhắc, không thẻ, không gọi AI", async () => {
    const { result } = mount();
    await act(async () => result.current.submitText("   ", "company"));
    expect(cardsOf(result)).toHaveLength(0);
    expect(h.readWithAi).not.toHaveBeenCalled();
  });
});

describe("useQuickEntryFeed — ảnh bill", () => {
  const bill = ai({ items: [{ desc: "Bóng LED", amount_vnd: 90_000, category: "c1", confidence: 0.9 }], total_vnd: 90_000, vendor: "Minh Phát", building_mention: "102LVT" });

  it("công ty: AI đọc ảnh ⇒ một thẻ, GIỮ ảnh để tải lên làm chứng từ khi lưu", async () => {
    h.readWithAi.mockResolvedValue(ok(bill));
    const file = new File(["img"], "bill.jpg", { type: "image/jpeg" });
    const { result } = mount();
    await act(async () => result.current.submitPhoto(file, "company"));
    const sent = JSON.stringify(h.readWithAi.mock.calls[0][0].messages);
    expect(sent).toContain("data:image/jpeg;base64,");
    const [c] = cardsOf(result);
    expect(c.state.draft).toMatchObject({ buildingId: "b102", vendor: "Minh Phát" });
    expect(c.photo).toBe(file);
  });

  it("cá nhân: giữ ảnh để tải chứng từ khi lưu", async () => {
    h.readWithAi.mockResolvedValue(ok(bill));
    const { result } = mount();
    await act(async () => result.current.submitPhoto(new File(["img"], "bill.jpg", { type: "image/jpeg" }), "personal"));
    expect(cardsOf(result)[0].photo).toBeInstanceOf(File);
  });

  it("AI lỗi ⇒ vẫn có thẻ trống để nhập tay, kèm lời báo", async () => {
    h.readWithAi.mockResolvedValue({ ok: false, error: classifyAiError({ status: 0, code: null }) });
    const { result } = mount();
    await act(async () => result.current.submitPhoto(new File(["img"], "bill.jpg", { type: "image/jpeg" }), "company"));
    expect(cardsOf(result)).toHaveLength(1);
    expect(result.current.messages[0].note).toMatch(/Mất kết nối/);
  });
});

describe("useQuickEntryFeed — lưu", () => {
  const filledText = async (result: { current: ReturnType<typeof useQuickEntryFeed> }) => {
    h.readWithAi.mockResolvedValue(ok(ai({ items: [{ desc: "sơn", amount_vnd: 300_000, category: "c1", confidence: 0.9 }] })));
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    return cardsOf(result)[0];
  };

  it("công ty có ảnh: tải ảnh MỘT lần; rớt mạng rồi gửi lại ⇒ không tải lại, cùng id thẻ (cùng khoá chống trùng)", async () => {
    h.readWithAi.mockResolvedValue(
      ok(ai({ items: [{ desc: "Bóng LED", amount_vnd: 90_000, category: "c1", confidence: 0.9 }], total_vnd: 90_000, building_mention: "102LVT" })),
    );
    h.uploadPhoto.mockResolvedValue("https://cdn.test/u/a.jpg");
    h.saveCompany
      .mockResolvedValueOnce({ kind: "unknown", ids: [], done: 0, message: "Chưa rõ" })
      .mockResolvedValueOnce({ kind: "saved", code: "PC2610001", approvalStatus: "UNAPPROVED", ids: ["v1"], done: 1, message: "ok" });
    const { result } = mount();
    await act(async () => result.current.submitPhoto(new File(["img"], "bill.jpg", { type: "image/jpeg" }), "company"));
    const id = cardsOf(result)[0].id;
    await act(async () => result.current.saveCard(id));
    expect(result.current.cards[id].status.kind).toBe("unknown");
    await act(async () => result.current.saveCard(id));
    expect(h.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(h.saveCompany).toHaveBeenCalledTimes(2);
    expect(h.saveCompany.mock.calls[1][0]).toEqual(h.saveCompany.mock.calls[0][0]);
    expect(h.saveCompany.mock.calls[0][0]).toMatchObject({ id, attachmentUrls: ["https://cdn.test/u/a.jpg"] });
    expect(result.current.cards[id].status).toMatchObject({ kind: "saved", code: "PC2610001", approvalStatus: "UNAPPROVED" });
  });

  it("bấm Lưu hai lần liền ⇒ chỉ gửi một lần", async () => {
    let resolve!: (v: unknown) => void;
    h.saveCompany.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = mount();
    const c = await filledText(result);
    await act(async () => {
      const a = result.current.saveCard(c.id);
      const b = result.current.saveCard(c.id);
      resolve({ kind: "saved", code: "PC1", approvalStatus: "APPROVED", ids: [], done: 1, message: "" });
      await Promise.all([a, b]);
    });
    expect(h.saveCompany).toHaveBeenCalledTimes(1);
  });

  it("đã lưu ⇒ nhớ sổ vừa dùng cho lần sau", async () => {
    h.saveCompany.mockResolvedValue({ kind: "saved", code: "PC1", approvalStatus: "APPROVED", ids: ["v1"], done: 1, message: "" });
    const { result } = mount();
    const c = await filledText(result);
    await act(async () => result.current.saveCard(c.id));
    expect(localStorage.getItem(`ihome:quick-entry:last-account:${ORG}`)).toBe("acc1");
  });

  it("cá nhân: batch chưa xác nhận ⇒ retry nguyên thẻ, không có tiến độ lẻ", async () => {
    h.readWithAi.mockResolvedValue(
      ok(ai({ items: [{ desc: "bún", amount_vnd: 50_000, category: "c1", confidence: 0.9 }, { desc: "xăng", amount_vnd: 100_000, category: "c1", confidence: 0.9 }] })),
    );
    h.savePersonal
      .mockResolvedValueOnce({ kind: "unknown", ids: [], done: 0, message: "Chưa rõ" })
      .mockResolvedValueOnce({ kind: "saved", code: null, approvalStatus: null, ids: ["p2"], done: 2, message: "" });
    const { result } = mount();
    await act(async () => result.current.submitText("bún 50k, xăng 100k", "personal"));
    const id = cardsOf(result)[0].id;
    await act(async () => result.current.saveCard(id));
    await act(async () => result.current.saveCard(id));
    expect(h.savePersonal.mock.calls[0][1]).toBe(0);
    expect(h.savePersonal.mock.calls[1][1]).toBe(0);
  });

  it("cá nhân: nháp đang gửi được lưu máy; chỉ cập nhật done sau biên nhận atomic", async () => {
    h.readWithAi.mockResolvedValue(
      ok(ai({ items: [{ desc: "bún", amount_vnd: 50_000, category: "c1", confidence: 0.9 }, { desc: "xăng", amount_vnd: 100_000, category: "c1", confidence: 0.9 }] })),
    );
    let release: (v: unknown) => void = () => {};
    h.savePersonal.mockImplementationOnce(async (_draft: unknown, _done: number, onProgress?: (n: number) => void) => {

      return new Promise((r) => {
        release = r;
      });
    });
    const { result } = mount();
    await act(async () => result.current.submitText("bún 50k, xăng 100k", "personal"));
    const id = cardsOf(result)[0].id;
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.saveCard(id);
    });
    await waitFor(() => expect(result.current.cards[id].personalDone).toBe(0));
    expect(result.current.cards[id].status.kind).toBe("saving");
    await waitFor(() => expect(localStorage.getItem(draftsKey(USER, ORG)) ?? "").toContain('"personalDone":0'));
    await act(async () => {
      release({ kind: "saved", code: null, approvalStatus: null, ids: ["p1", "p2"], done: 2, message: "" });
      await pending;
    });
    expect(result.current.cards[id].personalDone).toBe(2);
  });

  it("thẻ chưa hợp lệ (thiếu hạng mục) ⇒ không gửi máy chủ", async () => {
    h.readWithAi.mockResolvedValue(ok(ai()));
    const { result } = mount();
    await act(async () => result.current.submitText("102LVT linh tinh 50k", "company"));
    const c = cardsOf(result)[0];
    expect(c.state.draft.lines[0].categoryId).toBeNull();
    await act(async () => result.current.saveCard(c.id));
    expect(h.saveCompany).not.toHaveBeenCalled();
    expect(result.current.cards[c.id].status.kind).toBe("draft");
  });

  it("bỏ thẻ ⇒ thẻ và tin chỉ còn thẻ đó biến mất", async () => {
    const { result } = mount();
    h.readWithAi.mockResolvedValue(ok(ai()));
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    const id = cardsOf(result)[0].id;
    act(() => result.current.discardCard(id));
    expect(cardsOf(result)).toHaveLength(0);
    expect(result.current.messages).toHaveLength(0);
  });

  it("tải ảnh hỏng ⇒ thẻ bị từ chối (sửa/lưu lại được), KHÔNG gọi lưu phiếu", async () => {
    h.readWithAi.mockResolvedValue(
      ok(ai({ items: [{ desc: "Bóng LED", amount_vnd: 90_000, category: "c1", confidence: 0.9 }], total_vnd: 90_000, building_mention: "102LVT" })),
    );
    h.uploadPhoto.mockRejectedValue(new Error("Máy chủ đã từ chối tải tệp."));
    const { result } = mount();
    await act(async () => result.current.submitPhoto(new File(["img"], "bill.jpg", { type: "image/jpeg" }), "company"));
    const id = cardsOf(result)[0].id;
    await act(async () => result.current.saveCard(id));
    expect(result.current.cards[id].status).toMatchObject({ kind: "rejected", message: "Máy chủ đã từ chối tải tệp." });
    expect(h.saveCompany).not.toHaveBeenCalled();
    const c = result.current.cards[id];
    act(() => result.current.changeCard(id, { ...c.state, draft: { ...c.state.draft, vendor: "Minh Phát" } }));
    expect(result.current.cards[id].status).toEqual({ kind: "draft" });
  });
});

describe("useQuickEntryFeed — giữ thẻ qua lần tải lại", () => {
  it("thẻ chưa lưu được ghi lại và hiện lại khi mở trang; khoá của người khác bị dọn", async () => {
    localStorage.setItem(draftsKey("nguoi-khac", ORG), "x");
    h.readWithAi.mockResolvedValue(ok(ai({ items: [{ desc: "sơn", amount_vnd: 300_000, category: "c1", confidence: 0.9 }] })));
    const first = mount();
    await act(async () => first.result.current.submitText("102LVT sơn 300k", "company"));
    first.unmount();
    expect(localStorage.getItem(draftsKey("nguoi-khac", ORG))).toBeNull();
    const second = mount();
    await waitFor(() => expect(cardsOf(second.result)).toHaveLength(1));
    expect(second.result.current.messages[0].kind).toBe("restored");
    expect(h.readWithAi).toHaveBeenCalledTimes(1);
  });

  it("đổi công ty ⇒ thẻ của công ty cũ không còn trên trang", async () => {
    h.readWithAi.mockResolvedValue(ok(ai()));
    const { result, rerender } = mount();
    await act(async () => result.current.submitText("102LVT sơn 300k", "company"));
    expect(cardsOf(result)).toHaveLength(1);
    rerender({ r: refs({ orgId: "org-2" }) });
    await waitFor(() => expect(cardsOf(result)).toHaveLength(0));
  });
});

it('reload locks editable-looking card from persisted pending payload instead of changed draft',async()=>{
 const r=refs();h.readWithAi.mockResolvedValue(ok(ai({items:[{desc:'bún',amount_vnd:50000,category:'c1',confidence:1}]})));
 const first=mount(r);await act(async()=>first.result.current.submitText('bún 50k','personal'));
 const card=cardsOf(first.result)[0];
 const path='11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.webp';
 h.pending=[{ownerId:USER,requestKey:card.id,payload:{action:'transaction.batch',rows:[{type:'EXPENSE',amount:70000,txn_date:'2026-09-01',wallet_id:r.personalWallets[0].id,category_id:r.personalCategories[0].id,description:'Đã gửi',attachment_paths:[path]}]}}];
 first.unmount();const restored=mount(r);
 await waitFor(()=>expect(restored.result.current.cards[card.id]?.status.kind).toBe('unknown'));
 expect(restored.result.current.cards[card.id].state.draft.lines[0]).toMatchObject({amount:70000,description:'Đã gửi'});
 expect(restored.result.current.cards[card.id].state.draft.personalAttachmentPaths).toEqual([path]);
});
it('personal photo stays local, failure blocks save, retry persists actual paths before mutation', async () => {
  const file=new File(['bill'],'bill.png',{type:'image/png'});
  h.readWithAi.mockResolvedValue(ok(ai({items:[{desc:'Ăn uống',amount_vnd:50000,category:'c1'}]})));
  const {result}=mount();
  await act(async()=>result.current.submitPhoto(file,'personal'));
  const card=cardsOf(result)[0];
  expect(card.photo).toBe(file);
  h.uploadPersonalPhoto.mockRejectedValueOnce(new Error('Không có quyền tải ảnh'));
  await act(async()=>result.current.saveCard(card.id));
  expect(cardsOf(result)[0].status.kind).toBe('rejected');
  expect(h.savePersonal).not.toHaveBeenCalled();
  const path='11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.webp';
  h.uploadPersonalPhoto.mockResolvedValueOnce(path);
  h.savePersonal.mockImplementation(async(draft)=>{
    expect(JSON.parse(localStorage.getItem(draftsKey(USER,ORG))!).cards[0].state.draft.personalAttachmentPaths).toEqual([path]);
    expect(draft.personalAttachmentPaths).toEqual([path]);
    return {kind:'unknown',ids:[],done:0,message:'retry'};
  });
  await act(async()=>result.current.saveCard(card.id));
  await act(async()=>result.current.saveCard(card.id));
  expect(h.uploadPersonalPhoto).toHaveBeenCalledTimes(2);
  expect(h.savePersonal).toHaveBeenCalledTimes(2);
});
it('reload loses the unuploaded File, retains the marker and refuses Save until explicit discard',async()=>{
 h.readWithAi.mockResolvedValue(ok(ai({items:[{desc:'Ăn uống',amount_vnd:50000,category:'c1'}]})));
 const first=mount();await act(async()=>first.result.current.submitPhoto(new File(['img'],'bill.png',{type:'image/png'}),'personal'));const id=cardsOf(first.result)[0].id;first.unmount();
 const restored=mount();await waitFor(()=>expect(cardsOf(restored.result)).toHaveLength(1));
 expect(cardsOf(restored.result)[0].photo).toBeNull();expect(cardsOf(restored.result)[0].state.draft.personalAttachmentPending).toBe(true);
 await act(async()=>restored.result.current.saveCard(id));expect(h.savePersonal).not.toHaveBeenCalled();
 const card=cardsOf(restored.result)[0];act(()=>restored.result.current.changeCard(id,{...card.state,touched:['personalAttachmentPaths'],draft:{...card.state.draft,personalAttachmentPending:false}}));
 h.savePersonal.mockResolvedValue({kind:'saved',ids:[],done:1,message:'saved'});await act(async()=>restored.result.current.saveCard(id));expect(h.savePersonal).toHaveBeenCalledOnce();
});
it('one photo split into income/expense cards uploads once and shares the confirmed path',async()=>{
 const r=refs({personalCategories:[...refs().personalCategories,{...refs().personalCategories[0],id:'33333333-3333-4333-8333-333333333333',type:'INCOME',name:'Lương'}]});
 h.readWithAi.mockResolvedValue(ok(ai({items:[{desc:'Ăn uống',amount_vnd:50000,category:'c1',transactionType:'EXPENSE'},{desc:'Lương',amount_vnd:100000,category:'c2',transactionType:'INCOME'}]})));
 const {result}=mount(r);await act(async()=>result.current.submitPhoto(new File(['img'],'bill.png',{type:'image/png'}),'personal'));
 expect(cardsOf(result)).toHaveLength(2);const path='11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.webp';h.uploadPersonalPhoto.mockResolvedValue(path);h.savePersonal.mockResolvedValue({kind:'saved',ids:[],done:1,message:'saved'});
 for(const card of cardsOf(result))await act(async()=>result.current.saveCard(card.id));
 expect(h.uploadPersonalPhoto).toHaveBeenCalledOnce();expect(h.savePersonal.mock.calls.every(([draft])=>JSON.stringify(draft.personalAttachmentPaths)===JSON.stringify([path]))).toBe(true);
});
it('closing the feed aborts upload and a late completion never sends a money mutation',async()=>{
 let finish!:(path:string)=>void;h.uploadPersonalPhoto.mockImplementation(()=>new Promise<string>(r=>{finish=r;}));
 h.readWithAi.mockResolvedValue(ok(ai({items:[{desc:'Ăn uống',amount_vnd:50000,category:'c1'}]})));
 const view=mount();await act(async()=>view.result.current.submitPhoto(new File(['img'],'bill.png',{type:'image/png'}),'personal'));const id=cardsOf(view.result)[0].id;
 let pending!:Promise<void>;act(()=>{pending=view.result.current.saveCard(id);});const signal=h.uploadPersonalPhoto.mock.calls[0][2] as AbortSignal;view.unmount();expect(signal.aborted).toBe(true);
 await act(async()=>{finish('11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.webp');await pending;});expect(h.savePersonal).not.toHaveBeenCalled();
});
