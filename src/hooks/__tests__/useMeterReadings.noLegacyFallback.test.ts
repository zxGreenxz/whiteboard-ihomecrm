import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// PMETER-C01 (re-anchor bảo mật 02/09/2026): hook duyệt chỉ số từng rơi về RPC
// legacy KHÔNG authz khi gặp PGRST202 — tức thiếu writer là tự bỏ kiểm quyền.
// Từ migration 20260902082002, _v1 nằm trong migration thật và legacy bị REVOKE
// anon; nhánh fallback phải biến mất và không được quay lại.

const full = readFileSync(new URL("../useMeterReadings.ts", import.meta.url), "utf8");
// Soi 3 hook duyệt/bỏ duyệt: approve, bulk (migration 20260902082002) và
// unapprove (migration 20260902084240) — cả ba *_v1 đều đã nằm trong migration thật.
const start = full.indexOf("export const useApproveMeterReading");
const source = full.slice(start);

describe("useMeterReadings không còn fallback sang RPC duyệt chỉ số legacy", () => {
  it("chỉ gọi *_v1, không có nhánh PGRST202 rơi về approve_meter_reading / bulk_approve_meter_readings", () => {
    expect(source).toMatch(/supabase\.rpc\("approve_meter_reading_v1"/);
    expect(source).toMatch(/supabase\.rpc\("bulk_approve_meter_readings_v1"/);
    expect(source).not.toMatch(/supabase\.rpc\("approve_meter_reading"/);
    expect(source).not.toMatch(/supabase\.rpc\("bulk_approve_meter_readings"/);
    // chi bat MA fallback (so sanh ma loi roi goi legacy), khong bat chu "PGRST202" trong comment giai thich
    expect(source).not.toMatch(/=== "PGRST202"/);
  });

  it("bỏ duyệt chỉ gọi unapprove_meter_reading_v1, không còn UPDATE thẳng meter_readings", () => {
    expect(source).toMatch(/supabase\.rpc\("unapprove_meter_reading_v1"/);
    expect(source).not.toMatch(/\.from\("meter_readings"\)\s*\.update\(\{ status: "UNAPPROVED"/);
  });
});
