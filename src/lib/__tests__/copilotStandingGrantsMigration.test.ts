import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql, thanHam } from './helpers/sqlTestUtils';

// G5-B — uỷ quyền đứng (standing grant): điểm nối #4 của Mức 3 toàn quyền.
// Test này ghim đúng những mệnh đề mà một cơ chế TỰ DUYỆT KHÔNG NGƯỜI BẤM đứng
// sau: soát phủ phải KHOÁ (FOR UPDATE) trước khi ghi, hạn mức hết ngày phải
// reset, ràng buộc thiếu dữ liệu không được coi là tự do, action không
// `grantable` không bao giờ được phủ, và token step-up bị tiêu ĐÚNG một lần.
//
// MỌI assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN (`migration`), cùng kỷ
// luật với `copilotStepUpPinMigration.test.ts`: soi văn bản thô để lại một lớp
// xanh-giả có thật trong repo này, vì `-- ` trước một hàng rào vẫn khớp regex
// trong khi Postgres đã ngừng đọc nó. Bài kiểm đột biến ở cuối file chứng minh
// cửa đó đóng thật.
const migrationPath = 'supabase/migrations/20260903171622_copilot_standing_grants_v1.sql';

/** Văn bản thô — CHỈ dùng cho bài kiểm đột biến ở cuối file. */
const tho = docSql(migrationPath);
const migration = boCommentSql(tho);

/**
 * Thân của một hàm public: `thanHam` cắt tới khai báo kế tiếp hoặc tới khối
 * ACL, rồi cắt thêm ở dấu đóng dollar-quote để một `expect(...).not.toMatch`
 * không vô tình đọc sang hàm sau.
 */
function than(ten: string, schema = 'public'): string {
  const rong = thanHam(migration, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

// ---------------------------------------------------------------------------
// ĐỊNH NGHĨA SỐNG của `copilot_plan_execute_step_v1` — gate
// `check-migration-test-liveness.mjs`.
//
// G5-C (`20260903190255_copilot_action_ie_duyet_v1.sql`) CREATE OR REPLACE lại
// đúng hàm này để thêm nhánh `executor_kind = 'direct_l5_v1'` — định nghĩa
// SỐNG dời sang file đó, muộn hơn migration G5-B ở trên. Đọc thẳng
// `migration`/`than()` (frozen) cho hàm NÀY sẽ là đo một bản đã bị thay, y hệt
// lớp lỗi mà `copilotIncomeExpenseRpcHardeningMigration.test.ts` đã ghim
// trước đó (xem báo cáo G2-D mục 5). Khuôn `liveDefinitionOf()` lấy TỪ
// `src/lib/__tests__/salaryCompletionDate.test.ts`, viết lại cục bộ ở đây vì
// không có ích khi kéo thành một helper dùng chung (chỉ một hàm cần).
const MIG_DIR = 'supabase/migrations';
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ file: f, sql: stripComments(readFileSync(join(MIG_DIR, f), 'utf8')) }));
  }
  return corpusCache;
}
function liveDefinitionOf(fnName: string): { file: string; sql: string } {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`, 'i');
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${fnName}`);
  return hit;
}
/** Thân hàm SỐNG (không phải bản đóng băng của migration G5-B). */
function thanSong(ten: string): string {
  const { sql } = liveDefinitionOf(ten);
  const sach = boCommentSql(sql);
  const rong = thanHam(sach, ten);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

const RPC_PUBLIC = [
  'copilot_standing_grant_create_v1',
  'copilot_standing_grant_revoke_v1',
  'copilot_standing_grants_revoke_all_v1',
  'copilot_standing_grants_list_v1',
  'copilot_standing_grants_daily_report_v1',
] as const;

describe('G5-B — khung migration', () => {
  it('tồn tại và là một cặp BEGIN/COMMIT duy nhất', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('chạy lại được lượt hai: bảng/cột IF NOT EXISTS, RPC là CREATE OR REPLACE, không DROP FUNCTION/TABLE', () => {
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS app_private\.copilot_standing_grants\s*\(/,
    );
    expect(migration).toMatch(
      /CREATE TABLE IF NOT EXISTS app_private\.copilot_standing_grants_audit\s*\(/,
    );
    expect(migration).toMatch(
      /ALTER TABLE app_private\.copilot_action_registry\s+ADD COLUMN IF NOT EXISTS grantable/,
    );
    expect(migration).toMatch(
      /ALTER TABLE app_private\.copilot_action_ledger ADD COLUMN IF NOT EXISTS amount numeric;/,
    );
    for (const fn of [
      ...RPC_PUBLIC,
      'copilot_plan_create_v1',
      'copilot_plan_execute_step_v1',
    ]) {
      expect(migration).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    }
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION app_private\.copilot_ledger_append_v1\(p jsonb\)/,
    );
    expect(migration).not.toMatch(/DROP FUNCTION/);
    expect(migration).not.toMatch(/DROP TABLE/);
  });

  it('KHÔNG đổi chữ ký ABI của copilot_plan_create_v1 (hàm này không bị migration nào sau G5-B định nghĩa lại)', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.copilot_plan_create_v1\(\s*p_organization_id\s+uuid,\s*p_client_request_id text,\s*p_steps\s+jsonb\s*\)/,
    );
    // Chữ ký của `copilot_plan_execute_step_v1` được ghim ở khối "định nghĩa
    // SỐNG" phía dưới (G5-C định nghĩa lại hàm này để thêm nhánh direct_l5_v1
    // — xem chú thích `liveDefinitionOf`).
  });
});

describe('G5-B — cột grantable trên registry (Fix round 1, F1: fail-closed)', () => {
  it('boolean NOT NULL DEFAULT false — moi action MOI khong grantable cho toi khi duoc mo tuong minh', () => {
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS grantable boolean NOT NULL DEFAULT false;/,
    );
    // Khong con DEFAULT true trong toan bo cot nay.
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS grantable boolean NOT NULL DEFAULT true;/);
  });

  it('allowlist tuong minh dung 6 action L3/L4 nonce_abi_v1 hien co, KHONG bao gom nop_ho_so', () => {
    const khoi = migration.slice(
      migration.indexOf('UPDATE app_private.copilot_action_registry'),
      migration.indexOf('AND NOT grantable;') + 20,
    );
    expect(khoi).not.toBe('');
    for (const actionId of [
      'income_expense.annotate',
      'reservation.set_hold_terms',
      'zalo.set_conversation_flags',
      'meter_reading.create',
      'reservation_deposit.create',
      'income_expense.create_draft',
    ]) {
      expect(khoi).toContain(`'${actionId}'`);
    }
    // L5/maker_submit_v1 KHONG duoc nam trong allowlist mo grantable.
    expect(khoi).not.toContain('income_expense.nop_ho_so');
    // UPDATE co dieu kien AND NOT grantable — idempotent, khong ghi lai vo ich.
    expect(khoi).toContain('AND NOT grantable');
  });

  it('nghiem thu dem dung 6 hang grantable=true tu allowlist, va nop_ho_so PHAI van false', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu_grant$'));
    expect(nghiemThu).toContain('<> 6 THEN');
    expect(nghiemThu).toMatch(
      /RAISE EXCEPTION 'allowlist F1 khong du 6 action grantable=true'/,
    );
    expect(nghiemThu).toContain("action_id = 'income_expense.nop_ho_so' AND grantable");
    expect(nghiemThu).toMatch(
      /RAISE EXCEPTION 'income_expense\.nop_ho_so khong duoc grantable \(fail-closed\)'/,
    );
  });
});

describe('G5-B — sổ (copilot_action_ledger): 3 sự kiện grant_* + cột amount', () => {
  it('DO-guard drop-rồi-add idempotent, giữ nguyên các sự kiện cũ', () => {
    const khoi = migration.slice(
      migration.indexOf('$mo_rong_event_ledger_grant$'),
      migration.indexOf('$mo_rong_event_ledger_grant$', migration.indexOf('$mo_rong_event_ledger_grant$') + 1) + 30,
    );
    expect(khoi).toContain("NOT LIKE '%grant_created%'");
    expect(khoi).toContain('DROP CONSTRAINT copilot_action_ledger_event_check');
    for (const su_kien of [
      'plan_created', 'plan_approved', 'step_done', 'step_failed', 'step_blocked',
      'plan_cancelled', 'plan_expired', 'action_executed', 'action_failed',
      'policy_changed', 'capability_changed', 'step_up_pin_set', 'step_up_verified',
      'step_up_locked', 'step_up_unlocked', 'grant_created', 'grant_revoked', 'grant_used',
    ]) {
      expect(khoi).toContain(`'${su_kien}'`);
    }
  });

  it('KHÔNG đụng copilot_action_ledger_org_required — grant_* luôn mang tổ chức', () => {
    expect(migration).not.toMatch(/DROP CONSTRAINT copilot_action_ledger_org_required/);
  });

  it('cột amount là numeric, nullable (không NOT NULL)', () => {
    const dong = migration.match(/ALTER TABLE app_private\.copilot_action_ledger ADD COLUMN IF NOT EXISTS amount numeric;/);
    expect(dong).not.toBeNull();
  });
});

describe('G5-B — copilot_ledger_append_v1 (CREATE OR REPLACE)', () => {
  const body = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION app_private.copilot_ledger_append_v1'),
    migration.indexOf('CREATE TABLE IF NOT EXISTS app_private.copilot_standing_grants ('),
  );

  it('thêm amount vào cả cột INSERT lẫn giá trị VALUES, có gác regex (Fix round 1, F4)', () => {
    expect(body).toMatch(/sqlstate, entity_table, entity_id, audit_id, amount\s*\)/);
    // Fix round 1 (F4, review): KHÔNG còn ép kiểu thô NULLIF(...)::numeric —
    // một chuỗi bất kỳ (không phải số) sẽ ném 22P02 và cuốn ngược cả INSERT.
    expect(body).not.toMatch(/NULLIF\(p ->> 'amount', ''\)::numeric/);
    expect(body).toContain("CASE WHEN (p ->> 'amount') ~ '^[0-9]+(");
    expect(body).toContain(")?$'");
    expect(body).toContain("THEN (p ->> 'amount')::numeric ELSE NULL END");
  });

  it('không đổi điều kiện ngoại lệ tổ chức đã có từ G5-A', () => {
    expect(body).toContain(
      "'policy_changed', 'step_up_pin_set', 'step_up_unlocked', 'step_up_locked'",
    );
  });
});

describe('G5-B — bảng copilot_standing_grants', () => {
  it('đủ cột khoá theo brief', () => {
    for (const cot of [
      'granter_user_id', 'organization_id', 'action_id', 'constraints',
      'max_per_day', 'used_today', 'used_on', 'expires_at',
      'created_with_step_up_id', 'revoked_at', 'revoked_by', 'reason',
    ]) {
      expect(migration).toContain(cot);
    }
    expect(migration).toMatch(
      /action_id\s+text NOT NULL REFERENCES app_private\.copilot_action_registry\(action_id\)/,
    );
    expect(migration).toMatch(
      /created_with_step_up_id uuid NOT NULL REFERENCES app_private\.copilot_write_confirmations\(id\)/,
    );
  });

  it('6 CHECK theo hàng: max_per_day 1..200, hết hạn ≤30 ngày kể từ created_at, lý do bắt buộc, constraints là object, used_today ≥0, cặp revoked', () => {
    expect(migration).toMatch(/CHECK \(max_per_day BETWEEN 1 AND 200\);/);
    expect(migration).toMatch(
      /CHECK \(expires_at <= created_at \+ interval '30 days'\);/,
    );
    expect(migration).toMatch(/CHECK \(btrim\(reason\) <> ''\);/);
    expect(migration).toMatch(/CHECK \(jsonb_typeof\(constraints\) = 'object'\);/);
    expect(migration).toMatch(/CHECK \(used_today >= 0\);/);
    expect(migration).toMatch(/CHECK \(\(revoked_at IS NULL\) = \(revoked_by IS NULL\)\);/);
  });

  it('index bộ phận (organization_id, action_id) WHERE revoked_at IS NULL', () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_copilot_standing_grants_active\s*\n\s*ON app_private\.copilot_standing_grants \(organization_id, action_id\)\s*\n\s*WHERE revoked_at IS NULL;/,
    );
  });

  it('REVOKE ALL FROM PUBLIC + guarded anon/authenticated/service_role, cả bảng lẫn audit', () => {
    for (const bang of ['copilot_standing_grants', 'copilot_standing_grants_audit']) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON app_private\\.${bang} FROM PUBLIC;`));
    }
    for (const tag of ['$thu_hoi_standing_grants$', '$thu_hoi_standing_grants_audit$']) {
      const khoi = migration.slice(
        migration.indexOf(tag),
        migration.indexOf(tag, migration.indexOf(tag) + 1) + 20,
      );
      for (const vai of ['anon', 'authenticated', 'service_role']) {
        expect(khoi).toContain(`to_regrole('${vai}')`);
      }
    }
  });
});

describe('G5-B — trigger BEFORE INSERT chặn action không grantable', () => {
  const guard = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION app_private.copilot_standing_grant_guard_v1'),
    migration.indexOf('DROP TRIGGER IF EXISTS trg_copilot_standing_grant_guard'),
  );

  it('đọc grantable/enabled từ registry theo NEW.action_id, RAISE action_not_grantable với 42501', () => {
    expect(guard).toMatch(/SELECT grantable, enabled INTO v_grantable, v_enabled/);
    expect(guard).toMatch(/WHERE action_id = NEW\.action_id;/);
    expect(guard).toMatch(/'action_not_grantable: % khong the uy quyen dung', NEW\.action_id/);
    expect(guard).toContain("ERRCODE = '42501'");
  });

  it('trigger gắn BEFORE INSERT trên copilot_standing_grants', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER trg_copilot_standing_grant_guard\s*\n\s*BEFORE INSERT ON app_private\.copilot_standing_grants\s*\n\s*FOR EACH ROW EXECUTE FUNCTION app_private\.copilot_standing_grant_guard_v1\(\);/,
    );
  });
});

describe('G5-B — sổ riêng copilot_standing_grants_audit là chỉ-ghi-thêm', () => {
  it('trigger BEFORE UPDATE OR DELETE RAISE 42501 với mọi vai', () => {
    const body = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION app_private.copilot_standing_grants_audit_bat_bien_v1'),
      migration.indexOf('DROP TRIGGER IF EXISTS trg_copilot_standing_grants_audit_bat_bien'),
    );
    expect(body).toContain("ERRCODE = '42501'");
    expect(migration).toMatch(
      /CREATE TRIGGER trg_copilot_standing_grants_audit_bat_bien\s*\n\s*BEFORE UPDATE OR DELETE ON app_private\.copilot_standing_grants_audit/,
    );
  });

  it('action CHECK giới hạn đúng 4 giá trị vòng đời', () => {
    expect(migration).toMatch(
      /action\s+text NOT NULL CHECK \(action IN \('created', 'revoked', 'revoked_all', 'used'\)\)/,
    );
  });
});

describe('G5-B — RPC 1/5: copilot_standing_grant_create_v1', () => {
  const body = than('copilot_standing_grant_create_v1');

  it('thứ tự cửa: danh tính → super admin → tổ chức ACTIVE → van standing_grants_enabled', () => {
    const iAuth = body.indexOf("'unauthenticated'");
    const iSuper = body.indexOf('is_super_admin()');
    const iOrg = body.indexOf("'organization_not_found'");
    const iPolicy = body.indexOf("'standing_grants_disabled'");
    expect(iAuth).toBeGreaterThan(-1);
    expect(iSuper).toBeGreaterThan(iAuth);
    expect(iOrg).toBeGreaterThan(iSuper);
    expect(iPolicy).toBeGreaterThan(iOrg);
  });

  it('van standing_grants_enabled đọc từ copilot_action_policy, RAISE 42501 khi tắt', () => {
    expect(body).toMatch(/SELECT \* INTO v_policy FROM app_private\.copilot_action_policy WHERE id;/);
    expect(body).toMatch(/IF NOT v_policy\.standing_grants_enabled THEN/);
    expect(body).toContain("RAISE EXCEPTION 'standing_grants_disabled' USING ERRCODE = '42501';");
  });

  it('action phải tồn tại/enabled/grantable — 3 nhánh RAISE riêng, cùng mã 42501', () => {
    expect(body).toMatch(/copilot_action_disabled: % khong co trong registry', p_action_id/);
    expect(body).toMatch(/copilot_action_disabled: % da tat trong registry', p_action_id/);
    expect(body).toMatch(/action_not_grantable: % khong the uy quyen dung', p_action_id/);
    expect(body).toMatch(/IF NOT v_reg\.grantable THEN/);
  });

  it('max_per_day 1..200, expires_at trong (now, now+30d], reason không rỗng, constraints là object', () => {
    expect(body).toMatch(/p_max_per_day < 1 OR p_max_per_day > 200/);
    expect(body).toMatch(
      /v_expires IS NULL OR v_expires <= v_now OR v_expires > v_now \+ interval '30 days'/,
    );
    expect(body).toMatch(/COALESCE\(btrim\(p_reason\), ''\) = ''/);
    expect(body).toMatch(/jsonb_typeof\(v_constraints\) <> 'object'/);
  });

  it('max_amount trong constraints phải là số dương, bắt cả lỗi ép kiểu', () => {
    expect(body).toMatch(/v_constraints \? 'max_amount'/);
    expect(body).toMatch(/\(v_constraints ->> 'max_amount'\)::numeric <= 0/);
    expect(body).toMatch(/WHEN invalid_text_representation THEN/);
  });

  it('building_ids trong constraints phải là mảng jsonb', () => {
    expect(body).toMatch(
      /v_constraints \? 'building_ids' AND jsonb_typeof\(v_constraints -> 'building_ids'\) <> 'array'/,
    );
  });

  it('step-up: hình sai không soi bảng nonce (regex hex64 trước FOR UPDATE)', () => {
    const iRegex = body.indexOf("p_step_up_token !~ '^[0-9a-fA-F]{64}\\$'".replace('\\$', '$'));
    const iSelect = body.indexOf('FOR UPDATE');
    expect(iRegex).toBeGreaterThan(-1);
    expect(iSelect).toBeGreaterThan(iRegex);
  });

  it('7 điều kiện của token đều gộp vào một OR, trả cùng step_up_required — không phân biệt lý do sai', () => {
    const iSelect = body.indexOf('FOR UPDATE');
    const iRaise = body.indexOf("RAISE EXCEPTION 'step_up_required'", iSelect);
    const khoiDieuKien = body.slice(iSelect, iRaise);
    expect(khoiDieuKien).toContain('NOT FOUND');
    expect(khoiDieuKien).toContain('v_step_up.user_id IS DISTINCT FROM v_actor');
    expect(khoiDieuKien).toContain("v_step_up.tool IS DISTINCT FROM 'step_up'");
    expect(khoiDieuKien).toContain("v_step_up.permission_key IS DISTINCT FROM 'copilot.step_up'");
    expect(khoiDieuKien).toContain('v_step_up.consumed_at IS NOT NULL');
    expect(khoiDieuKien).toContain('v_step_up.expires_at <= v_now');
    expect(khoiDieuKien).toContain('v_step_up.organization_id IS DISTINCT FROM p_organization_id');
    expect(khoiDieuKien).toContain('v_step_up.payload_hash IS DISTINCT FROM');
    // Đúng một khối OR duy nhất — không phải nhiều RAISE rải rác với mã khác nhau.
    expect(khoiDieuKien.match(/RAISE EXCEPTION/g)).toBeNull();
  });

  it('token bị TIÊU (CAS consumed_at IS NULL) SAU khi mọi validate đã qua, TRƯỚC khi INSERT', () => {
    const iLastValidateCond = body.indexOf('v_step_up.payload_hash IS DISTINCT FROM');
    const iConsume = body.indexOf('WHERE id = v_step_up.id AND consumed_at IS NULL');
    const iInsertGrant = body.indexOf('INSERT INTO app_private.copilot_standing_grants (');
    expect(iLastValidateCond).toBeGreaterThan(-1);
    expect(iConsume).toBeGreaterThan(iLastValidateCond);
    expect(iInsertGrant).toBeGreaterThan(iConsume);
    // CAS phải tự kiểm NOT FOUND — hai request song song cùng token chỉ một thắng.
    const duoiConsume = body.slice(iConsume, iConsume + 200);
    expect(duoiConsume).toMatch(/IF NOT FOUND THEN\s*\n\s*RAISE EXCEPTION 'step_up_required'/);
  });

  it('ghi INSERT grant + audit(created) + ledger grant_created với grant_id/step_up_id', () => {
    expect(body).toMatch(
      /INSERT INTO app_private\.copilot_standing_grants \(\s*granter_user_id, organization_id, action_id, constraints, max_per_day,\s*expires_at, created_with_step_up_id, reason\s*\)/,
    );
    expect(body).toMatch(/INSERT INTO app_private\.copilot_standing_grants_audit \(/);
    expect(body).toContain("'created', v_actor,");
    expect(body).toMatch(/'event',\s*'grant_created',/);
    expect(body).toContain("'grant_id',        v_grant_id,");
    expect(body).toContain("'step_up_id',      v_step_up.id,");
  });
});

describe('G5-B — RPC 2/5 và 3/5: thu hồi KHÔNG cần step-up', () => {
  it('copilot_standing_grant_revoke_v1 không nhận p_step_up_token', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.copilot_standing_grant_revoke_v1\(\s*p_grant_id uuid,\s*p_reason\s+text\s*\)/,
    );
    const body = than('copilot_standing_grant_revoke_v1');
    expect(body).not.toContain('step_up');
    expect(body).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(body).toMatch(/SELECT \* INTO v_row FROM app_private\.copilot_standing_grants\s*\n\s*WHERE id = p_grant_id FOR UPDATE;/);
    expect(body).toMatch(/'event',\s*'grant_revoked',/);
  });

  it('copilot_standing_grants_revoke_all_v1 không nhận p_step_up_token, khoá FOR UPDATE cả loạt, đếm revoked_count', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.copilot_standing_grants_revoke_all_v1\(\s*p_organization_id uuid,\s*p_reason\s+text\s*\)/,
    );
    const body = than('copilot_standing_grants_revoke_all_v1');
    expect(body).not.toContain('step_up');
    expect(body).toMatch(
      /WHERE organization_id = p_organization_id AND revoked_at IS NULL\s*\n\s*FOR UPDATE/,
    );
    expect(body).toContain("'revoked_count', v_n");
    expect(body).toContain("'kill_switch', true");
  });
});

describe('G5-B — RPC 4/5 và 5/5: đọc, chỉ super admin', () => {
  it('copilot_standing_grants_list_v1 reset used_today theo ngày trong kết quả trả về', () => {
    const body = than('copilot_standing_grants_list_v1');
    expect(body).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(body).toMatch(
      /'used_today',\s*CASE WHEN g\.used_on IS DISTINCT FROM current_date\s*\n\s*THEN 0 ELSE g\.used_today END,/,
    );
  });

  it('copilot_standing_grants_daily_report_v1 lọc consent_kind=standing_grant theo ngày + tổng amount từ sổ', () => {
    const body = than('copilot_standing_grants_daily_report_v1');
    expect(body).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(body).toContain("p.consent_kind = 'standing_grant'");
    expect(body).toContain("l.consent_kind = 'standing_grant'");
    expect(body).toContain("l.event = 'step_done'");
    expect(body).toMatch(/COALESCE\(sum\(l\.amount\), 0\)/);
  });
});

describe('G5-B — RPC 1..5: REVOKE ALL PUBLIC + guarded anon/service_role, GRANT authenticated', () => {
  const chuKy: Record<(typeof RPC_PUBLIC)[number], string> = {
    copilot_standing_grant_create_v1: 'uuid, text, jsonb, int, timestamptz, text, text',
    copilot_standing_grant_revoke_v1: 'uuid, text',
    copilot_standing_grants_revoke_all_v1: 'uuid, text',
    copilot_standing_grants_list_v1: 'uuid',
    copilot_standing_grants_daily_report_v1: 'uuid, date',
  };

  for (const fn of RPC_PUBLIC) {
    it(`${fn}: REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO authenticated`, () => {
      const sig = chuKy[fn];
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}(${sig}) FROM PUBLIC;`,
      );
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.${fn}(${sig}) TO authenticated;`,
      );
    });
  }
});

describe('G5-B — nhánh tự duyệt trong copilot_plan_create_v1', () => {
  const body = than('copilot_plan_create_v1');

  it('mỗi bước trong v_gom mang khoá grantable lấy từ v_reg.grantable', () => {
    expect(body).toMatch(/'grantable',\s*v_reg\.grantable,/);
  });

  it('khóa TOÀN BỘ hạn mức MỘT LẦN, sắp theo id, TRƯỚC vòng lặp so khớp từng bước (Fix round 1, F3)', () => {
    const iSoat = body.indexOf('SELECT standing_grants_enabled INTO v_standing_enabled');
    const iOrderById = body.indexOf('ORDER BY g.id', iSoat);
    const iForUpdate = body.indexOf('FOR UPDATE', iSoat);
    const iPerStepLoop = body.indexOf('FOR v_j IN 0 .. v_n - 1 LOOP', iSoat);
    const iApply = body.indexOf('FOR v_grant_key, v_grant_val IN SELECT * FROM jsonb_each_text');
    expect(iSoat).toBeGreaterThan(-1);
    expect(iOrderById).toBeGreaterThan(iSoat);
    expect(iForUpdate).toBeGreaterThan(iOrderById);
    // Khóa xảy ra TRƯỚC vòng lặp so khớp từng bước — không còn SELECT ...
    // FOR UPDATE nào bên trong vòng lặp đó nữa.
    expect(iForUpdate).toBeLessThan(iPerStepLoop);
    expect(iForUpdate).toBeLessThan(iApply);
  });

  it('vòng lặp so khớp từng bước KHÔNG còn khóa riêng — chỉ đọc lại tập đã khóa (id = ANY(v_locked_ids))', () => {
    const iPerStepLoop = body.indexOf('FOR v_j IN 0 .. v_n - 1 LOOP');
    const iApply = body.indexOf('FOR v_grant_key, v_grant_val IN SELECT * FROM jsonb_each_text');
    const perStep = body.slice(iPerStepLoop, iApply);
    expect(perStep).toContain('WHERE g.id = ANY(v_locked_ids)');
    // Vung soat tung buoc KHONG con dieu kien organization_id/revoked_at rieng
    // -- tat ca da chuyen sang khoi khoa mot pha o TRUOC vong lap nay.
    expect(perStep).not.toContain('g.organization_id = p_organization_id');
    expect(perStep).not.toContain('g.revoked_at IS NULL');
    expect((perStep.match(/FOR UPDATE/g) || []).length).toBe(0);
  });

  it('action không grantable làm cả kế hoạch KHÔNG được phủ (v_standing_ok := false)', () => {
    expect(body).toMatch(
      /IF NOT COALESCE\(\(v_step_entry ->> 'grantable'\)::boolean, false\) THEN\s*\n\s*v_standing_ok := false;/,
    );
  });

  it('used_today reset khi used_on khác ngày hôm nay (cả lúc soát lẫn lúc ghi tăng)', () => {
    expect(body).toMatch(
      /v_reset_used := CASE WHEN v_grant_row\.used_on IS DISTINCT FROM current_date\s*\n\s*THEN 0 ELSE v_grant_row\.used_today END;/,
    );
    expect(body).toMatch(
      /used_today = \(CASE WHEN used_on IS DISTINCT FROM current_date\s*\n\s*THEN 0 ELSE used_today END\) \+ v_grant_val::int,/,
    );
  });

  it('nhiều bước cùng action_id trong một kế hoạch cộng dồn đúng vào v_grant_locks trước khi ghi', () => {
    expect(body).toMatch(
      /v_planned := COALESCE\(\(v_grant_locks ->> v_grant_row\.id::text\)::int, 0\);/,
    );
    expect(body).toMatch(/IF v_reset_used \+ v_planned >= v_grant_row\.max_per_day THEN/);
    expect(body).toMatch(
      /v_grant_locks := jsonb_set\(v_grant_locks, ARRAY\[v_grant_row\.id::text\],\s*\n\s*to_jsonb\(v_planned \+ 1\)\);/,
    );
  });

  it('ràng buộc max_amount: THIẾU/SAI dạng dữ liệu ở canonical là KHÔNG khớp (Fix round 1, F4: gác regex trước ép kiểu)', () => {
    expect(body).toContain("v_amt_txt := (v_step_entry -> 'canonical') ->> 'amount';");
    expect(body).toContain("IF v_grant_row.constraints ? 'max_amount' THEN");
    expect(body).toContain('IF v_amt_txt IS NULL');
    expect(body).toContain("v_amt_txt !~ '^[0-9]+(");
    expect(body).toContain(")?$'");
  });

  it('ràng buộc building_ids: THIẾU dữ liệu ở canonical là KHÔNG khớp, không phải tự do', () => {
    expect(body).toContain("IF v_grant_row.constraints ? 'building_ids' THEN");
    expect(body).toContain("IF NOT ((v_step_entry -> 'canonical') ? 'building_id')");
  });

  it('sau khi đủ phủ: tăng used_today, ghi audit(used) + ledger grant_used cho MỖI grant đã khoá', () => {
    expect(body).toMatch(/UPDATE app_private\.copilot_standing_grants\s*\n\s*SET used_today = /);
    expect(body).toMatch(/INSERT INTO app_private\.copilot_standing_grants_audit \(/);
    expect(body).toContain("'used', v_actor,");
    expect(body).toMatch(/'event',\s*'grant_used',/);
  });

  it('tiêu nonce cấp kế hoạch NGAY, đẩy plan sang APPROVED với consent_kind=standing_grant', () => {
    expect(body).toMatch(
      /UPDATE app_private\.copilot_write_confirmations\s*\n\s*SET consumed_at = clock_timestamp\(\)\s*\n\s*WHERE id = v_consent_id AND consumed_at IS NULL;/,
    );
    expect(body).toMatch(
      /SET status\s*= 'APPROVED',\s*\n\s*approved_at\s*= clock_timestamp\(\),/,
    );
    expect(body).toContain("consent_kind            = 'standing_grant',");
    expect(body).toContain('standing_grant_ids      = v_final_grant_ids,');
  });

  it('ledger plan_approved mang consent_kind=standing_grant + grant_id đại diện', () => {
    expect(body).toMatch(/'event',\s*'plan_approved',/);
    expect(body).toContain("'consent_kind',    'standing_grant',");
    expect(body).toContain("'grant_id',        v_first_grant_id,");
  });

  it('RETURN nhánh tự duyệt: consent_nonce NULL, có tu_duyet_theo_uy_quyen là mảng grant id', () => {
    expect(body).toMatch(/'consent_nonce',\s+NULL,\s*\n\s*'da_ton_tai',\s+false,\s*\n\s*'tu_duyet_theo_uy_quyen'/);
    expect(body).toContain("'tu_duyet_theo_uy_quyen', to_jsonb(v_final_grant_ids));");
  });

  it('đường DRAFT cũ (không được phủ) vẫn còn nguyên — vẫn trả consent_nonce hex như trước G5-B', () => {
    expect(body).toMatch(/'consent_nonce', encode\(v_nonce, 'hex'\),/);
  });
});

describe('G5-B — nhánh amount trong copilot_plan_execute_step_v1 (đọc định nghĩa SỐNG)', () => {
  it('sự kiện step_done ghi amount từ v_step.canonical (đã chốt ở preview), không từ payload thô', () => {
    const body = thanSong('copilot_plan_execute_step_v1');
    expect(body).toMatch(/'amount',\s*NULLIF\(v_step\.canonical ->> 'amount', ''\),/);
  });

  it('chữ ký ABI KHÔNG đổi ở định nghĩa sống (G5-C chỉ thêm một nhánh, không đổi tham số)', () => {
    const { sql } = liveDefinitionOf('copilot_plan_execute_step_v1');
    expect(sql).toMatch(
      /FUNCTION public\.copilot_plan_execute_step_v1\(p_plan_id uuid, p_step_no integer, p_expected_plan_version integer, p_organization_id uuid\)/,
    );
  });

  it('định nghĩa sống mang nhánh direct_l5_v1 (G5-C) — chi tiết đầy đủ do copilotActionsL5Migration.test.ts ghim', () => {
    const body = thanSong('copilot_plan_execute_step_v1');
    expect(body).toMatch(/executor_kind = 'direct_l5_v1'/);
  });
});

describe('G5-B — thu hồi giữa chừng chặn được kế hoạch đang chạy (Fix round 1, F2) (đọc định nghĩa SỐNG)', () => {
  const body = thanSong('copilot_plan_execute_step_v1');

  it('kiểm consent_kind=standing_grant NGAY ở đầu TIỀN KIỂM, trước cả registry/policy', () => {
    const iFlag = body.indexOf('copilot_feature_disabled');
    const iGrantCheck = body.indexOf("v_plan.consent_kind = 'standing_grant'");
    const iRegistry = body.indexOf('SELECT * INTO v_reg');
    expect(iFlag).toBeGreaterThan(-1);
    expect(iGrantCheck).toBeGreaterThan(iFlag);
    expect(iRegistry).toBeGreaterThan(iGrantCheck);
  });

  it('MỌI id trong standing_grant_ids phải còn sống (revoked_at IS NULL AND expires_at > now); một cái chết là RAISE grant_revoked', () => {
    expect(body).toContain('FROM unnest(v_plan.standing_grant_ids) AS gid');
    expect(body).toContain('WHERE g.id = gid');
    expect(body).toContain('AND g.revoked_at IS NULL');
    expect(body).toContain('AND g.expires_at > clock_timestamp()');
    expect(body).toMatch(/RAISE EXCEPTION 'grant_revoked' USING ERRCODE = '42501';/);
  });

  it('CHỈ áp dụng cho consent_kind=standing_grant — đường bấm tay/PIN không có grant nào để kiểm', () => {
    expect(body).toContain("IF v_plan.consent_kind = 'standing_grant' THEN");
  });

  it('lỗi grant_revoked đi qua ĐÚNG đường write-rồi-return có sẵn: step BLOCKED, plan FAILED, ledger step_blocked (không phải RAISE trần không ghi gì)', () => {
    // Khối TIỀN KIỂM bọc trong BEGIN...EXCEPTION WHEN others chung — RAISE ở
    // đây rơi vào v_su_kien := 'step_blocked' rồi chảy qua đúng nhánh ghi sổ
    // đã có sẵn (không phải một nhánh RETURN riêng mới viết cho F2).
    const iGrantCheck = body.indexOf("v_plan.consent_kind = 'standing_grant'");
    const iExceptionCatch = body.indexOf("v_su_kien := 'step_blocked';", iGrantCheck);
    expect(iExceptionCatch).toBeGreaterThan(iGrantCheck);
  });
});

describe('G5-B — đột biến thứ ba (Fix round 1, F2): bỏ kiểm grant_revoked làm assertion phía trên đỏ', () => {
  const MOC = "RAISE EXCEPTION 'grant_revoked' USING ERRCODE = '42501';";

  it('gỡ RAISE grant_revoked làm kế hoạch tự duyệt chạy NGẦM sau khi hạn mức đã bị thu hồi', () => {
    expect(tho).toContain(MOC);
    const dotBien = tho.replace(MOC, "NULL;");
    const dotBienSach = boCommentSql(dotBien);
    const body = thanHam(dotBienSach, 'copilot_plan_execute_step_v1');
    expect(body).not.toMatch(/RAISE EXCEPTION 'grant_revoked'/);
  });
});

describe('G5-B — nghiệm thu catalog-only trong chính file', () => {
  it('khối DO $nghiem_thu_grant$ đọc pg_proc/has_function_privilege/has_table_privilege, không đụng bảng dữ liệu', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu_grant$'));
    expect(nghiemThu).toContain('has_function_privilege');
    expect(nghiemThu).toContain('has_table_privilege');
    expect(nghiemThu).not.toMatch(/SELECT \* FROM app_private\.copilot_standing_grants\b/);
  });

  it('nghiệm thu canh cả bảng grant/audit không lộ cho authenticated/anon', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu_grant$'));
    for (const bang of ['copilot_standing_grants', 'copilot_standing_grants_audit']) {
      for (const vai of ['anon', 'authenticated']) {
        expect(nghiemThu).toContain(`has_table_privilege('${vai}', 'app_private.${bang}', 'SELECT')`);
      }
    }
  });

  it('nghiệm thu xác nhận ABI cũ của plan_create/execute_step không đổi', () => {
    const nghiemThu = migration.slice(migration.indexOf('DO $nghiem_thu_grant$'));
    expect(nghiemThu).toContain("to_regprocedure('public.copilot_plan_create_v1(uuid, text, jsonb)')");
    expect(nghiemThu).toContain(
      "to_regprocedure('public.copilot_plan_execute_step_v1(uuid, integer, integer, uuid)')",
    );
  });
});

// ---------------------------------------------------------------------------
// Bài kiểm đột biến — chứng minh các pin ở trên KHÔNG phải màu xanh rỗng.
// Không sửa file trên đĩa: đột biến chỉ tồn tại trong bộ nhớ của chính test này.
// ---------------------------------------------------------------------------
describe('G5-B — pin phải đỏ khi hàng rào bị bình luận hoá', () => {
  const MOC = 'WHERE id = v_step_up.id AND consumed_at IS NULL';
  const PIN = /WHERE id = v_step_up\.id AND consumed_at IS NULL/;

  function binhLuanHoaCasTieuToken(sql: string): string {
    const dong = sql.split('\n');
    let daBinhLuan = 0;
    for (let i = 0; i < dong.length; i += 1) {
      if (dong[i].includes(MOC)) {
        dong[i] = '-- ' + dong[i];
        daBinhLuan += 1;
      }
    }
    expect(daBinhLuan, 'khong tim thay dong CAS tieu token step-up de dot bien').toBe(1);
    return dong.join('\n');
  }

  it('văn bản THÔ vẫn khớp pin sau khi bị bình luận hoá — đó chính là cái lỗ', () => {
    expect(binhLuanHoaCasTieuToken(tho)).toMatch(PIN);
  });

  it('bản đã lột bình luận thì KHÔNG khớp nữa — cửa đã đóng', () => {
    const dotBien = boCommentSql(binhLuanHoaCasTieuToken(tho));
    expect(dotBien).not.toMatch(PIN);
    // Bản không đột biến vẫn khớp, để bài kiểm này không xanh vì lý do sai.
    expect(migration).toMatch(PIN);
  });
});

describe('G5-B — đột biến thứ hai (Fix round 1, F3): FOR UPDATE trong khối khoá một pha', () => {
  // Nếu ai đó bỏ FOR UPDATE khỏi câu SELECT khoá một pha (ORDER BY g.id),
  // hai kế hoạch song song lại có thể cùng đọc used_today thấp rồi cùng nghĩ
  // mình được phủ — pin này chứng minh assertion "khoá TRƯỚC vòng lặp so
  // khớp" ở trên không xanh rỗng.
  const MOC = 'ORDER BY g.id\n       FOR UPDATE;';

  it('gỡ FOR UPDATE khỏi khối khoá một pha làm assertion phía trên đỏ', () => {
    expect(tho).toContain(MOC);
    const dotBien = tho.replace(MOC, 'ORDER BY g.id;');
    const dotBienSach = boCommentSql(dotBien);
    const body = thanHam(dotBienSach, 'copilot_plan_create_v1');
    const iSoat = body.indexOf('SELECT standing_grants_enabled INTO v_standing_enabled');
    const iForUpdate = body.indexOf('FOR UPDATE', iSoat);
    const iApply = body.indexOf('FOR v_grant_key, v_grant_val IN SELECT * FROM jsonb_each_text');
    // Không còn FOR UPDATE nào trong cả khối soát -> chỉ số tìm thấy phải nằm
    // NGOÀI khoảng [iSoat, iApply), tức là -1 hoặc >= iApply.
    expect(iForUpdate === -1 || iForUpdate >= iApply).toBe(true);
  });
});
