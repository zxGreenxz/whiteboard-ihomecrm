import { describe, expect, it } from 'vitest';

import { docSqlKhongComment, thanHam, chuKyHam } from './helpers/sqlTestUtils';

// Bổ sung G5-C2 (theo yêu cầu điều phối viên — E2E review: mất PIN thì không
// có đường phục hồi). `copilot_step_up_reset_pin_v1` khác hẳn
// `copilot_step_up_unlock_v1` (chỉ mở khoá đếm/lock, GIỮ NGUYÊN PIN cũ): hàm
// mới XOÁ HẲN hàng PIN để `copilot_step_up_set_pin_v1` của chính người đó đi
// nhánh TẠO MỚI (không đòi PIN cũ).
const FILE = 'supabase/migrations/20260903220855_copilot_step_up_reset_pin_v1.sql';
const sql = docSqlKhongComment(FILE);

describe('copilot_step_up_reset_pin_v1 — khung', () => {
  it('file tồn tại, một cặp BEGIN/COMMIT', () => {
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(sql.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
  });

  it('chữ ký ABI: (uuid, text) → jsonb', () => {
    expect(chuKyHam(sql, 'copilot_step_up_reset_pin_v1')).toBe('p_user_id uuid, p_reason text');
  });
});

describe('copilot_step_up_reset_pin_v1 — bảo vệ super-admin-only + validate', () => {
  const than = thanHam(sql, 'copilot_step_up_reset_pin_v1');

  it('RAISE unauthenticated nếu chưa đăng nhập', () => {
    expect(than).toMatch(/IF v_actor IS NULL THEN\s*\n\s*RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';/);
  });

  it('RAISE step_up_superadmin_only nếu KHÔNG phải super admin — TRƯỚC mọi DELETE', () => {
    const iCheck = than.search(/RAISE EXCEPTION 'step_up_superadmin_only'/);
    const iDelete = than.search(/DELETE FROM app_private\.copilot_step_up_pins/);
    expect(iCheck).toBeGreaterThan(-1);
    expect(iDelete).toBeGreaterThan(-1);
    expect(iCheck).toBeLessThan(iDelete);
  });

  it('đòi p_user_id khác NULL và p_reason >= 3 ký tự', () => {
    expect(than).toMatch(/RAISE EXCEPTION 'user_required' USING ERRCODE = '22023';/);
    expect(than).toMatch(/length\(trim\(p_reason\)\) < 3/);
    expect(than).toMatch(/RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';/);
  });
});

describe('copilot_step_up_reset_pin_v1 — XOÁ HẲN hàng PIN (khác unlock_v1 — chỉ mở khoá đếm/lock)', () => {
  const than = thanHam(sql, 'copilot_step_up_reset_pin_v1');

  it('DELETE (không phải UPDATE failed_attempts/locked_until) trên copilot_step_up_pins', () => {
    expect(than).toMatch(/DELETE FROM app_private\.copilot_step_up_pins WHERE user_id = p_user_id;/);
    expect(than).not.toMatch(/UPDATE app_private\.copilot_step_up_pins/);
  });

  it('dọn token step_up CHƯA TIÊU của người đó', () => {
    expect(than).toMatch(
      /DELETE FROM app_private\.copilot_write_confirmations\s*\n\s*WHERE user_id = p_user_id AND tool = 'step_up' AND consumed_at IS NULL;/,
    );
  });

  it('ghi sổ step_up_pin_reset — KHÔNG mang PIN/token, chỉ mang target_user_id/reason/cờ đã-xoá', () => {
    expect(than).toMatch(/'event',\s*\n?\s*'step_up_pin_reset',/);
    expect(than).toMatch(/'target_user_id', p_user_id,/);
    expect(than).toMatch(/'reason',\s*p_reason,/);
    expect(than).not.toMatch(/pin_hash/);
  });

  it("RETURN {ok:true, da_reset} — LUÔN ok:true (idempotent kể cả khi không có gì để xoá)", () => {
    expect(than).toMatch(/RETURN jsonb_build_object\('ok', true, 'da_reset', v_da_xoa_pin\);/);
  });
});

describe('copilot_step_up_reset_pin_v1 — mở rộng enum sổ hành động', () => {
  it("event CHECK thêm 'step_up_pin_reset' (idempotent DROP+ADD có điều kiện)", () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS copilot_action_ledger_event_check;/);
    expect(sql).toMatch(/'step_reconciled','step_up_pin_reset'\]/);
  });

  it("org_required CHECK miễn organization_id cho step_up_pin_reset (giống policy_changed/step_up_pin_set/step_up_unlocked/step_up_locked)", () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS copilot_action_ledger_org_required;/);
    expect(sql).toMatch(
      /'policy_changed','step_up_pin_set','step_up_unlocked','step_up_locked',\s*\n\s*'step_up_pin_reset'\]/,
    );
  });

  it('ledger append KHÔNG mang organization_id (đúng khuôn miễn trừ — không tự ý gán một org)', () => {
    const than = thanHam(sql, 'copilot_step_up_reset_pin_v1');
    expect(than).not.toMatch(/'organization_id'/);
  });
});

describe('copilot_step_up_reset_pin_v1 — ACL: REVOKE PUBLIC/anon/service_role, GRANT authenticated', () => {
  it('REVOKE ALL FROM PUBLIC ngay sau COMMENT', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.copilot_step_up_reset_pin_v1\(uuid, text\)\s*\n\s*FROM PUBLIC;/,
    );
  });

  it('DO block guarded revoke anon/service_role/authenticated rồi GRANT lại authenticated', () => {
    const iDo = sql.indexOf('$quyen_reset_pin$');
    const doan = sql.slice(iDo, sql.indexOf('$quyen_reset_pin$;', iDo + 20));
    expect(doan).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_step_up_reset_pin_v1\(uuid, text\) FROM anon;/);
    expect(doan).toMatch(/REVOKE ALL ON FUNCTION public\.copilot_step_up_reset_pin_v1\(uuid, text\) FROM service_role;/);
    expect(doan).toMatch(/GRANT EXECUTE ON FUNCTION public\.copilot_step_up_reset_pin_v1\(uuid, text\) TO authenticated;/);
  });
});

describe('copilot_step_up_reset_pin_v1 — nghiệm thu xác nhận enum + ACL', () => {
  it('khối nghiệm thu tồn tại và kiểm cả hai CHECK mở rộng + anon không gọi được', () => {
    const iNghiem = sql.search(/DO \$nghiem_thu\$/);
    expect(iNghiem).toBeGreaterThan(-1);
    const than = sql.slice(iNghiem);
    expect(than).toMatch(/copilot_action_ledger_event_check/);
    expect(than).toMatch(/copilot_action_ledger_org_required/);
    expect(than).toMatch(/has_function_privilege\('anon', 'public\.copilot_step_up_reset_pin_v1/);
  });
});
