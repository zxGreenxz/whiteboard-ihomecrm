// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({ createWalletVoucher:vi.fn(), createIE: vi.fn(), createPersonal: vi.fn(), prepare: vi.fn(), upload: vi.fn() }));
vi.mock('@/hooks/company-wallet/useCompanyWallets',()=>({useCreateCompanyWalletVoucher:()=>({mutateAsync:h.createWalletVoucher})}));
vi.mock("@/hooks/income-expenses/mutations", () => ({ useCreateIncomeExpense: () => ({ mutateAsync: h.createIE }) }));
vi.mock("@/hooks/personal-finance/usePersonalFinance", () => ({ usePersonalFinanceMutation: () => ({ mutateAsync: h.createPersonal, prepare:h.prepare, pending:[] }) }));
vi.mock("@/lib/storage", () => ({ uploadFileDetailed: h.upload }));
vi.mock("@/lib/authSession", () => ({ getSessionUser: async () => ({ id: "u1" }) }));

import { useQuickEntrySave } from "../useQuickEntrySave";
import type { QuickDraft } from "@/lib/quickEntry/draft";
import { CompanyWalletError } from '@/lib/companyWallet/service';

const ID = "0f1e2d3c-4b5a-4987-8765-43210fedcba9";
const company: QuickDraft = {
  id: ID,
  mode: "company",
  date: "2026-10-01",
  name: "Mua bóng đèn",
  vendor: null,
  buildingId: "b102",
  roomId: null,
  accountId: "acc1",
  attachmentUrls: ["https://cdn.test/a.jpg"],
  lines: [{ description: "bóng đèn", amount: 120_000, categoryId: "t1", personalCategory: null, periodStart: null, periodEnd: null }],
};
const personal: QuickDraft = {
  ...company,
  mode: "personal", personalProtocol:1, personalWalletId:ID,
  buildingId: null,
  accountId: null,
  attachmentUrls: [],
  name: "Đi chợ",
  lines: [
    { description: "rau", amount: 20_000, categoryId: null, personalCategoryId:ID, personalCategory: "Ăn uống", periodStart: null, periodEnd: null },
    { description: "dầu gội", amount: 85_000, categoryId: null, personalCategoryId:ID, personalCategory: "Cá nhân", periodStart: null, periodEnd: null },
  ],
};

beforeEach(() => {
  h.createWalletVoucher.mockReset();
  h.createIE.mockReset();
  h.createPersonal.mockReset(); h.prepare.mockImplementation((payload,requestKey)=>({ownerId:ID,payload,requestKey}));
  h.upload.mockReset();
});

const save = () => renderHook(() => useQuickEntrySave()).result.current;

describe("useQuickEntrySave — công ty", () => {
  it('receipt chưa xác nhận giữ khóa gửi lại của writer ví công ty',async()=>{
    h.createWalletVoucher.mockRejectedValueOnce(new CompanyWalletError('internal','receipt mismatch',undefined,true));
    const writer=renderHook(()=>useQuickEntrySave('org-demo')).result.current;
    expect(await writer.saveCompany({...company,entrySource:'personal_wallet',companyOrganizationId:'org-demo',companyWalletId:'wallet-demo'})).toMatchObject({kind:'unknown'});
    expect(h.createIE).not.toHaveBeenCalled();
  });
  it('phiếu từ trang ví dùng writer atomic với ví và khóa chống trùng, không gọi writer thường',async()=>{
    h.createWalletVoucher.mockResolvedValueOnce({id:'v-wallet',code:'PC-DEMO',approval_status:'UNAPPROVED'});
    const writer=renderHook(()=>useQuickEntrySave('org-demo')).result.current;
    const out=await writer.saveCompany({...company,entrySource:'personal_wallet',companyOrganizationId:'org-demo',companyWalletId:'wallet-demo'});
    expect(out).toMatchObject({kind:'saved',ids:['v-wallet']});
    expect(h.createWalletVoucher).toHaveBeenCalledWith(expect.objectContaining({walletId:'wallet-demo',idempotencyKey:`qe-${ID}`}));
    expect(h.createIE).not.toHaveBeenCalled();
    expect(h.createPersonal).not.toHaveBeenCalled();
  });
  it('đổi công ty không gửi nháp sang công ty mới',async()=>{
    const writer=renderHook(()=>useQuickEntrySave('org-other')).result.current;
    expect(await writer.saveCompany({...company,entrySource:'personal_wallet',companyOrganizationId:'org-demo',companyWalletId:'wallet-demo'})).toMatchObject({kind:'rejected'});
    expect(h.createWalletVoucher).not.toHaveBeenCalled();
    expect(h.createIE).not.toHaveBeenCalled();
  });
  it("gửi đúng hình phiếu với khoá chống trùng của thẻ; trả mã + trạng thái máy chủ quyết", async () => {
    h.createIE.mockResolvedValueOnce({ id: "v1", code: "PC2610001", approval_status: "UNAPPROVED" });
    const out = await save().saveCompany(company);
    expect(h.createIE.mock.calls[0][0]).toMatchObject({ idempotency_key: `qe-${ID}`, building_id: "b102", account_id: "acc1" });
    expect(out).toMatchObject({ kind: "saved", code: "PC2610001", approvalStatus: "UNAPPROVED", ids: ["v1"], done: 1 });
  });

  it("rớt mạng ⇒ 'unknown' (thẻ phải khoá, chỉ thử lại y nguyên)", async () => {
    h.createIE.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await save().saveCompany(company)).toMatchObject({ kind: "unknown", done: 0 });
  });

  it("rớt mạng ở đường compat (không có khoá chống trùng) ⇒ 'maybe_saved', KHÔNG cho gửi lại y nguyên", async () => {
    h.createIE.mockRejectedValueOnce(Object.assign(new TypeError("Failed to fetch"), { ieCreatePath: "compat" }));
    const out = await save().saveCompany(company);
    expect(out.kind).toBe("maybe_saved");
    expect(out.message).toContain("Thu chi");
  });

  it("23505 cùng khoá ⇒ 'maybe_saved' (có thể đã lưu ở lần trước)", async () => {
    h.createIE.mockRejectedValueOnce({ code: "23505", message: "duplicate key" });
    expect((await save().saveCompany(company)).kind).toBe("maybe_saved");
  });

  it("máy chủ từ chối (thiếu quyền) ⇒ 'rejected' kèm lời báo", async () => {
    h.createIE.mockRejectedValueOnce({ code: "42501", message: "Không có quyền tạo phiếu trên toà này" });
    const out = await save().saveCompany(company);
    expect(out.kind).toBe("rejected");
    expect(out.message.length).toBeGreaterThan(5);
  });
});

describe("useQuickEntrySave — cá nhân atomic", () => {
  it("ghi tất cả dòng trong một batch và trả các id xác nhận", async()=>{
    h.createPersonal.mockResolvedValue({entities:[{id:'p1'},{id:'p2'}]});
    const out=await save().savePersonal(personal);
    expect(h.createPersonal).toHaveBeenCalledTimes(1);
    expect(h.createPersonal.mock.calls[0][0]).toMatchObject({requestKey:ID,payload:{action:'transaction.batch',rows:[{amount:20000,category_id:ID},{amount:85000,category_id:ID}]}});
    expect(out).toMatchObject({kind:'saved',ids:['p1','p2'],done:2});
  });
  it("batch rớt mạng không nhận một phần hay báo thành công",async()=>{
    h.createPersonal.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await save().savePersonal(personal)).toMatchObject({kind:'unknown',ids:[],done:0});
  });
  it("lời báo yêu cầu gửi lại y nguyên với khóa máy chủ và trỏ về Ví cá nhân",async()=>{
    h.createPersonal.mockRejectedValue(new TypeError('Failed to fetch'));
    const out=await save().savePersonal(personal);expect(out.message).toContain('máy chủ');expect(out.message).toContain('Ví cá nhân');expect(out.message).not.toContain('Thu chi');
  });
  it("retry giữ nguyên UUID và payload của batch",async()=>{
    h.createPersonal.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({entities:[{id:'p1'},{id:'p2'}]});
    await save().savePersonal(personal);const retry=await save().savePersonal(personal);
    expect(h.createPersonal.mock.calls[1][0]).toEqual(h.createPersonal.mock.calls[0][0]);expect(retry).toMatchObject({kind:'saved',done:2});
  });
  it("tiến độ chỉ báo một lần sau biên nhận atomic",async()=>{
    const seen:number[]=[];h.createPersonal.mockImplementation(async()=>{expect(seen).toEqual([]);return{entities:[{id:'p1'},{id:'p2'}]};});
    await save().savePersonal(personal,0,n=>seen.push(n));expect(seen).toEqual([2]);
  });
  it("nháp cũ đã ghi một phần khóa đối chiếu, không replay bất kỳ dòng nào",async()=>{
    const out=await save().savePersonal({...personal,personalProtocol:undefined},1);
    expect(out).toMatchObject({kind:'maybe_saved',ids:[],done:1});expect(out.message).toContain('Đối chiếu');expect(h.createPersonal).not.toHaveBeenCalled();
  });
  it("máy chủ từ chối batch thì không có dòng thành công",async()=>{
    h.createPersonal.mockRejectedValue(Object.assign(new Error('permission denied'),{code:'42501'}));
    expect(await save().savePersonal(personal)).toMatchObject({kind:'rejected',ids:[],done:0});expect(h.createPersonal).toHaveBeenCalledTimes(1);
  });
});
describe("useQuickEntrySave — ảnh chứng từ", () => {
  it("tải vào kho chứng từ phiếu, đường dẫn trong thư mục của chính người dùng, gắn id thẻ", async () => {
    h.upload.mockResolvedValueOnce({ url: "https://cdn.test/u1/x.jpg", path: "u1/x.jpg", type: "image/jpeg", size: 1 });
    const url = await save().uploadPhoto(new File(["x"], "bill.jpg", { type: "image/jpeg" }), ID);
    expect(url).toBe("https://cdn.test/u1/x.jpg");
    const [bucket, path] = h.upload.mock.calls[0];
    expect(bucket).toBe("income-expense-attachments");
    expect(path).toMatch(new RegExp(`^u1/\\d+-qe-${ID}\\.jpg$`));
  });

  it("ảnh chụp màn hình PNG/WebP ⇒ đuôi đường dẫn theo đúng loại ảnh (nén không lợi thì giữ file gốc)", async () => {
    h.upload.mockResolvedValue({ url: "https://cdn.test/u1/x", path: "u1/x", type: "image/png", size: 1 });
    await save().uploadPhoto(new File(["x"], "Screenshot.png", { type: "image/png" }), ID);
    await save().uploadPhoto(new File(["x"], "shopee", { type: "image/webp" }), ID);
    expect(h.upload.mock.calls[0][1]).toMatch(/\.png$/);
    expect(h.upload.mock.calls[1][1]).toMatch(/\.webp$/);
  });
});
