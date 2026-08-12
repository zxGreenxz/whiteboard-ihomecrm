import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  EDGE_FN,
  type AdminCreateUserRequest,
  taoTaiKhoanQuanTri,
} from "../edgeFunctions";

/**
 * Chốt chặn chống TRÔI cho `src/lib/edgeFunctions.ts`.
 *
 * Edge Function là bề mặt DUY NHẤT của app không có kiểu sinh tự động: không có
 * `Database["public"]["Functions"]` nào mô tả nó, nên kiểu ở phía frontend là bản
 * CHÉP TAY từ mã Deno. Bản chép thì trôi, và trình biên dịch sẽ im lặng vì nó tin
 * lời khai. Đó đúng lớp lỗi repo này đã trả giá nhiều lần.
 *
 * Nên các ca dưới đây đọc THẲNG `supabase/functions/<tên>/index.ts` rồi đối chiếu.
 */
const doc = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

/** Bóc tên trường của một `interface X { … }` trong mã nguồn TypeScript/Deno. */
function truongCuaInterface(nguon: string, ten: string): string[] {
  const mo = nguon.indexOf(`interface ${ten} {`);
  if (mo === -1) throw new Error(`không tìm thấy interface ${ten}`);
  const dong = nguon.indexOf("}", mo);
  const than = nguon.slice(mo, dong);
  // `m[1]` là `string | undefined` dưới `noUncheckedIndexedAccess` (đảo tầng 2).
  // Nhóm bắt ở đây luôn khớp khi cả regex khớp, nhưng kiểu không biết điều đó —
  // lọc tường minh thay vì ép kiểu, để nếu regex đổi thì kết quả teo đi chứ không
  // sinh ra `undefined` trôi xuống phép so bên dưới.
  return [...than.matchAll(/^\s{2}(\w+)\??:/gm)]
    .map((m) => m[1])
    .filter((t): t is string => typeof t === "string");
}

describe("hợp đồng Edge Function khớp mã Deno thật", () => {
  const nguonAdmin = doc("supabase/functions/admin-create-user/index.ts");

  it("thư mục Edge Function tồn tại đúng tên đang khai", () => {
    // Sai tên là 404 lúc chạy, không phải lỗi biên dịch — nên phải kiểm ở đây.
    for (const ten of Object.values(EDGE_FN)) {
      expect(() => doc(`supabase/functions/${ten}/index.ts`), `thiếu ${ten}`).not.toThrow();
    }
  });

  it("mọi trường của CreateUserRequest bên Deno đều CÓ trong kiểu frontend", () => {
    const ben_deno = truongCuaInterface(nguonAdmin, "CreateUserRequest");
    // Chống-xanh-rỗng: bóc hỏng thì mảng rỗng và phép so trở nên vô nghĩa.
    expect(ben_deno.length).toBeGreaterThanOrEqual(8);

    // Khai đủ ở phía frontend. `satisfies` bắt lỗi lúc biên dịch nếu tên nào sai;
    // phép so bên dưới bắt lỗi khi Deno THÊM trường mới mà đây chưa theo.
    const ben_fe: Record<keyof AdminCreateUserRequest, true> = {
      email: true,
      password: true,
      full_name: true,
      phone: true,
      username: true,
      contact_email: true,
      employee_code: true,
      department: true,
      job_title: true,
      is_active: true,
    };
    const thieu = ben_deno.filter((t) => !(t in ben_fe));
    expect(thieu, `kiểu frontend thiếu trường Deno đang nhận: ${thieu.join(", ")}`).toEqual([]);
  });

  it("mã Deno vẫn trả `user: { id, email }` khi thành công", () => {
    // Wrapper đọc đúng hai khoá này. Deno đổi hình dạng phản hồi thì ca này đỏ.
    expect(nguonAdmin).toContain("user: { id: created.user.id, email: created.user.email }");
  });
});

describe("taoTaiKhoanQuanTri — ba đường hỏng", () => {
  const ok = { data: { success: true, user: { id: "u1", email: "a@b.c" } }, error: null };

  it("thành công trả về id + email", async () => {
    const invoke = vi.fn().mockResolvedValue(ok);
    await expect(taoTaiKhoanQuanTri(invoke, { email: "a@b.c", password: "123456" })).resolves.toEqual(
      { id: "u1", email: "a@b.c" },
    );
    expect(invoke).toHaveBeenCalledWith("admin-create-user", {
      body: { email: "a@b.c", password: "123456" },
    });
  });

  it("(1) lỗi của supabase-js → ném kèm message", async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: { message: "mạng hỏng" } });
    await expect(taoTaiKhoanQuanTri(invoke, { email: "a", password: "b" })).rejects.toThrow("mạng hỏng");
  });

  it("(1b) lỗi không có message → dùng thông điệp mặc định của caller", async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: { message: "" } });
    await expect(
      taoTaiKhoanQuanTri(invoke, { email: "a", password: "b" }, "Tạo user thất bại"),
    ).rejects.toThrow("Tạo user thất bại");
  });

  it("(2) phản hồi mang { error } → ném ĐÚNG thông điệp của server", async () => {
    // Edge trả 400/403 KÈM thân JSON. Hai caller cũ đều đọc chỗ này bằng
    // `(data as any)?.error`; giờ chỉ còn một chỗ đọc.
    const invoke = vi.fn().mockResolvedValue({ data: { error: "Forbidden: super_admin only" }, error: null });
    await expect(taoTaiKhoanQuanTri(invoke, { email: "a", password: "b" })).rejects.toThrow(
      "Forbidden: super_admin only",
    );
  });

  it("(3) 200 mà THIẾU user.id → ném, không trả về id rỗng", async () => {
    // Đây là đường mà `useAdminUsers` TRƯỚC ĐÂY BỎ SÓT: nó `return data` thẳng,
    // nên hợp đồng vỡ sẽ đi tiếp xuống dưới dưới dạng undefined.
    for (const data of [{ success: true }, { success: true, user: {} }, { success: true, user: { id: "" } }, null]) {
      const invoke = vi.fn().mockResolvedValue({ data, error: null });
      await expect(
        taoTaiKhoanQuanTri(invoke, { email: "a", password: "b" }),
        `không ném với data=${JSON.stringify(data)}`,
      ).rejects.toThrow("Không nhận được ID tài khoản mới");
    }
  });

  it("email không phải chuỗi → trả null chứ không ném", async () => {
    // Id là thứ caller BẮT BUỘC cần; email chỉ để hiển thị nên thiếu không đáng
    // làm hỏng cả luồng tạo tài khoản.
    const invoke = vi.fn().mockResolvedValue({ data: { user: { id: "u1", email: null } }, error: null });
    await expect(taoTaiKhoanQuanTri(invoke, { email: "a", password: "b" })).resolves.toEqual({
      id: "u1",
      email: null,
    });
  });
});
