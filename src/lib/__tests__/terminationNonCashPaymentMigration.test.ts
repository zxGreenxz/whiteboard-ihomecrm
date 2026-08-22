import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * Thân hàm ĐANG CHẠY = lần CREATE cuối cùng trên toàn bộ thư mục migration.
 *
 * Cần thiết từ 22/08/2026: đợt "Hoàn lại khách" phải DROP rồi CREATE lại
 * public.terminate_contract_move_out để thêm tham số p_refund_items, nên định
 * nghĩa sống đã dời sang file khác. Đọc file cũ thì vế 'actual' thành hằng số —
 * test xanh vĩnh viễn kể cả khi hàm thật đổi hành vi.
 * Xem scripts/check-migration-test-liveness.mjs.
 */
function thanHamDangChay(tenHam: string): string {
  const signature = `FUNCTION public.${tenHam}(`;
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let hit: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), "utf8");
    if (sql.includes(signature)) hit = sql;
  }
  expect(hit, `không thấy định nghĩa nào của ${tenHam}`).not.toBeNull();
  const sql = hit as string;
  // Tên hàm còn xuất hiện ở REVOKE/GRANT/postflight NẰM SAU phần thân, nên
  // lastIndexOf() trần sẽ rơi vào một dòng cấp quyền và không tìm thấy thân.
  // Chỉ nhận lần xuất hiện thật sự mở đầu một định nghĩa.
  let start = -1;
  for (let i = sql.indexOf(signature); i >= 0; i = sql.indexOf(signature, i + 1)) {
    if (/\bCREATE\s+(OR\s+REPLACE\s+)?$/i.test(sql.slice(Math.max(0, i - 24), i))) {
      start = i;
    }
  }
  expect(start, `không thấy định nghĩa của ${tenHam}`).toBeGreaterThan(-1);
  // Thẻ dollar-quote thay đổi theo cách sinh: `$$` khi viết tay, `$function$`
  // khi lấy ra bằng pg_get_functiondef.
  const tag = /\bAS (\$[A-Za-z_]*\$)/.exec(sql.slice(start))?.[1] ?? "$$";
  const open = sql.indexOf(tag, start);
  const close = sql.indexOf(tag, open + tag.length);
  expect(close, signature).toBeGreaterThan(open);
  return sql.slice(start, close + tag.length);
}

const migrationPath =
  "supabase/migrations/20260721135500_termination_non_cash_payment_semantics.sql";
const gatePath =
  "supabase/migrations/20260721140500_accounting_rollout_gate_v1.sql";
const migrationSql = readFileSync(migrationPath, "utf8");
const reversalSql = readFileSync(
  "supabase/migrations/20260721100000_invoice_collection_v5.sql",
  "utf8",
);

const rolloutScripts = [
  "scripts/validate-accounting-migrations.mjs",
  "scripts/audit-accounting-rollout.mjs",
  "scripts/test-accounting-chain.mjs",
].map((path) => ({ path, source: readFileSync(path, "utf8") }));

function functionBody(signature: string): string {
  const start = migrationSql.indexOf(signature);
  const end = migrationSql.indexOf("\n$$;", start);
  expect(start, signature).toBeGreaterThan(-1);
  expect(end, signature).toBeGreaterThan(start);
  return migrationSql.slice(start, end + 4);
}

describe("termination non-cash payment migration", () => {
  it("keeps A/R settlement amount but records no cash decomposition", () => {
    const classifier = functionBody(
      "CREATE OR REPLACE FUNCTION app_private.classify_termination_payment_v1()",
    );
    expect(classifier).toContain("termination_move_out_writer_context");
    expect(classifier).toContain("NEW.payment_method IS DISTINCT FROM 'CT'");
    expect(classifier).toContain("NEW.received_amount := 0");
    expect(classifier).toContain("NEW.credit_amount := 0");
    expect(classifier).toContain("NEW.change_amount := 0");
    expect(classifier).toContain("NEW.rounding_amount := 0");
    expect(classifier).not.toContain("NEW.amount := 0");
    expect(migrationSql).toContain("a10_payment_termination_non_cash");
  });

  it("makes the forfeit pair and its payment immutable outside trusted writers", () => {
    expect(migrationSql).toContain("payment_id uuid UNIQUE");
    expect(migrationSql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.require_termination_forfeit_authorization_v1",
    );
    expect(migrationSql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.require_termination_forfeit_payment_v1",
    );
    expect(migrationSql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.guard_termination_non_cash_payment_v1",
    );
    expect(migrationSql).toContain("to_jsonb(NEW) - ARRAY[");
    expect(migrationSql).toContain("a05_termination_non_cash_payment_guard");
    expect(migrationSql).toContain(
      "Termination non-cash payment is immutable outside its trusted writer",
    );
    expect(migrationSql).toContain("app_private.ie_transition_authorization");
    expect(migrationSql).toContain(
      "Forfeit voucher status must be changed by its authorized transition RPC",
    );
    expect(migrationSql).toContain(
      "CREATE OR REPLACE FUNCTION public.set_termination_forfeit_status_v1",
    );
  });

  it("settles only the exact authorized pair and cascades cancellation", () => {
    const trigger = functionBody(
      "CREATE OR REPLACE FUNCTION public.trg_forfeit_settle_on_approve()",
    );
    expect(trigger).toContain("v_authorization.revenue_voucher_id");
    expect(trigger).toContain("require_termination_forfeit_payment_v1");
    expect(trigger).toContain("SET payment_id = v_payment_id");
    expect(trigger).toContain("SET payment_id = NULL");
    expect(trigger).toContain(
      "NEW.approval_status IN ('UNAPPROVED', 'CANCELLED')",
    );
    expect(trigger).toContain("received_amount, credit_amount");
    expect(trigger).not.toContain("notes LIKE");
    expect(migrationSql).toContain(
      "CREATE TRIGGER trg_forfeit_settle_on_approve",
    );
    expect(migrationSql).toContain("DO $assert_forfeit_runtime$");
  });

  it("scopes both termination wrappers around their required capabilities", () => {
    const forfeitWrapper = functionBody(
      "CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(",
    );
    // Đo ĐỊNH NGHĨA SỐNG: hàm này đã được DROP/CREATE lại ở đợt "Hoàn lại
    // khách" (22/08/2026) nên không còn nằm trong file migration của đợt này.
    const moveOutWrapper = thanHamDangChay("terminate_contract_move_out");
    expect(forfeitWrapper).toContain("begin_accounting_chain_write_v1");
    expect(forfeitWrapper).toContain("terminate_contract_forfeit_impl");
    expect(forfeitWrapper).toContain("end_accounting_chain_write_v1");
    expect(moveOutWrapper).toContain("termination_move_out_writer_context");
    expect(moveOutWrapper).toContain("terminate_contract_move_out_impl");
    expect(moveOutWrapper).toContain("DELETE FROM app_private.termination_move_out_writer_context");
    expect(moveOutWrapper).toContain("account_row.organization_id = v_org");
    expect(moveOutWrapper).toContain("'thu_tien.collect'");
    expect(moveOutWrapper).toContain("v_receipt_account");
  });

  it("locks both forfeit legs and detects migration-gap payments", () => {
    const transition = functionBody(
      "CREATE OR REPLACE FUNCTION public.set_termination_forfeit_status_v1(",
    );
    expect(transition).toContain("ORDER BY voucher.id");
    expect(transition).toContain("FOR UPDATE");
    expect(transition).toContain("'income_expenses.approve'");
    expect(migrationSql).toContain("DO $assert_no_termination_migration_gap$");
    expect(migrationSql).toContain(
      "Termination payment appeared between history repair and protection",
    );
  });

  it("keeps legacy reversal fail-closed for non-cash offsets", () => {
    expect(migrationSql).toContain("IF v_received_amount = 0");
    expect(reversalSql).toContain("IF v_received_amount = 0");
    expect(reversalSql).toContain(
      "không phải khoản thu tiền để hoàn tác riêng",
    );
  });

  it("runs immediately before the final rollout gate everywhere", () => {
    for (const script of rolloutScripts) {
      const migrationIndex = script.source.indexOf(migrationPath);
      const gateIndex = script.source.indexOf(gatePath);
      expect(migrationIndex, script.path).toBeGreaterThan(-1);
      expect(gateIndex, script.path).toBeGreaterThan(migrationIndex);
      expect(script.source.slice(gateIndex)).not.toContain(migrationPath);
    }
  });
});
