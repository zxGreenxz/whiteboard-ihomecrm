import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

// G3-T1 dựng khung "kế hoạch thực thi + đồng ý theo lô" bằng MỘT migration. Test
// này ghim những mệnh đề mà bốn task sau (planClient, planTools, KeHoachCard,
// E2E) và cả Mức 3 (step-up PIN, uỷ quyền đứng, action L5) tựa vào — biến mất
// một trong chúng thì hoặc một hàng rào bảo mật đã rơi, hoặc một giai đoạn sau
// phải sửa lược đồ, đúng thứ file migration sinh ra để tránh.
//
// MỌI assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN. Soi văn bản thô là một
// lớp xanh-giả có thật trong repo này: đặt `-- ` trước một hàng rào thì Postgres
// ngừng đọc nó trong khi mọi `expect` vẫn khớp. Bài kiểm đột biến ở cuối file
// chứng minh cửa đó đã đóng.
//
// Đây vẫn là test ĐỌC FILE, nên nó chỉ trả lời "văn bản có còn nói điều đó
// không". Hành vi thật (khối con có cuốn ngược không, CHECK có từ chối hàng sai
// không) do khối nghiệm thu trong chính migration, hai lượt dry-run trên
// production, và E2E T7 đo.
const migrationPath = 'supabase/migrations/20260903100253_copilot_execution_plan_v1.sql';

/** Văn bản thô — CHỈ dùng cho bài kiểm đột biến ở cuối file. */
const tho = docSql(migrationPath);
const migration = boCommentSql(tho);

/**
 * Thân chính xác của một hàm: `thanHam` cắt tới khai báo kế tiếp hoặc tới khối
 * ACL, rồi ta cắt thêm ở dấu đóng dollar-quote để một `expect(...).not.toMatch`
 * không vô tình đọc sang hàm sau.
 */
function than(ten: string, schema = 'public'): string {
  const rong = thanHam(migration, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

const RPC_PUBLIC = [
  'copilot_plan_create_v1',
  'copilot_plan_approve_v1',
  'copilot_plan_execute_step_v1',
  'copilot_plan_get_v1',
  'copilot_plan_cancel_v1',
  'copilot_plan_reconcile_step_v1',
] as const;

const HELPER_RIENG = [
  ['copilot_action_flag_allows_v1', 'text, uuid'],
  ['copilot_plan_registry_revision_v1', ''],
  ['copilot_plan_summary_v1', 'uuid'],
  ['copilot_plan_submit_voucher_v1', 'uuid, uuid, uuid, int'],
] as const;

describe('G3-T1 — khung migration', () => {
  it('tồn tại và là một cặp BEGIN/COMMIT duy nhất', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });

  it('chạy lại được lượt hai: bảng IF NOT EXISTS, ràng buộc DO-guard, index IF NOT EXISTS', () => {
    for (const t of ['copilot_plans', 'copilot_plan_steps']) {
      expect(migration).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS app_private\\.${t}\\b`, 'i'),
      );
    }
    for (const c of ['copilot_plans_client_request_unique', 'copilot_plans_client_request_shape']) {
      expect(migration).toMatch(
        new RegExp(`conname = '${c}'[\\s\\S]{0,400}ADD CONSTRAINT ${c}`),
      );
    }
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_copilot_plans_user_status/);
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_copilot_plans_org_time/);
  });

  // Ba CHECK này là hợp đồng trạng thái. `UNKNOWN_EFFECT` đặc biệt đáng ghim: nó
  // là chỗ đậu của các action có hiệu ứng NGOÀI database (G5-C) và là lý do
  // `copilot_plan_reconcile_step_v1` tồn tại. Rơi giá trị đó khỏi CHECK là buộc
  // Mức 3 phải sửa lược đồ.
  it('ghim đủ ba CHECK enum: trạng thái kế hoạch, kiểu đồng ý, trạng thái bước', () => {
    expect(migration).toMatch(
      /status IN \('DRAFT', 'APPROVED', 'DONE', 'FAILED', 'CANCELLED', 'EXPIRED'\)/,
    );
    expect(migration).toMatch(
      /consent_kind IN \('click', 'step_up', 'standing_grant'\)/,
    );
    expect(migration).toMatch(
      /status IN \('PENDING', 'DONE', 'FAILED', 'BLOCKED', 'SKIPPED', 'UNKNOWN_EFFECT'\)/,
    );
    expect(migration).toMatch(/step_count BETWEEN 1 AND 8/);
  });

  // ĐIỂM NỐI #3/#4 — G5 điền hai cột này. Có sẵn từ hôm nay chính là lý do Mức 3
  // không phải đổi lược đồ giữa một đợt canary.
  it('giữ chỗ sẵn cho step-up PIN và uỷ quyền đứng', () => {
    expect(migration).toMatch(/step_up_confirmation_id\s+uuid REFERENCES/);
    expect(migration).toMatch(/standing_grant_ids\s+uuid\[\] NOT NULL DEFAULT '\{\}'::uuid\[\]/);
  });

  it('KHÔNG gieo hàng registry và KHÔNG chạm trạng thái cờ rollout', () => {
    expect(migration).not.toMatch(/INSERT INTO app_private\.copilot_action_registry/i);
    expect(migration).not.toMatch(/INSERT INTO public\.copilot_feature_flags/i);
    expect(migration).not.toMatch(/UPDATE public\.copilot_feature_flags/i);
    expect(migration).not.toMatch(/app\.copilot_feature_flag_transition/);
    // Cặp writer thu/chi đang chạy trên production nằm ngoài phạm vi G3-T1.
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.copilot_(preview|execute)_income_expense/i,
    );
    expect(migration).not.toMatch(/ALTER TABLE\s+public\.ai_write_audit/i);
  });
});

describe('G3-T1 — sáu chữ ký RPC public là hợp đồng', () => {
  it('đúng tên, đúng thứ tự tham số, đúng kiểu', () => {
    expect(chuKyHam(migration, 'copilot_plan_create_v1')).toBe(
      'p_organization_id uuid, p_client_request_id text, p_steps jsonb',
    );
    expect(chuKyHam(migration, 'copilot_plan_execute_step_v1')).toBe(
      'p_plan_id uuid, p_step_no int, p_expected_plan_version int, p_organization_id uuid',
    );
    expect(chuKyHam(migration, 'copilot_plan_get_v1')).toBe('p_plan_id uuid');
    expect(chuKyHam(migration, 'copilot_plan_cancel_v1')).toBe(
      'p_plan_id uuid, p_expected_plan_version int, p_reason text',
    );
    expect(chuKyHam(migration, 'copilot_plan_reconcile_step_v1')).toBe(
      'p_plan_id uuid, p_step_no int, p_expected_plan_version int',
    );
  });

  // `p_step_up_token` phải có DEFAULT NULL TỪ HÔM NAY: G5-A chỉ được thay THÂN
  // hàm, không được thêm tham số — thêm tham số nghĩa là đổi overload, và
  // PostgREST sẽ chọn nhầm (án lệ "them-tham-so-rpc-phai-drop-create").
  it('copilot_plan_approve_v1 mang sẵn p_step_up_token text DEFAULT NULL ở cuối', () => {
    expect(chuKyHam(migration, 'copilot_plan_approve_v1')).toBe(
      'p_plan_id uuid, p_consent_nonce text, p_plan_digest text, ' +
        'p_expected_plan_version int, p_step_up_token text default null',
    );
  });

  it('cả sáu đều VOLATILE/STABLE + SECURITY DEFINER + SET search_path', () => {
    for (const ten of RPC_PUBLIC) {
      const t = than(ten);
      expect(t, ten).not.toBe('');
      expect(t, ten).toMatch(/SECURITY DEFINER/);
      expect(t, ten).toMatch(/SET search_path = pg_catalog, public, app_private/);
    }
    // Hàm đọc phải STABLE và KHÔNG được khoá dòng: một hàm STABLE có `FOR UPDATE`
    // chết 25006 ngay lần gọi đầu.
    expect(than('copilot_plan_get_v1')).toMatch(/\bSTABLE\b/);
    expect(than('copilot_plan_get_v1')).not.toMatch(/FOR UPDATE/);
    for (const ten of ['copilot_plan_create_v1', 'copilot_plan_approve_v1',
      'copilot_plan_execute_step_v1', 'copilot_plan_cancel_v1']) {
      expect(than(ten), ten).toMatch(/\bVOLATILE\b/);
    }
  });
});

describe('G3-T1 — ACL tường minh từng chữ ký', () => {
  it('sáu RPC public: REVOKE PUBLIC/anon/service_role, GRANT authenticated', () => {
    for (const ten of RPC_PUBLIC) {
      expect(migration, ten).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${ten}\\([^)]*\\) FROM PUBLIC`),
      );
      expect(migration, ten).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${ten}\\([^)]*\\) FROM anon`),
      );
      expect(migration, ten).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${ten}\\([^)]*\\) FROM service_role`),
      );
      expect(migration, ten).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${ten}\\([^)]*\\) TO authenticated`),
      );
    }
  });

  // Helper KHÔNG được cấp cho ai. `copilot_plan_submit_voucher_v1` là đường nộp
  // hồ sơ vào engine duyệt; để `authenticated` gọi thẳng là bỏ qua toàn bộ máy
  // trạng thái kế hoạch.
  it('bốn helper app_private: REVOKE hết, KHÔNG có GRANT nào', () => {
    for (const [ten] of HELPER_RIENG) {
      expect(migration, ten).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION app_private\\.${ten}\\([^)]*\\) FROM PUBLIC`),
      );
      expect(migration, ten).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION app_private\\.${ten}\\([^)]*\\) FROM authenticated`),
      );
      expect(migration, ten).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION app_private\\.${ten}\\(`),
      );
    }
  });

  it('hai bảng kế hoạch bị thu hồi khỏi PUBLIC/anon/authenticated/service_role', () => {
    for (const t of ['copilot_plans', 'copilot_plan_steps']) {
      for (const vai of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
        expect(migration, `${t}/${vai}`).toMatch(
          new RegExp(`REVOKE ALL ON app_private\\.${t} FROM ${vai}`),
        );
      }
    }
    expect(migration).not.toMatch(/GRANT [A-Z, ]*ON app_private\.copilot_plan/);
  });

  // Mọi REVOKE với vai không chắc tồn tại phải đi qua to_regrole: bản khôi phục
  // schema-only không có `service_role`, và một REVOKE trần sẽ ném ngay giữa file.
  it('REVOKE vai tuỳ chọn luôn nằm trong guard to_regrole', () => {
    expect(migration).toMatch(/IF to_regrole\('service_role'\) IS NOT NULL THEN/);
    expect(migration).toMatch(/IF to_regrole\('anon'\) IS NOT NULL THEN/);
  });
});

describe('G3-T1 — lập kế hoạch: cửa, chống lặp, nonce mồ côi', () => {
  const t = than('copilot_plan_create_v1');

  it('thứ tự cửa: danh tính → vai → cờ kế hoạch → tổ chức → hình khoá → chống lặp → hạn mức', () => {
    const i = (s: string) => t.indexOf(s);
    expect(i('unauthenticated')).toBeGreaterThan(-1);
    expect(i('unauthenticated')).toBeLessThan(i('copilot_plan_role_allowed_v1'));
    expect(i('copilot_plan_role_allowed_v1')).toBeLessThan(i('copilot_action_flag_allows_v1'));
    expect(i('copilot_action_flag_allows_v1')).toBeLessThan(i('client_request_id_invalid'));
    expect(i('client_request_id_invalid')).toBeLessThan(i('plan_limit'));
    // Lời gọi xem trước (đắt nhất, và là thứ duy nhất chạm dữ liệu nghiệp vụ)
    // đứng SAU mọi cửa rẻ.
    expect(i('plan_limit')).toBeLessThan(i('v_reg.preview_rpc'));
  });

  it('hỏi cổng hành động cho TỪNG bước trước khi xem trước', () => {
    const iGate = t.indexOf('copilot_action_gate_v1');
    const iPreview = t.indexOf('v_reg.preview_rpc');
    expect(iGate).toBeGreaterThan(-1);
    expect(iGate).toBeLessThan(iPreview);
  });

  it('trần rủi ro theo policy, miễn trừ đúng một executor_kind', () => {
    expect(t).toMatch(/plan_risk_not_allowed/);
    expect(t).toMatch(/v_reg\.executor_kind <> 'maker_submit_v1'/);
    expect(t).toMatch(/max_direct_risk/);
  });

  // NONCE MỒ CÔI. Lời gọi xem trước sinh ra một hàng xác nhận còn hạn 5 phút cho
  // một thao tác chưa ai đồng ý. Không xoá là để tới 8 chiếc chìa khoá ghi tiền
  // nằm chờ cho một kế hoạch có thể không bao giờ được duyệt.
  it('xoá NGAY hàng xác nhận mà preview vừa sinh, theo digest của chính nonce đó', () => {
    expect(t).toMatch(
      /DELETE FROM app_private\.copilot_write_confirmations\s+WHERE nonce_digest = extensions\.digest\(decode\(v_nonce_hex, 'hex'\), 'sha256'\)/,
    );
    const iDelete = t.indexOf('DELETE FROM app_private.copilot_write_confirmations');
    const iInsertPlan = t.indexOf('INSERT INTO app_private.copilot_plans');
    expect(iDelete).toBeGreaterThan(-1);
    expect(iDelete).toBeLessThan(iInsertPlan);
  });

  it('phát đúng MỘT nonce cấp kế hoạch, tool `lap_ke_hoach`, hạn 5 phút', () => {
    expect(t).toMatch(/extensions\.gen_random_bytes\(32\)/);
    expect((t.match(/gen_random_bytes/g) ?? []).length).toBe(1);
    expect(t).toMatch(/'lap_ke_hoach', v_plan_digest, 'copilot\.execution_plan'/);
    expect(t).toMatch(/interval '5 minutes'/);
    expect(t).toMatch(/'consent_nonce', encode\(v_nonce, 'hex'\)/);
  });

  it('gửi lại cùng client_request_id trả kế hoạch cũ và KHÔNG trả nonce lại', () => {
    expect((t.match(/'consent_nonce', NULL/g) ?? []).length).toBe(2);
    expect(t).toMatch(/EXCEPTION WHEN unique_violation THEN/);
  });

  it('plan_digest băm đúng bốn trường theo brief', () => {
    expect(t).toMatch(
      /copilot_payload_hash_v1\(jsonb_build_object\(\s*'organization_id',[\s\S]{0,200}'actor',[\s\S]{0,200}'registry_revision',[\s\S]{0,200}'steps',/,
    );
    expect(t).toMatch(/'n', v_i \+ 1,\s*'a', v_reg\.action_id,\s*'v', v_reg\.version,\s*'d', encode\(v_digest, 'hex'\)/);
  });

  it('giới hạn 1..8 bước và 3 kế hoạch mở', () => {
    expect(t).toMatch(/v_n < 1 OR v_n > 8/);
    expect(t).toMatch(/plan_step_count/);
    expect(t).toMatch(/v_dem >= 3/);
  });

  it('ghi sổ plan_created', () => {
    expect(t).toMatch(/'event',\s*'plan_created'/);
  });
});

describe('G3-T1 — duyệt kế hoạch', () => {
  const t = than('copilot_plan_approve_v1');

  it('nonce phải đúng hình hex64 TRƯỚC khi chạm bảng nonce', () => {
    const iRegex = t.indexOf("'^[0-9a-fA-F]{64}$'");
    const iBang = t.indexOf('FROM app_private.copilot_write_confirmations');
    expect(iRegex).toBeGreaterThan(-1);
    expect(iRegex).toBeLessThan(iBang);
  });

  it('khoá hàng nonce FOR UPDATE và kiểm đủ năm vế của hợp đồng xác nhận', () => {
    expect(t).toMatch(/FROM app_private\.copilot_write_confirmations c[\s\S]{0,200}FOR UPDATE/);
    expect(t).toMatch(/confirmation_not_found/);
    expect(t).toMatch(/v_conf\.tool IS DISTINCT FROM 'lap_ke_hoach'/);
    expect(t).toMatch(/confirmation_contract_mismatch/);
    expect(t).toMatch(/confirmation_already_used/);
    expect(t).toMatch(/confirmation_expired/);
  });

  it('khoá kế hoạch NOWAIT và dịch 55P03 thành plan_busy', () => {
    expect(t).toMatch(/FOR UPDATE NOWAIT/);
    expect(t).toMatch(
      /EXCEPTION WHEN lock_not_available THEN[\s\S]{0,300}RAISE EXCEPTION 'plan_busy' USING ERRCODE = '55P03'/,
    );
  });

  it('đối chiếu plan_digest ba vế và CAS phiên bản với 40001', () => {
    expect(t).toMatch(/v_plan\.plan_digest IS DISTINCT FROM decode\(p_plan_digest, 'hex'\)/);
    expect(t).toMatch(/v_conf\.payload_hash IS DISTINCT FROM v_plan\.plan_digest/);
    expect(t).toMatch(/plan_digest_mismatch/);
    expect(t).toMatch(/plan_version_stale[\s\S]{0,200}ERRCODE = '40001'/);
  });

  // ĐIỂM NỐI #3. Nhận một token rồi lặng lẽ bỏ qua là điều nguy hiểm: giao diện
  // sẽ tin rằng đã có bước xác thực thứ hai.
  it('step-up: thiếu token cho kế hoạch L5 → 42501; có token → 0A000', () => {
    expect(t).toMatch(
      /v_plan\.max_risk = 'L5' AND v_max_direct = 'L5' AND p_step_up_token IS NULL THEN\s*RAISE EXCEPTION 'step_up_required' USING ERRCODE = '42501'/,
    );
    expect(t).toMatch(
      /p_step_up_token IS NOT NULL THEN\s*RAISE EXCEPTION 'step_up_not_implemented' USING ERRCODE = '0A000'/,
    );
  });

  // Kill switch giữa lúc lập và lúc bấm là chuyện thật — đó chính là ý nghĩa của
  // nó. Ở đây chưa có gì để ghi lại nên NÉM là câu trả lời đúng.
  it('hỏi lại công tắc kế hoạch trước khi kiểm bước', () => {
    const iCo = t.indexOf('copilot_action_flag_allows_v1');
    expect(iCo).toBeGreaterThan(-1);
    expect(t).toMatch(/copilot_feature_disabled/);
    expect(iCo).toBeLessThan(t.indexOf('FROM app_private.copilot_plan_steps'));
  });

  it('kiểm lại TOÀN BỘ bước trước khi mở cổng, và bước hỏng vẫn tiêu nonce', () => {
    const iLoop = t.indexOf('FROM app_private.copilot_plan_steps');
    const iGate = t.indexOf('copilot_action_gate_v1');
    const iCas = t.indexOf("SET consumed_at = clock_timestamp()");
    expect(iLoop).toBeGreaterThan(-1);
    expect(iGate).toBeGreaterThan(iLoop);
    expect(t).toMatch(/registry_changed/);
    expect(t).toMatch(/step_not_permitted/);
    // Nhánh hỏng tiêu nonce TRƯỚC khi đánh FAILED — để nonce sống tiếp là mở
    // đường thử lại tới khi lọt.
    expect(iCas).toBeGreaterThan(-1);
    expect(t).toMatch(/'event',\s*'step_blocked'/);
    expect(t).toMatch(/SET status = 'FAILED'/);
  });

  it('thành công: CAS tiêu nonce, APPROVED, hạn thực thi 30 phút, sổ plan_approved', () => {
    expect(t).toMatch(
      /SET consumed_at = clock_timestamp\(\)\s*WHERE id = v_conf\.id AND consumed_at IS NULL/,
    );
    expect(t).toMatch(/interval '30 minutes'/);
    expect(t).toMatch(/SET status = 'APPROVED'/);
    expect(t).toMatch(/consent_kind = 'click'/);
    expect(t).toMatch(/'event',\s*'plan_approved'/);
  });
});

describe('G3-T1 — thực thi một bước', () => {
  const t = than('copilot_plan_execute_step_v1');

  // Thứ tự này LÀ thiết kế: danh tính → khoá kế hoạch → cờ kế hoạch → cổng hành
  // động → xem trước lại → so digest → EXECUTE → đọc lại. Đảo bất kỳ cặp nào là
  // ghi trước khi kiểm.
  it('thứ tự: authz → NOWAIT → cờ → cổng → preview → execute → readback', () => {
    const i = (s: string) => t.indexOf(s);
    expect(i('unauthenticated')).toBeLessThan(i('FOR UPDATE NOWAIT'));
    expect(i('FOR UPDATE NOWAIT')).toBeLessThan(i('copilot_action_flag_allows_v1'));
    expect(i('copilot_action_flag_allows_v1')).toBeLessThan(i('copilot_action_gate_v1'));
    expect(i('copilot_action_gate_v1')).toBeLessThan(i('v_reg.preview_rpc'));
    expect(i('v_reg.preview_rpc')).toBeLessThan(i('v_reg.execute_rpc'));
    expect(i('v_reg.execute_rpc')).toBeLessThan(i('to_jsonb(t) FROM public.%I'));
  });

  it('ghi sổ TRƯỚC khi chốt trạng thái kế hoạch', () => {
    expect(t.indexOf("'step_done'")).toBeLessThan(t.indexOf('SET status = v_plan_status'));
  });

  it('tổ chức đi vào như tham số riêng và phải khớp kế hoạch', () => {
    expect(t).toMatch(
      /v_plan\.organization_id IS DISTINCT FROM p_organization_id THEN\s*RAISE EXCEPTION 'organization_mismatch'/,
    );
  });

  it('ép bước tuyến tính: PENDING nhỏ nhất và mọi bước trước đã DONE', () => {
    expect(t).toMatch(/SELECT min\(step_no\) INTO v_next/);
    expect(t).toMatch(/p_step_no IS DISTINCT FROM v_next THEN\s*RAISE EXCEPTION 'step_order/);
    expect(t).toMatch(/step_no < p_step_no AND status <> 'DONE'/);
  });

  it('tiền kiểm registry còn khớp ảnh chụp và digest lưu còn khớp canonical', () => {
    expect(t).toMatch(/v_reg\.version <> v_step\.action_version/);
    expect(t).toMatch(/registry_changed/);
    expect(t).toMatch(
      /copilot_payload_hash_v1\(v_step\.canonical\)\s*IS DISTINCT FROM v_step\.payload_digest/,
    );
    expect(t).toMatch(/payload_changed/);
  });

  it('xem trước LẠI rồi so digest trước khi gọi execute_rpc', () => {
    expect(t).toMatch(
      /copilot_payload_hash_v1\(v_canon_moi\)\s*IS DISTINCT FROM v_step\.payload_digest/,
    );
    const iSo = t.indexOf('IS DISTINCT FROM v_step.payload_digest');
    expect(iSo).toBeLessThan(t.indexOf('v_reg.execute_rpc'));
  });

  // Khối con là thứ làm hiệu ứng ghi cuốn ngược mà bằng chứng vẫn còn. Nếu dòng
  // sổ nằm TRONG khối con thì nó biến mất cùng lần hỏng — đúng lúc cần nó nhất.
  it('khối con bắt lỗi vào biến; sổ và trạng thái ghi ở giao dịch NGOÀI', () => {
    expect(t).toMatch(/EXCEPTION WHEN others THEN[\s\S]{0,400}GET STACKED DIAGNOSTICS/);
    expect(t).toMatch(/v_loi := split_part\(v_chi_tiet, ':', 1\)/);
    expect(t).toMatch(/v_su_kien := 'step_blocked'/);
    expect(t).toMatch(/v_su_kien := 'step_failed'/);
    // Đuôi chạy khi v_loi IS NULL / ELSE, tức NGOÀI mọi khối con.
    const iCuoiKhoiCon = t.lastIndexOf("v_su_kien := 'step_failed'");
    expect(t.indexOf('copilot_ledger_append_v1', iCuoiKhoiCon)).toBeGreaterThan(iCuoiKhoiCon);
  });

  it('đọc lại theo verify_kind, ba bất biến, đều P0001', () => {
    expect(t).toMatch(/CASE v_reg\.verify_kind/);
    expect(t).toMatch(/WHEN 'ie_draft' THEN/);
    expect(t).toMatch(/WHEN 'approval_request_pending' THEN/);
    expect(t).toMatch(/WHEN 'hold_pending_approval' THEN/);
    expect(t).toMatch(/copilot_draft_invariant_violation' USING ERRCODE = 'P0001'/);
    expect(t).toMatch(/copilot_write_readback_mismatch' USING ERRCODE = 'P0001'/);
    expect(t).toMatch(/'UNAPPROVED'/);
    expect(t).toMatch(/'UNPOSTED'/);
  });

  it('bước hỏng: FAILED/BLOCKED, kế hoạch FAILED, mọi bước còn chờ BLOCKED, mỗi bước một dòng sổ', () => {
    expect(t).toMatch(/v_su_kien = 'step_blocked' THEN 'BLOCKED' ELSE 'FAILED'/);
    expect(t).toMatch(/SET status = 'BLOCKED', error_code = 'plan_failed'/);
    expect(t).toMatch(/FOREACH v_j IN ARRAY v_chan LOOP[\s\S]{0,600}'event',\s*'step_blocked'/);
    expect(t).toMatch(/SET status = 'FAILED'/);
  });

  it('chạy lại một bước đã ghi là DONE + idempotent, không phải lỗi', () => {
    expect(t).toMatch(/'da_thuc_hien_truoc_do', 'da_tao_truoc_do'/);
    expect(t).toMatch(/'idempotent',\s*v_idem/);
  });

  it('quá hạn: ghi EXPIRED + BLOCKED + sổ rồi TRẢ VỀ, không RAISE', () => {
    const iHan = t.indexOf('execute_deadline, v_plan.expires_at) <= clock_timestamp()');
    expect(iHan).toBeGreaterThan(-1);
    const khoi = t.slice(iHan, t.indexOf('IF p_expected_plan_version IS NULL'));
    expect(khoi).toMatch(/SET status = 'EXPIRED'/);
    expect(khoi).toMatch(/'event',\s*'plan_expired'/);
    expect(khoi).toMatch(/RETURN jsonb_build_object/);
    expect(khoi).not.toMatch(/RAISE EXCEPTION/);
  });
});

describe('G3-T1 — nộp hồ sơ duyệt (đường L5 của Mức 2)', () => {
  const t = than('copilot_plan_submit_voucher_v1', 'app_private');

  it('khoá phiếu, ép đúng chủ + đúng công ty + đúng trạng thái nháp', () => {
    expect(t).toMatch(/FROM public\.income_expenses[\s\S]{0,200}FOR UPDATE/);
    expect(t).toMatch(/v_ie\.organization_id IS DISTINCT FROM p_org/);
    expect(t).toMatch(/v_ie\.user_id IS DISTINCT FROM v_actor/);
    expect(t).toMatch(/approval_status IS DISTINCT FROM 'UNAPPROVED'/);
    expect(t).toMatch(/posting_status IS DISTINCT FROM 'UNPOSTED'/);
    expect(t).toMatch(/voucher_already_submitted/);
  });

  it('gọi submit_financial_voucher với khoá copilot_plan:<plan>:<step> và AI_COPILOT', () => {
    expect(t).toMatch(
      /public\.submit_financial_voucher\(\s*p_voucher,\s*'copilot_plan:' \|\| p_plan_id::text \|\| ':' \|\| p_step_no::text,\s*'AI_COPILOT',\s*NULL\s*\)/,
    );
  });

  // AI KHÔNG ĐƯỢC HẠCH TOÁN. Nếu bộ luật của tổ chức khớp AUTO_POST thì lời gọi
  // trên vừa gián tiếp ghi sổ cái — phải ném để khối con cuốn ngược sạch.
  it('POSTED do AUTO_POST → copilot_auto_post_forbidden; DENY → rule_denied', () => {
    expect(t).toMatch(
      /v_req\.state = 'POSTED' THEN\s*RAISE EXCEPTION 'copilot_auto_post_forbidden' USING ERRCODE = '42501'/,
    );
    expect(t).toMatch(
      /v_req\.state = 'DENIED' THEN\s*RAISE EXCEPTION 'rule_denied' USING ERRCODE = '42501'/,
    );
    expect(t).toMatch(/IS DISTINCT FROM 'PENDING_APPROVAL'/);
  });

  it('đọc lại approval_requests từ BẢNG, ép maker = chính người thao tác', () => {
    expect(t).toMatch(/FROM public\.approval_requests a WHERE a\.id = v_id/);
    expect(t).toMatch(/v_req\.maker_user_id IS DISTINCT FROM v_actor/);
  });

  it('không có đường duyệt nào trong thân: chỉ nộp', () => {
    expect(t).not.toMatch(/decide_financial/);
    expect(t).not.toMatch(/_post_financial/);
    expect(t).not.toMatch(/approve_income_expense/);
  });
});

describe('G3-T1 — đọc, huỷ, đối soát', () => {
  it('copilot_plan_get_v1 không trả nonce/canonical/payload/digest thô', () => {
    const t = than('copilot_plan_get_v1');
    expect(t).not.toMatch(/confirmation_nonce/);
    expect(t).not.toMatch(/nonce_digest/);
    expect(t).toMatch(/- 'payload_digest' - 'before_digest' - 'after_digest'/);
    expect(t).toMatch(/LIMIT 20/);
    expect(t).toMatch(/public\.is_super_admin\(\)/);
    // Bản lược bỏ nằm ở MỘT chỗ: `copilot_plan_summary_v1`.
    expect(t).toMatch(/app_private\.copilot_plan_summary_v1\(p_plan_id\)/);
    const s = than('copilot_plan_summary_v1', 'app_private');
    expect(s).not.toMatch(/s\.canonical/);
    expect(s).not.toMatch(/s\.payload\b/);
    expect(s).not.toMatch(/s\.payload_digest/);
    expect(s).toMatch(/encode\(p\.plan_digest, 'hex'\)/);
  });

  it('copilot_plan_cancel_v1: SKIPPED, tiêu consent, sổ plan_cancelled', () => {
    const t = than('copilot_plan_cancel_v1');
    expect(t).toMatch(/status NOT IN \('DRAFT', 'APPROVED'\)/);
    expect(t).toMatch(/SET status = 'SKIPPED'/);
    expect(t).toMatch(
      /SET consumed_at = clock_timestamp\(\)[\s\S]{0,300}payload_hash = v_plan\.plan_digest[\s\S]{0,120}consumed_at IS NULL/,
    );
    expect(t).toMatch(/'event',\s*'plan_cancelled'/);
    expect(t).toMatch(/FOR UPDATE NOWAIT/);
    expect(t).toMatch(/plan_version_stale/);
  });

  // ĐIỂM NỐI #6. Trả một kết quả rỗng thì client sẽ tưởng đã đối soát xong.
  it('copilot_plan_reconcile_step_v1 chỉ RAISE not_implemented 0A000', () => {
    const t = than('copilot_plan_reconcile_step_v1');
    expect(t).toMatch(/RAISE EXCEPTION 'not_implemented[\s\S]{0,120}ERRCODE = '0A000'/);
    expect(t).not.toMatch(/INSERT INTO/);
    expect(t).not.toMatch(/UPDATE /);
  });
});

describe('G3-T1 — SQL động chỉ nhận tên từ registry', () => {
  /** Mọi dòng có `format(` trong bản đã lột bình luận. */
  const dongFormat = migration
    .split('\n')
    .filter((d) => d.includes('format('));

  it('có đúng bốn lời gọi format: xem trước x2, thực thi, đọc lại', () => {
    expect(dongFormat.length).toBe(4);
    expect(dongFormat.filter((d) => d.includes('v_reg.preview_rpc')).length).toBe(2);
    expect(dongFormat.filter((d) => d.includes('v_reg.execute_rpc')).length).toBe(1);
  });

  // ĐÂY LÀ BÀI KIỂM QUAN TRỌNG NHẤT CỦA FILE. Một tham số của người gọi lọt vào
  // `format()` là biến toàn bộ kiến trúc registry thành trang trí.
  it('KHÔNG dòng format nào chứa một tham số p_ của người gọi', () => {
    for (const d of dongFormat) {
      expect(d, d.trim()).not.toMatch(/\bp_[a-z_]+/);
    }
  });

  it('mảnh định danh luôn đi qua %I và tham số luôn đi qua $1/$2', () => {
    for (const d of dongFormat) {
      expect(d, d.trim()).toMatch(/%I/);
      expect(d, d.trim()).not.toMatch(/%s/);
    }
    expect(migration).toMatch(/format\('SELECT public\.%I\(\$1, \$2\)', v_reg\.preview_rpc\)/);
    expect(migration).toMatch(/format\('SELECT public\.%I\(\$1, \$2\)', v_reg\.execute_rpc\)/);
    // Tên bảng đọc lại đến từ kết quả RPC/registry và vẫn bị ràng buộc hình dạng.
    expect(migration).toMatch(/v_bang !~ '\^\[a-z_\]\[a-z0-9_\]\*\$'/);
  });

  // Không đường ghi nào được gọi THẲNG theo tên. Mọi thứ ghi phải đi qua registry
  // (đã có CHECK L5/L6 theo hàng) hoặc qua đúng một helper đã review.
  it('không gọi thẳng bất kỳ RPC duyệt/hạch toán/xoá nào', () => {
    const CHO_PHEP = new Set([
      // của chính file này
      'copilot_plan_create_v1', 'copilot_plan_approve_v1', 'copilot_plan_execute_step_v1',
      'copilot_plan_get_v1', 'copilot_plan_cancel_v1', 'copilot_plan_reconcile_step_v1',
      'copilot_action_flag_allows_v1', 'copilot_plan_registry_revision_v1',
      'copilot_plan_summary_v1', 'copilot_plan_submit_voucher_v1',
      // nền đã có
      'copilot_payload_hash_v1', 'copilot_action_gate_v1', 'copilot_ledger_append_v1',
      'copilot_plan_role_allowed_v1', 'is_super_admin', 'submit_financial_voucher',
      // bảng xuất hiện dưới dạng `<schema>.<bảng> (` trong INSERT
      'copilot_plans', 'copilot_plan_steps', 'copilot_write_confirmations',
      'organizations', 'income_expenses', 'approval_requests', 'copilot_feature_flags',
      'copilot_action_registry', 'copilot_action_policy', 'copilot_action_ledger',
    ]);
    const goi = new Set(
      [...migration.matchAll(/\b(?:public|app_private)\.([a-z0-9_]+)\s*\(/g)].map((m) => m[1]),
    );
    const la = [...goi].filter((x) => !CHO_PHEP.has(x));
    expect(la, `ten la trong migration: ${la.join(', ')}`).toEqual([]);
    for (const cam of ['decide_financial_voucher', 'decide_financial_request_v2',
      '_post_financial_voucher', 'approve_income_expense_v1', 'soft_delete']) {
      expect(migration, cam).not.toContain(cam);
    }
  });
});

describe('G3-T1 — khối nghiệm thu chỉ soi catalog', () => {
  const khoi = migration.slice(migration.lastIndexOf('DO $nghiem_thu$'));

  it('không đọc bảng nghiệp vụ nào (chạy được trên database rỗng)', () => {
    expect(khoi).toMatch(/to_regprocedure/);
    expect(khoi).toMatch(/has_function_privilege/);
    expect(khoi).toMatch(/has_table_privilege/);
    expect(khoi).not.toMatch(/FROM public\.organizations/);
    expect(khoi).not.toMatch(/FROM public\.income_expenses/);
    expect(khoi).not.toMatch(/INSERT INTO/);
    // Ngoại lệ DUY NHẤT là hàng cờ — chính là thứ file này KHÔNG được tự gieo,
    // nên nó phải kiểm rằng 20260903043956 đã gieo.
    expect(khoi).toMatch(/FROM public\.copilot_feature_flags/);
  });

  it('ghim đủ sáu chữ ký RPC và bốn helper', () => {
    for (const ten of RPC_PUBLIC) {
      expect(khoi, ten).toContain(`public.${ten}(`);
    }
    for (const [ten] of HELPER_RIENG) {
      expect(khoi, ten).toContain(`app_private.${ten}(`);
    }
  });

  it('khẳng định authenticated KHÔNG gọi được helper và KHÔNG đọc được bảng', () => {
    expect(khoi).toMatch(/authenticated goi duoc helper G3/);
    expect(khoi).toMatch(/authenticated doc duoc bang ke hoach/);
    expect(khoi).toMatch(/anon goi duoc ham G3/);
  });
});

// ---------------------------------------------------------------------------
// Bài kiểm đột biến — chứng minh các pin ở trên KHÔNG phải màu xanh rỗng.
// Không sửa file trên đĩa: đột biến chỉ tồn tại trong bộ nhớ của chính test này.
// ---------------------------------------------------------------------------
describe('G3-T1 — pin phải đỏ khi hàng rào bị bình luận hoá', () => {
  const MOC = 'DELETE FROM app_private.copilot_write_confirmations';
  const PIN = /DELETE FROM app_private\.copilot_write_confirmations/;

  /** Đặt `-- ` trước dòng mốc và 1 dòng vị ngữ ngay sau nó. */
  function binhLuanHoaXoaNonceMoCoi(sql: string): string {
    const dong = sql.split('\n');
    const i = dong.findIndex((d) => d.includes(MOC));
    expect(i, 'không tìm thấy khối xoá nonce mồ côi để đột biến').toBeGreaterThan(-1);
    for (let j = i; j < i + 2 && j < dong.length; j += 1) {
      dong[j] = `-- ${dong[j]}`;
    }
    return dong.join('\n');
  }

  it('văn bản THÔ vẫn khớp pin sau khi bị bình luận hoá — đó chính là cái lỗ', () => {
    expect(binhLuanHoaXoaNonceMoCoi(tho)).toMatch(PIN);
  });

  it('bản đã lột bình luận thì KHÔNG khớp nữa — cửa đã đóng', () => {
    const dotBien = boCommentSql(binhLuanHoaXoaNonceMoCoi(tho));
    expect(dotBien).not.toMatch(PIN);
    // Bản không đột biến vẫn khớp, để bài kiểm này không xanh vì lý do sai.
    expect(migration).toMatch(PIN);
  });

  it('bình luận hoá lời gọi cổng làm thứ tự trong execute_step sụp', () => {
    const dong = tho.split('\n');
    const i = dong.findIndex((d) => d.includes('v_snapshot := app_private.copilot_action_gate_v1'));
    expect(i).toBeGreaterThan(-1);
    dong[i] = `-- ${dong[i]}`;
    const than_dot = boCommentSql(
      thanHam(boCommentSql(dong.join('\n')), 'copilot_plan_execute_step_v1'),
    );
    const iGate = than_dot.indexOf('copilot_action_gate_v1');
    const iPreview = than_dot.indexOf('v_reg.preview_rpc');
    expect(iGate === -1 || iGate > iPreview).toBe(true);
  });
});
