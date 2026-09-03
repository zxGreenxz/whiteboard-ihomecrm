import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, docSqlKhongComment, thanHam } from './helpers/sqlTestUtils';

// G5-C (đợt 1) — tám action `direct_l5_v1` bọc RPC L5 có sẵn (duyệt/vào sổ/xoá
// mềm phiếu thu-chi, hoá đơn, chỉ số công tơ, thanh lý hợp đồng, khách hàng).
//
// KHUÔN direct_l5_v1 MỞ RỘNG Nonce ABI v1 — hai điều KHÁC nonce_abi_v1 thường
// (L3/L4), test này ghim RIÊNG cho cả tám action:
//   1. `execute` bắt đầu bằng một kiểm KHÔNG có ở nonce_abi_v1: từ chối
//      `l5_requires_plan` (42501) nếu KHÔNG chạy trong ngữ cảnh một kế hoạch
//      (`current_setting('app.copilot_plan_context', true)` rỗng/NULL) — đây
//      là hàng rào DUY NHẤT còn lại ở tầng RPC, vì PIN step-up đã là điều
//      kiện để kế hoạch được APPROVED từ `copilot_plan_approve_v1` (G5-A).
//   2. `before_digest` LUÔN khác NULL (không có nhánh `CASE WHEN … IS NULL`
//      như hành động TẠO của G2-E) — cả tám hành động đều là duyệt/xoá một
//      thực thể ĐÃ TỒN TẠI, nên "trạng thái trước" luôn có nghĩa.
//
// Migration đầu tiên (`income_expense.duyet`) còn vá `copilot_plan_execute_
// step_v1` để thêm nhánh `executor_kind = 'direct_l5_v1'` — bảy migration còn
// lại CHỈ định nghĩa cặp RPC + đăng ký, không đụng lại engine.
//
// Mọi assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN — cùng lý do đã ghi ở
// `copilotActionRegistryMigration.test.ts`/`copilotActionsL3Migration.test.ts`.
//
// Đây là test ĐỌC FILE. Hành vi thật do khối nghiệm thu trong từng migration
// và hai lượt dry-run trên production đo (xem báo cáo task).

interface CaAction {
  ten: string;
  file: string;
  actionId: string;
  permissionKey: string;
  previewRpc: string;
  executeRpc: string;
  entityTable: string;
  entityVar: string;
  verifyKind: string;
  rollbackRpc: string | null;
  /** Đoạn regex xác nhận lời gọi RPC gốc trong thân `execute`. */
  goiRpcGoc: RegExp;
}

const FILE_IE_DUYET = 'supabase/migrations/20260903190255_copilot_action_ie_duyet_v1.sql';
const FILE_IE_DUYET_VAO_SO =
  'supabase/migrations/20260903190840_copilot_action_ie_duyet_vao_so_v1.sql';
const FILE_IE_VAO_SO = 'supabase/migrations/20260903191400_copilot_action_ie_vao_so_v1.sql';
const FILE_INVOICE_DUYET = 'supabase/migrations/20260903191755_copilot_action_invoice_duyet_v1.sql';
const FILE_INVOICE_XOA_MEM =
  'supabase/migrations/20260903192041_copilot_action_invoice_xoa_mem_v1.sql';
const FILE_METER_READING_DUYET =
  'supabase/migrations/20260903192331_copilot_action_meter_reading_duyet_v1.sql';
const FILE_CONTRACT_DUYET_THANH_LY =
  'supabase/migrations/20260903192634_copilot_action_contract_duyet_thanh_ly_v1.sql';
const FILE_CUSTOMER_XOA_MEM =
  'supabase/migrations/20260903192942_copilot_action_customer_xoa_mem_v1.sql';

const CAC_ACTION: readonly CaAction[] = [
  {
    ten: 'income_expense.duyet',
    file: FILE_IE_DUYET,
    actionId: 'income_expense.duyet',
    permissionKey: 'income_expenses.approve',
    previewRpc: 'copilot_preview_ie_duyet_v1',
    executeRpc: 'copilot_execute_ie_duyet_v1',
    entityTable: 'income_expenses',
    entityVar: 'v_ie',
    verifyKind: 'ie_approved',
    rollbackRpc: 'cancel_income_expense_flex_v1',
    goiRpcGoc: /PERFORM public\.approve_income_expense_v1\(v_ie_id\);/,
  },
  {
    ten: 'income_expense.duyet_vao_so',
    file: FILE_IE_DUYET_VAO_SO,
    actionId: 'income_expense.duyet_vao_so',
    permissionKey: 'income_expenses.approve',
    previewRpc: 'copilot_preview_ie_duyet_vao_so_v1',
    executeRpc: 'copilot_execute_ie_duyet_vao_so_v1',
    entityTable: 'income_expenses',
    entityVar: 'v_ie',
    verifyKind: 'ie_posted',
    rollbackRpc: 'reverse_posted_income_expense_v2',
    goiRpcGoc: /v_ket := public\.approve_and_post_income_expense_v2\(v_input\);/,
  },
  {
    ten: 'income_expense.vao_so',
    file: FILE_IE_VAO_SO,
    actionId: 'income_expense.vao_so',
    permissionKey: 'income_expenses.approve',
    previewRpc: 'copilot_preview_ie_vao_so_v1',
    executeRpc: 'copilot_execute_ie_vao_so_v1',
    entityTable: 'income_expenses',
    entityVar: 'v_ie',
    verifyKind: 'ie_posted',
    rollbackRpc: 'reverse_posted_income_expense_v2',
    goiRpcGoc: /v_ket := public\.post_approved_income_expense_v2\(v_input\);/,
  },
  {
    ten: 'invoice.duyet',
    file: FILE_INVOICE_DUYET,
    actionId: 'invoice.duyet',
    permissionKey: 'invoices.edit',
    previewRpc: 'copilot_preview_invoice_duyet_v1',
    executeRpc: 'copilot_execute_invoice_duyet_v1',
    entityTable: 'invoices',
    entityVar: 'v_inv',
    verifyKind: 'invoice_approved',
    rollbackRpc: 'unapprove_invoice_v1',
    goiRpcGoc: /PERFORM public\.approve_invoice_v1\(v_inv_id\);/,
  },
  {
    ten: 'invoice.xoa_mem',
    file: FILE_INVOICE_XOA_MEM,
    actionId: 'invoice.xoa_mem',
    permissionKey: 'invoices.edit',
    previewRpc: 'copilot_preview_invoice_xoa_mem_v1',
    executeRpc: 'copilot_execute_invoice_xoa_mem_v1',
    entityTable: 'invoices',
    entityVar: 'v_inv',
    verifyKind: 'invoice_deleted',
    rollbackRpc: null,
    goiRpcGoc: /PERFORM public\.soft_delete_invoice_v1\(v_inv_id\);/,
  },
  {
    ten: 'meter_reading.duyet',
    file: FILE_METER_READING_DUYET,
    actionId: 'meter_reading.duyet',
    permissionKey: 'meter_readings.edit',
    previewRpc: 'copilot_preview_meter_reading_duyet_v1',
    executeRpc: 'copilot_execute_meter_reading_duyet_v1',
    entityTable: 'meter_readings',
    entityVar: 'v_mr',
    verifyKind: 'readback',
    rollbackRpc: 'unapprove_meter_reading_v1',
    goiRpcGoc: /PERFORM public\.approve_meter_reading_v1\(v_mr_id\);/,
  },
  {
    ten: 'contract.duyet_thanh_ly',
    file: FILE_CONTRACT_DUYET_THANH_LY,
    actionId: 'contract.duyet_thanh_ly',
    permissionKey: 'contracts.edit',
    previewRpc: 'copilot_preview_contract_duyet_thanh_ly_v1',
    executeRpc: 'copilot_execute_contract_duyet_thanh_ly_v1',
    entityTable: 'contract_terminations',
    entityVar: 'v_term',
    verifyKind: 'readback',
    rollbackRpc: null,
    goiRpcGoc: /v_ket := public\.approve_contract_termination_v1\(v_term_id, v_note\);/,
  },
  {
    ten: 'customer.xoa_mem',
    file: FILE_CUSTOMER_XOA_MEM,
    actionId: 'customer.xoa_mem',
    permissionKey: 'customers.delete',
    previewRpc: 'copilot_preview_customer_xoa_mem_v1',
    executeRpc: 'copilot_execute_customer_xoa_mem_v1',
    entityTable: 'customers',
    entityVar: 'v_cust',
    verifyKind: 'readback',
    rollbackRpc: null,
    goiRpcGoc: /PERFORM public\.soft_delete_customer\(v_cust_id\);/,
  },
];

function doc(file: string): string {
  return boCommentSql(docSql(file));
}

/** Escape dấu chấm của một `action_id` để nhét vào RegExp. */
function nhuMau(gt: string): string {
  return gt.replace(/[.]/g, '\\.');
}

/**
 * Thân chính xác của một hàm: `thanHam` cắt tới khai báo kế tiếp hoặc khối ACL,
 * rồi cắt thêm ở dấu đóng dollar-quote để `not.toMatch` không đọc sang hàm sau.
 */
function than(sql: string, ten: string, schema = 'public'): string {
  const rong = thanHam(sql, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

/** Vị trí đầu tiên của một mẫu trong thân hàm; -1 nếu không có. */
function viTri(than_ham: string, mau: RegExp): number {
  return than_ham.search(mau);
}

/** Ghim một chuỗi vị trí TĂNG DẦN, kèm tên bước để lỗi đọc được. */
function thuTuTang(than_ham: string, buoc: readonly (readonly [string, RegExp])[]): void {
  const viTriTungBuoc = buoc.map(([ten, mau]) => [ten, viTri(than_ham, mau)] as const);
  for (const [ten, vt] of viTriTungBuoc) {
    expect(vt, `không thấy bước "${ten}" trong thân hàm`).toBeGreaterThan(-1);
  }
  for (let i = 1; i < viTriTungBuoc.length; i += 1) {
    const [tenTruoc, vtTruoc] = viTriTungBuoc[i - 1];
    const [tenSau, vtSau] = viTriTungBuoc[i];
    expect(vtSau, `"${tenTruoc}" phải đứng TRƯỚC "${tenSau}"`).toBeGreaterThan(vtTruoc);
  }
}

describe.each(CAC_ACTION)('G5-C — action L5 $ten', (ca) => {
  const sql = doc(ca.file);

  it('tồn tại và là một cặp BEGIN/COMMIT duy nhất', () => {
    expect(sql, `không đọc được ${ca.file}`).not.toBe('');
    expect(sql.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(sql.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('cặp RPC đúng chữ ký Nonce ABI v1', () => {
    expect(chuKyHam(sql, ca.previewRpc)).toBe('p_organization_id uuid, p_payload jsonb');
    expect(chuKyHam(sql, ca.executeRpc)).toBe('p_confirmation_nonce text, p_payload jsonb');
    for (const ten of [ca.previewRpc, ca.executeRpc]) {
      const t = than(sql, ten);
      expect(t).toMatch(/SECURITY DEFINER/);
      expect(t).toMatch(/SET search_path = pg_catalog, public, app_private, extensions/);
    }
  });

  it('tên hàm wrapper KHÔNG chứa động từ cấm (approve/post/delete/…)', () => {
    // Từ cấm chỉ được phép nằm trong `execute_rpc` GỐC (tên RPC baseline) theo
    // CHECK `copilot_action_registry_l5_row_check` — KHÔNG trong tên hàm wrapper
    // mà gate `check-copilot-forbidden-actions` quét (nó chỉ soi src/copilot,
    // nhưng cấm ở đây phòng một bản sau lỡ tay đặt tên hàm SQL trùng khuôn).
    const cam = /approve|decide|_post_|posting|delete|remove|reverse|grant|revoke|permission|role/;
    expect(ca.previewRpc).not.toMatch(cam);
    expect(ca.executeRpc).not.toMatch(cam);
  });

  it('xem trước: cổng chạy TRƯỚC khi phát nonce và trước khi tra thực thể', () => {
    const t = than(sql, ca.previewRpc);
    thuTuTang(t, [
      ['kiểm đăng nhập', /IF v_actor IS NULL THEN\s*\n\s*RAISE EXCEPTION 'unauthenticated'/],
      ['kiểm tổ chức', /organization_required/],
      ['cổng hành động', new RegExp(`copilot_action_gate_v1\\(\\s*\\n?\\s*'${nhuMau(ca.actionId)}'`)],
      ['dựng canonical', /v_canonical := jsonb_build_object\(/],
      ['ghi hàng xác nhận', /INSERT INTO app_private\.copilot_write_confirmations/],
      ['trả nonce một lần', /'confirmation_nonce',\s*encode\(v_nonce, 'hex'\)/],
    ]);
    expect(t).toMatch(new RegExp(`'${nhuMau(ca.actionId)}', app_private\\.copilot_payload_hash_v1`));
    expect(t).toMatch(
      new RegExp(`'${nhuMau(ca.permissionKey)}', clock_timestamp\\(\\) \\+ interval '5 minutes'`),
    );
  });

  it('thực thi: BƯỚC ĐẦU TIÊN là chặn L5 ngoài kế hoạch (`l5_requires_plan`)', () => {
    const t = than(sql, ca.executeRpc);
    // `current_setting('app.copilot_plan_context', ...)` phải đứng TRƯỚC cả
    // kiểm đăng nhập — đây là hàng rào ĐẦU TIÊN của toàn thân hàm, không phải
    // một kiểm chen giữa.
    const viTriMarker = t.search(/current_setting\('app\.copilot_plan_context', true\)/);
    const viTriDangNhap = t.search(/IF v_actor IS NULL THEN/);
    expect(viTriMarker, 'không thấy kiểm app.copilot_plan_context').toBeGreaterThan(-1);
    expect(viTriDangNhap, 'không thấy kiểm đăng nhập').toBeGreaterThan(-1);
    expect(viTriMarker).toBeLessThan(viTriDangNhap);
    expect(t).toMatch(
      /IF current_setting\('app\.copilot_plan_context', true\) IS NULL\s*\n\s*OR current_setting\('app\.copilot_plan_context', true\) = ''/,
    );
    expect(t).toMatch(/RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';/);
  });

  it('thực thi: chuỗi bước đúng thứ tự ABI, marker L5 trước cả nonce, readback SAU RPC gốc', () => {
    const t = than(sql, ca.executeRpc);
    thuTuTang(t, [
      ['chặn L5 ngoài kế hoạch', /l5_requires_plan/],
      ['regex nonce', /p_confirmation_nonce !~ '\^\[0-9a-fA-F\]\{64\}\$'/],
      ['khoá hàng xác nhận', /FOR UPDATE/],
      ['so hợp đồng tool/permission', /confirmation_contract_mismatch/],
      ['so payload_hash', /payload_changed/],
      ['tổ chức của hàng xác nhận', /organization_mismatch/],
      ['cổng hành động lần hai', new RegExp(`copilot_action_gate_v1\\('${nhuMau(ca.actionId)}'`)],
      ['advisory lock', /pg_advisory_xact_lock\(hashtextextended\(v_key, 0\)\)/],
      ['tra sổ audit', /FROM public\.ai_write_audit a/],
      ['CAS consumed_at', /SET consumed_at = clock_timestamp\(\)/],
      ['before_digest', /v_before := to_jsonb\(/],
      ['gọi RPC gốc', ca.goiRpcGoc],
      ['ghi ai_write_audit', /INSERT INTO public\.ai_write_audit/],
      ['ghi sổ hành động', /copilot_ledger_append_v1\(jsonb_build_object\(\s*\n\s*'event',\s*'action_executed'/],
    ]);
  });

  it('thực thi: `before_digest` LUÔN khác NULL — không có nhánh CASE WHEN NULL (khác action TẠO)', () => {
    const t = than(sql, ca.executeRpc);
    // Cả tám action đều duyệt/xoá một thực thể ĐÃ TỒN TẠI (không phải TẠO mới
    // như `reservation_deposit.create`), nên before_digest không cần —
    // và không được có — nhánh "không có gì để so".
    const soLanBeforeDigest = (t.match(/'before_digest',/g) ?? []).length;
    expect(soLanBeforeDigest).toBeGreaterThanOrEqual(1);
    expect(t).not.toMatch(/'before_digest',\s*CASE WHEN v_before IS NULL/);
    expect(t).toMatch(
      /'before_digest',\s*encode\(extensions\.digest\(\s*\n\s*convert_to\(v_before::text, 'UTF8'\), 'sha256'\), 'hex'\)/,
    );
  });

  it(`thực thi: readback verify_kind "${ca.verifyKind}" khớp registry, ép danh tính + trạng thái`, () => {
    const t = than(sql, ca.executeRpc);
    expect(t).toMatch(/copilot_write_readback_mismatch/);
    expect(t).toMatch(/copilot_draft_invariant_violation/);
    // Danh tính (tổ chức) phải được so TRƯỚC bất biến trạng thái.
    thuTuTang(t, [
      ['sai danh tính', /copilot_write_readback_mismatch/],
      ['sai bất biến', /copilot_draft_invariant_violation/],
      ['ghi ai_write_audit', /INSERT INTO public\.ai_write_audit/],
    ]);
    const iRegistry = sql.indexOf('INSERT INTO app_private.copilot_action_registry');
    const khoiRegistry = sql.slice(iRegistry, sql.indexOf('ON CONFLICT (action_id)', iRegistry));
    expect(khoiRegistry).toMatch(new RegExp(`'${nhuMau(ca.verifyKind)}',`));
  });

  it('thực thi: lỗi của RPC gốc ghi `action_failed` rồi RE-RAISE', () => {
    const t = than(sql, ca.executeRpc);
    thuTuTang(t, [
      ['bắt lỗi', /EXCEPTION WHEN others THEN\s*\n\s*GET STACKED DIAGNOSTICS/],
      ['ghi sổ thất bại', /'event',\s*'action_failed'/],
      ['re-raise', /^\s*RAISE;$/m],
    ]);
    expect(t).toMatch(/'error_code',\s*v_message/);
    expect(t).toMatch(/'sqlstate',\s*v_sqlstate/);
    const iFail = t.search(/'event',\s*'action_failed'/);
    const khoiFail = t.slice(iFail, t.indexOf('RAISE;', iFail));
    expect(khoiFail).not.toMatch(/after_digest/);
  });

  it('thực thi: nhánh lặp trả `da_thuc_hien_truoc_do` TRƯỚC khi tiêu nonce, không ghi sổ', () => {
    const t = than(sql, ca.executeRpc);
    const lap = t.indexOf("'da_thuc_hien_truoc_do'");
    const casTieu = t.search(/SET consumed_at = clock_timestamp\(\)/);
    const ghiSo = t.search(/'event',\s*'action_executed'/);
    expect(lap).toBeGreaterThan(-1);
    expect(lap).toBeLessThan(casTieu);
    expect(ghiSo).toBeGreaterThan(lap);
    expect(t).toMatch(
      new RegExp(`v_key := 'copilot_action:${nhuMau(ca.actionId)}:' \\|\\| v_actor::text`),
    );
    expect(t).toMatch(/\|\| v_org::text \|\| ':' \|\| encode\(v_hash, 'hex'\)/);
  });

  it('ACL: REVOKE PUBLIC/anon/service_role/authenticated rồi GRANT authenticated', () => {
    for (const ten of [ca.previewRpc, ca.executeRpc]) {
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${ten}\\([a-z, ]+\\)\\s*\\n?\\s*FROM PUBLIC;`),
      );
      for (const vai of ['anon', 'service_role', 'authenticated']) {
        expect(sql).toMatch(
          new RegExp(`REVOKE ALL ON FUNCTION public\\.${ten}\\([a-z, ]+\\) FROM ${vai};`),
        );
      }
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${ten}\\([a-z, ]+\\) TO authenticated;`),
      );
    }
  });

  it('registry: risk L5 / direct_l5_v1 / step_up, grantable=false, đúng khoá quyền + rollback', () => {
    expect(sql).toMatch(/INSERT INTO app_private\.copilot_action_registry/);
    expect(sql).toMatch(new RegExp(`'${nhuMau(ca.actionId)}',`));
    expect(sql).toMatch(/\n\s*'L5',\n\s*'direct_l5_v1',\n\s*'step_up',/);
    expect(sql).toMatch(new RegExp(`'${nhuMau(ca.permissionKey)}',\\n\\s*'L5',`));
    expect(sql).toMatch(new RegExp(`'${ca.previewRpc}',\\n\\s*'${ca.executeRpc}',`));
    expect(sql).toMatch(/ON CONFLICT \(action_id\) DO NOTHING;/);
    // `grantable = false` xuất hiện tường minh trong tuple VALUES (không dựa
    // vào DEFAULT của cột — G5-B fix#1 đổi DEFAULT thành false, nhưng brief đòi
    // khai TƯỜNG MINH cho cả tám hàng của task này).
    const iRegistry = sql.indexOf('INSERT INTO app_private.copilot_action_registry');
    const khoiRegistry = sql.slice(iRegistry, sql.indexOf('ON CONFLICT (action_id)', iRegistry));
    expect(khoiRegistry).toMatch(/\n\s*true,\n\s*false\n\)/);

    if (ca.rollbackRpc) {
      expect(khoiRegistry).toMatch(new RegExp(`'${ca.rollbackRpc}',`));
    } else {
      // NULL + rollback_note không rỗng — một ghi chú rỗng nghĩa là không ai
      // biết lùi thế nào.
      expect(khoiRegistry).toMatch(/\n\s*NULL,\n\s*'[A-Za-z]/);
    }
  });

  it('cờ kill switch: seed `disabled`, kẹp giữa hai lần set_config transition v2', () => {
    const iMo = sql.indexOf("set_config('app.copilot_feature_flag_transition', 'v2', true)");
    const iSeed = sql.indexOf('INSERT INTO public.copilot_feature_flags');
    const iDong = sql.indexOf("set_config('app.copilot_feature_flag_transition', '', true)");
    expect(iMo).toBeGreaterThan(-1);
    expect(iSeed).toBeGreaterThan(iMo);
    expect(iDong).toBeGreaterThan(iSeed);
    expect(sql).toMatch(new RegExp(`'action', '${nhuMau(ca.actionId)}', 'disabled'`));
    expect(sql).toMatch(/ON CONFLICT \(scope, contract_id\) DO NOTHING;/);
  });

  it('khối nghiệm thu chỉ soi catalog — không truy vấn bảng nghiệp vụ nào', () => {
    const iNghiemThu = sql.indexOf('DO $nghiem_thu$');
    expect(iNghiemThu).toBeGreaterThan(-1);
    const khoi = sql.slice(iNghiemThu);
    expect(khoi).toMatch(/to_regprocedure\(/);
    expect(khoi).not.toMatch(new RegExp(`FROM public\\.${ca.entityTable}\\b`));
  });
});

describe('G5-C — vá dòng vào ke hoach (`copilot_plan_execute_step_v1`) chỉ trong migration đầu', () => {
  const sql = doc(FILE_IE_DUYET);

  it('thân hàm mang nhánh `direct_l5_v1` giữa nonce_abi_v1 và maker_submit_v1', () => {
    const t = than(sql, 'copilot_plan_execute_step_v1');
    thuTuTang(t, [
      ['nhánh nonce_abi_v1', /IF v_reg\.executor_kind = 'nonce_abi_v1' THEN/],
      ['nhánh direct_l5_v1', /ELSIF v_reg\.executor_kind = 'direct_l5_v1' THEN/],
      ['nhánh maker_submit_v1', /ELSIF v_reg\.executor_kind = 'maker_submit_v1' THEN/],
    ]);
  });

  it('BÊN TRONG nhánh direct_l5_v1: đặt marker ngữ cảnh kế hoạch TRƯỚC lời gọi execute_rpc', () => {
    const t = than(sql, 'copilot_plan_execute_step_v1');
    const iL5 = t.search(/ELSIF v_reg\.executor_kind = 'direct_l5_v1' THEN/);
    const iMaker = t.search(/ELSIF v_reg\.executor_kind = 'maker_submit_v1' THEN/);
    expect(iL5).toBeGreaterThan(-1);
    expect(iMaker).toBeGreaterThan(iL5);
    const khoiL5 = t.slice(iL5, iMaker);
    thuTuTang(khoiL5, [
      [
        'đặt marker ngữ cảnh kế hoạch',
        /PERFORM set_config\('app\.copilot_plan_context',\s*\n\s*v_plan\.id::text \|\| ':' \|\| p_step_no::text, true\);/,
      ],
      ['gọi execute_rpc SAU marker', /EXECUTE format\('SELECT public\.%I\(\$1, \$2\)', v_reg\.execute_rpc\)/],
    ]);
  });

  it('marker chỉ được đặt MỘT LẦN, ngay trước lời gọi execute_rpc của nhánh direct_l5_v1 (không phải nonce_abi_v1)', () => {
    const t = than(sql, 'copilot_plan_execute_step_v1');
    const soLanMarker = (t.match(/set_config\('app\.copilot_plan_context'/g) ?? []).length;
    expect(soLanMarker).toBe(1);
    // Nhánh nonce_abi_v1 (L3/L4) KHÔNG được mang marker — chỉ direct_l5_v1 mới
    // bị khoá "phải đi qua kế hoạch".
    const iNonce = t.search(/IF v_reg\.executor_kind = 'nonce_abi_v1' THEN/);
    const iL5 = t.search(/ELSIF v_reg\.executor_kind = 'direct_l5_v1' THEN/);
    const khoiNonce = t.slice(iNonce, iL5);
    expect(khoiNonce).not.toMatch(/set_config\('app\.copilot_plan_context'/);
  });

  it('bảy migration còn lại KHÔNG đụng lại `copilot_plan_execute_step_v1`', () => {
    for (const file of [
      FILE_IE_DUYET_VAO_SO,
      FILE_IE_VAO_SO,
      FILE_INVOICE_DUYET,
      FILE_INVOICE_XOA_MEM,
      FILE_METER_READING_DUYET,
      FILE_CONTRACT_DUYET_THANH_LY,
      FILE_CUSTOMER_XOA_MEM,
    ]) {
      expect(doc(file)).not.toMatch(/CREATE OR REPLACE FUNCTION public\.copilot_plan_execute_step_v1/);
    }
  });
});

describe('G5-C — customer.xoa_mem vá bảo mật: REVOKE anon KHỎI RPC GỐC (không phải wrapper)', () => {
  const sql = doc(FILE_CUSTOMER_XOA_MEM);

  it('revoke CẢ HAI đường: anon riêng VÀ PUBLIC (proacl production có cả hai)', () => {
    thuTuTang(sql, [
      ['revoke anon', /REVOKE ALL ON FUNCTION public\.soft_delete_customer\(uuid\) FROM anon;/],
      ['revoke PUBLIC', /REVOKE ALL ON FUNCTION public\.soft_delete_customer\(uuid\) FROM PUBLIC;/],
    ]);
    // Đứng TRƯỚC cả cặp wrapper (mục 0 của file, không lẫn với ACL của wrapper).
    const iVaAnon = sql.indexOf('REVOKE ALL ON FUNCTION public.soft_delete_customer(uuid)');
    const iPreview = sql.indexOf('CREATE OR REPLACE FUNCTION public.copilot_preview_customer_xoa_mem_v1');
    expect(iVaAnon).toBeGreaterThan(-1);
    expect(iPreview).toBeGreaterThan(iVaAnon);
  });

  it('KHÔNG revoke authenticated/service_role trên RPC gốc — người dùng thật không bị đổi hành vi', () => {
    const iVaAnon = sql.indexOf('DO $va_anon_soft_delete_customer$');
    const iHetKhoi = sql.indexOf('$va_anon_soft_delete_customer$;', iVaAnon + 1);
    const khoi = sql.slice(iVaAnon, iHetKhoi);
    expect(khoi).not.toMatch(/FROM authenticated/);
    expect(khoi).not.toMatch(/FROM service_role/);
  });

  it('nghiệm thu ghim: anon KHÔNG còn gọi được RPC gốc', () => {
    const iNghiemThu = sql.indexOf('DO $nghiem_thu$');
    const khoi = sql.slice(iNghiemThu);
    expect(khoi).toMatch(
      /has_function_privilege\('anon', 'public\.soft_delete_customer\(uuid\)', 'EXECUTE'\)/,
    );
  });
});

describe('G5-C — đột biến: bình luận hoá `l5_requires_plan` phải làm test ĐỎ', () => {
  const thoIeDuyet = docSql(FILE_IE_DUYET);
  const MOC = "RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';";
  const PIN = /RAISE EXCEPTION 'l5_requires_plan' USING ERRCODE = '42501';/;

  function binhLuanHoa(sqlTho: string): string {
    const dong = sqlTho.split('\n');
    const i = dong.findIndex((d) => d.includes(MOC));
    expect(i, 'không tìm thấy dòng để đột biến').toBeGreaterThan(-1);
    dong[i] = `-- ${dong[i]}`;
    return dong.join('\n');
  }

  it('văn bản THÔ vẫn khớp pin sau khi bị bình luận hoá — đó chính là cái lỗ', () => {
    expect(binhLuanHoa(thoIeDuyet)).toMatch(PIN);
  });

  it('bản đã lột bình luận thì KHÔNG khớp nữa — cửa đã đóng', () => {
    expect(boCommentSql(binhLuanHoa(thoIeDuyet))).not.toMatch(PIN);
    expect(doc(FILE_IE_DUYET)).toMatch(PIN);
  });
});

describe('G5-C — chính sách vẫn L4: mọi action L5 của đợt này bị runtime từ chối cho tới G5-D', () => {
  it('registry policy hiện hành (seed từ 20260903043956) vẫn `max_direct_risk` = L4', () => {
    const seed = docSqlKhongComment('supabase/migrations/20260903043956_copilot_action_registry_policy_ledger_v1.sql');
    expect(seed).toMatch(/'L4'/);
  });

  it('đường chặn runtime `plan_risk_not_allowed` có thật trong `copilot_plan_create_v1`', () => {
    const sql = docSqlKhongComment('supabase/migrations/20260903100253_copilot_execution_plan_v1.sql');
    expect(sql).toMatch(/plan_risk_not_allowed/);
  });
});
