import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

// G5-E-FIX — vá lỗi CHẠY (không phải lỗi biên dịch) của nhánh tự duyệt bằng
// standing grant trong `copilot_plan_create_v1`.
//
// LỖI GỐC: khối soát phủ trộn hàm gộp `array_agg` với `FOR UPDATE` trong CÙNG
// một câu SQL. Postgres cấm tổ hợp đó, nhưng plpgsql chỉ phân tích câu SQL nhúng
// lúc CHẠY — nên `CREATE OR REPLACE FUNCTION` vẫn thành công, mọi gate tĩnh vẫn
// xanh, và chỉ lời gọi thật mới nổ:
//     0A000  FOR UPDATE is not allowed with aggregate functions
// Hệ quả đo được ở lượt E2E sống 33956801431 (build 7142a9eb, Mức 3 ON): nhánh
// tự duyệt L5 CHƯA TỪNG chạy nổi trên production — mọi ca đi qua nó đều 400.
//
// Vì lớp lỗi này vô hình với `tsc`/`sqlfluff`/`CREATE OR REPLACE`, phép đo duy
// nhất còn lại là ĐỌC VĂN BẢN. Test này soi bản ĐÃ LỘT BÌNH LUẬN (`migration`),
// cùng kỷ luật với `copilotStandingGrantsMigration.test.ts`: một `-- ` trước
// hàng rào vẫn khớp regex trong khi Postgres đã ngừng đọc nó.
const migrationPath =
  'supabase/migrations/20260905091725_copilot_plan_create_grant_lock_fix_v1.sql';

const tho = docSql(migrationPath);
const migration = boCommentSql(tho);

/**
 * Thân hàm: `thanHam` cắt tới khai báo kế tiếp hoặc tới khối ACL
 * (`^REVOKE ALL ON FUNCTION`), rồi cắt thêm ở dấu đóng dollar-quote.
 *
 * PHẢI cắt: khối nghiệm thu `DO $nghiem_thu$` ở cuối file chứa CHÍNH các chuỗi
 * `'FOR UPDATE'`, `'array_agg'`, `'v_grant_ids := ARRAY('` dưới dạng literal để
 * tự canh lại bất biến ở tầng catalog. Đếm trên cả file sẽ ra 4 lần "FOR UPDATE"
 * và tưởng là hàm khoá bốn chỗ.
 */
function than(ten: string, schema = 'public'): string {
  const rong = thanHam(migration, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

const body = than('copilot_plan_create_v1');

/** Những câu SQL VỪA khoá dòng VỪA gọi hàm gộp — tổ hợp Postgres từ chối. */
function cauKhoaTronHamGop(sql: string): string[] {
  return sql
    .split(';')
    .filter(
      (c) =>
        /\bFOR\s+UPDATE\b/i.test(c) &&
        /\b(array_agg|count|sum|avg|min|max|jsonb_agg|json_agg|string_agg|bool_and|bool_or)\s*\(/i.test(
          c,
        ),
    );
}

/**
 * Bản CŨ, sao y từ `20260903212600_copilot_action_member_cap_quyen_v1.sql` (file
 * đóng băng, chỉ đọc). Giữ nguyên ở đây làm BÀI KIỂM ĐỘT BIẾN: nó chứng minh
 * `cauKhoaTronHamGop` thật sự đỏ được, thay vì xanh vì phép đo hỏng.
 */
const BAN_CU_G5C2 = [
  "      SELECT COALESCE(array_agg(g.id ORDER BY g.id), '{}'::uuid[])",
  '        INTO v_locked_ids',
  '        FROM app_private.copilot_standing_grants g',
  '       WHERE g.organization_id = p_organization_id',
  '         AND g.action_id = ANY(v_needed_actions)',
  '         AND g.revoked_at IS NULL',
  '         AND g.expires_at > clock_timestamp()',
  '       ORDER BY g.id',
  '       FOR UPDATE;',
].join('\n');

describe('G5-E-FIX — khung migration', () => {
  it('tồn tại, một cặp BEGIN/COMMIT duy nhất, có lock_timeout và NOTIFY', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('chạy lại được lượt hai: chỉ CREATE OR REPLACE, không DROP gì', () => {
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)?.length ?? 0).toBe(1);
    expect(migration).not.toMatch(/DROP FUNCTION/);
    expect(migration).not.toMatch(/DROP TABLE/);
    expect(migration).not.toMatch(/ALTER TABLE/);
  });
});

describe('G5-E-FIX — ABI giữ nguyên (vá thân hàm, không đổi bề mặt)', () => {
  it('chữ ký ba tham số đúng như bản trên production', () => {
    expect(chuKyHam(migration, 'copilot_plan_create_v1')).toBe(
      'p_organization_id uuid, p_client_request_id text, p_steps jsonb',
    );
  });

  it('vẫn RETURNS jsonb, SECURITY DEFINER và ghim search_path', () => {
    expect(migration).toMatch(/RETURNS jsonb\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path/);
    expect(migration).toMatch(/AS \$function\$\nDECLARE/);
    expect(migration).toMatch(
      /SET search_path TO 'pg_catalog', 'public', 'app_private', 'extensions'/,
    );
  });
});

describe('G5-E-FIX — lỗi gốc: khoá dòng không được ở cùng câu với hàm gộp', () => {
  it('không câu nào trong thân hàm vừa FOR UPDATE vừa gọi hàm gộp', () => {
    expect(cauKhoaTronHamGop(body)).toEqual([]);
  });

  it('bài kiểm đột biến: chính bản G5-C2 cũ bị phép đo trên bắt đỏ', () => {
    // Nếu bài này xanh mà bài trên cũng xanh thì phép đo là thật. Nếu bài này
    // đỏ, `cauKhoaTronHamGop` đã hỏng và bài trên chỉ là xanh-giả.
    expect(cauKhoaTronHamGop(BAN_CU_G5C2)).toHaveLength(1);
  });

  it('thân hàm khoá dòng đúng MỘT chỗ, và chỗ đó không có hàm gộp', () => {
    expect(body.match(/FOR UPDATE/g)?.length ?? 0).toBe(1);
    expect(body).not.toMatch(/array_agg/);
  });
});

describe('G5-E-FIX — hình BA BƯỚC thay cho một câu gộp+khoá', () => {
  const iB1 = body.indexOf('v_grant_ids := ARRAY(');
  const iB2 = body.indexOf('PERFORM 1');
  const iB3 = body.indexOf('v_locked_ids := ARRAY(');

  it('ba mốc tồn tại và đúng thứ tự: ứng viên → khoá → đọc lại', () => {
    expect(iB1).toBeGreaterThan(0);
    expect(iB2).toBeGreaterThan(iB1);
    expect(iB3).toBeGreaterThan(iB2);
    // Khoá phải nằm TRƯỚC vòng lặp soát phủ từng bước và trước lúc ghi
    // used_today — nếu không, hai giao dịch chồng lấn cùng thấy hạn mức cũ.
    expect(body.indexOf('FOR v_j IN')).toBeGreaterThan(iB3);
    expect(body.indexOf('used_today = (CASE')).toBeGreaterThan(iB3);
  });

  it('bước 1 chỉ LIỆT KÊ: không khoá, không hàm gộp, đủ bốn điều kiện, sắp theo id', () => {
    const buoc1 = body.slice(iB1, iB2);
    expect(buoc1).not.toMatch(/FOR UPDATE/);
    expect(buoc1).not.toMatch(/array_agg|count\s*\(/i);
    expect(buoc1).toMatch(/SELECT g\.id\s*\n\s*FROM app_private\.copilot_standing_grants g/);
    expect(buoc1).toMatch(/g\.organization_id = p_organization_id/);
    expect(buoc1).toMatch(/g\.action_id = ANY\(v_needed_actions\)/);
    expect(buoc1).toMatch(/g\.revoked_at IS NULL/);
    expect(buoc1).toMatch(/g\.expires_at > clock_timestamp\(\)/);
    expect(buoc1).toMatch(/ORDER BY g\.id/);
  });

  it('bước 2 KHOÁ cả tập một lần bằng PERFORM, sắp theo g.id, không hàm gộp', () => {
    const buoc2 = body.slice(iB2, iB3);
    // `ORDER BY g.id` + `FOR UPDATE` liền nhau: LockRows nằm TRÊN Sort nên các
    // dòng bị khoá theo đúng thứ tự id — thứ tự toàn cục, không deadlock giữa
    // hai kế hoạch chồng lấn.
    expect(buoc2).toMatch(/PERFORM 1\s*\n\s*FROM app_private\.copilot_standing_grants g/);
    expect(buoc2).toMatch(/WHERE g\.id = ANY\(v_grant_ids\)/);
    expect(buoc2).toMatch(/ORDER BY g\.id\s*\n\s*FOR UPDATE;/);
    expect(buoc2).not.toMatch(/array_agg|count\s*\(/i);
    expect(buoc2).not.toMatch(/INTO /);
  });

  it('bước 3 đọc lại TẬP ĐÃ KHOÁ và lặp lại đủ bốn điều kiện (thay cho EvalPlanQual)', () => {
    const buoc3 = body.slice(iB3, body.indexOf('ELSE', iB3));
    // `FOR UPDATE` tự làm recheck WHERE sau khi giành được khoá. Tách khoá khỏi
    // lọc thì mất recheck đó, nên phải lọc lại bằng tay ở đây: một giao dịch
    // khác vừa thu hồi/hết hạn trong lúc chờ khoá sẽ bị loại đúng chỗ này.
    expect(buoc3).toMatch(/g\.id = ANY\(v_grant_ids\)/);
    expect(buoc3).toMatch(/g\.organization_id = p_organization_id/);
    expect(buoc3).toMatch(/g\.action_id = ANY\(v_needed_actions\)/);
    expect(buoc3).toMatch(/g\.revoked_at IS NULL/);
    expect(buoc3).toMatch(/g\.expires_at > clock_timestamp\(\)/);
    expect(buoc3).toMatch(/ORDER BY g\.id/);
    expect(buoc3).not.toMatch(/FOR UPDATE/);
  });

  it('nhánh rỗng đặt cả hai biến về mảng rỗng — không để NULL lọt xuống ANY()', () => {
    expect(body).toMatch(/v_grant_ids\s*:= '\{\}'::uuid\[\];/);
    expect(body).toMatch(/v_locked_ids := '\{\}'::uuid\[\];/);
    expect(body).toMatch(/v_grant_ids\s+uuid\[\];/);
    expect(body).toMatch(/v_locked_ids\s+uuid\[\];/);
  });
});

describe('G5-E-FIX — mọi hàng rào cũ còn nguyên (vá đúng một khối)', () => {
  it('trần rủi ro, cờ Mức 3, hai nhánh thực thi và loại pin_always vẫn còn', () => {
    expect(body).toMatch(/plan_risk_not_allowed/);
    expect(body).toMatch(/max_direct_risk/);
    expect(body).toMatch(/standing_grants_enabled/);
    expect(body).toMatch(/direct_l5_v1/);
    expect(body).toMatch(/maker_submit_v1/);
    // Action bắt buộc nhập PIN thì KHÔNG bao giờ được phủ bởi uỷ quyền đứng.
    expect(body).toMatch(/NOT COALESCE\(\(e ->> 'pin_always'\)::boolean, false\)/);
    expect(body).toMatch(/COALESCE\(\(e ->> 'grantable'\)::boolean, false\)/);
  });

  it('vẫn tăng used_today và reset khi sang ngày mới', () => {
    expect(body).toMatch(
      /used_today = \(CASE WHEN used_on IS DISTINCT FROM current_date\s*\n\s*THEN 0 ELSE used_today END\) \+ v_grant_val::int/,
    );
    expect(body).toMatch(/used_on\s*= current_date/);
    expect(body).toMatch(/'used'/);
    expect(body).toMatch(/grant_used/);
  });

  it('vẫn chụp digest/registry/policy và xoá nonce mồ côi', () => {
    expect(body).toMatch(/v_digest/);
    expect(body).toMatch(/copilot_action_registry/);
    expect(body).toMatch(/DELETE FROM app_private\.copilot_write_confirmations/);
    expect(body).toMatch(/nonce_digest = extensions\.digest\(decode\(v_nonce_hex, 'hex'\), 'sha256'\)/);
  });
});

describe('G5-E-FIX — ACL cấp lại và khối nghiệm thu', () => {
  it('REVOKE PUBLIC, chỉ authenticated có EXECUTE, không cấp anon/service_role', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.copilot_plan_create_v1\(uuid, text, jsonb\) FROM PUBLIC;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.copilot_plan_create_v1\(uuid, text, jsonb\) TO authenticated;/,
    );
    expect(migration).toMatch(/to_regrole\('anon'\)/);
    expect(migration).toMatch(/to_regrole\('service_role'\)/);
    expect(migration).not.toMatch(/GRANT EXECUTE[^;]*TO anon/);
    expect(migration).not.toMatch(/GRANT EXECUTE[^;]*TO service_role/);
  });

  it('khối nghiệm thu chỉ đọc catalog và TỰ canh lại bất biến khoá/hàm gộp', () => {
    const dat = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(dat).not.toBe('');
    // Chỉ đọc catalog: không INSERT/UPDATE/DELETE dữ liệu nghiệp vụ.
    expect(dat).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
    expect(dat).toMatch(/to_regprocedure\('public\.copilot_plan_create_v1\(uuid, text, jsonb\)'\)/);
    expect(dat).toMatch(/pg_get_function_identity_arguments/);
    expect(dat).toMatch(/prosecdef/);
    expect(dat).toMatch(/proconfig/);
    // Bất biến lỗi gốc, đo lại ở tầng catalog trên `prosrc` thật:
    expect(dat).toMatch(/'FOR UPDATE'/);
    expect(dat).toMatch(/'array_agg'/);
    expect(dat).toMatch(/'PERFORM 1'/);
    expect(dat).toMatch(/has_function_privilege/);
  });
});
