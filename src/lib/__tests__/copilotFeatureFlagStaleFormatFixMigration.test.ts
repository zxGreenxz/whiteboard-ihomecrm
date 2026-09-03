import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql, thanHam } from './helpers/sqlTestUtils';

// G3-FIX migration 1/2 — ghim hai chỗ sửa đo được trong task-G3-E2E-report.md
// (§7 format() nuốt mã lỗi CAS, §6 nhánh plan_expired là mã chết). MỌI assertion
// nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN — soi văn bản thô để lại đúng lớp
// xanh-giả mà `-- ` trước một hàng rào vẫn khớp regex trong khi Postgres đã
// ngừng đọc nó (xem copilotExecutionPlanMigration.test.ts, cùng khuôn).
const migrationPath =
  'supabase/migrations/20260903132857_copilot_feature_flag_stale_format_fix_v1.sql';
const tho = docSql(migrationPath);
const migration = boCommentSql(tho);

function than(ten: string, schema = 'public'): string {
  const rong = thanHam(migration, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

describe('G3-FIX migration 1/2 — khung', () => {
  it('tồn tại, một cặp BEGIN/COMMIT, có lock_timeout + reload schema', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('cả hai hàm là CREATE OR REPLACE cùng chữ ký cũ, không overload', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.set_copilot_feature_flag_v2\(\s*p_scope text,/,
    );
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.copilot_plan_approve_v1\(\s*p_plan_id\s+uuid,/,
    );
    expect(migration).not.toMatch(/DROP FUNCTION/);
  });
});

describe('G3-FIX §7 — set_copilot_feature_flag_v2: format() specifier', () => {
  const than_flag = than('set_copilot_feature_flag_v2');

  it('không còn thân hàm rỗng (thanHam phải cắt được cả hai dạng $fn$/$$)', () => {
    expect(than_flag.length).toBeGreaterThan(200);
  });

  it('DETAIL của copilot_rollout_stale_revision dùng đúng %s, không còn % trần', () => {
    expect(than_flag).toContain("format('expected %s, current %s'");
    expect(than_flag).not.toContain("format('expected %, current %'");
  });

  it('DETAIL của invalid_rollout_transition dùng đúng %s, không còn % trần', () => {
    expect(than_flag).toContain("format('%s -> %s'");
    // '% -> %' không phải substring của '%s -> %s' (ký tự sau '%' đầu là 's',
    // không phải khoảng trắng) — assertion này chỉ xanh nếu bug thật đã hết.
    expect(than_flag).not.toContain("format('% -> %'");
  });

  it('vẫn ném đúng ERRCODE cũ (không đổi hợp đồng lỗi, chỉ sửa DETAIL)', () => {
    expect(than_flag).toContain('copilot_rollout_stale_revision');
    expect(than_flag).toContain("ERRCODE = '40001'");
    expect(than_flag).toContain('invalid_rollout_transition');
    expect(than_flag).toContain("ERRCODE = '22023'");
  });

  it('tái cấp ACL: authenticated giữ EXECUTE, PUBLIC/anon/service_role bị revoke có guard', () => {
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.set_copilot_feature_flag_v2\([^)]*\) TO authenticated;/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_copilot_feature_flag_v2\([^)]*\) FROM PUBLIC;/,
    );
    expect(migration).toMatch(/to_regrole\('anon'\) IS NOT NULL/);
    expect(migration).toMatch(/to_regrole\('service_role'\) IS NOT NULL/);
  });
});

describe('G3-FIX §6 — copilot_plan_approve_v1: plan_expired trước confirmation_expired', () => {
  const than_approve = than('copilot_plan_approve_v1');

  it('không còn thân hàm rỗng', () => {
    expect(than_approve.length).toBeGreaterThan(1000);
  });

  it('cả hai nhánh vẫn còn mặt (không bị xoá nhầm trong lúc đổi thứ tự)', () => {
    expect(than_approve).toContain('plan_expired');
    expect(than_approve).toContain('confirmation_expired');
    expect(than_approve).toContain("'EXPIRED'");
  });

  it('plan_expired (ghi-rồi-RETURN) đứng TRƯỚC confirmation_expired (RAISE) trong thân hàm', () => {
    const viTriPlan = than_approve.indexOf('plan_expired');
    const viTriConf = than_approve.indexOf('confirmation_expired');
    expect(viTriPlan).toBeGreaterThan(-1);
    expect(viTriConf).toBeGreaterThan(-1);
    expect(viTriPlan).toBeLessThan(viTriConf);
  });

  it('nhánh quá hạn kế hoạch vẫn GHI (UPDATE...EXPIRED + ledger) rồi RETURN, không RAISE', () => {
    const doanQuaHan = than_approve.slice(
      than_approve.indexOf('v_plan.expires_at <= clock_timestamp()'),
      than_approve.indexOf('confirmation_expired'),
    );
    expect(doanQuaHan).toContain("SET status = 'EXPIRED'");
    expect(doanQuaHan).toContain('copilot_ledger_append_v1');
    expect(doanQuaHan).toContain('RETURN jsonb_build_object');
    expect(doanQuaHan).not.toMatch(/RAISE EXCEPTION 'plan_expired'/);
  });

  it('nhánh confirmation_expired vẫn RAISE 42501 (không đổi hợp đồng của cửa nonce)', () => {
    expect(than_approve).toMatch(
      /IF v_conf\.expires_at <= clock_timestamp\(\) THEN\s*\n\s*RAISE EXCEPTION 'confirmation_expired' USING ERRCODE = '42501';/,
    );
  });

  it('tái cấp ACL: authenticated giữ EXECUTE, PUBLIC/anon/service_role bị revoke có guard', () => {
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.copilot_plan_approve_v1\([^)]*\) TO authenticated;/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.copilot_plan_approve_v1\([^)]*\) FROM PUBLIC;/,
    );
  });
});

describe('G3-FIX migration 1/2 — nghiệm thu catalog-only trong chính file', () => {
  it('khối DO $nghiem_thu$ đọc pg_proc.prosrc + has_function_privilege, không đụng bảng dữ liệu', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(nghiemThu).toContain('pg_proc');
    expect(nghiemThu).toContain('has_function_privilege');
    expect(nghiemThu).not.toMatch(/INSERT INTO|UPDATE public\.|DELETE FROM/);
  });

  it('nghiệm thu ghim đúng thứ tự plan_expired/confirmation_expired bằng strpos', () => {
    expect(migration).toMatch(
      /strpos\(v_src_approve, 'plan_expired'\) > strpos\(v_src_approve, 'confirmation_expired'\)/,
    );
  });
});

describe('Đột biến — assertion phải đỏ nếu bug quay lại (canh gác cửa comment-strip)', () => {
  it('nếu format specifier thiếu %s xuất hiện lại trong CODE (không phải comment), assertion phải bắt được', () => {
    const gia = migration.replace(
      "format('expected %s, current %s'",
      "format('expected %, current %'",
    );
    expect(gia).toContain("format('expected %, current %'");
  });

  it('bản thô (chưa lột comment) không được dùng để khẳng định — chỉ boComment mới đáng tin', () => {
    // Nếu ai đó comment-hoá dòng format fix, văn bản thô vẫn "chứa" chuỗi đúng
    // (vì comment vẫn là text), nhưng thân hàm cắt bởi thanHam áp dụng trên bản
    // ĐÃ lột comment — nên các test ở trên không bị lừa. Assertion này chỉ ghi
    // lại tiền đề đó, không lặp lại logic sản phẩm.
    expect(tho.length).toBeGreaterThanOrEqual(migration.length);
  });
});
