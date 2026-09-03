import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// G2-A dựng nền ghi có kiểm soát bằng MỘT migration. Test này ghim những mệnh đề
// mà G3 (kế hoạch thực thi) và G5 (Mức 3 — lật `max_direct_risk` sang L5) sẽ tựa
// vào: nếu một trong chúng biến mất thì hai giai đoạn sau phải sửa lược đồ, đúng
// thứ mà file migration sinh ra để tránh.
//
// Đây là test ĐỌC FILE, không phải test chạy SQL, nên nó chỉ trả lời được câu
// "văn bản có còn nói điều đó không". Hành vi thật (trigger có chặn UPDATE không,
// CHECK có từ chối hàng sai không) được khối nghiệm thu trong chính migration và
// hai lượt dry-run trên production đo — ghi ra đây để không ai đọc màu xanh của
// file này thành "đã kiểm chứng trên database".
const migrationPath =
  'supabase/migrations/20260903043956_copilot_action_registry_policy_ledger_v1.sql';

const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

/** Thân một hàm plpgsql: từ CREATE tới hết, đủ để so thứ tự bên trong nó. */
function functionBody(sql: string, name: string): string {
  const start = sql.search(
    new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\s*\\(`, 'i'),
  );
  if (start < 0) return '';
  const rest = sql.slice(start);
  const end = rest.search(/\n\$[a-z_]+\$;/i);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('G2-A — migration nền ghi có kiểm soát', () => {
  it('tồn tại và là một cặp BEGIN/COMMIT duy nhất', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('dựng đủ bốn bảng nền, không đụng ai khác', () => {
    for (const t of [
      'copilot_action_registry',
      'copilot_action_policy',
      'copilot_action_policy_audit',
      'copilot_action_ledger',
    ]) {
      expect(migration).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS app_private\\.${t}\\b`, 'i'),
      );
    }
    // Cặp writer thu/chi đang chạy trên production và `ai_write_audit` đều nằm
    // ngoài phạm vi G2-A. Một ALTER lọt vào đây là một thay đổi không ai duyệt.
    expect(migration).not.toMatch(/ALTER TABLE\s+public\.ai_write_audit/i);
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.copilot_execute_income_expense_v1/i,
    );
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.copilot_preview_income_expense_v1/i,
    );
  });

  // ĐIỂM NỐI #1. Hai CHECK theo hàng là nơi luật "L5 phải khai đúng mặt" và luật
  // "L6 không bao giờ" sống ở tầng dữ liệu, chứ không chỉ trong gate tĩnh chạy
  // trên TypeScript — gate tĩnh không nhìn thấy hàng ai đó INSERT thẳng vào bảng.
  it('ghim CHECK L5 theo hàng đúng tên và đúng ba vế', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT copilot_action_registry_l5_row_check CHECK/i,
    );
    const khoi = migration.slice(
      migration.indexOf('copilot_action_registry_l5_row_check CHECK'),
    );
    expect(khoi).toMatch(
      /execute_rpc\s*!~\s*'\(approve\|decide\|_post_\|posting\|delete\|remove\|reverse\|grant\|revoke\|permission\|role\)'/,
    );
    expect(khoi.slice(0, 600)).toMatch(
      /risk\s*=\s*'L5'\s*AND\s*executor_kind\s*=\s*'direct_l5_v1'\s*AND\s*consent_required\s*=\s*'step_up'/,
    );
  });

  it('ghim CHECK L6 tuyệt đối trên cả ba cột tên RPC', () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT copilot_action_registry_l6_forbidden CHECK/i,
    );
    const khoi = migration.slice(
      migration.indexOf('copilot_action_registry_l6_forbidden CHECK'),
      migration.indexOf('copilot_action_registry_l6_forbidden CHECK') + 600,
    );
    const cam = /'\(sql\|secret\|deploy\|migration\|drop\|truncate\|pg_\)'/g;
    expect(khoi.match(cam)?.length ?? 0).toBe(3);
    expect(khoi).toMatch(/execute_rpc\s*!~/);
    expect(khoi).toMatch(/preview_rpc\s*!~/);
    expect(khoi).toMatch(/COALESCE\(rollback_rpc, ''\)\s*!~/);
  });

  it('dựng ba trigger: hai cái chặn sửa sổ, một cái giữ updated_at', () => {
    for (const tg of [
      'trg_copilot_action_registry_updated_at',
      'trg_copilot_action_policy_audit_bat_bien',
      'trg_copilot_action_ledger_bat_bien',
    ]) {
      // DROP IF EXISTS + CREATE là điều kiện để migration chạy lại được lượt hai.
      expect(migration).toMatch(new RegExp(`DROP TRIGGER IF EXISTS\\s+${tg}\\b`));
      expect(migration).toMatch(new RegExp(`CREATE TRIGGER\\s+${tg}\\b`));
    }
    // Hai sổ chỉ-ghi-thêm: chặn cả UPDATE lẫn DELETE, ném 42501 vô điều kiện,
    // thông điệp phải nói "chi ghi them" để người đọc log hiểu ngay đây là luật
    // chứ không phải lỗi quyền ngẫu nhiên (cùng khuôn ai_write_audit 20260814034600).
    for (const fn of [
      'app_private\\.copilot_policy_audit_bat_bien_v1',
      'app_private\\.copilot_action_ledger_bat_bien_v1',
    ]) {
      const body = functionBody(migration, fn);
      expect(body).toMatch(/RAISE EXCEPTION/i);
      expect(body).toMatch(/chi ghi them/);
      expect(body).toMatch(/ERRCODE = '42501'/);
      expect(body).not.toMatch(/RETURN NEW/);
    }
    expect(migration).toMatch(
      /BEFORE UPDATE OR DELETE ON app_private\.copilot_action_policy_audit/i,
    );
    expect(migration).toMatch(
      /BEFORE UPDATE OR DELETE ON app_private\.copilot_action_ledger/i,
    );
  });

  // ĐIỂM NỐI #2. G5 nâng trần rủi ro bằng cách GỌI RPC này, không bằng migration
  // mới — nên chữ ký sáu tham số và CAS theo revision phải đứng yên.
  it('RPC đổi policy có đúng sáu tham số theo thứ tự đã hẹn', () => {
    const dau = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.set_copilot_action_policy_v1(',
    );
    expect(dau).toBeGreaterThan(-1);
    const chuKy = migration.slice(dau, migration.indexOf(')', dau) + 1);
    const thamSo = [
      'p_expected_revision      bigint',
      'p_max_direct_risk        text DEFAULT NULL',
      'p_allowed_roles          text[] DEFAULT NULL',
      'p_standing_grants_enabled boolean DEFAULT NULL',
      'p_reason                 text DEFAULT NULL',
      'p_evidence_link          text DEFAULT NULL',
    ];
    let truoc = -1;
    for (const t of thamSo) {
      const vi = chuKy.indexOf(t);
      expect(vi, `thiếu hoặc sai thứ tự tham số: ${t}`).toBeGreaterThan(truoc);
      truoc = vi;
    }
    expect(chuKy.split(',').length).toBe(6);
  });

  it('CAS revision ném 40001, và lý do + bằng chứng là bắt buộc', () => {
    const body = functionBody(
      migration,
      'public\\.set_copilot_action_policy_v1',
    );
    expect(body).toMatch(/is_super_admin\(\)/);
    expect(body).toMatch(/FOR UPDATE/);
    expect(body).toMatch(/copilot_policy_stale_revision/);
    // 40001 (serialization_failure) là mã mà client hiểu là "đọc lại rồi thử lại",
    // khác hẳn 42501 "anh không có quyền". Đổi mã là đổi hành vi retry của client.
    expect(body).toMatch(
      /copilot_policy_stale_revision[\s\S]{0,240}ERRCODE = '40001'/,
    );
    expect(body).toMatch(/policy_reason_required[\s\S]{0,80}ERRCODE = '22023'/);
    expect(body).toMatch(
      /btrim\(p_reason\)[\s\S]{0,120}btrim\(p_evidence_link\)/,
    );
    // NULL = giữ nguyên: một lần đổi trần rủi ro không được reset danh sách vai.
    expect(body).toMatch(/COALESCE\(p_max_direct_risk, v_cu\.max_direct_risk\)/);
    expect(body).toMatch(/COALESCE\(p_allowed_roles, v_cu\.allowed_roles\)/);
    expect(body).toMatch(/revision\s*=\s*v_cu\.revision \+ 1/);
    expect(body).toMatch(/INSERT INTO app_private\.copilot_action_policy_audit/i);
  });

  it('gieo cờ scope=action có dấu giao dịch v2 TRƯỚC khi INSERT', () => {
    const dat = migration.indexOf(
      "set_config('app.copilot_feature_flag_transition', 'v2', true)",
    );
    const chen = migration.indexOf(
      'INSERT INTO public.copilot_feature_flags',
    );
    const traLai = migration.indexOf(
      "set_config('app.copilot_feature_flag_transition', '', true)",
    );
    expect(dat).toBeGreaterThan(-1);
    // Trigger v2 (20260829030000) từ chối mọi ghi không mang dấu này; đặt sau
    // INSERT thì migration chết, đặt mà không trả lại thì dấu rò sang câu sau.
    expect(dat).toBeLessThan(chen);
    expect(chen).toBeLessThan(traLai);
    expect(migration).toMatch(
      /\('action', 'income_expense\.create_draft', 'disabled'\)/,
    );
    expect(migration).toMatch(
      /\('action', 'copilot\.execution_plan'\s*, 'disabled'\)/,
    );
    expect(migration).toMatch(/ON CONFLICT \(scope, contract_id\) DO NOTHING/i);
  });

  it('seed registry khai đúng mặt action thu/chi nháp', () => {
    const dau = migration.indexOf(
      'INSERT INTO app_private.copilot_action_registry',
    );
    expect(dau).toBeGreaterThan(-1);
    const seed = migration.slice(dau, dau + 1400);
    expect(seed).toMatch(/'income_expense\.create_draft'/);
    expect(seed).toMatch(/'income_expenses\.create'/);
    expect(seed).toMatch(/'L4'/);
    expect(seed).toMatch(/'nonce_abi_v1'/);
    expect(seed).toMatch(/'click'/);
    expect(seed).toMatch(/'copilot_preview_income_expense_v1'/);
    expect(seed).toMatch(/'copilot_execute_income_expense_v1'/);
    expect(seed).toMatch(/ON CONFLICT \(action_id\) DO NOTHING/i);
    // enabled=true mô tả THỰC TẠI (đường IE đã live), còn cờ rollout thì
    // disabled — hai cột trả lời hai câu khác nhau và không được lẫn.
    expect(seed).toMatch(/\n\s*true\n\)/);
  });

  it('thu hồi quyền bảng khỏi service_role trên cả ba sổ', () => {
    for (const t of [
      'copilot_action_registry',
      'copilot_action_policy',
      'copilot_action_ledger',
    ]) {
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON app_private\\.${t} FROM PUBLIC;`),
      );
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON app_private\\.${t} FROM anon;`),
      );
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON app_private\\.${t} FROM authenticated;`),
      );
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON app_private\\.${t} FROM service_role;`),
      );
    }
    // REVOKE FROM PUBLIC KHÔNG cắt anon/authenticated trên Supabase (án lệ đã
    // ghi trong repo), và `service_role` không tồn tại ở mọi môi trường nên
    // lệnh thu hồi nó phải nằm sau guard to_regrole.
    expect(migration).toMatch(/IF to_regrole\('service_role'\) IS NOT NULL THEN/);
  });

  it('cổng action kiểm bốn cửa theo đúng thứ tự rẻ-trước-đắt-sau', () => {
    const body = functionBody(
      migration,
      'app_private\\.copilot_action_gate_v1',
    );
    expect(body).not.toBe('');
    const viTri = {
      registry: body.indexOf('app_private.copilot_action_registry'),
      flag: body.indexOf('public.copilot_feature_flags'),
      scope: body.indexOf('app_private.authorized_scope_v3'),
      denies: body.indexOf('app_private.tenant_emergency_denies'),
    };
    for (const [ten, vi] of Object.entries(viTri)) {
      expect(vi, `cổng không đọc ${ten}`).toBeGreaterThan(-1);
    }
    expect(viTri.registry).toBeLessThan(viTri.flag);
    expect(viTri.flag).toBeLessThan(viTri.scope);
    expect(viTri.scope).toBeLessThan(viTri.denies);

    expect(body).toMatch(/copilot_action_disabled[\s\S]{0,200}ERRCODE = '42501'/);
    expect(body).toMatch(/tenant_emergency_denied[\s\S]{0,200}ERRCODE = '42501'/);
    // Cột `permission_key IS NULL` là cách bảng cấm khẩn cấp nói "cấm mọi quyền";
    // bỏ vế đó là bỏ lọt đúng lệnh cấm rộng nhất.
    expect(body).toMatch(
      /d\.permission_key IS NULL OR d\.permission_key = v_reg\.permission_key/,
    );
    expect(body).toMatch(/d\.active_from <= v_now/);
    expect(body).toMatch(/d\.expires_at IS NULL OR d\.expires_at > v_now/);
    // Thiếu hàng cờ = TẮT. Một action chưa ai gieo cờ là action chưa ai duyệt.
    expect(body).toMatch(/NOT v_co_co[\s\S]{0,200}NOT IN \('shadow', 'enabled'\)/);

    for (const truong of [
      'org_wide',
      'building_count',
      'cashbook_count',
      'is_super_admin',
      'flag_state',
      'registry_version',
      'checked_at',
    ]) {
      expect(body).toMatch(new RegExp(`'${truong}'`));
    }
  });

  it('RPC bật/tắt capability nhận organization_id làm tham số ĐẦU TIÊN', () => {
    const dau = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.set_copilot_writer_capability_v1(',
    );
    expect(dau).toBeGreaterThan(-1);
    const chuKy = migration.slice(dau, migration.indexOf(')', dau) + 1);
    // Không có tổ chức thì dòng sổ không lọc ra được ở màn hình nào — đó là lý
    // do tham số này đứng trước, thay cho một UUID toàn số 0.
    expect(chuKy.indexOf('p_organization_id uuid')).toBeLessThan(
      chuKy.indexOf('p_capability_key'),
    );
    expect(chuKy).not.toMatch(/00000000-0000-0000-0000-000000000000/);
    const body = functionBody(
      migration,
      'public\\.set_copilot_writer_capability_v1',
    );
    expect(body).toMatch(/is_super_admin\(\)/);
    expect(body).toMatch(/capability_reason_required/);
    expect(body).toMatch(/capability_not_found[\s\S]{0,120}ERRCODE = 'P0002'/);
    expect(body).toMatch(
      /enabled_at = CASE WHEN p_enabled THEN clock_timestamp\(\) ELSE c\.enabled_at END/,
    );
    expect(body).toMatch(
      /copilot_ledger_append_v1[\s\S]{0,200}'capability_changed'/,
    );
  });

  it('mọi hàm SECURITY DEFINER đều ghim search_path', () => {
    const dinhNghia = [
      ...migration.matchAll(
        /CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z0-9_]+)\s*\(/gi,
      ),
    ].map((m) => m[1]);
    expect(dinhNghia.length).toBeGreaterThanOrEqual(9);
    for (const ten of dinhNghia) {
      const body = functionBody(migration, ten.replace('.', '\\.'));
      expect(body, `${ten} không phải SECURITY DEFINER`).toMatch(
        /SECURITY DEFINER/,
      );
      expect(body, `${ten} thiếu SET search_path`).toMatch(
        /SET search_path = pg_catalog, public, app_private/,
      );
    }
  });

  it('sổ hành động có index đọc và đường ghi duy nhất', () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_copilot_action_ledger_org_time[\s\S]{0,160}\(organization_id, created_at DESC\)/,
    );
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_copilot_action_ledger_plan_step[\s\S]{0,160}\(plan_id, step_no\)/,
    );
    const doc = functionBody(
      migration,
      'public\\.copilot_action_ledger_list_v1',
    );
    // Ba digest là bằng chứng nội bộ; đưa hex 64 ký tự ra trình duyệt chỉ mời
    // người ta thử đoán ngược payload.
    expect(doc).toMatch(
      /- 'payload_digest' - 'before_digest' - 'after_digest'/,
    );
    expect(doc).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 200\)/);
    expect(doc).toMatch(/v_super OR l\.user_id = v_actor/);
    expect(doc).toMatch(/ORDER BY l\.created_at DESC/);
  });

  it('khối nghiệm thu chỉ soi catalog nên chạy được trên database rỗng', () => {
    const dau = migration.indexOf('DO $nghiem_thu$');
    expect(dau).toBeGreaterThan(-1);
    const khoi = migration.slice(dau, migration.indexOf('COMMIT;', dau));
    expect(khoi).toMatch(/pg_tables/);
    expect(khoi).toMatch(/pg_constraint/);
    expect(khoi).toMatch(/pg_trigger/);
    expect(khoi).toMatch(/to_regprocedure/);
    // Restore Drill replay lane này lên baseline schema-only: không có tổ chức,
    // không có người dùng. Một phép thử ghi thật ở đây sẽ cuộn cả file.
    expect(khoi).not.toMatch(/INSERT INTO public\.(?!copilot_feature_flags)/);
    expect(khoi).not.toMatch(/FROM public\.organizations/);
    expect(khoi).not.toMatch(/auth\.users/);
  });
});
