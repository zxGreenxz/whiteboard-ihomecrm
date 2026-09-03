import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, docSqlKhongComment, thanHam } from './helpers/sqlTestUtils';

// G5-C2 (đợt 2) — bảy action `direct_l5_v1` mới:
//   Nhóm A (phân quyền, KHÔNG BAO GIỜ uỷ quyền đứng): member.update_authorization,
//   role.upsert, member.invite, member.set_status.
//   Nhóm B (hiệu ứng NGOÀI hệ, verify_kind='external_effect'): zalo.broadcast,
//   zalo.recall_message, network.execute_action.
//
// Khuôn direct_l5_v1 nền tảng (guard L5, Nonce ABI v1) đã ghim ở
// `copilotActionsL5Migration.test.ts` (G5-C, đợt 1) — file này CHỈ ghim những
// gì MỚI của đợt 2: cột `pin_always`, patch `copilot_plan_create_v1`, nhánh
// `external_effect`/`UNKNOWN_EFFECT` của `copilot_plan_execute_step_v1`, và
// thân THẬT của `copilot_plan_reconcile_step_v1` (trước là stub `not_implemented`).
//
// Mọi assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN, cùng khuôn với các
// test SQL khác trong thư mục này.

const FILE_MEMBER_CAP_QUYEN =
  'supabase/migrations/20260903212600_copilot_action_member_cap_quyen_v1.sql';
const FILE_ROLE_CAP_NHAT = 'supabase/migrations/20260903212603_copilot_action_role_cap_nhat_v1.sql';
const FILE_MEMBER_MOI = 'supabase/migrations/20260903212605_copilot_action_member_moi_v1.sql';
const FILE_MEMBER_TRANG_THAI =
  'supabase/migrations/20260903212607_copilot_action_member_trang_thai_v1.sql';
const FILE_ZALO_PHAT_SONG =
  'supabase/migrations/20260903212610_copilot_action_zalo_phat_song_v1.sql';
const FILE_ZALO_THU_HOI_TIN =
  'supabase/migrations/20260903212612_copilot_action_zalo_thu_hoi_tin_v1.sql';
const FILE_NETWORK_THUC_THI =
  'supabase/migrations/20260903212614_copilot_action_network_thuc_thi_v1.sql';

const TAT_CA_FILE = [
  FILE_MEMBER_CAP_QUYEN,
  FILE_ROLE_CAP_NHAT,
  FILE_MEMBER_MOI,
  FILE_MEMBER_TRANG_THAI,
  FILE_ZALO_PHAT_SONG,
  FILE_ZALO_THU_HOI_TIN,
  FILE_NETWORK_THUC_THI,
];

describe('G5-C2 — cả bảy file migration đều tồn tại', () => {
  it.each(TAT_CA_FILE)('%s', (file) => {
    expect(docSql(file).length, file).toBeGreaterThan(0);
  });
});

interface CaAction {
  ten: string;
  file: string;
  actionId: string;
  permissionKey: string;
  previewRpc: string;
  executeRpc: string;
  verifyKind: 'readback' | 'external_effect';
  grantable: false;
  pinAlways: boolean;
  rollbackRpc: string | null;
  /** `true` khi ledger `before_digest` được ghi bằng NULL TĨNH (hành động TẠO). */
  beforeDigestLuonNull: boolean;
  goiRpcGoc: RegExp;
}

const CAC_ACTION: readonly CaAction[] = [
  {
    ten: 'member.update_authorization',
    file: FILE_MEMBER_CAP_QUYEN,
    actionId: 'member.update_authorization',
    permissionKey: 'users.edit',
    previewRpc: 'copilot_preview_member_cap_quyen_v1',
    executeRpc: 'copilot_execute_member_cap_quyen_v1',
    verifyKind: 'readback',
    grantable: false,
    pinAlways: true,
    rollbackRpc: 'update_member_authorization_v1',
    beforeDigestLuonNull: false,
    goiRpcGoc: /public\.update_member_authorization_v1\(\s*v_membership, v_expected, v_role_bindings, v_overrides, v_reason\)/,
  },
  {
    ten: 'role.upsert',
    file: FILE_ROLE_CAP_NHAT,
    actionId: 'role.upsert',
    permissionKey: 'users.edit',
    previewRpc: 'copilot_preview_role_cap_nhat_v1',
    executeRpc: 'copilot_execute_role_cap_nhat_v1',
    verifyKind: 'readback',
    grantable: false,
    pinAlways: true,
    rollbackRpc: null,
    // Lưỡng tính: NULL ở nhánh TẠO, khác NULL ở nhánh SỬA — không phải NULL tĩnh.
    beforeDigestLuonNull: false,
    goiRpcGoc: /public\.upsert_organization_role_v1\(\s*v_role_id, v_name, v_permissions, v_expected, v_reason\)/,
  },
  {
    ten: 'member.invite',
    file: FILE_MEMBER_MOI,
    actionId: 'member.invite',
    permissionKey: 'users.create',
    previewRpc: 'copilot_preview_member_moi_v1',
    executeRpc: 'copilot_execute_member_moi_v1',
    verifyKind: 'readback',
    grantable: false,
    pinAlways: true,
    rollbackRpc: 'revoke_organization_invitation_v1',
    beforeDigestLuonNull: true,
    goiRpcGoc: /public\.invite_organization_member_v1\(\s*v_email, v_member_type, v_role_id, v_scope_ids, v_days\)/,
  },
  {
    ten: 'member.set_status',
    file: FILE_MEMBER_TRANG_THAI,
    actionId: 'member.set_status',
    permissionKey: 'users.edit',
    previewRpc: 'copilot_preview_member_trang_thai_v1',
    executeRpc: 'copilot_execute_member_trang_thai_v1',
    verifyKind: 'readback',
    grantable: false,
    pinAlways: true,
    rollbackRpc: 'set_membership_status_v1',
    beforeDigestLuonNull: false,
    goiRpcGoc: /public\.set_membership_status_v1\(v_user_id, v_status, v_reason\)/,
  },
  {
    ten: 'zalo.broadcast',
    file: FILE_ZALO_PHAT_SONG,
    actionId: 'zalo.broadcast',
    permissionKey: 'chat_zalo.send',
    previewRpc: 'copilot_preview_zalo_phat_song_v1',
    executeRpc: 'copilot_execute_zalo_phat_song_v1',
    verifyKind: 'external_effect',
    grantable: false,
    pinAlways: false,
    rollbackRpc: null,
    beforeDigestLuonNull: true,
    goiRpcGoc: /public\.zalo_broadcast\(ARRAY\[v_conv_id\], v_body\)/,
  },
  {
    ten: 'zalo.recall_message',
    file: FILE_ZALO_THU_HOI_TIN,
    actionId: 'zalo.recall_message',
    permissionKey: 'chat_zalo.send',
    previewRpc: 'copilot_preview_zalo_thu_hoi_tin_v1',
    executeRpc: 'copilot_execute_zalo_thu_hoi_tin_v1',
    verifyKind: 'external_effect',
    grantable: false,
    pinAlways: false,
    rollbackRpc: null,
    beforeDigestLuonNull: false,
    goiRpcGoc: /public\.zalo_recall_message\(v_msg_id\)/,
  },
  {
    ten: 'network.execute_action',
    file: FILE_NETWORK_THUC_THI,
    actionId: 'network.execute_action',
    permissionKey: 'network_center.execute',
    previewRpc: 'copilot_preview_network_thuc_thi_v1',
    executeRpc: 'copilot_execute_network_thuc_thi_v1',
    verifyKind: 'external_effect',
    grantable: false,
    pinAlways: false,
    rollbackRpc: 'network_center_retire_uncertain_command_v1',
    beforeDigestLuonNull: true,
    goiRpcGoc: /public\.network_center_execute_action_v1\(\s*v_device_id, v_action_type, v_reason, v_parameters, v_confirmation, v_request_id\)/,
  },
];

describe.each(CAC_ACTION)('$ten — cặp preview/execute + đăng ký', (ca) => {
  const sql = docSqlKhongComment(ca.file);

  it('preview/execute RPC tồn tại trong file', () => {
    expect(thanHam(sql, ca.previewRpc).length, ca.previewRpc).toBeGreaterThan(0);
    expect(thanHam(sql, ca.executeRpc).length, ca.executeRpc).toBeGreaterThan(0);
  });

  it('execute — GUARD L5 (l5_requires_plan) chạy TRƯỚC khi gọi RPC gốc', () => {
    const than = thanHam(sql, ca.executeRpc);
    const iGuard = than.search(/copilot_l5_plan_context_ok_v1/);
    const iGoc = than.search(ca.goiRpcGoc);
    expect(iGuard, `${ca.executeRpc}: thiếu lời gọi copilot_l5_plan_context_ok_v1`).toBeGreaterThan(-1);
    expect(iGoc, `${ca.executeRpc}: thiếu lời gọi RPC gốc "${ca.goiRpcGoc}"`).toBeGreaterThan(-1);
    expect(iGuard, `${ca.ten}: guard L5 phải đứng TRƯỚC lời gọi RPC gốc`).toBeLessThan(iGoc);
  });

  it('execute — RAISE l5_requires_plan đúng mã lỗi 42501', () => {
    const than = thanHam(sql, ca.executeRpc);
    expect(than).toMatch(/RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501'/);
  });

  it('execute — ABI Nonce v1: kiểm nonce dạng hex 64 ký tự trước khi tra bảng xác nhận', () => {
    const than = thanHam(sql, ca.executeRpc);
    const iForm = than.search(/p_confirmation_nonce !~ '\^\[0-9a-fA-F\]\{64\}\$'/);
    const iTra = than.search(/FROM app_private\.copilot_write_confirmations c/);
    expect(iForm).toBeGreaterThan(-1);
    expect(iTra).toBeGreaterThan(-1);
    expect(iForm).toBeLessThan(iTra);
  });

  it('execute — tool/permission_key của phiếu đồng ý phải khớp action này', () => {
    const than = thanHam(sql, ca.executeRpc);
    expect(than).toContain(`v_row.tool IS DISTINCT FROM '${ca.actionId}'`);
    expect(than).toContain(`v_row.permission_key IS DISTINCT FROM '${ca.permissionKey}'`);
  });

  it('execute — khoá advisory theo idempotency key riêng của action này', () => {
    const than = thanHam(sql, ca.executeRpc);
    expect(than).toContain(`'copilot_action:${ca.actionId}:'`);
    expect(than).toMatch(/PERFORM pg_advisory_xact_lock\(hashtextextended\(v_key, 0\)\);/);
  });

  it('execute — ghi ai_write_audit + copilot_ledger_append_v1 SAU khi gọi RPC gốc', () => {
    const than = thanHam(sql, ca.executeRpc);
    const iGoc = than.search(ca.goiRpcGoc);
    const iAudit = than.search(/INSERT INTO public\.ai_write_audit/);
    const iLedger = than.search(/action_executed/);
    expect(iGoc).toBeGreaterThan(-1);
    expect(iAudit).toBeGreaterThan(iGoc);
    expect(iLedger).toBeGreaterThan(iAudit);
  });

  it(ca.beforeDigestLuonNull
    ? 'execute — before_digest LUÔN NULL (hành động TẠO, không có "trước")'
    : 'execute — before_digest KHÔNG phải NULL tĩnh (đọc lại thực thể trước khi ghi)', () => {
    const than = thanHam(sql, ca.executeRpc);
    if (ca.beforeDigestLuonNull) {
      expect(than).toMatch(/'before_digest',\s*NULL,/);
    } else {
      expect(than).not.toMatch(/'before_digest',\s*NULL,/);
    }
  });

  it('registry — hàng seed đúng hình: risk L5, direct_l5_v1, step_up, grantable=false', () => {
    const insertStart = sql.search(new RegExp(`'${ca.actionId.replace('.', '\\.')}',\\s*\\n\\s*1,`));
    expect(insertStart, `${ca.actionId}: không tìm thấy khối INSERT registry`).toBeGreaterThan(-1);
    const doan = sql.slice(insertStart, insertStart + 900);
    expect(doan).toContain(`'${ca.permissionKey}'`);
    expect(doan).toContain("'L5'");
    expect(doan).toContain("'direct_l5_v1'");
    expect(doan).toContain("'step_up'");
    expect(doan).toContain(`'${ca.previewRpc}'`);
    expect(doan).toContain(`'${ca.executeRpc}'`);
    expect(doan).toContain(`'${ca.verifyKind}'`);
    if (ca.rollbackRpc) {
      expect(doan).toContain(`'${ca.rollbackRpc}'`);
    }
  });

  it('registry — nghiệm thu cuối file đòi grantable=false' + (ca.pinAlways ? ' + pin_always=true' : ''), () => {
    const iNghiem = sql.search(/DO \$nghiem_thu\$/);
    expect(iNghiem).toBeGreaterThan(-1);
    const than = sql.slice(iNghiem);
    expect(than).toContain('grantable = false');
    if (ca.pinAlways) {
      expect(than).toContain('pin_always = true');
    }
    if (ca.verifyKind === 'external_effect') {
      expect(than).toContain("verify_kind = 'external_effect'");
    }
  });

  it('cờ rollout — seed disabled cho đúng action_id này', () => {
    expect(sql).toMatch(
      new RegExp(`'action', '${ca.actionId.replace('.', '\\.')}', 'disabled',`),
    );
  });

  it('ACL — REVOKE ALL FROM PUBLIC rồi mới GRANT lại cho authenticated (cả preview lẫn execute)', () => {
    for (const rpc of [ca.previewRpc, ca.executeRpc]) {
      const re = new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\)\\s*\\n\\s*FROM PUBLIC;`,
      );
      expect(sql, rpc).toMatch(re);
    }
  });
});

describe('G5-C2 nhóm A — cột pin_always', () => {
  it.each([FILE_MEMBER_CAP_QUYEN, FILE_ROLE_CAP_NHAT, FILE_MEMBER_MOI, FILE_MEMBER_TRANG_THAI, FILE_ZALO_PHAT_SONG])(
    '%s tự thêm cột pin_always (idempotent, chạy độc lập được)',
    (file) => {
      const sql = docSqlKhongComment(file);
      expect(sql).toMatch(
        /ALTER TABLE app_private\.copilot_action_registry\s*\n\s*ADD COLUMN pin_always boolean NOT NULL DEFAULT false;/,
      );
    },
  );

  it('hai file nhóm B còn lại (zalo_thu_hoi_tin, network_thuc_thi) KHÔNG cần tự thêm cột — registry INSERT của chúng không tham chiếu pin_always', () => {
    for (const file of [FILE_ZALO_THU_HOI_TIN, FILE_NETWORK_THUC_THI]) {
      const sql = docSqlKhongComment(file);
      expect(sql, file).not.toMatch(/ADD COLUMN pin_always/);
      const iInsert = sql.search(/INSERT INTO app_private\.copilot_action_registry \(/);
      const cotList = sql.slice(iInsert, sql.indexOf(')', iInsert));
      expect(cotList, file).not.toMatch(/\bpin_always\b/);
    }
  });

  it('member_cap_quyen (file đầu nhóm A) patch copilot_plan_create_v1 đọc pin_always ở CẢ hai chỗ (xây v_gom + soát vòng lặp uỷ quyền đứng)', () => {
    const sql = docSqlKhongComment(FILE_MEMBER_CAP_QUYEN);
    const than = thanHam(sql, 'copilot_plan_create_v1');
    expect(than.length).toBeGreaterThan(0);
    expect(than).toMatch(/'pin_always',\s*v_reg\.pin_always/);
    expect(than).toMatch(
      /COALESCE\(\(v_step_entry ->> 'pin_always'\)::boolean, false\)/,
    );
  });

  it('bốn file nhóm A KHÔNG lặp lại patch copilot_plan_create_v1 (chỉ file đầu chạm hàm này)', () => {
    for (const file of [FILE_ROLE_CAP_NHAT, FILE_MEMBER_MOI, FILE_MEMBER_TRANG_THAI]) {
      const sql = docSqlKhongComment(file);
      expect(sql, file).not.toMatch(/CREATE OR REPLACE FUNCTION public\.copilot_plan_create_v1/);
    }
  });
});

describe('G5-C2 nhóm B — engine UNKNOWN_EFFECT + copilot_plan_reconcile_step_v1 (chỉ file đầu — zalo_phat_song)', () => {
  const sql = docSqlKhongComment(FILE_ZALO_PHAT_SONG);

  it('copilot_plan_execute_step_v1 mang nhánh verify_kind=external_effect → UNKNOWN_EFFECT', () => {
    const than = thanHam(sql, 'copilot_plan_execute_step_v1');
    expect(than.length).toBeGreaterThan(0);
    expect(than).toMatch(
      /v_buoc_status := CASE WHEN v_reg\.verify_kind = 'external_effect'\s*\n\s*THEN 'UNKNOWN_EFFECT' ELSE 'DONE' END;/,
    );
    // v_buoc_status phải được TÍNH TRƯỚC UPDATE (không còn hardcode 'DONE' ở SET status).
    const iTinh = than.search(/v_buoc_status := CASE WHEN v_reg\.verify_kind/);
    const iUpdate = than.search(/UPDATE app_private\.copilot_plan_steps\s*\n\s*SET status = v_buoc_status,/);
    expect(iTinh).toBeGreaterThan(-1);
    expect(iUpdate).toBeGreaterThan(-1);
    expect(iTinh).toBeLessThan(iUpdate);
  });

  it('copilot_plan_execute_step_v1 — plan_status ép APPROVED khi buoc la UNKNOWN_EFFECT (khong bao gio nhay len DONE)', () => {
    const than = thanHam(sql, 'copilot_plan_execute_step_v1');
    expect(than).toMatch(
      /v_plan_status := CASE WHEN v_buoc_status = 'UNKNOWN_EFFECT' THEN 'APPROVED'\s*\n\s*WHEN v_next IS NULL THEN 'DONE' ELSE 'APPROVED' END;/,
    );
  });

  it('copilot_plan_reconcile_step_v1 — KHÔNG còn là stub not_implemented', () => {
    const than = thanHam(sql, 'copilot_plan_reconcile_step_v1');
    expect(than.length).toBeGreaterThan(200);
    expect(than).not.toMatch(/not_implemented/);
  });

  it('copilot_plan_reconcile_step_v1 — chủ kế hoạch hoặc super admin, đòi plan APPROVED + step UNKNOWN_EFFECT + registry verify_kind=external_effect', () => {
    const than = thanHam(sql, 'copilot_plan_reconcile_step_v1');
    expect(than).toMatch(/p\.user_id = v_actor OR public\.is_super_admin\(\)/);
    expect(than).toMatch(/IF v_plan\.status <> 'APPROVED' THEN/);
    expect(than).toMatch(/IF v_step\.status <> 'UNKNOWN_EFFECT' THEN/);
    expect(than).toMatch(/v_reg\.verify_kind <> 'external_effect'/);
  });

  it('copilot_plan_reconcile_step_v1 — đọc entity_table/entity_id TỪ outcome đã ghi (không tin tham số người gọi)', () => {
    const than = thanHam(sql, 'copilot_plan_reconcile_step_v1');
    expect(than).toMatch(/v_step\.outcome ->> 'entity_table'/);
    expect(than).toMatch(/v_step\.outcome ->> 'entity_id'/);
  });

  it('copilot_plan_reconcile_step_v1 — CASE trên entity_table: zalo_send_queue (sent/failed) và network_commands (SUCCEEDED/FAILED/CANCELLED_BY_KILL_SWITCH)', () => {
    const than = thanHam(sql, 'copilot_plan_reconcile_step_v1');
    expect(than).toMatch(/v_entity_table = 'zalo_send_queue'/);
    expect(than).toMatch(/WHEN 'sent' THEN 'DONE'/);
    expect(than).toMatch(/WHEN 'failed' THEN 'FAILED'/);
    expect(than).toMatch(/v_entity_table = 'network_commands'/);
    expect(than).toMatch(/'SUCCEEDED' THEN 'DONE'/);
    expect(than).toMatch(/IN \('FAILED', 'CANCELLED_BY_KILL_SWITCH'\) THEN 'FAILED'/);
  });

  it('copilot_plan_reconcile_step_v1 — còn PENDING thì KHÔNG ghi sổ, KHÔNG tăng version', () => {
    const than = thanHam(sql, 'copilot_plan_reconcile_step_v1');
    const iPending = than.search(/IF v_ext_status = 'PENDING' THEN/);
    const iReturn = than.indexOf('RETURN jsonb_build_object(', iPending);
    const doan = than.slice(iPending, iReturn + 30);
    expect(doan).not.toMatch(/copilot_ledger_append_v1/);
    expect(doan).not.toMatch(/UPDATE app_private\.copilot_plans/);
  });

  it('copilot_plan_reconcile_step_v1 — nhánh FAILED chặn các bước PENDING/UNKNOWN_EFFECT còn lại, ghi step_reconciled + step_blocked', () => {
    const than = thanHam(sql, 'copilot_plan_reconcile_step_v1');
    expect(than).toMatch(/status IN \('PENDING','UNKNOWN_EFFECT'\) AND step_no <> p_step_no/);
    expect(than).toMatch(/'event',\s*'step_reconciled',/);
    expect(than).toMatch(/'event',\s*'step_blocked',/);
  });

  it('enum copilot_action_ledger.event mở rộng thêm step_reconciled (idempotent DROP+ADD có điều kiện)', () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS copilot_action_ledger_event_check;/);
    expect(sql).toMatch(/'grant_used','step_reconciled','step_unknown_effect'\]/);
  });

  it('nghiệm thu cuối file xác nhận cả ba: nhánh external_effect/UNKNOWN_EFFECT, reconcile hết stub, enum có step_reconciled', () => {
    const iNghiem = sql.search(/DO \$nghiem_thu\$/);
    const than = sql.slice(iNghiem);
    expect(than).toMatch(/v_than !~ 'external_effect' OR v_than !~ 'UNKNOWN_EFFECT'/);
    expect(than).toMatch(/v_than ~ 'not_implemented'/);
    expect(than).toMatch(/conname = 'copilot_action_ledger_event_check'/);
  });
});

describe('G5-C2 nhóm B — hai file còn lại KHÔNG lặp lại patch engine/reconcile', () => {
  it.each([FILE_ZALO_THU_HOI_TIN, FILE_NETWORK_THUC_THI])('%s', (file) => {
    const sql = docSqlKhongComment(file);
    expect(sql, file).not.toMatch(/CREATE OR REPLACE FUNCTION public\.copilot_plan_execute_step_v1/);
    expect(sql, file).not.toMatch(/CREATE OR REPLACE FUNCTION public\.copilot_plan_reconcile_step_v1/);
    expect(sql, file).not.toMatch(/copilot_action_ledger_event_check/);
  });
});

describe('G5-C2 — chữ ký ABI của cặp preview/execute không đổi so với khuôn direct_l5_v1', () => {
  it.each(CAC_ACTION)('$ten — preview(uuid, jsonb) / execute(text, jsonb)', (ca) => {
    const sql = docSqlKhongComment(ca.file);
    expect(chuKyHam(sql, ca.previewRpc)).toBe('p_organization_id uuid, p_payload jsonb');
    expect(chuKyHam(sql, ca.executeRpc)).toBe('p_confirmation_nonce text, p_payload jsonb');
  });
});

describe('G5-C2 — copilot_plan_create_v1 mang nhánh direct_l5_v1 (phát hiện qua G5-DE E2E: thiếu nhánh này thì mọi kế hoạch mang bước L5 chết với executor_not_supported ngay cả khi policy đã mở L5)', () => {
  const sql = docSqlKhongComment(FILE_MEMBER_CAP_QUYEN);

  it('CREATE OR REPLACE copilot_plan_create_v1 có mặt trong file đầu nhóm A', () => {
    const than = thanHam(sql, 'copilot_plan_create_v1');
    expect(than.length).toBeGreaterThan(0);
  });

  it('nhánh ELSIF v_reg.executor_kind = \'direct_l5_v1\' tồn tại, ĐỨNG SAU nhánh nonce_abi_v1, TRƯỚC maker_submit_v1', () => {
    const than = thanHam(sql, 'copilot_plan_create_v1');
    const iNonce = than.search(/IF v_reg\.executor_kind = 'nonce_abi_v1' THEN/);
    const iL5 = than.search(/ELSIF v_reg\.executor_kind = 'direct_l5_v1' THEN/);
    const iMaker = than.search(/ELSIF v_reg\.executor_kind = 'maker_submit_v1' THEN/);
    expect(iNonce).toBeGreaterThan(-1);
    expect(iL5).toBeGreaterThan(-1);
    expect(iMaker).toBeGreaterThan(-1);
    expect(iNonce).toBeLessThan(iL5);
    expect(iL5).toBeLessThan(iMaker);
  });

  it('nhánh direct_l5_v1 dựng canonical/preview/nonce_hex y hệt nonce_abi_v1: gọi preview_rpc, xoá nonce mồ côi, băm digest', () => {
    const than = thanHam(sql, 'copilot_plan_create_v1');
    const iL5 = than.search(/ELSIF v_reg\.executor_kind = 'direct_l5_v1' THEN/);
    const iMaker = than.search(/ELSIF v_reg\.executor_kind = 'maker_submit_v1' THEN/);
    const doanL5 = than.slice(iL5, iMaker);
    expect(doanL5).toMatch(/EXECUTE format\('SELECT public\.%I\(\$1, \$2\)', v_reg\.preview_rpc\)/);
    expect(doanL5).toMatch(/v_canonical := v_kq -> 'canonical';/);
    expect(doanL5).toMatch(/DELETE FROM app_private\.copilot_write_confirmations/);
    expect(doanL5).toMatch(/v_digest := app_private\.copilot_payload_hash_v1\(v_canonical\);/);
    expect(doanL5).toMatch(/v_ref := NULL;/);
  });

  it('trần rủi ro (plan_risk_not_allowed) đứng TRƯỚC nhánh executor_kind, áp cho MỌI kind trừ maker_submit_v1 — direct_l5_v1 không có lối tắt', () => {
    const than = thanHam(sql, 'copilot_plan_create_v1');
    const iTran = than.search(/RAISE EXCEPTION 'plan_risk_not_allowed:/);
    const iGate = than.search(/PERFORM app_private\.copilot_action_gate_v1\(v_hanh_dong, p_organization_id\);/);
    const iNonce = than.search(/IF v_reg\.executor_kind = 'nonce_abi_v1' THEN/);
    expect(iTran).toBeGreaterThan(-1);
    expect(iTran).toBeLessThan(iGate);
    expect(iGate).toBeLessThan(iNonce);
    expect(than).toMatch(/v_reg\.executor_kind <> 'maker_submit_v1'/);
  });

  it('ba file còn lại của nhóm A KHÔNG lặp lại patch copilot_plan_create_v1 (chỉ file đầu chạm hàm này — đã ghim ở describe pin_always phía trên)', () => {
    for (const file of [FILE_ROLE_CAP_NHAT, FILE_MEMBER_MOI, FILE_MEMBER_TRANG_THAI]) {
      const s = docSqlKhongComment(file);
      expect(s, file).not.toMatch(/ELSIF v_reg\.executor_kind = 'direct_l5_v1' THEN/);
    }
  });
});

describe('G5-C2 — copilot_plan_execute_step_v1 vẫn đặt marker app.copilot_plan_context cho direct_l5_v1 (không bị patch UNKNOWN_EFFECT làm mất)', () => {
  it('marker được đặt NGAY TRƯỚC EXECUTE execute_rpc trong nhánh direct_l5_v1, và xoá sau đó (cả đường thành công lẫn đường lỗi)', () => {
    const sql = docSqlKhongComment(FILE_ZALO_PHAT_SONG);
    const than = thanHam(sql, 'copilot_plan_execute_step_v1');
    expect(than).toMatch(
      /PERFORM set_config\('app\.copilot_plan_context',\s*\n\s*v_plan\.id::text \|\| ':' \|\| p_step_no::text, true\);/,
    );
    // Ba lần set_config trên cùng khoá: một lần dựng, hai lần xoá (thành công + lỗi) — khuôn F5 của G5-C.
    const soLan = (than.match(/set_config\('app\.copilot_plan_context'/g) ?? []).length;
    expect(soLan).toBe(3);
  });
});

describe('G5-C2 — không đụng chính sách L4 (giữ nguyên "chưa lên van")', () => {
  it.each(CAC_ACTION)('$ten — không mở max_direct_risk lên L5', (ca) => {
    const sql = docSqlKhongComment(ca.file);
    expect(sql).not.toMatch(/UPDATE app_private\.copilot_action_policy\s+SET max_direct_risk/);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (review) — F1 (BLOCKING): race ở đường đọc lại entity_id của
// zalo.broadcast/zalo.recall_message. Bản trước đọc "hàng zalo_send_queue MỚI
// NHẤT của hội thoại" — một lần gửi/thu hồi SONG SONG khác vào CÙNG hội thoại
// có thể chen một hàng MỚI HƠN giữa lúc RPC gốc INSERT và lúc wrapper SELECT,
// làm entity_id (và do đó cả đối soát sau này) trỏ SAI sang tin của người
// khác. Sửa bằng LIÊN KẾT THẬT thay vì "mới nhất": zalo.broadcast qua
// message_id (zalo_broadcast tự đặt khi INSERT zalo_send_queue), zalo.recall_
// message qua target_msg_id/target_cli_msg_id (payload mà chính RPC gốc đóng
// gói). CẢ HAI đều chốt mốc thời gian `v_moc` TRƯỚC khi gọi RPC gốc.
// ---------------------------------------------------------------------------
describe('Fix round 1 — F1 (BLOCKING): zalo.broadcast chống race khi đọc lại entity_id', () => {
  const sql = docSqlKhongComment(FILE_ZALO_PHAT_SONG);
  const than = thanHam(sql, 'copilot_execute_zalo_phat_song_v1');

  it('v_moc := clock_timestamp() được chốt TRƯỚC khi gọi zalo_broadcast', () => {
    const iMoc = than.search(/v_moc := clock_timestamp\(\);/);
    const iGoc = than.search(/v_count := public\.zalo_broadcast\(ARRAY\[v_conv_id\], v_body\);/);
    expect(iMoc).toBeGreaterThan(-1);
    expect(iGoc).toBeGreaterThan(-1);
    expect(iMoc).toBeLessThan(iGoc);
  });

  it('KHÔNG còn đọc "mới nhất" trần (ORDER BY created_at DESC) trên zalo_send_queue', () => {
    expect(than).not.toMatch(/ORDER BY t\.created_at DESC/);
  });

  it('tìm zalo_messages CỦA CHÍNH giao dịch này: sent_by=actor + body khớp + sent_at >= v_moc', () => {
    expect(than).toMatch(/m\.sent_by = v_actor/);
    expect(than).toMatch(/m\.body = v_body/);
    expect(than).toMatch(/m\.sent_at >= v_moc/);
  });

  it('KHÔNG lọc zalo_send_queue.user_id = actor — cột đó là chủ sở hữu hội thoại, không phải actor (đã xác minh qua thân RPC gốc)', () => {
    expect(than).not.toMatch(/t\.user_id = v_actor/);
  });

  it('lấy hàng outbox LIÊN KẾT qua message_id (không phải "mới nhất của hội thoại")', () => {
    expect(than).toMatch(/WHERE t\.message_id = v_msg_id/);
  });

  it('không tìm thấy tin/hàng outbox của CHÍNH giao dịch này → RAISE external_effect_entity_not_found, TRƯỚC khi ghi ai_write_audit/ledger', () => {
    const soLoi = (than.match(/RAISE EXCEPTION 'external_effect_entity_not_found'/g) ?? []).length;
    expect(soLoi).toBeGreaterThanOrEqual(2); // một cho v_msg_id, một cho v_queue_id
    const iLoiCuoi = than.lastIndexOf("RAISE EXCEPTION 'external_effect_entity_not_found'");
    const iAudit = than.indexOf('INSERT INTO public.ai_write_audit');
    expect(iLoiCuoi).toBeLessThan(iAudit);
  });
});

describe('Fix round 1 — F1 (BLOCKING): zalo.recall_message chống race khi đọc lại entity_id', () => {
  const sql = docSqlKhongComment(FILE_ZALO_THU_HOI_TIN);
  const than = thanHam(sql, 'copilot_execute_zalo_thu_hoi_tin_v1');

  it('v_moc := clock_timestamp() được chốt TRƯỚC khi gọi zalo_recall_message', () => {
    const iMoc = than.search(/v_moc := clock_timestamp\(\);/);
    const iGoc = than.search(/PERFORM public\.zalo_recall_message\(v_msg_id\);/);
    expect(iMoc).toBeGreaterThan(-1);
    expect(iGoc).toBeGreaterThan(-1);
    expect(iMoc).toBeLessThan(iGoc);
  });

  it('KHÔNG còn đọc "mới nhất" trần (ORDER BY created_at DESC) trên zalo_send_queue', () => {
    expect(than).not.toMatch(/ORDER BY t\.created_at DESC/);
  });

  it('liên kết qua target_msg_id/target_cli_msg_id (IS NOT DISTINCT FROM, an toàn với NULL) + cửa sổ thời gian', () => {
    expect(than).toMatch(
      /\(t\.payload ->> 'target_msg_id'\) IS NOT DISTINCT FROM \(v_before ->> 'zalo_msg_id'\)/,
    );
    expect(than).toMatch(
      /\(t\.payload ->> 'target_cli_msg_id'\) IS NOT DISTINCT FROM \(v_before ->> 'cli_msg_id'\)/,
    );
    expect(than).toMatch(/t\.created_at >= v_moc/);
  });

  it('không tìm thấy hàng outbox của CHÍNH giao dịch này → RAISE external_effect_entity_not_found', () => {
    expect(than).toMatch(/RAISE EXCEPTION 'external_effect_entity_not_found' USING ERRCODE = 'P0001';/);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (review) — F4 (LOW): sự kiện sổ RIÊNG cho bước UNKNOWN_EFFECT.
// ---------------------------------------------------------------------------
describe('Fix round 1 — F4: copilot_plan_execute_step_v1 ghi step_unknown_effect thay vì step_done khi buoc la UNKNOWN_EFFECT', () => {
  it('event là CASE điều kiện theo v_buoc_status, không còn literal step_done tĩnh ở nhánh thành công', () => {
    const sql = docSqlKhongComment(FILE_ZALO_PHAT_SONG);
    const than = thanHam(sql, 'copilot_plan_execute_step_v1');
    expect(than).toMatch(
      /'event',\s*CASE WHEN v_buoc_status = 'UNKNOWN_EFFECT'\s*\n\s*THEN 'step_unknown_effect' ELSE 'step_done' END,/,
    );
  });

  it("enum copilot_action_ledger.event có cả 'step_reconciled' VÀ 'step_unknown_effect'", () => {
    const sql = docSqlKhongComment(FILE_ZALO_PHAT_SONG);
    expect(sql).toMatch(/'grant_used','step_reconciled','step_unknown_effect'\]/);
  });

  it('hai file còn lại của nhóm B (zalo_thu_hoi_tin, network_thuc_thi) KHÔNG lặp lại patch engine — không có literal step_unknown_effect trong DDL của chúng', () => {
    for (const file of [FILE_ZALO_THU_HOI_TIN, FILE_NETWORK_THUC_THI]) {
      const sql = docSqlKhongComment(file);
      expect(sql, file).not.toMatch(/step_unknown_effect/);
    }
  });
});
