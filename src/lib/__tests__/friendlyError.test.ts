import { describe, expect, it } from "vitest";

import { friendlyError } from "../friendlyError";

describe("friendlyError — 42501", () => {
  it("giữ nguyên message nghiệp vụ của RPC thay vì nuốt thành 'Không đủ quyền'", () => {
    // Án lệ 27/07/2026: create_contract_v2 ném đúng lý do (chọn nhầm sổ ảo)
    // nhưng dùng ERRCODE 42501, nên user chỉ thấy "chưa được cấp quyền".
    const fe = friendlyError(
      { code: "42501", message: "Sổ quỹ cọc không thuộc tổ chức" },
      "Không lưu được hợp đồng",
    );

    expect(fe.title).toBe("Không lưu được hợp đồng");
    expect(fe.description).toBe("Sổ quỹ cọc không thuộc tổ chức");
  });

  it.each([
    "Không có quyền tạo hợp đồng",
    "Không có quyền ghi tiền cọc vào sổ đã chọn",
    "Khách hàng không thuộc tổ chức",
  ])("hiện rõ lý do RPC: %s", (message) => {
    expect(friendlyError({ code: "42501", message }).description).toBe(message);
  });

  it.each([
    "permission denied for table contracts",
    "permission denied for schema app_private",
    'new row violates row-level security policy for table "contracts"',
  ])("vẫn báo chung khi Postgres tự chặn: %s", (message) => {
    const fe = friendlyError({ code: "42501", message });

    expect(fe.title).toBe("Không đủ quyền");
    expect(fe.description).toContain("liên hệ quản trị viên");
  });

  it("báo chung khi 42501 không kèm message", () => {
    expect(friendlyError({ code: "42501", message: "" }).title).toBe(
      "Không đủ quyền",
    );
  });
});

describe("friendlyError — các nhánh cũ không đổi", () => {
  it("map 23505 thành lỗi trùng dữ liệu", () => {
    expect(friendlyError({ code: "23505", message: "duplicate key" }).title).toBe(
      "Trùng dữ liệu",
    );
  });

  it("map heuristic 'row-level security' khi không có code", () => {
    const fe = friendlyError({
      message: 'new row violates row-level security policy for table "invoices"',
    });

    expect(fe.title).toBe("Không đủ quyền");
  });

  it("dùng fallbackTitle khi không nhận diện được", () => {
    expect(friendlyError({ message: "wat" }, "Không lưu được hợp đồng").title).toBe(
      "Không lưu được hợp đồng",
    );
  });

  it("chịu được error rỗng", () => {
    expect(friendlyError(null, "Không lưu được hợp đồng").title).toBe(
      "Không lưu được hợp đồng",
    );
  });
});
