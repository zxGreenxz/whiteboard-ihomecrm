import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260725060000_authz_wave1_hardening.sql"),
  "utf8",
);

// 14 SECURITY DEFINER writer finance-v2 bị anon-executable do Postgres mặc định
// GRANT ... TO PUBLIC khi CREATE FUNCTION (AUTHORIZATION-PLAN §9.2, §20-11).
const REVOKED_RPCS = [
  "create_income_expense_v2(jsonb)",
  "approve_income_expense_v2(uuid, bigint, text)",
  "approve_and_post_income_expense_v2(jsonb)",
  "post_approved_income_expense_v2(jsonb)",
  "reverse_posted_income_expense_v2(uuid, uuid, date, text, text)",
  "cancel_unposted_income_expense_v2(uuid, bigint, bigint, text, text)",
  "withdraw_income_expense_v2(uuid, bigint, bigint, text)",
  "resubmit_income_expense_v2(uuid, bigint, jsonb, text)",
  "reject_invalid_income_expense_v2(uuid, bigint, text, text)",
  "request_income_expense_changes_v2(uuid, bigint, text, jsonb, text)",
  "mark_income_expense_disputed_v2(uuid, bigint, uuid, text, timestamptz, text)",
  "adopt_voucher_attachments_as_evidence_v2(uuid)",
  "list_cashbook_visibility_v2()",
];

// Bucket chứa PII — cùng danh sách với can_read_storage_object_v1 (t5_29).
const PII_BUCKETS = [
  "customer-id-cards",
  "customer-images",
  "income-expense-attachments",
  "job-attachments",
  "payment-receipts",
  "meter-images",
  "document-templates",
];

describe("Đợt 1 hardening — đóng 5 khoảng hở §20 sau audit 2026-07-25", () => {
  it("là migration một-transaction, forward-only, không đụng feature flag", () => {
    expect(sql.match(/^\s*begin\s*;\s*$/gim)).toHaveLength(1);
    expect(sql.match(/^\s*commit\s*;\s*$/gim)).toHaveLength(1);
    expect(sql).not.toMatch(/set_feature_route_v1\s*\(/i);
    expect(sql).not.toMatch(/update\s+app_private\.server_feature_flags/i);
  });

  it("revoke anon+PUBLIC cho từng writer v2 theo ĐÚNG signature (không sót overload)", () => {
    for (const sig of REVOKED_RPCS) {
      expect(sql).toContain(`revoke all on function public.${sig}`);
    }
    // Đủ 13 RPC + 1 trigger function = 14 hàm CI gate từng báo đỏ.
    expect(REVOKED_RPCS).toHaveLength(13);
    expect(sql).toContain("revoke all on function public.jobs_stamp_completion_time()");
  });

  it("giữ authenticated cho RPC client gọi, nhưng KHÔNG cấp lại cho trigger function", () => {
    for (const sig of REVOKED_RPCS) {
      expect(sql).toContain(`grant  execute on function public.${sig}`);
    }
    // Trigger function là internal-only: revoke cả authenticated, không grant lại.
    expect(sql).toMatch(
      /revoke all on function public\.jobs_stamp_completion_time\(\)\s*\n\s*from public, anon, authenticated;/,
    );
    expect(sql).not.toMatch(/grant\s+execute on function public\.jobs_stamp_completion_time/);
  });

  it("xoá đủ 4 policy mồ côi room-sale-images, gồm policy đọc công khai", () => {
    expect(sql).toContain('drop policy if exists "Public view room sale images"');
    expect(sql).toContain('drop policy if exists "Authenticated upload room sale images"');
    expect(sql).toContain('drop policy if exists "Authenticated update room sale images"');
    expect(sql).toContain('drop policy if exists "Authenticated delete room sale images"');
  });

  it("T7 Pha A: rút DML của riêng anon, KHÔNG đụng authenticated và KHÔNG đụng SELECT", () => {
    for (const t of ["invoices", "payments", "accounts"]) {
      expect(sql).toContain(`revoke insert, update, delete on table public.${t}  from anon;`);
    }
    expect(sql).not.toMatch(/revoke[^\n;]*on table public\.(invoices|payments|accounts)[^\n;]*from[^\n;]*authenticated/i);
    expect(sql).not.toMatch(/revoke\s+select[^\n;]*on table public\.(invoices|payments|accounts)/i);
  });

  it("hàm gác GHI storage phủ đúng danh sách bucket PII của hàm đọc", () => {
    const fn = sql.slice(sql.indexOf("can_write_storage_object_v1"));
    for (const b of PII_BUCKETS) {
      expect(fn).toContain(`'${b}'`);
    }
    expect(fn).toMatch(/security definer/i);
    expect(fn).toMatch(/set search_path to 'pg_catalog', 'app_private', 'public'/i);
  });

  it("predicate GHI chấp nhận đúng hai hình dạng path hợp lệ đang chạy production", () => {
    // (a) thư mục gốc = uid của chính caller
    expect(sql).toMatch(/\(storage\.foldername\(p_name\)\)\[1\] = \(select auth\.uid\(\)\)::text/);
    // (b) path do server cấp qua upload-intent finance-v2, gắn với chính caller
    expect(sql).toContain("from public.finance_evidence_objects e");
    expect(sql).toMatch(/e\.uploader_user_id = \(select auth\.uid\(\)\)/);
  });

  it("ACL hàm gác GHI khớp hàm đọc: chỉ authenticated, không anon", () => {
    expect(sql).toContain(
      "revoke all on function app_private.can_write_storage_object_v1(text, text) from public, anon;",
    );
    expect(sql).toContain(
      "grant execute on function app_private.can_write_storage_object_v1(text, text) to authenticated;",
    );
  });

  it("policy INSERT là RESTRICTIVE (AND với permissive), không phải permissive nới thêm", () => {
    expect(sql).toMatch(
      /create policy storage_pii_org_isolation_insert\s*\n\s*on storage\.objects\s*\n\s*as restrictive\s*\n\s*for insert/i,
    );
    expect(sql).toContain("with check (app_private.can_write_storage_object_v1(bucket_id, name))");
  });

  it("pin search_path cho SECURITY DEFINER cuối cùng còn thiếu", () => {
    expect(sql).toMatch(
      /alter function public\.generate_invoices_for_building\(uuid, uuid, text, text\)\s*\n\s*set search_path to 'pg_catalog', 'public';/,
    );
  });
});
