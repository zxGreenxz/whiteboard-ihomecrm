import { describe, it, expect } from "vitest";
import { oCsvAnToan as o } from "../ExportButtons";

/**
 * Ô CSV do NGƯỜI NGOÀI điều khiển: `log_public_room_events` mở cho `anon`, nên
 * ai cầm link chia sẻ cũng ghi được thông điệp lỗi tuỳ ý, và chuỗi đó chảy vào
 * file mà chủ nhà mở bằng Excel.
 */
describe("ô CSV an toàn", () => {
  it("bọc nháy mọi chuỗi và nhân đôi nháy bên trong", () => {
    expect(o("binh thuong")).toBe('"binh thuong"');
    // Dấu nháy lẻ không được phép lọt ra: nó nuốt phần còn lại của file vào một ô.
    expect(o('co "nhay" ben trong')).toBe('"co ""nhay"" ben trong"');
    expect(o("co, phay")).toBe('"co, phay"');
    expect(o("co\nxuong dong")).toBe('"co\nxuong dong"');
  });

  it("vô hiệu hoá công thức Excel — bọc nháy KHÔNG đủ để chặn", () => {
    for (const doc of ["=1+1", "+1", "-1", "@SUM(A1)", "=HYPERLINK(\"http://x\",\"a\")"]) {
      expect(o(doc).startsWith("\"'")).toBe(true);
    }
    // Số âm thật cũng bị thêm nháy dẫn đầu — đánh đổi có chủ ý: an toàn trước,
    // và mọi số trong báo cáo này đều là số đếm không âm.
    expect(o("-5")).toBe("\"'-5\"");
  });

  it("giữ số và null ở dạng đọc được", () => {
    expect(o(42)).toBe('"42"');
    expect(o(null)).toBe("");
    expect(o(undefined)).toBe("");
  });
});
