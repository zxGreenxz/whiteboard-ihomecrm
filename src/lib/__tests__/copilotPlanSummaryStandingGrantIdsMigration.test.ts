import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

// Bài này canh migration 20260905133739: bản đọc ĐÃ LƯỢC BỎ của một kế hoạch
// phải phát ra `standing_grant_ids`, vì người duyệt (và E2E ca 4) cần biết kế
// hoạch tự duyệt bằng uỷ quyền đứng NÀO. Trước bản vá, dòng plans và dòng ledger
// `plan_approved` đều có mảng id, nhưng hàm chiếu đọc không hề phát khoá đó ra
// nên `.e2e-fleet/specs/copilot-plan-l5-matrix.spec.ts:823` nhận `[]`.
const duongDanMigration =
  'supabase/migrations/20260905133739_copilot_plan_summary_standing_grant_ids_v1.sql';
const tho = docSql(duongDanMigration);
const migration = boCommentSql(tho);

// Cắt lấy THÂN hàm, không kèm khối nghiệm thu. Khối `DO $nghiem_thu$` chứa đúng
// những chuỗi mà các assertion "không lọt bí mật" đi tìm (canonical,
// payload_digest, consent_nonce) dưới dạng regex kiểm tra — soi cả file sẽ cho
// kết luận ngược hẳn với sự thật.
function than(ten: string, schema = 'public'): string {
  const rong = thanHam(migration, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

const thanTomTat = than('copilot_plan_summary_v1', 'app_private');

// Định nghĩa CŨ vẫn còn sống trong migration gốc (20260903100253:523). Dùng
// chính nó làm phép đo đột biến, thay vì chép một bản đóng băng vào file test —
// bản chép sẽ qua được `check-migration-test-liveness` nhưng không còn đo gì thật.
const migrationGoc = boCommentSql(
  docSql('supabase/migrations/20260903100253_copilot_execution_plan_v1.sql'),
);

function thanGoc(): string {
  const rong = thanHam(migrationGoc, 'copilot_plan_summary_v1', 'app_private');
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

// 17 khoá vô hướng của bản cũ + `steps`. Bản mới chỉ được PHÉP THÊM, không được
// đánh rơi khoá nào: giao diện KeHoachCard và standingGrantClient đọc theo tên.
const KHOA_CU = [
  'plan_id',
  'plan_version',
  'plan_digest',
  'plan_status',
  'organization_id',
  'client_request_id',
  'max_risk',
  'step_count',
  'consent_kind',
  'registry_revision',
  'policy_revision',
  'expires_at',
  'approved_at',
  'execute_deadline',
  'failure_reason',
  'created_at',
  'updated_at',
  'steps',
] as const;

describe('migration 20260905133739 — khung file', () => {
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
});

describe('migration 20260905133739 — chạy lại hai lượt không hỏng', () => {
  it('chỉ CREATE OR REPLACE, không DROP/ALTER gì', () => {
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(migration).not.toMatch(/DROP FUNCTION/);
    expect(migration).not.toMatch(/DROP TABLE/);
    expect(migration).not.toMatch(/ALTER TABLE/);
    expect(migration).not.toMatch(/CREATE TABLE/);
  });

  it('giữ nguyên chữ ký nên không đẻ overload cho PostgREST', () => {
    expect(chuKyHam(migration, 'copilot_plan_summary_v1', 'app_private')).toBe('p_plan_id uuid');
  });
});

describe('migration 20260905133739 — hàm chiếu đọc', () => {
  it('cắt được thân hàm', () => {
    expect(thanTomTat).not.toBe('');
  });

  it('giữ nguyên mọi modifier của bản cũ', () => {
    expect(thanTomTat).toMatch(/RETURNS jsonb/);
    expect(thanTomTat).toMatch(/LANGUAGE sql/);
    expect(thanTomTat).toMatch(/^STABLE$/m);
    expect(thanTomTat).toMatch(/SECURITY DEFINER/);
    expect(thanTomTat).toMatch(/SET search_path = pg_catalog, public, app_private/);
    expect(thanTomTat).toMatch(/AS \$tom_tat\$/);
  });

  it('phát ra standing_grant_ids dưới dạng mảng JSON', () => {
    expect(thanTomTat).toMatch(
      /'standing_grant_ids',\s*COALESCE\(to_jsonb\(p\.standing_grant_ids\), '\[\]'::jsonb\)/,
    );
  });

  it('không đánh rơi khoá nào của bản cũ', () => {
    for (const khoa of KHOA_CU) {
      expect(thanTomTat).toContain(`'${khoa}',`);
    }
  });

  it('vẫn không để bí mật lọt ra ngoài', () => {
    expect(thanTomTat).not.toMatch(/canonical/);
    expect(thanTomTat).not.toMatch(/payload_digest/);
    expect(thanTomTat).not.toMatch(/s\.payload/);
    expect(thanTomTat).not.toMatch(/consent_nonce/);
    expect(thanTomTat).not.toMatch(/step_up_confirmation_id/);
  });

  it('plan_digest ra ngoài dạng hex, không phải bytea thô', () => {
    expect(thanTomTat).toMatch(/'plan_digest',\s*encode\(p\.plan_digest, 'hex'\)/);
  });
});

describe('migration 20260905133739 — ACL', () => {
  it('thu hồi PUBLIC và ba vai Supabase (REVOKE FROM PUBLIC không cắt anon)', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.copilot_plan_summary_v1\(uuid\) FROM PUBLIC;/,
    );
    for (const vai of ['anon', 'authenticated', 'service_role']) {
      expect(migration).toMatch(new RegExp(String.raw`to_regrole\('${vai}'\) IS NOT NULL`));
      expect(migration).toMatch(
        new RegExp(
          String.raw`REVOKE ALL ON FUNCTION app_private\.copilot_plan_summary_v1\(uuid\) FROM ${vai};`,
        ),
      );
    }
  });

  it('không GRANT lại cho ai — hàm app_private chỉ RPC public gọi được', () => {
    expect(migration).not.toMatch(/^\s*GRANT\b/m);
  });
});

describe('migration 20260905133739 — khối nghiệm thu chạy được trên DB rỗng', () => {
  const dat = migration.slice(migration.indexOf('DO $nghiem_thu'));

  it('có khối nghiệm thu', () => {
    expect(dat).not.toBe('');
  });

  it('chỉ soi catalog, không ghi dữ liệu', () => {
    expect(dat).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
    expect(dat).toMatch(/pg_get_functiondef/);
    expect(dat).toMatch(/pg_get_function_identity_arguments/);
  });

  it('tự kiểm cả nội dung lẫn ACL của hàm vừa tạo', () => {
    expect(dat).toMatch(/standing_grant_ids/);
    expect(dat).toMatch(/proacl/);
    expect(dat).toMatch(/has_function_privilege/);
    expect(dat).toMatch(/to_regrole/);
  });
});

describe('phép đo đột biến — bản CŨ phải làm bài này ĐỎ', () => {
  const goc = thanGoc();

  it('đọc được định nghĩa cũ đang sống trong migration gốc', () => {
    expect(goc).not.toBe('');
    expect(goc).toMatch(/jsonb_build_object/);
  });

  it('bản cũ KHÔNG phát standing_grant_ids — đó chính là lỗi ca 4', () => {
    expect(goc).not.toMatch(/standing_grant_ids/);
  });

  it('bản cũ vẫn đủ 18 khoá kia — bản vá là THÊM, không phải viết lại', () => {
    for (const khoa of KHOA_CU) {
      expect(goc).toMatch(new RegExp(String.raw`'${khoa}',`));
    }
  });
});
