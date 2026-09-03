import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

// G3-FIX migration 2/2 — DML seed một approval_rule_set ACTIVE tối thiểu cho
// MỘT MÌNH org DEMO. Ghim: đúng org id, KHÔNG auto-post/deny (fallback
// REQUIRE_APPROVAL), mọi câu lệnh khoá theo hằng số ORG (không vòng lặp theo
// organizations), và DB rỗng thì bỏ qua thay vì lỗi. MỌI assertion chạy trên
// bản ĐÃ LỘT BÌNH LUẬN — cùng lý do nêu ở copilotExecutionPlanMigration.test.ts.
const migrationPath = 'supabase/migrations/20260903133353_demo_approval_rule_set_seed_v1.sql';
const migration = boCommentSql(docSql(migrationPath));

const DEMO_ORG = 'dddd0000-0000-4000-8000-000000000001';

describe('G3-FIX migration 2/2 — khung', () => {
  it('tồn tại, một cặp BEGIN/COMMIT, có lock_timeout', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('không CREATE/DROP object nào — thuần DML', () => {
    expect(migration).not.toMatch(/CREATE TABLE|CREATE FUNCTION|DROP TABLE|DROP FUNCTION|ALTER TABLE/);
  });
});

describe('Org đúng, và ĐÚNG MỘT org — DEMO', () => {
  it('mọi câu lệnh khoá theo hằng số ORG = DEMO, không vòng lặp theo organizations', () => {
    expect(migration).toContain(`ORG constant uuid := '${DEMO_ORG}';`);
    expect(migration).not.toMatch(/FOR\s+\w+\s+IN\s+SELECT\s+id\s+FROM\s+public\.organizations/i);
  });

  it('mọi INSERT nhắm vào approval_rule_sets/rules/steps/approvers đều dùng ORG, không phải cột động khác', () => {
    const soDongDung = (migration.match(/SELECT\s+ORG,/g) ?? []).length;
    // 4 bảng: rule_sets, rules, rule_steps, step_approvers.
    expect(soDongDung).toBeGreaterThanOrEqual(4);
  });
});

describe('DB rỗng — org DEMO không tồn tại thì bỏ qua, không lỗi', () => {
  it('khối seed kiểm organizations rồi RAISE NOTICE + RETURN khi không thấy org, không RAISE EXCEPTION', () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    expect(seed).toMatch(/IF NOT v_org_ton_tai THEN/);
    expect(seed).toMatch(/RAISE NOTICE[\s\S]{0,200}RETURN;/);
    expect(seed).not.toMatch(/IF NOT v_org_ton_tai THEN[\s\S]{0,200}RAISE EXCEPTION/);
  });

  it('khối nghiệm thu cũng bỏ qua (không RAISE EXCEPTION) khi org không tồn tại', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(nghiemThu).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.organizations WHERE id = ORG\) THEN/);
    expect(nghiemThu).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM public\.organizations WHERE id = ORG\) THEN\s*\n\s*RAISE NOTICE[\s\S]{0,120}RETURN;/,
    );
  });
});

describe('Idempotent qua trigger a00_rules_immutable — SELECT...WHERE NOT EXISTS, không ON CONFLICT trần', () => {
  // BẪY ĐO ĐƯỢC (xem đầu file migration): app_private.guard_published_rule_set()
  // chặn BEFORE INSERT trên approval_rules một khi rule_set đã ACTIVE/RETIRED,
  // và BEFORE INSERT trigger chạy TRƯỚC khi Postgres xét ON CONFLICT — nên
  // `INSERT ... VALUES ... ON CONFLICT DO NOTHING` vẫn nổ trigger trên lượt
  // chạy lại dù hàng sẽ bị bỏ qua. Migration PHẢI dùng `INSERT ... SELECT ...
  // WHERE NOT EXISTS` để SELECT nguồn trả 0 hàng và trigger không bị gọi.
  it('bốn INSERT vào approval_rule_sets/rules/rule_steps/step_approvers đều là SELECT...WHERE NOT EXISTS', () => {
    const konVaoBonBang = [
      'approval_rule_sets',
      'approval_rules',
      'approval_rule_steps',
      'approval_step_approvers',
    ];
    for (const bang of konVaoBonBang) {
      const re = new RegExp(
        `INSERT INTO public\\.${bang} \\([^)]*\\)\\s*SELECT [\\s\\S]{0,200}?WHERE NOT EXISTS`,
      );
      expect(migration).toMatch(re);
    }
  });

  it('không còn VALUES(...) ON CONFLICT DO NOTHING trần cho bốn bảng đó (lớp lỗi đã sửa)', () => {
    for (const bang of [
      'approval_rule_sets',
      'approval_rules',
      'approval_rule_steps',
      'approval_step_approvers',
    ]) {
      const re = new RegExp(`INSERT INTO public\\.${bang}[\\s\\S]{0,200}?VALUES[\\s\\S]{0,200}?ON CONFLICT`);
      expect(migration).not.toMatch(re);
    }
  });

  it('rule_set được tạo ở DRAFT trước, chỉ ACTIVE sau khi publish_rule_set_v1', () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    expect(seed).toMatch(/SELECT ORG, 'FINANCIAL_VOUCHER', 1, 'DRAFT'/);
    expect(seed).not.toMatch(/SELECT ORG, 'FINANCIAL_VOUCHER', 1, 'ACTIVE'/);
    expect(seed).toContain("IF v_rs_status = 'DRAFT' THEN");
    expect(seed).toContain('app_private.publish_rule_set_v1(v_rs, v_actor)');
  });

  it('chỉ publish khi rule set CÒN DRAFT — lượt chạy lại (đã ACTIVE) không gọi lại publish', () => {
    const seed = migration.slice(migration.indexOf('DO $seed$'), migration.indexOf('$seed$;'));
    const viTriIf = seed.indexOf("IF v_rs_status = 'DRAFT' THEN");
    const viTriPublish = seed.indexOf('app_private.publish_rule_set_v1');
    expect(viTriIf).toBeGreaterThan(-1);
    expect(viTriPublish).toBeGreaterThan(viTriIf);
  });
});

describe('Hình dạng rule — KHÔNG auto-post, KHÔNG deny, mọi phiếu đều cần duyệt', () => {
  it('fallback rule là REQUIRE_APPROVAL + is_fallback=true, không AUTO_POST/DENY nào được chèn', () => {
    expect(migration).toContain("'REQUIRE_APPROVAL', true");
    expect(migration).not.toContain("'AUTO_POST'");
    expect(migration).not.toContain("'DENY'");
  });

  it('một step ANY, min_approvals=1', () => {
    expect(migration).toMatch(/SELECT ORG, v_rule, 1, 1, 'ANY'/);
  });

  it('approver PERMISSION income_expenses.approve — đúng permission key có thật trong catalog', () => {
    expect(migration).toContain("'PERMISSION', 'income_expenses.approve'");
  });
});

describe('Nghiệm thu — ASSERT rule set ACTIVE khi org tồn tại, catalog-only style', () => {
  it('kiểm status ACTIVE, effect/is_fallback, step, và approver — bốn RAISE EXCEPTION riêng biệt', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(nghiemThu).toMatch(/v_status IS DISTINCT FROM 'ACTIVE'/);
    expect(nghiemThu).toMatch(/v_effect IS DISTINCT FROM 'REQUIRE_APPROVAL' OR v_is_fallback IS DISTINCT FROM true/);
    expect(nghiemThu).toMatch(/v_min_approvals IS DISTINCT FROM 1 OR v_mode IS DISTINCT FROM 'ANY'/);
    expect(nghiemThu).toContain('v_approver_count < 1');
  });
});
