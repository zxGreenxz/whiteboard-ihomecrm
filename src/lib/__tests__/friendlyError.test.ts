import { describe, expect, it } from "vitest";

import { friendlyError, isSystemOnlyManualBlocked } from "../friendlyError";

describe("friendlyError — hạng mục hệ thống bị chặn lập tay (danh mục chi chuẩn 03/10/2026)", () => {
  const blocked = {
    code: "42501",
    message: "Hạng mục này chỉ được tạo từ luồng nghiệp vụ (hợp đồng, phiếu cọc, thanh lý), không lập tay ở Thu chi",
    hint: "ie_system_only_manual_blocked",
  };

  it("đổi 42501 + HINT thành lời giải thích, không phải 'Không đủ quyền'", () => {
    const fe = friendlyError(blocked, "Không thể tạo phiếu", { operation: "tạo phiếu", financial: true });
    expect(fe.title).toBe("Không lập tay được hạng mục này");
    expect(fe.description).toBe(
      "Hoa hồng, thưởng sale và các khoản cọc/thanh lý chỉ tạo từ hợp đồng, phiếu cọc hoặc thanh lý.",
    );
  });

  it("nhận theo HINT hoặc theo câu thông báo; lỗi bọc trong cause vẫn nhận", () => {
    expect(isSystemOnlyManualBlocked({ code: "42501", message: "x", hint: "ie_system_only_manual_blocked" })).toBe(true);
    expect(isSystemOnlyManualBlocked({ code: "42501", message: blocked.message })).toBe(true);
    expect(isSystemOnlyManualBlocked({ cause: blocked })).toBe(true);
  });

  it("các lỗi 42501 khác giữ nguyên cách báo cũ", () => {
    expect(isSystemOnlyManualBlocked({ code: "42501", message: "permission denied for table x" })).toBe(false);
    expect(isSystemOnlyManualBlocked({ code: "P0001", message: blocked.message })).toBe(false);
    expect(friendlyError({ code: "42501", message: "permission denied for table x" }).title).toBe("Không đủ quyền");
  });
});
it('reports rent support disabled without implying a contract was saved', () => {
  expect(friendlyError({ code: '55000', message: 'RENT_SUPPORT_WRITERS_DISABLED' }).description).toContain('chưa được bật');
});

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

describe("friendlyError — 55000", () => {
  it.each([
    "canonical income expense 401f14e3-a43d-4f4b-b878-6a631c27e4fd is frozen (update rejected)",
    "link contract scope may only change contract_id of 401f14e3-a43d-4f4b-b878-6a631c27e4fd",
    "cashbook move scope may only change account_id of 401f14e3",
    "authorized transition may only change lifecycle columns of 401f14e3",
  ])("giấu câu guard nội bộ sau hướng dẫn kèm mã lỗi: %s", (message) => {
    // Án lệ 05/08/2026: cửa LINK_CONTRACT bị đợt vá sau xoá mất ⇒ tạo hợp đồng
    // trên phòng "Đã cọc" chết 55000, nhưng user chỉ thấy "Vui lòng thử lại".
    const fe = friendlyError({ code: "55000", message }, "Không lưu được hợp đồng");

    expect(fe.title).toBe("Thao tác bị khoá bởi hệ thống kế toán");
    expect(fe.code).toBe("55000");
    expect(fe.description).not.toContain("55000");
    expect(fe.description).not.toContain(message);
  });

  it.each([
    "Phiếu cọc được chọn không hợp lệ hoặc đã được dùng",
    "Số tiền cọc phải lớn hơn 0",
    "Phòng đang có hợp đồng hiệu lực",
  ])("đưa nguyên văn câu nghiệp vụ ra cho user: %s", (message) => {
    const fe = friendlyError({ code: "55000", message }, "Không lưu được hợp đồng");

    expect(fe.title).toBe("Không lưu được hợp đồng");
    expect(fe.description).toBe(message);
  });

  it("báo chung khi 55000 không kèm message", () => {
    const fe = friendlyError({ code: "55000", message: "" }, "Không lưu được hợp đồng");

    expect(fe.title).toBe("Không lưu được hợp đồng");
    expect(fe.description).toContain("kiểm tra lại trạng thái");
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
