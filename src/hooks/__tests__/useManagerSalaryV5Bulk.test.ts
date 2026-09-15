import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Rà soát 15/09/2026 · plan con I1.
//
// Màn lương quản lý gọi `v5_month_money` MỘT LẦN CHO MỖI quản lý bên trong một
// `Promise.all` — N lượt khứ hồi cho một màn hình. Bản gộp `v5_month_money_bulk`
// (migration 20260915074852_luong_authz_org_scope_v1) trả tất cả trong một lượt.
//
// Vì sao kiểm bằng cách đọc mã nguồn chứ không dựng hook lên chạy: đây đúng lối
// đã dùng ở useManagerSalaryOrganizationScope.test.ts cạnh file này. `queryFn`
// của hook kéo theo hơn mười lời gọi bảng khác nhau, nên dựng đủ mock cho nó sẽ
// đo cái mock nhiều hơn đo cái thật. Thứ cần khoá lại ở đây là một sự thật đọc
// được tĩnh: không còn vòng lặp RPC, và tên tham số khớp chữ ký server (PostgREST
// phân giải hàm bằng tham số CÓ TÊN — sai một tên là PGRST202 "không tìm thấy
// hàm", một thông báo dẫn người sửa đi nhầm hướng hoàn toàn).
const source = readFileSync(
  new URL("../useManagerSalary.ts", import.meta.url),
  "utf8",
);

// Các khẳng định ÂM BẢN phải soi MÃ, không soi chú thích. Chú thích ở chỗ đã sửa
// cố ý nhắc lại lối cũ (`rpc("v5_month_money")` trong `staffIds.map`) để người
// đọc sau hiểu vì sao đổi — và bản nháp đầu của chính test này đã bắt nhầm đúng
// câu chú thích ấy, báo đỏ trên một tệp đã sửa xong.
const code = source.replace(/^\s*\/\/.*$/gm, "");

describe("useManagerSalary v5 money fetch", () => {
  it("lấy tiền v5 của mọi quản lý bằng MỘT lời gọi gộp", () => {
    expect(source).toMatch(
      /rpc\(\s*"v5_month_money_bulk"[^)]*\{\s*p_users:\s*staffIds,\s*p_month:\s*periodMonth\s*\}/,
    );
  });

  it("không còn gọi v5_month_money lẻ cho từng người", () => {
    // Bắt CHÍNH lời gọi, không bắt chữ trong chú thích: phải có dấu `(` ngay sau
    // tên trong một `supabase.rpc(...)`.
    expect(code).not.toMatch(/rpc\(\s*"v5_month_money"/);
    expect(code).not.toMatch(/staffIds\.map\(\s*async/);
  });

  it("đọc lỗi RPC thay vì nuốt im lặng", () => {
    // `supabase.rpc` KHÔNG BAO GIỜ ném — lỗi mạng/5xx/42501 về dưới dạng
    // `{ error }` trên một promise đã fulfil. Bản cũ chỉ destructure `data`, nên
    // một lời gọi bị từ chối trở thành số 0 trên màn lương mà không ai biết.
    expect(source).toMatch(
      /const\s*\{\s*data:\s*v5BulkRes,\s*error:\s*v5BulkErr\s*\}\s*=\s*await\s+supabase\.rpc\(\s*"v5_month_money_bulk"/,
    );
    expect(source).toMatch(/if\s*\(v5BulkErr\)\s*throw\s+v5BulkErr;/);
  });
});
