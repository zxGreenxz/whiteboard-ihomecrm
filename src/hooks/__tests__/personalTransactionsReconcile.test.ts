// @vitest-environment jsdom
// Lỗi cũ: useCreatePersonalTransaction dùng FinancialWorkflowGuard khoá cố định 'create' mà không có
// bước đối chiếu ⇒ MỘT lần lưu rớt mạng để lại dấu "đang chờ" trong localStorage và chặn MỌI khoản cá
// nhân sau đó trên máy đó, vĩnh viễn. Đối chiếu: có khoản giống hệt tạo sau lúc đó ⇒ chính là nó;
// không có ⇒ ghi khoản đang lưu.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  insertSingle: vi.fn(),
  selectResult: vi.fn(),
  inserted: [] as unknown[],
  filters: [] as Array<[string, unknown]>,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: unknown) => options,
  useQuery: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/lib/authSession", () => ({ getSessionUser: async () => ({ id: "u1" }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "gte", "order"]) {
      q[m] = (...args: unknown[]) => {
        if (m !== "select") h.filters.push([m, args]);
        return q;
      };
    }
    q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(h.selectResult()).then(ok, bad);
    return q;
  };
  return {
    supabase: {
      from: () => ({
        insert: (row: unknown) => {
          h.inserted.push(row);
          return { select: () => ({ single: h.insertSingle }) };
        },
        select: () => chain(),
      }),
    },
  };
});

import { useCreatePersonalTransaction, type PersonalTransactionFormValues } from "../usePersonalTransactions";

type Mutation = { mutationFn: (v: PersonalTransactionFormValues) => Promise<unknown> };
// react-query bị giả thành "trả nguyên options" nên gọi hook ngoài React là an toàn; đặt tên use*
// để đúng luật hook. Dấu "đang chờ" sống trong localStorage nên hai lần gọi giống hai lần tải trang.
const useCreate = () => useCreatePersonalTransaction() as unknown as Mutation;

const pho: PersonalTransactionFormValues = { type: "EXPENSE", amount: 50_000, txn_date: "2026-10-01", category: "Ăn uống", description: "phở" };
const xang: PersonalTransactionFormValues = { type: "EXPENSE", amount: 80_000, txn_date: "2026-10-01", category: "Đi lại", description: "xăng" };
const row = (v: PersonalTransactionFormValues, id: string) => ({ id, user_id: "u1", ...v, amount: String(v.amount), deleted_at: null });

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  h.insertSingle.mockReset();
  h.selectResult.mockReset();
  h.inserted.length = 0;
  h.filters.length = 0;
});

async function failOnce(m: Mutation, v: PersonalTransactionFormValues) {
  h.insertSingle.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(m.mutationFn(v)).rejects.toBeTruthy();
}

describe("useCreatePersonalTransaction — đối chiếu sau lần lưu không rõ kết quả", () => {
  it("lần trước THỰC RA đã ghi ⇒ lưu lại cùng khoản trả đúng khoản đó, không ghi trùng", async () => {
    await failOnce(useCreate(), pho);
    h.selectResult.mockResolvedValueOnce({ data: [row(pho, "p1")], error: null });
    await expect(useCreate().mutationFn(pho)).resolves.toMatchObject({ id: "p1" });
    expect(h.inserted).toHaveLength(1);
  });

  it("lần trước KHÔNG ghi được ⇒ lưu lại thì ghi mới, rồi hết bị chặn", async () => {
    await failOnce(useCreate(), pho);
    h.selectResult.mockResolvedValueOnce({ data: [], error: null });
    h.insertSingle.mockResolvedValueOnce({ data: row(pho, "p2"), error: null });
    await expect(useCreate().mutationFn(pho)).resolves.toMatchObject({ id: "p2" });

    h.insertSingle.mockResolvedValueOnce({ data: row(xang, "x1"), error: null });
    await expect(useCreate().mutationFn(xang)).resolves.toMatchObject({ id: "x1" });
    expect(h.selectResult).toHaveBeenCalledTimes(1);
  });

  it("khoản KHÁC sau lần rớt mạng vẫn ghi được (trước đây bị chặn vĩnh viễn)", async () => {
    await failOnce(useCreate(), pho);
    h.selectResult.mockResolvedValueOnce({ data: [row(pho, "p1")], error: null });
    h.insertSingle.mockResolvedValueOnce({ data: row(xang, "x1"), error: null });
    await expect(useCreate().mutationFn(xang)).resolves.toMatchObject({ id: "x1" });
  });

  it("lưu khoản KHÁC không xoá dấu của khoản đang treo ⇒ gửi lại khoản treo vẫn đối chiếu, không ghi trùng", async () => {
    await failOnce(useCreate(), pho); // phở: rớt mạng — thật ra máy chủ đã ghi
    h.selectResult.mockResolvedValue({ data: [row(pho, "p1")], error: null });
    h.insertSingle.mockResolvedValueOnce({ data: row(xang, "x1"), error: null });
    await expect(useCreate().mutationFn(xang)).resolves.toMatchObject({ id: "x1" });
    await expect(useCreate().mutationFn(pho)).resolves.toMatchObject({ id: "p1" });
    expect(h.inserted.map((r) => (r as { description: string }).description)).toEqual(["phở", "xăng"]);
  });

  it("khoản giống mọi thứ trừ SỐ TIỀN không phải là nó ⇒ vẫn ghi khoản đang lưu", async () => {
    await failOnce(useCreate(), pho);
    h.selectResult.mockResolvedValueOnce({ data: [row({ ...pho, amount: 45_000 }, "p0")], error: null });
    h.insertSingle.mockResolvedValueOnce({ data: row(pho, "p3"), error: null });
    await expect(useCreate().mutationFn(pho)).resolves.toMatchObject({ id: "p3" });
    expect(h.inserted).toHaveLength(2);
  });

  it("đối chiếu chỉ xét khoản CỦA MÌNH tạo từ lúc lần trước bắt đầu", async () => {
    await failOnce(useCreate(), pho);
    h.selectResult.mockResolvedValueOnce({ data: [], error: null });
    h.insertSingle.mockResolvedValueOnce({ data: row(pho, "p2"), error: null });
    await useCreate().mutationFn(pho);
    expect(h.filters).toContainEqual(["eq", ["user_id", "u1"]]);
    expect(h.filters).toContainEqual(["is", ["deleted_at", null]]);
    expect(h.filters.some(([m, a]) => m === "gte" && (a as unknown[])[0] === "created_at")).toBe(true);
  });

  it("chính bước đối chiếu lỗi mạng ⇒ vẫn giữ khoá, không ghi bừa", async () => {
    await failOnce(useCreate(), pho);
    h.selectResult.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    await expect(useCreate().mutationFn(pho)).rejects.toBeTruthy();
    expect(h.inserted).toHaveLength(1);
  });
});
