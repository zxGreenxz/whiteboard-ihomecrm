import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// PANALYTICS-C02 (re-anchor bảo mật 02/09/2026): `log_public_room_events` cấp
// EXECUTE cho anon và chỉ có trần 50 sự kiện MỖI LỜI GỌI — người ngoài lặp lời
// gọi để bơm bảng lớn vô hạn. Migration 20260902091449 thêm ngân sách theo
// token/ngày + retention 90 ngày có cron. Test ghim các bất biến dễ mất.

const sql = readFileSync(
  new URL("../../../supabase/migrations/20260902091449_public_room_events_budget_va_retention.sql", import.meta.url),
  "utf8",
);

describe("20260902091449 — ngân sách + retention cho analytics công khai", () => {
  it("có bảng ngân sách trong app_private (không lộ qua PostgREST) và bật RLS", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS app_private\.public_room_event_budgets/);
    expect(sql).toMatch(/PRIMARY KEY \(token, ngay\)/);
    expect(sql).toMatch(/ALTER TABLE app_private\.public_room_event_budgets ENABLE ROW LEVEL SECURITY;/);
  });

  it("logger kiểm trần TRƯỚC khi ghi, kẹp batch theo hạn mức còn lại, cộng dồn sau khi ghi", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.log_public_room_events"), sql.indexOf("COMMENT ON FUNCTION public.log_public_room_events"));
    const checkPos = body.indexOf("IF v_con_lai <= 0 THEN");
    const loopPos = body.indexOf("FOR r IN");
    const updatePos = body.indexOf("SET so_dong = b.so_dong + v_count");
    expect(checkPos).toBeGreaterThan(-1);
    expect(loopPos).toBeGreaterThan(checkPos);
    expect(updatePos).toBeGreaterThan(loopPos);
    expect(body).toMatch(/t\.ord <= LEAST\(50, v_con_lai\)/);
    expect(body).toMatch(/c_tran\s+CONSTANT int := 5000;/);
    // ngày tính theo giờ VN để khớp cách báo cáo đọc dữ liệu
    expect(body).toMatch(/now\(\) AT TIME ZONE 'Asia\/Ho_Chi_Minh'/);
    // vượt trần phải im lặng như mọi nhánh từ chối khác (không lộ nội bộ cho anon)
    expect(body.slice(checkPos, checkPos + 120)).toMatch(/RETURN 0;/);
  });

  it("giữ nguyên chữ ký + ACL anon của logger (không phá tính năng đang chạy)", () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.log_public_room_events\(text, jsonb\) TO anon, authenticated;/);
    expect(sql).not.toMatch(/DROP FUNCTION/);
  });

  it("retention có sàn 30 ngày, cron đăng ký idempotent, anon không gọi được hàm xoá", () => {
    expect(sql).toMatch(/pra_prune_public_room_events_v1\(p_days int DEFAULT 90\)/);
    expect(sql).toMatch(/IF p_days IS NULL OR p_days < 30 THEN/);
    expect(sql).toMatch(/cron\.unschedule\('pra_prune_public_room_events_v1'\)/);
    expect(sql).toMatch(/cron\.schedule\(\s*'pra_prune_public_room_events_v1'/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION app_private\.pra_prune_public_room_events_v1\(int\) FROM PUBLIC, anon, authenticated;/);
  });
});
