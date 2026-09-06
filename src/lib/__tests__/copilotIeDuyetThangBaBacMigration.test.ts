import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

// Bài này canh migration 20260906012317 — lỗ hổng NĂNG LỰC của hành động L5
// `income_expense.duyet`, lộ ra từ ca 6 ma trận L5.
//
// Wrapper chỉ gọi `approve_income_expense_v1` rồi RAISE lại mọi lỗi. Nhưng RPC đó
// từ chối phiếu KHÔNG thuộc luồng canonical bằng 55000 "chưa thuộc luồng canonical
// — dùng đường legacy", và chính nó ghi trong thân rằng đó là "tín hiệu fallback
// (hook chuyển sang approve_voucher legacy)". Đo production 06/09/2026, 30 ngày:
// org thật 741 phiếu / 342 canonical (hơn nửa KHÔNG duyệt được), DEMO 0/31.
//
// Nên bản vá là đi ĐÚNG thang ba bậc của `useApproveVoucher`:
//   (1) cặp phiếu bỏ cọc → set_termination_forfeit_status_v1
//   (2) canonical        → approve_income_expense_v1
//   (3) legacy           → approve_voucher (chỉ khi 55000 mang dấu canonical+legacy)
//
// Hai bất biến đắt nhất mà bài này canh: bộ lọc 55000 phải HẸP (bắt trần sẽ nuốt
// lỗi "approve transition affected % rows"), và MỌI cửa phía trên phải còn nguyên.
const duongDan = 'supabase/migrations/20260906012317_copilot_ie_duyet_thang_ba_bac_v1.sql';
const tho = docSql(duongDan);
const migration = boCommentSql(tho);

function than(nguon: string, ten: string, schema = 'public'): string {
  const rong = thanHam(nguon, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

const thanMoi = than(migration, 'copilot_execute_ie_duyet_v1');

// Bản CŨ vẫn sống trong file đóng băng — phép đo đột biến đọc chính nó.
const cu = boCommentSql(
  docSql('supabase/migrations/20260903190255_copilot_action_ie_duyet_v1.sql'),
);
const thanCu = than(cu, 'copilot_execute_ie_duyet_v1');

function dem(nguon: string, mau: RegExp): number {
  return (nguon.match(mau) ?? []).length;
}

describe('migration 20260906012317 — khung file', () => {
  it('đọc được file migration', () => {
    expect(tho.length).toBeGreaterThan(0);
  });

  it('đúng một cặp BEGIN/COMMIT, có lock_timeout và nạp lại schema', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('chạy lại hai lượt không hỏng: đúng MỘT CREATE OR REPLACE, không DDL bảng', () => {
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(migration).not.toMatch(/DROP FUNCTION/);
    expect(migration).not.toMatch(/ALTER TABLE/);
    expect(migration).not.toMatch(/CREATE TABLE/);
  });

  it('giữ nguyên chữ ký nên PostgREST không phải chọn giữa hai bản', () => {
    expect(chuKyHam(migration, 'copilot_execute_ie_duyet_v1')).toBe(
      'p_confirmation_nonce text, p_payload jsonb',
    );
  });

  it('chỉ sửa MỘT wrapper — các wrapper L5 khác không bị chạm', () => {
    for (const khac of [
      'copilot_execute_ie_duyet_vao_so_v1',
      'copilot_execute_ie_vao_so_v1',
      'copilot_execute_invoice_duyet_v1',
      'copilot_preview_ie_duyet_v1',
    ]) {
      expect(migration).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${khac}`));
    }
  });
});

describe('migration 20260906012317 — thang ba bậc, đúng thứ tự của giao diện', () => {
  it('cắt được thân hàm', () => {
    expect(thanMoi).not.toBe('');
  });

  it('bậc (1) cặp phiếu bỏ cọc rẽ TRƯỚC, đúng một lần', () => {
    expect(dem(thanMoi, /set_termination_forfeit_status_v1\(v_ie_id, 'APPROVED'\)/g)).toBe(1);
    expect(thanMoi).toMatch(/FROM app_private\.termination_forfeit_authorizations f/);
    expect(thanMoi).toMatch(/f\.revenue_voucher_id = v_ie_id OR f\.offset_voucher_id = v_ie_id/);
  });

  it('bậc (2) canonical và bậc (3) legacy, mỗi bậc đúng một lần', () => {
    expect(dem(thanMoi, /PERFORM public\.approve_income_expense_v1\(v_ie_id\);/g)).toBe(1);
    expect(dem(thanMoi, /PERFORM public\.approve_voucher\(v_ie_id\);/g)).toBe(1);
  });

  it('bậc bỏ cọc đứng TRƯỚC hai bậc kia', () => {
    const viBoCoc = thanMoi.search(/termination_forfeit_authorizations/);
    const viCanonical = thanMoi.search(/PERFORM public\.approve_income_expense_v1/);
    const viLegacy = thanMoi.search(/PERFORM public\.approve_voucher/);
    expect(viBoCoc).toBeGreaterThan(-1);
    expect(viCanonical).toBeGreaterThan(viBoCoc);
    expect(viLegacy).toBeGreaterThan(viCanonical);
  });

  it('BỘ LỌC 55000 PHẢI HẸP — bắt trần sẽ nuốt lỗi "approve transition affected % rows"', () => {
    expect(thanMoi).toMatch(/WHEN sqlstate '55000' THEN/);
    expect(thanMoi).toMatch(/SQLERRM NOT LIKE '%canonical%'/);
    expect(thanMoi).toMatch(/SQLERRM NOT LIKE '%legacy%'/);
    // Hai điều kiện phải nối bằng OR trong một câu RAISE-lại: thiếu MỘT trong hai
    // là bộ lọc rộng ra.
    expect(thanMoi).toMatch(
      /IF SQLERRM NOT LIKE '%canonical%' OR SQLERRM NOT LIKE '%legacy%' THEN\s*\n\s*RAISE;/,
    );
  });

  it('vẫn còn nhánh WHEN others THEN RAISE — engine mới là chỗ ghi step_failed', () => {
    expect(thanMoi).toMatch(/WHEN others THEN[\s\S]*?RAISE;/);
  });

  it('ghi bậc đã đi vào SỔ, không vào vỏ trả về (hợp đồng engine↔wrapper không đổi)', () => {
    expect(thanMoi).toMatch(/v_duong\s+text := NULL;/);
    expect(thanMoi).toMatch(/'duong_duyet', v_duong/);
    for (const gt of ['forfeit_pair', 'canonical', 'legacy']) {
      expect(thanMoi).toMatch(new RegExp(`v_duong := '${gt}';`));
    }
    expect(dem(thanMoi, /RETURN jsonb_build_object\(/g)).toBe(2);
    // Vỏ trả về vẫn đúng 5 khoá cũ ở nhánh thành công. Cắt riêng khối RETURN
    // cuối: `duong_duyet` chỉ được sống trong SỔ, không lọt vào vỏ mà engine đọc
    // (đếm trần `'status', 'da_thuc_hien'` sẽ khớp cả dòng sổ).
    const voCuoi = thanMoi.slice(thanMoi.lastIndexOf('RETURN jsonb_build_object('));
    expect(voCuoi).toMatch(/'status',\s+'da_thuc_hien',\n\s+'entity_table'/);
    expect(voCuoi).not.toMatch(/duong_duyet/);
    for (const khoa of ['status', 'entity_table', 'entity_id', 'audit_id', 'ledger_id']) {
      expect(voCuoi).toMatch(new RegExp(`'${khoa}',`));
    }
  });
});

describe('migration 20260906012317 — KHÔNG nới một cửa nào phía trên', () => {
  for (const cua of [
    'confirmation_required',
    'confirmation_not_found',
    'confirmation_contract_mismatch',
    'confirmation_already_used',
    'confirmation_expired',
    'payload_changed',
    'organization_mismatch',
    'l5_requires_plan',
    'copilot_action_gate_v1',
    'pg_advisory_xact_lock',
    'ai_write_audit',
    'copilot_write_readback_mismatch',
    'copilot_draft_invariant_violation',
  ]) {
    it(`còn cửa "${cua}"`, () => {
      expect(thanMoi).toContain(cua);
    });
  }

  it('READBACK vẫn đòi approval_status = APPROVED bất kể bậc nào đã chạy', () => {
    expect(thanMoi).toMatch(
      /v_ie\.approval_status IS DISTINCT FROM 'APPROVED'[\s\S]*?copilot_draft_invariant_violation/,
    );
  });

  it('nonce vẫn bị tiêu bằng CAS consumed_at IS NULL', () => {
    expect(thanMoi).toMatch(/SET consumed_at = clock_timestamp\(\)[\s\S]*?AND consumed_at IS NULL;/);
  });

  it('vẫn DEFINER + search_path ghim, và ACL thu hồi đủ ba vai', () => {
    expect(thanMoi).toMatch(/SECURITY DEFINER/);
    expect(thanMoi).toMatch(/SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'/);
    const k = String.raw`public\.copilot_execute_ie_duyet_v1\(text, jsonb\)`;
    expect(migration).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION ${k} FROM PUBLIC;`));
    for (const vai of ['anon', 'service_role', 'authenticated']) {
      expect(migration).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION ${k} FROM ${vai};`));
    }
    expect(migration).toMatch(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${k} TO authenticated;`));
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION [^\n]*TO (anon|service_role);/);
  });
});

describe('migration 20260906012317 — khối nghiệm thu chạy được trên DB rỗng', () => {
  const dat = migration.slice(migration.indexOf('DO $nghiem_thu'));

  it('có khối nghiệm thu, chỉ soi catalog', () => {
    expect(dat).not.toBe('');
    expect(dat).not.toMatch(/\b(INSERT INTO|DELETE FROM)\b/);
    expect(dat).toMatch(/pg_get_functiondef/);
    expect(dat).toMatch(/pg_get_function_identity_arguments/);
  });

  it('tự canh ba bậc, độ hẹp của bộ lọc, danh sách cửa và ACL', () => {
    expect(dat).toMatch(/thieu bac \(1\) cap phieu bo coc/);
    expect(dat).toMatch(/thieu bac \(2\) duong canonical/);
    expect(dat).toMatch(/thieu bac \(3\) duong legacy/);
    expect(dat).toMatch(/khong loc theo CA HAI dau canonical va legacy/);
    expect(dat).toMatch(/mat cua bao ve/);
    expect(dat).toMatch(/proacl/);
    expect(dat).not.toMatch(/has_function_privilege\(\s*'public'/);
  });
});

describe('phép đo đột biến — bản CŨ phải làm bài này ĐỎ', () => {
  it('đọc được bản cũ trong file đóng băng', () => {
    expect(thanCu).not.toBe('');
    expect(thanCu).toMatch(/PERFORM public\.approve_income_expense_v1\(v_ie_id\);/);
  });

  it('bản CŨ chỉ có bậc giữa — đó chính là lỗ hổng năng lực', () => {
    expect(thanCu).not.toMatch(/approve_voucher/);
    expect(thanCu).not.toMatch(/termination_forfeit_authorizations/);
    expect(thanCu).not.toMatch(/sqlstate '55000'/);
  });

  it('bản CŨ không ghi bậc nào vào sổ', () => {
    expect(thanCu).not.toMatch(/duong_duyet/);
  });

  it('bản CŨ vẫn đủ mọi cửa — bản vá là THÊM bậc, không viết lại hàng rào', () => {
    for (const cua of ['l5_requires_plan', 'copilot_action_gate_v1', 'ai_write_audit']) {
      expect(thanCu).toContain(cua);
    }
  });
});
