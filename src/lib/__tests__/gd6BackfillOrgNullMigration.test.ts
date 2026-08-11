import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// GĐ6 (phần một) — điền organization_id cho những dòng TRUY ĐƯỢC CHA.
//
// 4.189 dòng đang mang organization_id NULL, và 20/21 bảng chứa chúng ĐÃ có biên
// giới — chúng vẫn lọt cho mọi công ty vì công thức chuẩn mở đầu bằng
// `organization_id IS NULL OR …`. Nhánh đó là cửa thoát hiểm cố ý của Sprint 3b,
// nhưng cửa thoát hiểm mở suốt thì là cửa.
//
// ⚠ VÌ SAO KHÔNG DÙNG LẠI _autofill_org().
// Hàm autofill của Sprint 3b kết thúc bằng `NEW.organization_id := COALESCE(v, PROD)`
// — dòng nào không truy được cha thì gán thẳng cho CÔNG TY THẬT. Backfill 4.189
// dòng bằng logic đó sẽ lặng lẽ nhận vơ hàng nghìn dòng của DEMO/Test cho công ty
// thật, trông như thành công và không báo lỗi gì. File này vì thế KHÔNG có nhánh
// mặc định: không suy ra được thì để nguyên.
//
// ⚠ VÌ SAO KHÔNG SUY QUA NGƯỜI KHI NGƯỜI ĐÓ THUỘC NHIỀU CÔNG TY.
// Đo thật: cả 3.032 dòng public_room_events đều thuộc một chủ có HAI công ty đang
// hoạt động. Suy theo owner_id ở đó là tung đồng xu 3.032 lần. Chỉ điền khi người
// đó có ĐÚNG MỘT membership ACTIVE.
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260808040000_gd6_backfill_org_null.sql"),
  "utf8",
);

describe("GĐ6 — backfill an toàn", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("TUYỆT ĐỐI không có nhánh mặc định gán về một tổ chức cố định", () => {
    // Đây là mệnh đề quan trọng nhất của cả file. Một hằng số uuid xuất hiện
    // trong câu UPDATE nghĩa là ai đó đã thêm lại nhánh fallback.
    const chiLenh = sql.split("\n").filter((d) => !/^\s*--/.test(d)).join("\n");
    expect(chiLenh).not.toMatch(/COALESCE\([^)]*,\s*'?[0-9a-f]{8}-/i);
    expect(chiLenh).not.toMatch(/aaaa0000-0000-4000-8000-000000000001/);
    expect(chiLenh).not.toMatch(/_autofill_org/);
  });

  it("chỉ điền khi cha CÓ tổ chức — không lan NULL xuống con", () => {
    expect(sql).toMatch(/p\.organization_id IS NOT NULL/);
  });

  it("suy qua người CHỈ khi người đó có đúng một membership ACTIVE", () => {
    expect(sql).toMatch(/count\(DISTINCT organization_id\)\s*=\s*1/);
    // Câu SQL nằm trong format() nên dấu nháy bị nhân đôi: ''ACTIVE''. Mệnh đề
    // đầu tiên tôi viết đòi đúng 'ACTIVE' và báo đỏ một file hoàn toàn đúng.
    expect(sql).toMatch(/status\s*=\s*''?ACTIVE''?/);
  });

  it("chạy theo THỨ TỰ DÂY CHUYỀN — cha trước, con sau", () => {
    // inspection_photos truy được 0 chỉ vì inspection_sessions cha của chúng cũng
    // đang NULL. Vá cha trước thì 335 dòng ảnh tự truy được. Sai thứ tự thì lượt
    // này bỏ sót chúng và không ai biết vì sao.
    //
    // Phải so THỨ TỰ CHẠY (vòng lặp), không phải thứ tự KHAI BÁO. Bản đầu so
    // vị trí tên bảng trong file — hai thứ đó không liên quan gì tới nhau, và
    // một biến khai báo sau vẫn có thể chạy trước.
    const viTri = (s: string) => {
      const i = sql.indexOf(s);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const chayQuaCha = viTri("FOR i IN 1 .. array_length(qua_cha");
    const chayQuaNguoi = viTri("FOR i IN 1 .. array_length(qua_nguoi");
    const chayDayChuyen = viTri("FOR i IN 1 .. array_length(day_chuyen");

    expect(chayQuaNguoi).toBeGreaterThan(chayQuaCha);
    expect(chayDayChuyen).toBeGreaterThan(chayQuaNguoi);

    // Và từng cặp cha–con phải nằm đúng phía: cha ở hai lượt đầu, con ở lượt ba.
    const khoiDayChuyen = sql.slice(chayDayChuyen);
    for (const con of ["inspection_photos", "cash_handover_items", "material_usage_items"]) {
      expect(sql.slice(chayQuaCha, chayDayChuyen)).not.toContain(`'${con}'`);
    }
    for (const cha of ["inspection_sessions", "cash_handovers", "material_usages"]) {
      expect(khoiDayChuyen).not.toMatch(new RegExp(`ARRAY\\['${cha}',`));
    }
  });

  it("báo lại số dòng đã điền và số dòng CÒN LẠI, không im lặng", () => {
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).toMatch(/DO \$verify\$/);
  });

  it("verify chặn trường hợp con mang tổ chức KHÁC cha", () => {
    const verify = sql.slice(sql.indexOf("DO $verify$"));
    expect(verify).toMatch(/<>/);
    expect(verify).toMatch(/RAISE EXCEPTION/);
  });

  it("nói rõ hai bảng CỐ Ý không đụng tới và vì sao", () => {
    expect(sql).toMatch(/public_room_events/);
    expect(sql).toMatch(/cron_runs/);
    expect(sql).toMatch(/3\.?032|3032/);
  });

  it("ghi rõ đường rollback", () => {
    expect(sql).toMatch(/ROLLBACK:/);
  });
});
