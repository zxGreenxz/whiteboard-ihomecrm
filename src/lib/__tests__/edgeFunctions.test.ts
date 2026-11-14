import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  EDGE_FN,
  RESET_PASSWORD_UNKNOWN_MESSAGE,
  ResetUserPasswordError,
  type AdminCreateUserRequest,
  chuanHoaLoiDatLaiMatKhau,
  datLaiMatKhauNguoiDung,
  taoTaiKhoanQuanTri,
} from "../edgeFunctions";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_CHARS } from "../accountFeedback";

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

describe("admin-reset-user-password — hợp đồng khớp mã Deno thật", () => {
  // Đọc TRONG từng ca chứ không ở mức describe: thiếu file thì chỉ các ca này đỏ, không sập cả tệp.
  const nguonReset = () => doc("supabase/functions/admin-reset-user-password/index.ts");

  /** Giá trị của `export const <ten> = <số>;` bên Deno; không thấy ⇒ null. */
  function hangSo(nguon: string, ten: string): number | null {
    const so = new RegExp(`export const ${ten} = (\\d+);`).exec(nguon)?.[1];
    return so === undefined ? null : Number(so);
  }

  it("luật mật khẩu: hai hằng bên Deno bằng đúng hằng frontend", () => {
    const nguon = nguonReset();
    expect(hangSo(nguon, "MIN_PASSWORD_CHARS"), "MIN_PASSWORD_CHARS bên Deno").toBe(MIN_PASSWORD_CHARS);
    expect(hangSo(nguon, "MAX_PASSWORD_BYTES"), "MAX_PASSWORD_BYTES bên Deno").toBe(MAX_PASSWORD_BYTES);
    // Chốt cả giá trị: hai bên cùng trôi sang số khác thì phải có người cố ý sửa ca này.
    expect([MIN_PASSWORD_CHARS, MAX_PASSWORD_BYTES]).toEqual([6, 72]);
  });

  it("thân yêu cầu và phản hồi: mã Deno có `userId`, `password`, `via`", () => {
    const nguon = nguonReset();
    for (const truong of ["userId", "password", "via"]) {
      expect(nguon, `mã Deno không còn "${truong}"`).toMatch(new RegExp(`\\b${truong}\\b`));
    }
  });

  it("mọi mã lỗi và giá trị `via` mà wrapper đọc đều có trong mã Deno", () => {
    // Wrapper ánh xạ theo ĐÚNG chuỗi mã; Deno đổi chính tả một mã là lỗi đó rơi về câu mặc định.
    const nguon = nguonReset();
    const thieu = [
      "invalid_request",
      "unauthorized",
      "forbidden",
      "weak_password",
      "rate_limited",
      "service_unavailable",
      "outcome_unknown",
      "SUPER_ADMIN",
      "COMPANY_OWNER",
    ].filter((chuoi) => !nguon.includes(`"${chuoi}"`) && !nguon.includes(`'${chuoi}'`));
    expect(thieu, `mã Deno thiếu: ${thieu.join(", ")}`).toEqual([]);
  });
});

describe("datLaiMatKhauNguoiDung — ánh xạ lỗi và cờ outcomeUnknown", () => {
  const than = { userId: "u-1", password: "MatKhau123" };

  /** Lỗi non-2xx đúng hình supabase-js: `context` là Response chưa đọc thân. */
  const loiHttp = (status: number, body: unknown) => ({
    data: null,
    error: {
      name: "FunctionsHttpError",
      message: "Edge Function returned a non-2xx status code",
      context: new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json" },
      }),
    },
  });

  async function batLoi(ketQua: unknown): Promise<ResetUserPasswordError> {
    const invoke = vi.fn().mockResolvedValue(ketQua);
    try {
      await datLaiMatKhauNguoiDung(invoke, than);
    } catch (loi) {
      if (loi instanceof ResetUserPasswordError) return loi;
      throw loi;
    }
    throw new Error("datLaiMatKhauNguoiDung lẽ ra phải ném");
  }

  it("thành công: gửi đúng tên hàm + thân, trả `via`", async () => {
    for (const via of ["SUPER_ADMIN", "COMPANY_OWNER"] as const) {
      const invoke = vi.fn().mockResolvedValue({ data: { ok: true, via }, error: null });
      await expect(datLaiMatKhauNguoiDung(invoke, than)).resolves.toEqual({ via });
      expect(invoke).toHaveBeenCalledWith("admin-reset-user-password", {
        body: { userId: "u-1", password: "MatKhau123" },
      });
    }
  });

  it.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [422, "weak_password"],
    [429, "rate_limited"],
    [503, "service_unavailable"],
  ] as const)("HTTP %i `%s` ⇒ chắc chắn chưa đổi, hiện câu của máy chủ", async (status, ma) => {
    const cau = `Câu của máy chủ cho ${ma}.`;
    const loi = await batLoi(loiHttp(status, { error: ma, message: cau }));
    expect(loi.kind).toBe(ma);
    expect(loi.outcomeUnknown).toBe(false);
    expect(loi.httpStatus).toBe(status);
    expect(loi.message).toBe(cau);
  });

  it.each([
    [502, { error: "outcome_unknown", message: "Auth không trả lời rõ." }],
    [500, { error: "internal", message: "Lỗi nội bộ." }],
    [504, "<html>Gateway Timeout</html>"],
    [546, { code: "WORKER_LIMIT", message: "Function failed due to not having enough compute resources" }],
  ])("HTTP %i ⇒ CHƯA BIẾT đã đổi hay chưa, dùng câu riêng", async (status, body) => {
    const loi = await batLoi(loiHttp(status, body));
    expect(loi.kind).toBe("outcome_unknown");
    expect(loi.outcomeUnknown).toBe(true);
    expect(loi.httpStatus).toBe(status);
    expect(loi.message).toBe(RESET_PASSWORD_UNKNOWN_MESSAGE);
  });

  it("mạng đứt, relay lỗi, thân 200 đọc hỏng hay lỗi lạ ⇒ chưa rõ", async () => {
    const cacLoi = [
      { name: "FunctionsFetchError", message: "Failed to send a request to the Edge Function" },
      { name: "FunctionsRelayError", message: "Relay Error invoking the Edge Function", context: new Response("", { status: 200 }) },
      { name: "SyntaxError", message: "Unexpected end of JSON input" },
      { message: "lỗi không tên" },
    ];
    for (const error of cacLoi) {
      const loi = await batLoi({ data: null, error });
      expect(loi.outcomeUnknown, `error.name=${String(error.name)}`).toBe(true);
      expect(loi.kind).toBe("outcome_unknown");
      expect(loi.httpStatus).toBeNull();
      expect(loi.message).toBe(RESET_PASSWORD_UNKNOWN_MESSAGE);
    }
  });

  it("invoke bơm vào mà ném ⇒ chưa rõ", async () => {
    const invoke = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(datLaiMatKhauNguoiDung(invoke, than)).rejects.toMatchObject({
      kind: "outcome_unknown",
      outcomeUnknown: true,
    });
  });

  // Mỗi ca bọc trong mảng một phần tử: ca cuối chính là một MẢNG, không bọc thì it.each trải nó ra.
  it.each([
    [null],
    ["ok"],
    [{}],
    [{ ok: true }],
    [{ ok: true, via: "ADMIN" }],
    [{ ok: false, via: "SUPER_ADMIN" }],
    [{ via: "COMPANY_OWNER" }],
    [[{ ok: true, via: "SUPER_ADMIN" }]],
  ])("200 mà thân sai dạng (%j) ⇒ chưa rõ, không coi là thành công", async (data: unknown) => {
    const loi = await batLoi({ data, error: null });
    expect(loi.kind).toBe("outcome_unknown");
    expect(loi.outcomeUnknown).toBe(true);
    expect(loi.httpStatus).toBe(200);
  });

  it("4xx không mang phong bì của hàm ⇒ chắc chắn chưa đổi; 503 của cổng/proxy ⇒ chưa rõ; không lộ chữ của cổng", async () => {
    const chuaTrienKhai = await batLoi(loiHttp(404, { code: "NOT_FOUND", message: "Requested function was not found" }));
    expect(chuaTrienKhai).toMatchObject({ kind: "not_deployed", outcomeUnknown: false, httpStatus: 404 });
    expect(chuaTrienKhai.message).not.toMatch(/Requested function/);

    const jwtHong = await batLoi(loiHttp(401, { msg: "Invalid JWT" }));
    expect(jwtHong).toMatchObject({ kind: "unauthorized", outcomeUnknown: false });
    expect(jwtHong.message).toMatch(/Phiên đăng nhập/);

    // 503 không có phong bì của hàm có thể do proxy trả SAU khi hàm đã đổi xong ⇒ không dám nói "chưa đổi".
    const congBan = await batLoi(loiHttp(503, "<html>Service Unavailable</html>"));
    expect(congBan).toMatchObject({ kind: "outcome_unknown", outcomeUnknown: true, httpStatus: 503 });
    expect(congBan.message).not.toMatch(/Service Unavailable/);

    // 503 mang đúng phong bì của hàm (hỏng TRƯỚC bước đổi) ⇒ chắc chắn chưa đổi.
    const hamBao = await batLoi(loiHttp(503, { error: "service_unavailable", message: "Hệ thống chưa đặt lại được mật khẩu (chưa có gì thay đổi)." }));
    expect(hamBao).toMatchObject({ kind: "service_unavailable", outcomeUnknown: false, httpStatus: 503 });
  });

  it.each([
    [405, "method_not_allowed", "Chỉ nhận POST."],
    [413, "payload_too_large", "Yêu cầu quá lớn."],
    [415, "unsupported_media_type", "Yêu cầu phải là JSON."],
  ])("HTTP %i `%s` (mã ngoài danh sách) ⇒ chắc chắn chưa đổi, vẫn hiện câu của máy chủ", async (status, ma, cau) => {
    const loi = await batLoi(loiHttp(status, { error: ma, message: cau }));
    expect(loi).toMatchObject({ kind: "invalid_request", outcomeUnknown: false, httpStatus: status, message: cau });
  });

  it("máy chủ không gửi `message` ⇒ câu mặc định theo mã; mã trong thân thắng status", async () => {
    const yeu = await batLoi(loiHttp(422, { error: "weak_password" }));
    expect(yeu).toMatchObject({ kind: "weak_password", outcomeUnknown: false });
    expect(yeu.message).toMatch(/quá yếu/);

    const rong = await batLoi(loiHttp(400, { error: "forbidden", message: "   " }));
    expect(rong).toMatchObject({ kind: "forbidden", outcomeUnknown: false });
    expect(rong.message).toMatch(/không có quyền/);
  });

  it("4xx mà thân nói `outcome_unknown` ⇒ vẫn là chưa rõ", async () => {
    const loi = await batLoi(loiHttp(400, { error: "outcome_unknown", message: "?" }));
    expect(loi).toMatchObject({ kind: "outcome_unknown", outcomeUnknown: true, message: RESET_PASSWORD_UNKNOWN_MESSAGE });
  });

  it("chuanHoaLoiDatLaiMatKhau: giữ nguyên lỗi của luồng, lỗi lạ thành chưa rõ", () => {
    const loi = new ResetUserPasswordError("forbidden", "Không được.", 403);
    expect(chuanHoaLoiDatLaiMatKhau(loi)).toBe(loi);
    expect(chuanHoaLoiDatLaiMatKhau(new Error("boom"))).toMatchObject({
      kind: "outcome_unknown",
      outcomeUnknown: true,
      message: RESET_PASSWORD_UNKNOWN_MESSAGE,
    });
  });
});
