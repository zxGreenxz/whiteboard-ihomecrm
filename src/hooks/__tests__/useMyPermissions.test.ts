// `get_my_permissions()` lỗi từng ra `{}` — và `{}` đọc y hệt "tài khoản này
// không có quyền gì". RequirePermission thấy vậy thì Navigate về `/`, nên một
// lần RPC hỏng nhất thời (5xx, đứt mạng, JWT vừa hết hạn) đá người dùng ra khỏi
// đúng trang họ có quyền, im lặng, không có gì để bấm thử lại.
//
// Mock `{ error }` chứ KHÔNG mockRejectedValue: supabase.rpc không bao giờ ném,
// nó trả lỗi trong envelope — test ném-sẵn sẽ xanh cả khi mã nuốt lỗi.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

const { fetchMyPermissions, can } = await import("../useMyPermissions");
type PermissionsMap = Awaited<ReturnType<typeof fetchMyPermissions>>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchMyPermissions", () => {
  it("trả đúng map khi RPC thành công", async () => {
    rpc.mockResolvedValue({ data: { invoices: { view: true } }, error: null });
    await expect(fetchMyPermissions()).resolves.toEqual({ invoices: { view: true } });
  });

  it("giữ sentinel __superadmin", async () => {
    rpc.mockResolvedValue({ data: { __superadmin: true }, error: null });
    await expect(fetchMyPermissions()).resolves.toEqual({ __superadmin: true });
  });

  it("RPC trả { error } → NÉM, không trả {}", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "RLS" } });
    await expect(fetchMyPermissions()).rejects.toMatchObject({ code: "42501" });
  });

  it("lỗi mạng trong envelope cũng ném", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    await expect(fetchMyPermissions()).rejects.toBeTruthy();
  });

  it("data null KHÔNG lỗi → {} (tài khoản chưa gán vai, đây là câu trả lời thật)", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(fetchMyPermissions()).resolves.toEqual({});
  });

  it("data sai hình dạng (array) → {}", async () => {
    rpc.mockResolvedValue({ data: [1, 2], error: null });
    await expect(fetchMyPermissions()).resolves.toEqual({});
  });
});

describe("can — không đổi hành vi", () => {
  it("undefined → false", () => {
    expect(can(undefined, "invoices", "view")).toBe(false);
  });

  it("__superadmin → true cho mọi module", () => {
    expect(can({ __superadmin: true } as PermissionsMap, "bat-ky", "delete")).toBe(true);
  });
});
