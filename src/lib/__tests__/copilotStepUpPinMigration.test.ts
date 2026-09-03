import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

// G5-A — bảng PIN step-up + 4 RPC + thân thật của `copilot_plan_approve_v1`.
// Test này ghim đúng những mệnh đề mà một hàng rào bảo mật thật đứng sau: một
// dòng biến mất ở đây là dấu hiệu một trong bốn thứ đã rơi — hoặc PIN lọt vào
// log, hoặc token step-up không còn dùng-một-lần, hoặc trần rủi ro L5 duyệt
// được mà không cần xác thực hai lớp, hoặc sổ chứng cứ ghi sai người/tổ chức.
//
// MỌI assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN (`migration`), cùng kỷ
// luật với `copilotExecutionPlanMigration.test.ts`: soi văn bản thô để lại một
// lớp xanh-giả có thật trong repo này, vì `-- ` trước một hàng rào vẫn khớp
// regex trong khi Postgres đã ngừng đọc nó. Bài kiểm đột biến ở cuối file
// chứng minh cửa đó đóng thật.
const migrationPath = 'supabase/migrations/20260903150311_copilot_step_up_pin_v1.sql';

/** Văn bản thô — CHỈ dùng cho bài kiểm đột biến ở cuối file. */
const tho = docSql(migrationPath);
const migration = boCommentSql(tho);

/**
 * Thân chính xác của một hàm: `thanHam` cắt tới khai báo kế tiếp hoặc tới khối
 * ACL, rồi cắt thêm ở dấu đóng dollar-quote để một `expect(...).not.toMatch`
 * không vô tình đọc sang hàm sau.
 */
function than(ten: string, schema = 'public'): string {
  const rong = thanHam(migration, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

const RPC_PUBLIC = [
  'copilot_step_up_set_pin_v1',
  'copilot_step_up_verify_v1',
  'copilot_step_up_status_v1',
  'copilot_step_up_unlock_v1',
] as const;

describe('G5-A — khung migration', () => {
  it('tồn tại và là một cặp BEGIN/COMMIT duy nhất', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('kiểm pgcrypto TRƯỚC khi dựng bảng — không im lặng nếu extensions.crypt/gen_salt thiếu', () => {
    const i = migration.indexOf('pgcrypto_missing');
    const iTable = migration.indexOf('CREATE TABLE IF NOT EXISTS app_private.copilot_step_up_pins');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(iTable);
    expect(migration).toMatch(/to_regprocedure\('extensions\.crypt\(text, text\)'\) IS NULL/);
    expect(migration).toMatch(/to_regprocedure\('extensions\.gen_salt\(text, integer\)'\) IS NULL/);
  });

  it('chạy lại được lượt hai: bảng IF NOT EXISTS, RPC là CREATE OR REPLACE, không DROP FUNCTION', () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS app_private\.copilot_step_up_pins\b/,
    );
    for (const fn of [...RPC_PUBLIC, 'copilot_plan_approve_v1']) {
      expect(migration).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    }
    expect(migration).not.toMatch(/DROP FUNCTION/);
  });
});

describe('G5-A — bảng copilot_step_up_pins', () => {
  it('user_id là PK FK auth.users ON DELETE CASCADE, có đủ cột khoá', () => {
    expect(migration).toMatch(
      /user_id\s+uuid PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE/,
    );
    for (const cot of ['pin_hash', 'failed_attempts', 'locked_until', 'lock_level']) {
      expect(migration).toContain(cot);
    }
  });

  it('REVOKE ALL FROM PUBLIC + guarded anon/authenticated/service_role', () => {
    expect(migration).toMatch(/REVOKE ALL ON app_private\.copilot_step_up_pins FROM PUBLIC;/);
    const khoi = migration.slice(
      migration.indexOf('$thu_hoi_pins$'),
      migration.indexOf('$thu_hoi_pins$', migration.indexOf('$thu_hoi_pins$') + 1) + 20,
    );
    for (const vai of ['anon', 'authenticated', 'service_role']) {
      expect(khoi).toContain(`to_regrole('${vai}')`);
    }
  });
});

describe('G5-A — sổ: bốn sự kiện mới + ngoại lệ tổ chức', () => {
  it('CHECK event thêm đủ bốn sự kiện step_up_*, DO-guard drop-rồi-add', () => {
    for (const su_kien of [
      'step_up_pin_set',
      'step_up_verified',
      'step_up_locked',
      'step_up_unlocked',
    ]) {
      expect(migration).toContain(su_kien);
    }
    expect(migration).toMatch(/conname = 'copilot_action_ledger_event_check'/);
    expect(migration).toMatch(/DROP CONSTRAINT copilot_action_ledger_event_check/);
    expect(migration).toMatch(/ADD CONSTRAINT copilot_action_ledger_event_check/);
  });

  it('org_required nới ngoại lệ cho step_up_pin_set/step_up_unlocked/step_up_locked (Fix round 1: step_up_locked gia nhập vì có thể kích hoạt từ set_pin_v1 qua helper dùng chung), KHÔNG cho step_up_verified', () => {
    const khoi = migration.slice(
      migration.indexOf("ADD CONSTRAINT copilot_action_ledger_org_required"),
      migration.indexOf("ADD CONSTRAINT copilot_action_ledger_org_required") + 300,
    );
    expect(khoi).toContain("'policy_changed'");
    expect(khoi).toContain("'step_up_pin_set'");
    expect(khoi).toContain("'step_up_unlocked'");
    expect(khoi).toContain("'step_up_locked'");
    expect(khoi).not.toContain("'step_up_verified'");
  });

  it('copilot_ledger_append_v1 được thay THÂN: NULL-safe (Fix round 1, F6) + ngoại lệ step_up_locked, vẫn REVOKE ALL', () => {
    const than_append = than('copilot_ledger_append_v1', 'app_private');
    // NULL-safe: 'v_event NOT IN (...)' MỘT MÌNH không an toàn khi v_event là
    // NULL (SQL ba-trị làm IF thành falsy trong im lặng) — bản vá phải đứng
    // trước bằng 'v_event IS NULL OR'.
    expect(than_append).toContain('v_event IS NULL OR v_event NOT IN (');
    expect(than_append).toContain(
      "'policy_changed', 'step_up_pin_set', 'step_up_unlocked', 'step_up_locked'",
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.copilot_ledger_append_v1\(jsonb\) FROM PUBLIC;/,
    );
  });
});

describe('G5-A — copilot_step_up_set_pin_v1: đặt/đổi PIN', () => {
  const than_set = than('copilot_step_up_set_pin_v1');

  it('chỉ super admin, mã step_up_superadmin_only', () => {
    expect(than_set).toMatch(
      /NOT public\.is_super_admin\(\) THEN\s*\n\s*RAISE EXCEPTION 'step_up_superadmin_only' USING ERRCODE = '42501'/,
    );
  });

  it('regex 4 số đúng chuẩn, mã pin_format 22023', () => {
    expect(than_set).toContain("p_pin !~ '^[0-9]{4}$'");
    expect(than_set).toMatch(/RAISE EXCEPTION 'pin_format' USING ERRCODE = '22023'/);
  });

  it('chặn đủ 14 PIN yếu đã liệt kê, mã pin_weak 22023', () => {
    const yeu = [
      '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
      '1234', '4321', '2580', '0852',
    ];
    for (const p of yeu) expect(than_set).toContain(`'${p}'`);
    expect(than_set).toMatch(/RAISE EXCEPTION 'pin_weak' USING ERRCODE = '22023'/);
  });

  it('đã có hàng (v_da_ton_tai) thì đòi p_current_pin khớp bằng extensions.crypt; sai → GHI-RỒI-RETURN qua helper dùng chung (Fix round 1, F1+F2), KHÔNG RAISE', () => {
    expect(than_set).toMatch(
      /extensions\.crypt\(p_current_pin, v_row\.pin_hash\) IS DISTINCT FROM v_row\.pin_hash/,
    );
    // PIN cũ sai KHÔNG còn RAISE 'pin_invalid' — nó RETURN qua
    // copilot_step_up_ghi_that_bai_v1, hàm dùng chung với verify_v1 để đếm/
    // khoá đúng (trước Fix round 1, set_pin là một đường dò PIN không bị đếm).
    expect(than_set).toContain('RETURN app_private.copilot_step_up_ghi_that_bai_v1(v_actor, NULL);');
    expect(than_set).not.toMatch(/RAISE EXCEPTION 'pin_invalid' USING ERRCODE/);
  });

  it('đang khoá (đổi PIN): GHI-RỒI-RETURN pin_locked kèm seconds_left, KHÔNG RAISE (Fix round 1, F1)', () => {
    const doan = than_set.slice(
      than_set.indexOf('IF v_da_ton_tai THEN'),
      than_set.indexOf('Doi PIN doi PIN CU khop'),
    );
    expect(doan).toContain('v_row.locked_until IS NOT NULL AND v_row.locked_until > v_now');
    expect(doan).toContain("RETURN jsonb_build_object('ok', false, 'error_code', 'pin_locked', 'seconds_left', v_giay);");
    expect(doan).not.toMatch(/RAISE EXCEPTION 'pin_locked'/);
  });

  it('v_da_ton_tai chụp NGAY sau SELECT — không đọc FOUND ở cuối hàm (Fix round 1, F5: bản trước luôn true vì FOUND bị INSERT ghi đè)', () => {
    const iSelect = than_set.indexOf('SELECT * INTO v_row');
    const iCapture = than_set.indexOf('v_da_ton_tai := FOUND;');
    const iInsert = than_set.indexOf('INSERT INTO app_private.copilot_step_up_pins');
    expect(iSelect).toBeGreaterThan(-1);
    expect(iCapture).toBeGreaterThan(iSelect);
    expect(iCapture).toBeLessThan(iInsert);
    // Ledger dùng biến đã chụp, KHÔNG đọc lại FOUND (vốn sẽ luôn true sau INSERT).
    expect(than_set).toContain("'outcome',        jsonb_build_object('da_doi', v_da_ton_tai)));");
    expect(than_set).not.toContain("jsonb_build_object('da_doi', FOUND)");
  });

  it('băm bằng extensions.crypt + extensions.gen_salt(\'bf\', 10), UPSERT reset cả lock_level', () => {
    expect(than_set).toContain("extensions.crypt(p_pin, extensions.gen_salt('bf', 10))");
    expect(than_set).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(than_set).toContain('lock_level      = 0');
  });

  it('ghi sổ step_up_pin_set, không mang organization_id', () => {
    expect(than_set).toContain("'event',          'step_up_pin_set'");
    expect(than_set).not.toContain("'organization_id'");
  });
});

describe('G5-A — copilot_step_up_verify_v1: xác thực + phát token', () => {
  const than_verify = than('copilot_step_up_verify_v1');

  it('org phải ACTIVE trước, cùng khuôn copilot_org_scope_buildings_v1 (mã 22023)', () => {
    expect(than_verify).toMatch(/o\.status = 'ACTIVE'/);
    expect(than_verify).toMatch(/RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023'/);
  });

  it('thành viên ACTIVE hoặc super admin, không thì not_permitted 42501', () => {
    expect(than_verify).toMatch(/public\.is_super_admin\(\) AND NOT EXISTS/);
    expect(than_verify).toMatch(/m\.status = 'ACTIVE'/);
    expect(than_verify).toMatch(/m\.revoked_at IS NULL/);
    expect(than_verify).toMatch(/RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'/);
  });

  it('không có hàng PIN → pin_not_set (42501), TRƯỚC khi so PIN', () => {
    const iNotFound = than_verify.indexOf('pin_not_set');
    const iCrypt = than_verify.indexOf('extensions.crypt(p_pin, v_row.pin_hash)');
    expect(iNotFound).toBeGreaterThan(-1);
    expect(iCrypt).toBeGreaterThan(-1);
    expect(iNotFound).toBeLessThan(iCrypt);
    expect(than_verify).toMatch(/RAISE EXCEPTION 'pin_not_set' USING ERRCODE = '42501'/);
  });

  it('đang khoá → GHI-RỒI-RETURN pin_locked kèm seconds_left (Fix round 1, F1: KHÔNG còn RAISE ở đây), TRƯỚC khi so PIN', () => {
    const iLocked = than_verify.indexOf(
      "RETURN jsonb_build_object('ok', false, 'error_code', 'pin_locked', 'seconds_left', v_giay);",
    );
    const iCrypt = than_verify.indexOf('extensions.crypt(p_pin, v_row.pin_hash)');
    expect(iLocked).toBeGreaterThan(-1);
    expect(iLocked).toBeLessThan(iCrypt);
    expect(than_verify).toContain('v_row.locked_until - v_now');
    expect(than_verify).not.toMatch(/RAISE EXCEPTION 'pin_locked/);
  });

  it('sai PIN (kể cả sai hình dạng) → GHI-RỒI-RETURN qua helper dùng chung với set_pin_v1, KHÔNG RAISE trong verify_v1 (Fix round 1, F1)', () => {
    expect(than_verify).toContain(
      'RETURN app_private.copilot_step_up_ghi_that_bai_v1(v_actor, p_organization_id);',
    );
    expect(than_verify).not.toMatch(/RAISE EXCEPTION 'pin_invalid/);
    expect(than_verify).not.toMatch(/pin_wrong|pin_mismatch|pin_incorrect/);
  });

  it('thành công KHÔNG reset lock_level — chỉ reset failed_attempts/locked_until', () => {
    // Chuỗi 'failed_attempts = 0, locked_until = NULL' CHỈ xuất hiện ở nhánh
    // thành công — nhánh khoá (thất bại lần 5) viết failed_attempts/lock_level/
    // locked_until trên BA dòng riêng, hình dạng khác hẳn.
    const iThanhCong = than_verify.indexOf('failed_attempts = 0, locked_until = NULL');
    expect(iThanhCong).toBeGreaterThan(-1);
    const doanThanhCong = than_verify.slice(
      Math.max(0, iThanhCong - 150),
      than_verify.indexOf('v_token := extensions.gen_random_bytes'),
    );
    expect(doanThanhCong).toContain('failed_attempts = 0, locked_until = NULL');
    expect(doanThanhCong).not.toContain('lock_level');
  });

  it('token 32 byte ngẫu nhiên, digest sha256, TTL 5 phút, tool/permission_key đúng chuỗi', () => {
    expect(than_verify).toContain('extensions.gen_random_bytes(32)');
    expect(than_verify).toContain("extensions.digest(v_token, 'sha256')");
    expect(than_verify).toContain("interval '5 minutes'");
    expect(than_verify).toContain("'step_up',");
    expect(than_verify).toContain("'copilot.step_up',");
  });

  it('payload_hash ràng buộc theo tổ chức qua copilot_payload_hash_v1(jsonb_build_object(\'org\', ...))', () => {
    expect(than_verify).toContain(
      "app_private.copilot_payload_hash_v1(jsonb_build_object('org', p_organization_id))",
    );
  });

  it('ghi sổ step_up_verified (có org, đứng NGAY trong verify_v1) — không mang PIN/token', () => {
    expect(than_verify).toContain("'event',           'step_up_verified'");
    expect(than_verify).not.toMatch(/'event',\s*'step_up_verified'[\s\S]{0,200}p_pin/);
    // step_up_locked KHÔNG còn nằm trong verify_v1 — nó chuyển sang helper
    // dùng chung copilot_step_up_ghi_that_bai_v1 (xem describe riêng bên dưới).
    expect(than_verify).not.toContain("'event',           'step_up_locked'");
  });

  it('ACL: authenticated giữ EXECUTE, PUBLIC/anon/service_role bị revoke có guard', () => {
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.copilot_step_up_verify_v1\(text, uuid\) TO authenticated;/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.copilot_step_up_verify_v1\(text, uuid\) FROM PUBLIC;/,
    );
  });
});

describe('G5-A — copilot_step_up_ghi_that_bai_v1: helper dùng CHUNG giữa verify_v1/set_pin_v1 (Fix round 1, F1+F2)', () => {
  const than_helper = than('copilot_step_up_ghi_that_bai_v1', 'app_private');

  it('thân không rỗng — thanHam cắt được cả tới REVOKE ALL của app_private', () => {
    expect(than_helper.length).toBeGreaterThan(300);
  });

  it('không có hàng PIN → RETURN ok:false pin_not_set (lưới an toàn, không RAISE)', () => {
    expect(than_helper).toContain("RETURN jsonb_build_object('ok', false, 'error_code', 'pin_not_set');");
  });

  it('chạm trần 5 lần: RESET failed_attempts, TĂNG lock_level, khoá nhân đôi, GHI SỔ step_up_locked, RỒI RETURN attempts_left=0 — KHÔNG RAISE', () => {
    const iCham = than_helper.indexOf('v_row.failed_attempts + 1 >= 5');
    expect(iCham).toBeGreaterThan(-1);
    const doan = than_helper.slice(iCham, than_helper.indexOf('UPDATE app_private.copilot_step_up_pins', iCham + 1));
    expect(than_helper).toContain('failed_attempts = 0');
    expect(than_helper).toContain('lock_level      = v_row.lock_level + 1');
    expect(than_helper).toContain("locked_until    = v_now + (interval '15 minutes'");
    expect(than_helper).toContain('power(2::float8, v_row.lock_level::float8)');
    expect(than_helper).toContain("'event',           'step_up_locked'");
    expect(than_helper).toContain(
      "RETURN jsonb_build_object('ok', false, 'error_code', 'pin_invalid', 'attempts_left', 0);",
    );
    void doan;
  });

  it('chưa chạm trần: TĂNG failed_attempts rồi RETURN attempts_left tính bằng GREATEST(0, 5 - (n+1))', () => {
    expect(than_helper).toContain('failed_attempts = failed_attempts + 1');
    expect(than_helper).toContain('v_left := GREATEST(0, 5 - (v_row.failed_attempts + 1));');
    expect(than_helper).toContain(
      "RETURN jsonb_build_object('ok', false, 'error_code', 'pin_invalid', 'attempts_left', v_left);",
    );
  });

  it('KHÔNG RAISE nào trong toàn thân helper — mọi nhánh đều GHI-RỒI-RETURN (đúng chỗ vá HIGH của Fix round 1)', () => {
    expect(than_helper).not.toMatch(/RAISE EXCEPTION/);
  });

  it('app_private, REVOKE ALL khỏi PUBLIC/anon/authenticated/service_role — KHÔNG grant cho ai (chỉ gọi nội bộ)', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.copilot_step_up_ghi_that_bai_v1\(uuid, uuid\) FROM PUBLIC;/,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION app_private\.copilot_step_up_ghi_that_bai_v1/,
    );
  });
});

describe('G5-A — copilot_step_up_status_v1: đọc trạng thái chính chủ', () => {
  it('không tham số, chỉ đọc hàng của auth.uid()', () => {
    expect(chuKyHam(migration, 'copilot_step_up_status_v1')).toBe('');
    const than_status = than('copilot_step_up_status_v1');
    expect(than_status).toContain('WHERE user_id = v_actor');
    expect(than_status).not.toMatch(/p_user_id/);
  });

  it('trả về da_dat/locked_until/failed_attempts kể cả khi chưa có hàng', () => {
    const than_status = than('copilot_step_up_status_v1');
    expect(than_status).toContain("'da_dat', false, 'locked_until', NULL, 'failed_attempts', 0");
  });
});

describe('G5-A — copilot_step_up_unlock_v1: mở khoá (super admin)', () => {
  const than_unlock = than('copilot_step_up_unlock_v1');

  it('chỉ super admin, bắt buộc lý do >= 3 ký tự', () => {
    expect(than_unlock).toMatch(/RAISE EXCEPTION 'step_up_superadmin_only' USING ERRCODE = '42501'/);
    expect(than_unlock).toMatch(/length\(trim\(p_reason\)\) < 3/);
    expect(than_unlock).toMatch(/RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'/);
  });

  it('reset failed_attempts/locked_until của NGƯỜI KHÁC (p_user_id, không phải v_actor)', () => {
    expect(than_unlock).toContain('WHERE user_id = p_user_id');
  });

  it('ghi sổ step_up_unlocked, không mang organization_id', () => {
    expect(than_unlock).toContain("'event',          'step_up_unlocked'");
    expect(than_unlock).not.toContain("'organization_id'");
  });
});

describe('G5-A — copilot_plan_approve_v1: thân thật thay chỗ 0A000', () => {
  const than_approve = than('copilot_plan_approve_v1');

  it('chữ ký GIỮ NGUYÊN — 5 tham số, p_step_up_token vẫn DEFAULT NULL ở cuối', () => {
    expect(chuKyHam(migration, 'copilot_plan_approve_v1')).toBe(
      'p_plan_id uuid, p_consent_nonce text, p_plan_digest text, p_expected_plan_version integer, p_step_up_token text default null::text',
    );
  });

  it('không còn RAISE step_up_not_implemented / 0A000', () => {
    expect(than_approve).not.toContain('step_up_not_implemented');
    expect(than_approve).not.toContain("ERRCODE = '0A000'");
  });

  it('thiếu token trên kế hoạch L5 dưới trần L5 vẫn step_up_required 42501 (giữ nguyên cửa cũ)', () => {
    expect(than_approve).toMatch(
      /v_plan\.max_risk = 'L5' AND v_max_direct = 'L5' AND p_step_up_token IS NULL THEN\s*\n\s*RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501'/,
    );
  });

  it('token sai hình dạng KHÔNG soi bảng — cùng kỷ luật với nonce cấp kế hoạch', () => {
    const doan = than_approve.slice(
      than_approve.indexOf('IF p_step_up_token IS NOT NULL THEN'),
      than_approve.indexOf('SELECT * INTO v_step_up'),
    );
    expect(doan).toContain("p_step_up_token !~ '^[0-9a-fA-F]{64}$'");
  });

  it('mọi nhánh token sai đều RAISE cùng step_up_required — không phân biệt lý do', () => {
    const doan = than_approve.slice(
      than_approve.indexOf('SELECT * INTO v_step_up'),
      than_approve.indexOf('WHERE id = v_step_up.id'),
    );
    for (const dieu_kien of [
      'NOT FOUND',
      "v_step_up.user_id IS DISTINCT FROM v_actor",
      "v_step_up.tool IS DISTINCT FROM 'step_up'",
      "v_step_up.permission_key IS DISTINCT FROM 'copilot.step_up'",
      'v_step_up.consumed_at IS NOT NULL',
      'v_step_up.expires_at <= clock_timestamp()',
      'v_step_up.organization_id IS DISTINCT FROM v_plan.organization_id',
      'v_step_up.payload_hash IS DISTINCT FROM',
    ]) {
      expect(doan).toContain(dieu_kien);
    }
    const soLanRaise = (doan.match(/RAISE EXCEPTION 'step_up_required'/g) ?? []).length;
    expect(soLanRaise).toBe(1);
  });

  it('CAS tiêu token: UPDATE ... WHERE id = v_step_up.id AND consumed_at IS NULL, NOT FOUND thì step_up_required', () => {
    const iCas = than_approve.indexOf('WHERE id = v_step_up.id AND consumed_at IS NULL');
    expect(iCas).toBeGreaterThan(-1);
    const doan = than_approve.slice(iCas, iCas + 250);
    expect(doan).toContain('WHERE id = v_step_up.id AND consumed_at IS NULL');
    expect(doan).toContain('IF NOT FOUND THEN');
    expect(doan).toContain("RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501';");
    expect(doan).toContain('v_step_up_id := v_step_up.id;');
  });

  it('token dùng payload_hash khớp CHÍNH TỔ CHỨC của kế hoạch, không phải tổ chức bất kỳ', () => {
    expect(than_approve).toContain(
      "app_private.copilot_payload_hash_v1(\n            jsonb_build_object('org', v_plan.organization_id))",
    );
  });

  it('consent_kind/step_up_confirmation_id dùng v_step_up_id (biến của LẦN DUYỆT NÀY), không dùng v_plan.step_up_confirmation_id (cột cũ)', () => {
    expect(than_approve).not.toMatch(/step_up_confirmation_id = v_plan\.step_up_confirmation_id/);
    expect(than_approve).toContain(
      "consent_kind = CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END",
    );
    // Xuất hiện ở CẢ nhánh FAILED lẫn nhánh APPROVED thành công.
    const soLanConsentKindCase = (
      than_approve.match(
        /consent_kind = CASE WHEN v_step_up_id IS NOT NULL THEN 'step_up' ELSE 'click' END/g,
      ) ?? []
    ).length;
    expect(soLanConsentKindCase).toBe(2);
    const soLanStepUpConfId = (than_approve.match(/step_up_confirmation_id = v_step_up_id/g) ?? []).length;
    expect(soLanStepUpConfId).toBe(2);
  });

  it('sổ plan_approved/step_blocked ghi step_up_id = v_step_up_id, không phải cột cũ trên hàng kế hoạch', () => {
    const soLanLedgerStepUpId = (than_approve.match(/'step_up_id',\s*v_step_up_id\)?\)?,?/g) ?? []).length;
    expect(soLanLedgerStepUpId).toBeGreaterThanOrEqual(2);
  });

  it('ACL tái cấp: authenticated giữ EXECUTE, PUBLIC/anon/service_role bị revoke có guard', () => {
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.copilot_plan_approve_v1\([^)]*\) TO authenticated;/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.copilot_plan_approve_v1\([^)]*\) FROM PUBLIC;/,
    );
  });
});

describe('G5-A — PIN/token không bao giờ lọt vào message hay log', () => {
  it('không dòng RAISE nào trong TOÀN FILE nội suy p_pin/p_current_pin/p_step_up_token vào chuỗi', () => {
    const dongRaise = migration
      .split('\n')
      .filter((d) => /RAISE (EXCEPTION|WARNING|NOTICE|LOG)/.test(d));
    for (const d of dongRaise) {
      expect(d).not.toMatch(/%\s*['",]?\s*,\s*p_pin\b/);
      expect(d).not.toContain('p_pin,');
      expect(d).not.toContain('p_current_pin,');
      expect(d).not.toContain('p_step_up_token,');
    }
  });

  it('không hàm nào trả jsonb chứa p_pin/p_current_pin/pin_hash nguyên văn', () => {
    for (const ten of ['copilot_step_up_set_pin_v1', 'copilot_step_up_verify_v1']) {
      const t = than(ten);
      const iReturn = t.lastIndexOf('RETURN jsonb_build_object(');
      expect(iReturn).toBeGreaterThan(-1);
      const doanReturn = t.slice(iReturn);
      expect(doanReturn).not.toContain('p_pin');
      expect(doanReturn).not.toContain('pin_hash');
    }
  });

  it('ghi sổ (mọi lời gọi copilot_ledger_append_v1 trong file) không mang p_pin/pin_hash/step_up_token', () => {
    const goiSo = [...migration.matchAll(/copilot_ledger_append_v1\(jsonb_build_object\(([\s\S]*?)\)\);/g)];
    expect(goiSo.length).toBeGreaterThan(0);
    for (const [, than_goi] of goiSo) {
      // Khớp theo TỪ ('\bp_pin\b'), không theo chuỗi con — 'step_up_pin_set'
      // (tên sự kiện hợp lệ) chứa "p_pin" như một chuỗi con tình cờ.
      expect(than_goi).not.toMatch(/\bp_pin\b/);
      expect(than_goi).not.toMatch(/\bpin_hash\b/);
      expect(than_goi).not.toMatch(/\bp_current_pin\b/);
      expect(than_goi).not.toMatch(/\bp_step_up_token\b/);
      expect(than_goi).not.toMatch(/\bv_token\b/);
    }
  });
});

describe('G5-A — Fix round 1, F1: quét CHUNG cả file, không UPDATE bảng PIN nào đứng ngay trước một RAISE (không có DB thật — xem ghi chú xác minh trong báo cáo)', () => {
  // Bài kiểm TĨNH mạnh nhất có thể viết mà không cần một cụm PostgreSQL thật:
  // với MỌI khối `UPDATE app_private.copilot_step_up_pins ... ;` trong file,
  // tìm câu lệnh KẾ TIẾP (bỏ qua khoảng trắng) — nếu đó là `RAISE EXCEPTION`
  // thì đúng hình dạng lỗi HIGH đã vá (UPDATE rồi RAISE trong cùng giao dịch
  // = Postgres cuộn ngược UPDATE). Quét toàn file thay vì từng hàm riêng lẻ để
  // bắt được cả trường hợp thêm một nhánh mới trong tương lai mà quên áp dụng
  // kỷ luật GHI-RỒI-RETURN.
  it('không có UPDATE...copilot_step_up_pins nào đứng ngay trước RAISE EXCEPTION', () => {
    const KHOI_UPDATE = /UPDATE app_private\.copilot_step_up_pins[\s\S]*?;/g;
    const viTriUpdate = [...migration.matchAll(KHOI_UPDATE)].map((m) => (m.index ?? 0) + m[0].length);
    expect(viTriUpdate.length).toBeGreaterThanOrEqual(4); // set_pin (2) + helper (2) + verify (thành công, 1) tối thiểu
    for (const viTri of viTriUpdate) {
      const tiepTheo = migration.slice(viTri, viTri + 400).trim();
      // Câu lệnh THẬT SỰ kế tiếp — bỏ qua chú thích và dòng trắng ở đầu đoạn.
      const dongThuc = tiepTheo
        .split('\n')
        .map((d) => d.trim())
        .find((d) => d.length > 0 && !d.startsWith('--'));
      expect(dongThuc ?? '', `sau UPDATE tại vị trí ${viTri}`).not.toMatch(/^RAISE EXCEPTION/);
    }
  });
});

describe('G5-A — nghiệm thu catalog-only trong chính file', () => {
  it('khối DO $nghiem_thu$ đọc pg_proc/has_function_privilege/has_table_privilege, không đụng bảng dữ liệu', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(nghiemThu).toContain('has_function_privilege');
    expect(nghiemThu).toContain('has_table_privilege');
    expect(nghiemThu).not.toMatch(/SELECT \* FROM app_private\.copilot_step_up_pins/);
  });

  it('nghiệm thu canh cả bảng copilot_step_up_pins không lộ cho authenticated/anon', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(nghiemThu).toContain("has_table_privilege('authenticated', 'app_private.copilot_step_up_pins', 'SELECT')");
    expect(nghiemThu).toContain("has_table_privilege('anon', 'app_private.copilot_step_up_pins', 'SELECT')");
  });
});

// ---------------------------------------------------------------------------
// Bài kiểm đột biến — chứng minh các pin ở trên KHÔNG phải màu xanh rỗng.
// Không sửa file trên đĩa: đột biến chỉ tồn tại trong bộ nhớ của chính test này.
// ---------------------------------------------------------------------------
describe('G5-A - pin phai do khi hang rao bi binh luan hoa', () => {
  const MOC = 'WHERE id = v_step_up.id AND consumed_at IS NULL';
  const PIN = /WHERE id = v_step_up\.id AND consumed_at IS NULL/;

  // Fix round 1 (F3) dat CAS-tieu-token o HAI diem (nhanh that bai + nhanh
  // thanh cong, cung diem voi nonce cap ke hoach) -- MOC khop CA HAI dong,
  // nen dot bien phai binh luan hoa CA HAI de dong tron cua; binh luan mot
  // dong de lot dong kia la mot lo gia -- pin khi do van xanh vi ban KHONG
  // binh luan con nguyen o cho khac, khong phai vi hang rao that dung vung.
  function binhLuanHoaCasTieuToken(sql) {
    const dong = sql.split('\n');
    let daBinhLuan = 0;
    for (let i = 0; i < dong.length; i += 1) {
      if (dong[i].includes(MOC)) {
        dong[i] = '-- ' + dong[i];
        daBinhLuan += 1;
      }
    }
    expect(daBinhLuan, 'khong tim thay du hai dong CAS tieu token step-up de dot bien').toBe(2);
    return dong.join('\n');
  }

  it('van ban THO van khop pin sau khi bi binh luan hoa -- do chinh la cai lo', () => {
    expect(binhLuanHoaCasTieuToken(tho)).toMatch(PIN);
  });

  it('ban da lot binh luan thi KHONG khop nua -- cua da dong', () => {
    const dotBien = boCommentSql(binhLuanHoaCasTieuToken(tho));
    expect(dotBien).not.toMatch(PIN);
    // Ban khong dot bien van khop, de bai kiem nay khong xanh vi ly do sai.
    expect(migration).toMatch(PIN);
  });
});
