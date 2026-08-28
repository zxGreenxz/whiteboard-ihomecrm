import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Tĩnh, không chạm cơ sở dữ liệu. Nó canh những bất biến mà một lần sửa vô ý sẽ
 * xoá mất, và bổ sung cho — chứ không thay — bản diễn tập chức năng đã chạy
 * migration này cùng 13 khẳng định trong một transaction rollback trên chính
 * schema production (28/08/2026). Bản diễn tập chứng minh nó CHẠY ĐÚNG; test này
 * chứng minh những dòng đắt nhất vẫn còn ở đó.
 */
const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260829010000_network_center_h196a_downstream.sql",
);
const sql = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

describe("migration H196A downstream", () => {
  it("tồn tại", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(sql.length).toBeGreaterThan(2_000);
  });

  it("mở đúng ba kind, không nhiều hơn", () => {
    expect(sql).toMatch(/network_devices_kind_check/);
    expect(sql).toMatch(/'MIKROTIK'::text,\s*'ARUBA'::text,\s*'ZTE_H196A'::text/);
  });

  it("KHÔNG đụng tới index một-MikroTik-một-toà", () => {
    // Nới `device_kind` là lúc dễ làm rơi ràng buộc này nhất, và mất nó nghĩa là
    // một toà có thể có hai gốc — sơ đồ nói dối mà không ai thấy.
    expect(sql).not.toMatch(/DROP\s+INDEX[\s\S]{0,80}one_active_mikrotik/i);
    expect(sql).toMatch(/network_devices_one_active_mikrotik_per_building/);
  });

  it("ép H196A là thiết bị chỉ-để-nhìn ở tầng dữ liệu", () => {
    const rangBuoc = sql.match(
      /CONSTRAINT network_devices_h196a_display_only[\s\S]*?\);/,
    )?.[0] ?? "";
    expect(rangBuoc).toMatch(/write_capability = false/);
    expect(rangBuoc).toMatch(/credential_ref IS NULL/);
    expect(rangBuoc).toMatch(/parent_device_id IS NOT NULL/);
  });

  it("dùng đúng luật MAC mà ràng buộc Aruba đã dùng", () => {
    // Nibble thứ hai thuộc [048c] = globally administered unicast. MAC ngẫu
    // nhiên của điện thoại đổi theo từng mạng nên sẽ đẻ một thiết bị mới mỗi
    // lượt poll nếu luật này lỏng ra.
    // Đếm, không phải "có ít nhất một". Luật này lặp ở BA nơi — ràng buộc
    // display-only, ràng buộc bảng hồ sơ, và cửa lọc trong vòng lặp nạp — và
    // nới lỏng đúng MỘT nơi là đủ để MAC ngẫu nhiên lọt qua. Một phép đột biến
    // làm đúng thế đã đi lọt qua bản test trước, nên chỗ này đếm.
    const luatMac = sql.match(/\[0-9a-f\]\[048c\]\(:\[0-9a-f\]\{2\}\)\{5\}/g) ?? [];
    expect(luatMac).toHaveLength(3);
    // Và không nơi nào được dùng luật lỏng hơn.
    expect(sql).not.toMatch(/mac:\[0-9a-f\]\{2\}\(:/);
    expect(sql).toMatch(/mac:00:00:00:00:00:00/);
    expect(sql).toMatch(/mac:ff:ff:ff:ff:ff:ff/);
  });

  it("canh cha là MikroTik đang hoạt động, cùng tổ chức và cùng toà", () => {
    const guard = sql.match(
      /FUNCTION app_private\.network_center_guard_h196a_parent_v1[\s\S]*?\$\$;/,
    )?.[0] ?? "";
    expect(guard).toMatch(/parent\.organization_id = NEW\.organization_id/);
    expect(guard).toMatch(/parent\.building_id = NEW\.building_id/);
    expect(guard).toMatch(/parent\.device_kind = 'MIKROTIK'/);
    expect(guard).toMatch(/parent\.is_active/);
    expect(sql).toMatch(/CREATE TRIGGER network_devices_guard_h196a_parent/);
  });

  it("khử trùng lặp theo stableKey trước khi upsert", () => {
    // Bất biến đắt nhất trong file. Một MAC hai dòng làm ON CONFLICT DO UPDATE
    // chạm cùng một hàng hai lần → 21000 → huỷ CẢ LÔ telemetry của MỌI toà.
    // Đã xảy ra 26–27/08/2026: 240 lượt poll hỏng liên tiếp, mù 20 tiếng.
    expect(sql).toMatch(/DISTINCT ON \(item->>'stableKey'\)/);
  });

  it("không tính lượt UNKNOWN là một lượt vắng mặt", () => {
    const upsert = sql.match(/consecutive_absent_polls = CASE[\s\S]*?END,/)?.[0] ?? "";
    expect(upsert).toMatch(/'ONLINE' THEN 0/);
    // Đọc hỏng một bảng không được phép dựng nên một sự cố không hề xảy ra.
    expect(upsert).toMatch(/'UNKNOWN' THEN profile\.consecutive_absent_polls/);
  });

  it("suy ra OFFLINE sau ba lượt, không sớm hơn", () => {
    expect(sql).toMatch(/consecutive_absent_polls >= 3[\s\S]{0,40}'OFFLINE'/);
    // Chưa có hồ sơ nghĩa là chưa đo, không phải đã chết.
    expect(sql).toMatch(/observed_health IS NULL THEN 'UNKNOWN'/);
  });

  it("không mang model, serial hay firmware", () => {
    const hoSo = sql.match(
      /CREATE TABLE IF NOT EXISTS app_private\.network_h196a_profiles[\s\S]*?\n\);/,
    )?.[0] ?? "";
    expect(hoSo.length).toBeGreaterThan(500);
    for (const cam of ["firmware_version", "model", "serial_number"]) {
      expect(hoSo).not.toContain(cam);
    }
    expect(hoSo).toMatch(/capability_verdict = 'INDIRECT_ONLY'/);
    expect(hoSo).toMatch(/monitoring_mode = 'INDIRECT'/);
  });

  it("giữ nguyên đường Aruba trong lớp bọc inventory", () => {
    const bocV2 = sql.match(
      /FUNCTION public\.network_center_worker_inventory_v2[\s\S]*?\n\$\$;/,
    )?.[0] ?? "";
    expect(bocV2).toMatch(/network_center_worker_inventory_legacy_impl_v1/);
    expect(bocV2).toMatch(/network_center_managed_interface_mapping_v1/);
    // Bước H196A nối THÊM vào cuối, không thay thế gì.
    expect(bocV2).toMatch(/network_center_h196a_inventory_v1/);
    expect(bocV2.indexOf("legacy_impl_v1"))
      .toBeLessThan(bocV2.indexOf("h196a_inventory_v1"));
  });

  it("mỗi CASE kiểm jsonb_typeof đều trả về giá trị ĐÃ coalesce", () => {
    // Bản đầu viết `WHEN jsonb_typeof(coalesce(x,'[]')) = 'array' THEN x`, nên
    // khi thiếu khoá thì phép kiểm nhìn thấy '[]' và cho qua còn nhánh THEN trả
    // NULL — bản diễn tập ngã ngay ở 23502 trên cột `evidence_sources`.
    const nhanhThen = [...sql.matchAll(/WHEN jsonb_typeof\(coalesce\(([^,]+), '\[\]'::jsonb\)\) = 'array'\s*\n?\s*THEN ([^\s]+)/g)];
    expect(nhanhThen.length).toBeGreaterThanOrEqual(3);
    for (const khop of nhanhThen) {
      expect(khop[2]).toMatch(/^coalesce\(/);
    }
  });

  it("khoá quyền hàm đọc đúng khuôn của repo", () => {
    // REVOKE FROM PUBLIC một mình KHÔNG cắt `anon` trên Supabase.
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.network_center_list_h196a_v1[\s\S]{0,120}FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.network_center_list_h196a_v1[\s\S]{0,120}TO authenticated;/,
    );
    // Hàm nội bộ không được cấp cho bất kỳ role nào.
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.network_center_h196a_inventory_v1[\s\S]{0,140}FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION app_private\.network_center_h196a_inventory_v1/);
  });

  it("lọc quyền xem theo toà, không tự viết nhánh super-admin", () => {
    const doc = sql.match(
      /FUNCTION public\.network_center_list_h196a_v1[\s\S]*?\n\$\$;/,
    )?.[0] ?? "";
    expect(doc).toMatch(/network_center_require_view_v1\(p_building_id\)/);
    expect(doc).toMatch(/device\.organization_id = v_scope\.organization_id/);
  });

  it("tự khẳng định các điều kiện bước sau phụ thuộc vào", () => {
    const kiem = sql.match(/DO \$kiem_tra\$[\s\S]*?\$kiem_tra\$;/)?.[0] ?? "";
    expect(kiem).toMatch(/ZTE_H196A/);
    expect(kiem).toMatch(/network_h196a_profiles/);
    expect(kiem).toMatch(/one_active_mikrotik/);
    expect(kiem).toMatch(/network_devices_guard_h196a_parent/);
  });
});
