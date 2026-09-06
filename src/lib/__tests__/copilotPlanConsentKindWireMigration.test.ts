import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

// Bài này canh migration 20260905181157 — hai chỗ hụt làm ca 6 của
// `.e2e-fleet/specs/copilot-plan-l5-matrix.spec.ts` đỏ:
//
//   (a) `copilot_plan_approve_v1` tính loại đồng ý bằng biểu thức CASE ở BỐN chỗ
//       (hai vào hàng `copilot_plans`, hai vào dòng sổ) nhưng KHÔNG vỏ trả về nào
//       phát khoá `consent_kind` → client nhận `undefined` ở dòng :976.
//   (b) Ba cột digest bị trừ khỏi bản đọc sổ — CHỦ Ý, ghi hai lần cùng một câu lý
//       do ở hai đường đọc — nên `after_digest` không thể tới trình duyệt. Bản vá
//       thêm ba cờ `has_*_digest` để chứng minh SỰ CÓ MẶT mà không nói giá trị.
//
// Bất biến đắt nhất của đợt này: hàng rào (phép trừ ba cột) KHÔNG được nới để bài
// test dễ xanh. Assertion dưới canh cả hai chiều.
const duongDan = 'supabase/migrations/20260905181157_copilot_plan_consent_kind_wire_v1.sql';
const tho = docSql(duongDan);
const migration = boCommentSql(tho);

// Cắt lấy THÂN hàm, bỏ khối nghiệm thu. Khối `DO $nghiem_thu$` chứa đúng những
// chuỗi mà các assertion đi tìm (`CASE WHEN v_step_up_id`, `payload_digest`,
// `has_after_digest`) dưới dạng regex kiểm tra — soi cả file sẽ cho kết luận
// ngược hẳn sự thật.
function than(ten: string, schema = 'public'): string {
  const rong = thanHam(migration, ten, schema);
  const dong = /\n\$function\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

const thanDuyet = than('copilot_plan_approve_v1');
const thanDoc = than('copilot_plan_get_v1');

function dem(nguon: string, mau: RegExp): number {
  return (nguon.match(mau) ?? []).length;
}

// Định nghĩa CŨ vẫn sống trong hai migration trước — dùng chính chúng làm phép đo
// đột biến thay vì chép một bản đóng băng vào file test (bản chép qua được
// `check-migration-test-liveness` nhưng không còn đo gì thật).
const duyetCu = boCommentSql(
  docSql('supabase/migrations/20260903150311_copilot_step_up_pin_v1.sql'),
);
const docCu = boCommentSql(
  docSql('supabase/migrations/20260903100253_copilot_execution_plan_v1.sql'),
);

function thanCu(nguon: string, ten: string): string {
  const rong = thanHam(nguon, ten, 'public');
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

describe('migration 20260905181157 — khung file', () => {
  it('đọc được file migration', () => {
    expect(tho.length).toBeGreaterThan(0);
  });

  it('đúng một cặp BEGIN/COMMIT', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('có lock_timeout và nạp lại schema cho PostgREST', () => {
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('chạy lại hai lượt không hỏng: chỉ CREATE OR REPLACE, không DDL bảng', () => {
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    expect(migration).not.toMatch(/DROP FUNCTION/);
    expect(migration).not.toMatch(/DROP TABLE/);
    expect(migration).not.toMatch(/ALTER TABLE/);
    expect(migration).not.toMatch(/CREATE TABLE/);
  });

  it('giữ nguyên hai chữ ký nên PostgREST không phải chọn giữa hai bản', () => {
    expect(chuKyHam(migration, 'copilot_plan_approve_v1')).toBe(
      'p_plan_id uuid, p_consent_nonce text, p_plan_digest text, p_expected_plan_version integer, p_step_up_token text default null::text',
    );
    expect(chuKyHam(migration, 'copilot_plan_get_v1')).toBe('p_plan_id uuid');
  });
});

describe('migration 20260905181157 — (a) MỘT biến consent_kind, ba vỏ trả về', () => {
  it('cắt được thân hàm duyệt', () => {
    expect(thanDuyet).not.toBe('');
    expect(thanDuyet).toMatch(/RETURNS jsonb/);
  });

  it('khai một biến v_consent_kind', () => {
    expect(thanDuyet).toMatch(/^\s*v_consent_kind text := NULL;$/m);
  });

  it('biểu thức CASE chỉ còn sống trong hai phép gán biến đó', () => {
    expect(dem(thanDuyet, /CASE WHEN v_step_up_id IS NOT NULL/g)).toBe(2);
    expect(dem(thanDuyet, /v_consent_kind := CASE WHEN v_step_up_id IS NOT NULL/g)).toBe(2);
  });

  it('hai UPDATE copilot_plans ghi chính biến đó — hàng = sổ = dây', () => {
    expect(dem(thanDuyet, /consent_kind = v_consent_kind,/g)).toBe(2);
  });

  it('ba vỏ trả về đều mang consent_kind, đứng ngay sau plan_status', () => {
    expect(dem(thanDuyet, /'plan_status',\s+'[A-Z]+',\n\s+'consent_kind',/g)).toBe(3);
    expect(dem(thanDuyet, /RETURN jsonb_build_object\(/g)).toBe(3);
  });

  it('nhánh quá hạn đọc từ hàng (kế hoạch chưa duyệt), hai nhánh kia đọc biến', () => {
    expect(thanDuyet).toMatch(/'plan_status',\s+'EXPIRED',\n\s+'consent_kind',\s+v_plan\.consent_kind,/);
    expect(thanDuyet).toMatch(/'plan_status',\s+'FAILED',\n\s+'consent_kind',\s+v_consent_kind,/);
    expect(thanDuyet).toMatch(/'plan_status',\s+'APPROVED',\n\s+'consent_kind',\s+v_consent_kind,/);
  });

  it('giữ nguyên khuôn bảo mật của hàm', () => {
    expect(thanDuyet).toMatch(/SECURITY DEFINER/);
    expect(thanDuyet).toMatch(/SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'/);
  });

  it('KHÔNG nới cửa step-up: kế hoạch L5 dưới trần L5 mà thiếu token vẫn bị chặn', () => {
    expect(thanDuyet).toMatch(/step_up_required/);
    expect(thanDuyet).toMatch(
      /v_plan\.max_risk = 'L5'\s+AND v_max_direct = 'L5'\s+AND p_step_up_token IS NULL/,
    );
  });

  it('vẫn tiêu token step-up bằng CAS consumed_at IS NULL', () => {
    expect(dem(thanDuyet, /WHERE id = v_step_up\.id AND consumed_at IS NULL;/g)).toBe(2);
  });
});

describe('migration 20260905181157 — (b) cờ has_*_digest, hàng rào KHÔNG nới', () => {
  it('cắt được thân hàm đọc', () => {
    expect(thanDoc).not.toBe('');
    expect(thanDoc).toMatch(/RETURNS jsonb/);
  });

  it('BA CỘT DIGEST THÔ VẪN BỊ TRỪ — đây là bất biến đắt nhất của đợt này', () => {
    expect(thanDoc).toMatch(
      /to_jsonb\(t\) - 'payload_digest' - 'before_digest' - 'after_digest'/,
    );
  });

  it('thêm đúng ba cờ nói SỰ CÓ MẶT, không nói giá trị', () => {
    expect(thanDoc).toMatch(/'has_payload_digest', t\.payload_digest IS NOT NULL/);
    expect(thanDoc).toMatch(/'has_before_digest',\s+t\.before_digest\s+IS NOT NULL/);
    expect(thanDoc).toMatch(/'has_after_digest',\s+t\.after_digest\s+IS NOT NULL/);
  });

  it('cờ là boolean thuần: không encode, không substr, không hex nào lọt ra', () => {
    expect(thanDoc).not.toMatch(/encode\(/);
    expect(thanDoc).not.toMatch(/substr/i);
    expect(thanDoc).not.toMatch(/'payload_digest',/);
    expect(thanDoc).not.toMatch(/'before_digest',/);
    expect(thanDoc).not.toMatch(/'after_digest',/);
  });

  it('vẫn chỉ 20 dòng gần nhất của ĐÚNG kế hoạch đó', () => {
    expect(thanDoc).toMatch(/WHERE l\.plan_id = p_plan_id/);
    expect(thanDoc).toMatch(/ORDER BY l\.created_at DESC/);
    expect(thanDoc).toMatch(/LIMIT 20/);
  });

  it('kế hoạch của người khác trả ĐÚNG câu như kế hoạch không tồn tại', () => {
    expect(thanDoc).toMatch(
      /v_plan\.user_id IS DISTINCT FROM v_actor AND NOT public\.is_super_admin\(\)/,
    );
    expect(dem(thanDoc, /'plan_not_found'/g)).toBe(2);
  });

  it('vẫn chiếu qua bản đọc đã lược bỏ, không tự dựng JSON kế hoạch', () => {
    expect(thanDoc).toMatch(/app_private\.copilot_plan_summary_v1\(p_plan_id\)/);
  });

  it('giữ nguyên khuôn: STABLE + DEFINER + search_path ghim', () => {
    expect(thanDoc).toMatch(/STABLE SECURITY DEFINER/);
    expect(thanDoc).toMatch(/SET search_path TO 'pg_catalog', 'public', 'app_private'/);
  });
});

describe('migration 20260905181157 — ACL của cả hai hàm', () => {
  for (const [ten, chuKy] of [
    ['copilot_plan_approve_v1', 'uuid, text, text, integer, text'],
    ['copilot_plan_get_v1', 'uuid'],
  ] as const) {
    it(`${ten}: thu hồi PUBLIC + ba vai (REVOKE FROM PUBLIC không cắt anon)`, () => {
      const k = String.raw`public\.${ten}\(${chuKy.replace(/,/g, ',')}\)`;
      expect(migration).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION ${k} FROM PUBLIC;`));
      for (const vai of ['anon', 'service_role', 'authenticated']) {
        expect(migration).toMatch(
          new RegExp(String.raw`REVOKE ALL ON FUNCTION ${k} FROM ${vai};`),
        );
      }
      // Giao diện gọi cả hai qua PostgREST nên `authenticated` phải được cấp lại.
      expect(migration).toMatch(
        new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${k} TO authenticated;`),
      );
    });
  }

  it('không cấp cho anon hay service_role', () => {
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION [^\n]*TO anon;/);
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION [^\n]*TO service_role;/);
  });
});

describe('migration 20260905181157 — khối nghiệm thu chạy được trên DB rỗng', () => {
  const dat = migration.slice(migration.indexOf('DO $nghiem_thu'));

  it('có khối nghiệm thu', () => {
    expect(dat).not.toBe('');
  });

  it('chỉ soi catalog, không đụng bảng dữ liệu', () => {
    expect(dat).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
    expect(dat).toMatch(/pg_get_functiondef/);
    expect(dat).toMatch(/pg_get_function_identity_arguments/);
  });

  it('tự canh cả hai nửa của bản vá và cả hàng rào digest', () => {
    expect(dat).toMatch(/v_consent_kind text/);
    expect(dat).toMatch(/plan_status.*consent_kind/s);
    expect(dat).toMatch(/has_payload_digest/);
    expect(dat).toMatch(/danh roi phep tru ba cot digest/);
  });

  it('đọc ACL bằng proacl, KHÔNG bằng has_function_privilege(public,…)', () => {
    // `has_function_privilege('public', …)` trả true qua đường thừa kế nên nó
    // không phân biệt được "đã REVOKE" với "chưa REVOKE" — đọc thẳng proacl.
    expect(dat).toMatch(/proacl/);
    expect(dat).toMatch(/v_acl IS NULL OR v_acl ~/);
    expect(dat).not.toMatch(/has_function_privilege\(\s*'public'/);
  });
});

describe('phép đo đột biến — hai bản CŨ phải làm bài này ĐỎ', () => {
  const duyetGoc = thanCu(duyetCu, 'copilot_plan_approve_v1');
  const docGoc = thanCu(docCu, 'copilot_plan_get_v1');

  it('đọc được cả hai định nghĩa cũ đang sống trong repo', () => {
    expect(duyetGoc).toMatch(/jsonb_build_object/);
    expect(docGoc).toMatch(/jsonb_build_object/);
  });

  it('bản duyệt CŨ chép biểu thức CASE bốn lần và không khai biến — lỗi ca 6 (a)', () => {
    expect(dem(duyetGoc, /CASE WHEN v_step_up_id IS NOT NULL/g)).toBe(4);
    expect(duyetGoc).not.toMatch(/v_consent_kind/);
  });

  it('bản duyệt CŨ không vỏ trả về nào mang consent_kind', () => {
    expect(dem(duyetGoc, /'plan_status',\s+'[A-Z]+',\n\s+'consent_kind',/g)).toBe(0);
  });

  it('bản đọc CŨ trừ đủ ba cột digest nhưng không có cờ nào — lỗi ca 6 (b)', () => {
    expect(docGoc).toMatch(/to_jsonb\(t\) - 'payload_digest' - 'before_digest' - 'after_digest'/);
    expect(docGoc).not.toMatch(/has_after_digest/);
  });
});
