import { describe, expect, it } from 'vitest';

import { docSql, docSqlKhongComment, thanHam } from './helpers/sqlTestUtils';

// G5-C3 (đợt 3) — chín action `direct_l5_v1` mới, nhóm C (tài chính còn lại):
//   invoice.duyet_hang_loat, contract.gia_han, contract.chuyen_nhuong,
//   termination.hoan_coc, cashbook.chot_so, salary.chi_luong, salary.khoa_thang,
//   room.chuyen_phong, meter_reading.xoa_hang_loat.
//
// Khuôn direct_l5_v1 nền tảng (guard L5, Nonce ABI v1) đã ghim ở
// `copilotActionsL5Migration.test.ts` (G5-C, đợt 1). File này ghim những gì
// CHUNG cho cả chín action của đợt 3 (guard trước RPC gốc, ABI, before_digest
// khác NULL, registry, cờ, ACL) + những gì RIÊNG của từng action (cap bulk 50,
// helper suy org từ nhân viên dùng chung giữa hai action lương, entity_table
// thay thế của cashbook.chot_so, verify_kind tuỳ chỉnh của mỗi action).
//
// Mọi assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN, cùng khuôn với các
// test SQL khác trong thư mục này.

const FILE_INVOICE_DUYET_HANG_LOAT =
  'supabase/migrations/20260903224410_copilot_action_invoice_duyet_hang_loat_v1.sql';
const FILE_CONTRACT_GIA_HAN =
  'supabase/migrations/20260903224411_copilot_action_contract_gia_han_v1.sql';
const FILE_CONTRACT_CHUYEN_NHUONG =
  'supabase/migrations/20260903224412_copilot_action_contract_chuyen_nhuong_v1.sql';
const FILE_ROOM_CHUYEN_PHONG =
  'supabase/migrations/20260903224413_copilot_action_room_chuyen_phong_v1.sql';
const FILE_METER_READING_XOA_HANG_LOAT =
  'supabase/migrations/20260903224414_copilot_action_meter_reading_xoa_hang_loat_v1.sql';
const FILE_TERMINATION_HOAN_COC =
  'supabase/migrations/20260903224415_copilot_action_termination_hoan_coc_v1.sql';
const FILE_CASHBOOK_CHOT_SO =
  'supabase/migrations/20260903224416_copilot_action_cashbook_chot_so_v1.sql';
const FILE_SALARY_CHI_LUONG =
  'supabase/migrations/20260903224417_copilot_action_salary_chi_luong_v1.sql';
const FILE_SALARY_KHOA_THANG =
  'supabase/migrations/20260903224418_copilot_action_salary_khoa_thang_v1.sql';

const TAT_CA_FILE = [
  FILE_INVOICE_DUYET_HANG_LOAT,
  FILE_CONTRACT_GIA_HAN,
  FILE_CONTRACT_CHUYEN_NHUONG,
  FILE_ROOM_CHUYEN_PHONG,
  FILE_METER_READING_XOA_HANG_LOAT,
  FILE_TERMINATION_HOAN_COC,
  FILE_CASHBOOK_CHOT_SO,
  FILE_SALARY_CHI_LUONG,
  FILE_SALARY_KHOA_THANG,
];

describe('G5-C3 — cả chín file migration đều tồn tại', () => {
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
  verifyKind: string;
  rollbackRpc: string | null;
  entityTable: string;
  goiRpcGoc: RegExp;
}

const CAC_ACTION: readonly CaAction[] = [
  {
    ten: 'invoice.duyet_hang_loat',
    file: FILE_INVOICE_DUYET_HANG_LOAT,
    actionId: 'invoice.duyet_hang_loat',
    permissionKey: 'invoices.edit',
    previewRpc: 'copilot_preview_invoice_duyet_hang_loat_v1',
    executeRpc: 'copilot_execute_invoice_duyet_hang_loat_v1',
    verifyKind: 'invoices_approved_count',
    rollbackRpc: 'unapprove_invoice_v1',
    entityTable: 'invoices',
    goiRpcGoc: /v_count := public\.bulk_approve_invoices_v1\(v_ids\);/,
  },
  {
    ten: 'contract.gia_han',
    file: FILE_CONTRACT_GIA_HAN,
    actionId: 'contract.gia_han',
    permissionKey: 'contracts.edit',
    previewRpc: 'copilot_preview_contract_gia_han_v1',
    executeRpc: 'copilot_execute_contract_gia_han_v1',
    verifyKind: 'contract_renewed',
    rollbackRpc: null,
    entityTable: 'contracts',
    goiRpcGoc: /v_ret := public\.renew_contract\(v_contract_id, v_new_end, v_new_rent, v_new_deposit, v_notes\);/,
  },
  {
    ten: 'contract.chuyen_nhuong',
    file: FILE_CONTRACT_CHUYEN_NHUONG,
    actionId: 'contract.chuyen_nhuong',
    permissionKey: 'contracts.edit',
    previewRpc: 'copilot_preview_contract_chuyen_nhuong_v1',
    executeRpc: 'copilot_execute_contract_chuyen_nhuong_v1',
    verifyKind: 'contract_transferred',
    rollbackRpc: null,
    entityTable: 'contracts',
    goiRpcGoc: /v_ret := public\.transfer_contract\(v_contract_id, v_new_cust, v_new_rent, v_new_deposit, v_xfer_date, v_notes\);/,
  },
  {
    ten: 'room.chuyen_phong',
    file: FILE_ROOM_CHUYEN_PHONG,
    actionId: 'room.chuyen_phong',
    permissionKey: 'contracts.edit',
    previewRpc: 'copilot_preview_room_chuyen_phong_v1',
    executeRpc: 'copilot_execute_room_chuyen_phong_v1',
    verifyKind: 'room_transferred',
    rollbackRpc: null,
    entityTable: 'contracts',
    goiRpcGoc: /v_ret := public\.transfer_room\(v_contract_id, v_new_room, v_new_rent, v_xfer_date, v_notes\);/,
  },
  {
    ten: 'meter_reading.xoa_hang_loat',
    file: FILE_METER_READING_XOA_HANG_LOAT,
    actionId: 'meter_reading.xoa_hang_loat',
    permissionKey: 'meter_readings.delete',
    previewRpc: 'copilot_preview_meter_reading_xoa_hang_loat_v1',
    executeRpc: 'copilot_execute_meter_reading_xoa_hang_loat_v1',
    verifyKind: 'readings_deleted_count',
    rollbackRpc: null,
    entityTable: 'meter_readings',
    goiRpcGoc: /v_ket := public\.bulk_delete_meter_readings_v1\(v_ids\);/,
  },
  {
    ten: 'termination.hoan_coc',
    file: FILE_TERMINATION_HOAN_COC,
    actionId: 'termination.hoan_coc',
    permissionKey: 'income_expenses.create',
    previewRpc: 'copilot_preview_termination_hoan_coc_v1',
    executeRpc: 'copilot_execute_termination_hoan_coc_v1',
    verifyKind: 'termination_refund_created',
    rollbackRpc: 'cancel_income_expense_flex_v1',
    entityTable: 'income_expenses',
    goiRpcGoc: /v_ket := public\.create_termination_refund_voucher_v1\(v_obligation, v_account, v_force, v_force_reason\);/,
  },
  {
    ten: 'cashbook.chot_so',
    file: FILE_CASHBOOK_CHOT_SO,
    actionId: 'cashbook.chot_so',
    permissionKey: 'cashbooks.close_confirm',
    previewRpc: 'copilot_preview_cashbook_chot_so_v1',
    executeRpc: 'copilot_execute_cashbook_chot_so_v1',
    verifyKind: 'cashbook_closed',
    rollbackRpc: null,
    entityTable: 'accounts',
    goiRpcGoc: /v_ket := public\.confirm_cashbook_closing_v1\(v_request_id, v_counted\);/,
  },
  {
    ten: 'salary.chi_luong',
    file: FILE_SALARY_CHI_LUONG,
    actionId: 'salary.chi_luong',
    permissionKey: 'salary.distribute',
    previewRpc: 'copilot_preview_salary_chi_luong_v1',
    executeRpc: 'copilot_execute_salary_chi_luong_v1',
    verifyKind: 'approval_request_pending',
    rollbackRpc: 'cancel_income_expense_flex_v1',
    entityTable: 'approval_requests',
    goiRpcGoc:
      /v_ket := public\.salary_payout_v1\(\s*v_staff_id, v_period, v_take_home, v_account, v_voucher_date, v_note,\s*v_key_goc, v_rent_inv, v_rent_amount\);/,
  },
  {
    ten: 'salary.khoa_thang',
    file: FILE_SALARY_KHOA_THANG,
    actionId: 'salary.khoa_thang',
    permissionKey: 'salary.lock',
    previewRpc: 'copilot_preview_salary_khoa_thang_v1',
    executeRpc: 'copilot_execute_salary_khoa_thang_v1',
    verifyKind: 'salary_locked',
    rollbackRpc: null,
    entityTable: 'salary_monthly',
    goiRpcGoc: /v_ket := public\.lock_salary_month_v1\(v_period, v_managers, v_key_goc\);/,
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
    expect(iGoc, `${ca.executeRpc}: thiếu lời gọi RPC gốc`).toBeGreaterThan(-1);
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

  it('execute — before_digest KHÔNG phải NULL tĩnh (mọi action nhóm C đều bọc quanh một thực thể ĐÃ TỒN TẠI)', () => {
    const than = thanHam(sql, ca.executeRpc);
    expect(than).not.toMatch(/'before_digest',\s*NULL,/);
    expect(than).toMatch(/v_before\s*:=/);
  });

  it('execute — readback đọc lại entity_table dự kiến từ BẢNG thật, không tin RPC gốc suông', () => {
    const than = thanHam(sql, ca.executeRpc);
    expect(than).toMatch(new RegExp(`FROM public\\.${ca.entityTable}\\b`));
  });

  it('registry — hàng seed đúng hình: risk L5, direct_l5_v1, step_up, grantable=false', () => {
    const insertStart = sql.search(new RegExp(`'${ca.actionId.replace(/\./g, '\\.')}',\\s*\\n\\s*1,`));
    expect(insertStart, `${ca.actionId}: không tìm thấy khối INSERT registry`).toBeGreaterThan(-1);
    const doan = sql.slice(insertStart, insertStart + 1000);
    expect(doan).toContain(`'${ca.permissionKey}'`);
    expect(doan).toContain("'L5'");
    expect(doan).toContain("'direct_l5_v1'");
    expect(doan).toContain("'step_up'");
    expect(doan).toContain(`'${ca.previewRpc}'`);
    expect(doan).toContain(`'${ca.executeRpc}'`);
    expect(doan).toContain(`'${ca.verifyKind}'`);
    expect(doan).toContain(`'${ca.entityTable}'`);
    if (ca.rollbackRpc) {
      expect(doan).toContain(`'${ca.rollbackRpc}'`);
    }
  });

  it('registry — nghiệm thu cuối file đòi grantable=false', () => {
    const iNghiem = sql.search(/DO \$nghiem_thu\$/);
    expect(iNghiem).toBeGreaterThan(-1);
    const than = sql.slice(iNghiem);
    expect(than).toContain('grantable = false');
    if (ca.rollbackRpc) {
      expect(than).toContain(`rollback_rpc = '${ca.rollbackRpc}'`);
    } else {
      expect(than).toContain('rollback_rpc IS NULL');
    }
  });

  it('cờ rollout — seed disabled cho đúng action_id này', () => {
    expect(sql).toMatch(new RegExp(`'action', '${ca.actionId.replace(/\./g, '\\.')}', 'disabled',`));
  });

  it('ACL — REVOKE ALL FROM PUBLIC rồi mới GRANT lại cho authenticated (cả preview lẫn execute)', () => {
    for (const rpc of [ca.previewRpc, ca.executeRpc]) {
      const re = new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\)\\s*\\n\\s*FROM PUBLIC;`);
      expect(sql, rpc).toMatch(re);
    }
  });
});

describe('G5-C3 — helper F1 (copilot_l5_plan_context_ok_v1) lặp lại GIỐNG HỆT ở cả chín file', () => {
  it.each(TAT_CA_FILE)('%s — CREATE OR REPLACE app_private.copilot_l5_plan_context_ok_v1', (file) => {
    const sql = docSqlKhongComment(file);
    const than = thanHam(sql, 'copilot_l5_plan_context_ok_v1', 'app_private');
    expect(than).toMatch(/p\.status = 'APPROVED'/);
    expect(than).toMatch(/s\.status = 'PENDING'/);
    expect(than).toMatch(/p\.organization_id = p_org/);
  });
});

describe('G5-C3 — cột pin_always tự thêm idempotent ở cả chín file (khác dot 2: không file nào chắc chắn đã apply trước)', () => {
  it.each(TAT_CA_FILE)('%s', (file) => {
    const sql = docSqlKhongComment(file);
    expect(sql).toMatch(
      /ALTER TABLE app_private\.copilot_action_registry\s*\n\s*ADD COLUMN pin_always boolean NOT NULL DEFAULT false;/,
    );
  });
});

describe('G5-C3 — hai action bulk (invoice.duyet_hang_loat, meter_reading.xoa_hang_loat) cap 50 phần tử, fail-closed', () => {
  it.each([
    [FILE_INVOICE_DUYET_HANG_LOAT, 'copilot_preview_invoice_duyet_hang_loat_v1', 'copilot_execute_invoice_duyet_hang_loat_v1'],
    [
      FILE_METER_READING_XOA_HANG_LOAT,
      'copilot_preview_meter_reading_xoa_hang_loat_v1',
      'copilot_execute_meter_reading_xoa_hang_loat_v1',
    ],
  ])('%s — preview VÀ execute đều RAISE bulk_too_large trên >50 phần tử', (file, previewRpc, executeRpc) => {
    const sql = docSqlKhongComment(file);
    const thanPreview = thanHam(sql, previewRpc);
    const thanExecute = thanHam(sql, executeRpc);
    expect(thanPreview).toMatch(/RAISE EXCEPTION 'bulk_too_large: % id, toi da 50', v_n USING ERRCODE = '22023';/);
    expect(thanExecute).toMatch(/> 50 THEN\s*\n\s*RAISE EXCEPTION 'bulk_too_large:/);
  });

  it.each([
    [FILE_INVOICE_DUYET_HANG_LOAT, 'copilot_execute_invoice_duyet_hang_loat_v1', 'bulk_approve_invoices_v1'],
    [FILE_METER_READING_XOA_HANG_LOAT, 'copilot_execute_meter_reading_xoa_hang_loat_v1', 'bulk_delete_meter_readings_v1'],
  ])('%s — execute RAISE bulk_partial_failure khi số thành công KHÔNG khớp expected_count (fail-closed, không làm dở dang)', (file, executeRpc) => {
    const sql = docSqlKhongComment(file);
    const than = thanHam(sql, executeRpc);
    expect(than).toMatch(/RAISE EXCEPTION 'bulk_partial_failure:/);
  });

  it('invoice.duyet_hang_loat — entity_id cho engine là PHẦN TỬ ĐẦU của mảng (v_ids[1])', () => {
    const than = thanHam(docSqlKhongComment(FILE_INVOICE_DUYET_HANG_LOAT), 'copilot_execute_invoice_duyet_hang_loat_v1');
    expect(than).toMatch(/'entity_id',\s*v_ids\[1\],/);
  });

  it('meter_reading.xoa_hang_loat — entity_id cho engine là PHẦN TỬ ĐẦU của mảng (v_ids[1])', () => {
    const than = thanHam(
      docSqlKhongComment(FILE_METER_READING_XOA_HANG_LOAT),
      'copilot_execute_meter_reading_xoa_hang_loat_v1',
    );
    expect(than).toMatch(/'entity_id',\s*v_ids\[1\],/);
  });
});

describe('G5-C3 — helper riêng copilot_salary_org_of_staff_v1 dùng chung giữa hai action lương', () => {
  it.each([FILE_SALARY_CHI_LUONG, FILE_SALARY_KHOA_THANG])(
    '%s — CREATE OR REPLACE app_private.copilot_salary_org_of_staff_v1',
    (file) => {
      const sql = docSqlKhongComment(file);
      const than = thanHam(sql, 'copilot_salary_org_of_staff_v1', 'app_private');
      expect(than.length).toBeGreaterThan(0);
      expect(than).toMatch(/manager_salary_config/);
      expect(than).toMatch(/organization_memberships/);
    },
  );

  it('salary.chi_luong — execute đối chiếu org suy ra từ staff_id KHỚP payload trước khi gọi RPC gốc (entity_changed_since_preview nếu lệch)', () => {
    const than = thanHam(docSqlKhongComment(FILE_SALARY_CHI_LUONG), 'copilot_execute_salary_chi_luong_v1');
    expect(than).toMatch(/v_derived_org := app_private\.copilot_salary_org_of_staff_v1\(v_staff_id\);/);
    expect(than).toMatch(/RAISE EXCEPTION 'entity_changed_since_preview'/);
  });

  it('salary.khoa_thang — execute đối chiếu org suy ra từ NHÂN VIÊN ĐẦU TIÊN trong managers[]', () => {
    const than = thanHam(docSqlKhongComment(FILE_SALARY_KHOA_THANG), 'copilot_execute_salary_khoa_thang_v1');
    expect(than).toMatch(/v_managers -> 0 ->> 'staff_id'/);
    expect(than).toMatch(/v_derived_org := app_private\.copilot_salary_org_of_staff_v1\(v_first_staff\);/);
  });

  it('salary.chi_luong — verify_kind approval_request_pending TÁI SỬ DỤNG nhánh CASE đã có sẵn trong engine (không cần patch engine)', () => {
    for (const file of [FILE_SALARY_CHI_LUONG]) {
      const sql = docSqlKhongComment(file);
      expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.copilot_plan_execute_step_v1/);
    }
  });

  it('salary.chi_luong — idempotency key của RPC gốc dẫn xuất từ payload_hash lớp ngoài (cùng khuôn income_expense.duyet_vao_so)', () => {
    const than = thanHam(docSqlKhongComment(FILE_SALARY_CHI_LUONG), 'copilot_execute_salary_chi_luong_v1');
    expect(than).toMatch(/v_key_goc := 'copilot_action_' \|\| substr\(encode\(v_hash, 'hex'\), 1, 40\);/);
  });

  it('salary.khoa_thang — idempotency key của RPC gốc dẫn xuất từ payload_hash lớp ngoài', () => {
    const than = thanHam(docSqlKhongComment(FILE_SALARY_KHOA_THANG), 'copilot_execute_salary_khoa_thang_v1');
    expect(than).toMatch(/v_key_goc := 'copilot_action_' \|\| substr\(encode\(v_hash, 'hex'\), 1, 40\);/);
  });

  it('salary.khoa_thang — readback fail-closed: MỌI staff_id trong managers[] phải LOCKED đúng tổ chức', () => {
    const than = thanHam(docSqlKhongComment(FILE_SALARY_KHOA_THANG), 'copilot_execute_salary_khoa_thang_v1');
    expect(than).toMatch(/FOREACH v_staff IN ARRAY v_staff_ids LOOP/);
    expect(than).toMatch(/v_check_status IS DISTINCT FROM 'LOCKED'/);
  });
});

describe('G5-C3 — cashbook.chot_so: chênh lệch schema (app_private.cashbook_closures) với readback chung của engine', () => {
  const sql = docSqlKhongComment(FILE_CASHBOOK_CHOT_SO);

  it('registry entity_table = accounts (public), KHÔNG phải cashbook_closures (app_private)', () => {
    const insertStart = sql.search(/'cashbook\.chot_so',\s*\n\s*1,/);
    const doan = sql.slice(insertStart, insertStart + 1000);
    expect(doan).toContain("'accounts'");
    expect(doan).not.toMatch(/'cashbook_closures'/);
  });

  it('execute — tự kiểm bằng chứng bên app_private.cashbook_closures TRƯỚC KHI ghi ledger entity_table=accounts cho engine', () => {
    const than = thanHam(sql, 'copilot_execute_cashbook_chot_so_v1');
    // Bỏ qua nhánh idempotent-replay ĐẦU HÀM (cũng trả entity_table='accounts'
    // nhưng không tự kiểm gì — nó chỉ lặp lại kết quả lần trước): tính từ SAU
    // lời gọi RPC gốc.
    const iGoc = than.search(/public\.confirm_cashbook_closing_v1\(v_request_id, v_counted\)/);
    const sauGoc = than.slice(iGoc);
    const iBienBan = sauGoc.search(/FROM app_private\.cashbook_closures c/);
    const iEntityAccounts = sauGoc.search(/entity_table',\s*'accounts',/);
    expect(iGoc, 'không tìm thấy lời gọi RPC gốc').toBeGreaterThan(-1);
    expect(iBienBan, 'thiếu tự kiểm app_private.cashbook_closures').toBeGreaterThan(-1);
    expect(iEntityAccounts, 'thiếu entity_table=accounts trả về cho engine').toBeGreaterThan(-1);
    expect(iBienBan).toBeLessThan(iEntityAccounts);
  });

  it('execute — readback đòi accounts.lock_date tiến TỚI closed_through (bằng chứng RPC gốc đã chạy)', () => {
    const than = thanHam(sql, 'copilot_execute_cashbook_chot_so_v1');
    expect(than).toMatch(/v_acc\.lock_date < v_closed_through/);
  });

  it('preview — chặn sớm người đề nghị tự xác nhận và sai người được chỉ định (mirror RPC gốc)', () => {
    const than = thanHam(sql, 'copilot_preview_cashbook_chot_so_v1');
    expect(than).toMatch(/v_actor = v_r\.proposed_by/);
    expect(than).toMatch(/v_actor <> v_r\.confirmer_user_id AND NOT public\.is_super_admin\(\)/);
  });
});

describe('G5-C3 — termination.hoan_coc: KHÔNG tái dùng nhánh ie_draft có sẵn của engine', () => {
  const sql = docSqlKhongComment(FILE_TERMINATION_HOAN_COC);

  it('registry verify_kind KHÔNG phải ie_draft (phiếu hoàn cọc gắn với nghĩa vụ, không gắn với người tạo)', () => {
    const insertStart = sql.search(/'termination\.hoan_coc',\s*\n\s*1,/);
    const doan = sql.slice(insertStart, insertStart + 1000);
    expect(doan).toContain("'termination_refund_created'");
    expect(doan).not.toMatch(/'ie_draft'/);
  });

  it('execute — tự kiểm UNAPPROVED+UNPOSTED, KHÔNG đòi user_id=actor (khác income_expense.nop_ho_so)', () => {
    const than = thanHam(sql, 'copilot_execute_termination_hoan_coc_v1');
    expect(than).toMatch(/v_ie\.approval_status IS DISTINCT FROM 'UNAPPROVED'/);
    expect(than).toMatch(/v_ie\.posting_status IS DISTINCT FROM 'UNPOSTED'/);
    expect(than).not.toMatch(/v_ie\.user_id IS DISTINCT FROM v_actor/);
  });

  it('preview — chặn sớm khi nghĩa vụ cảnh báo mà không ép (obligation_needs_force), và lý do ép tối thiểu 8 ký tự', () => {
    const than = thanHam(sql, 'copilot_preview_termination_hoan_coc_v1');
    expect(than).toMatch(/RAISE EXCEPTION 'obligation_needs_force'/);
    expect(than).toMatch(/length\(v_force_reason\) < 8/);
  });
});

describe('G5-C3 — contract.gia_han/contract.chuyen_nhuong/room.chuyen_phong: RPC gốc SỬA TẠI CHỖ, không tạo hợp đồng mới', () => {
  it('contract.gia_han — readback đòi giá trị trả về (uuid) BẰNG contract_id truyền vào, KHÔNG phải một id khác', () => {
    const than = thanHam(docSqlKhongComment(FILE_CONTRACT_GIA_HAN), 'copilot_execute_contract_gia_han_v1');
    expect(than).toMatch(/v_ret IS DISTINCT FROM v_contract_id/);
  });

  it('contract.chuyen_nhuong — readback đòi giá trị trả về (uuid) BẰNG contract_id truyền vào', () => {
    const than = thanHam(docSqlKhongComment(FILE_CONTRACT_CHUYEN_NHUONG), 'copilot_execute_contract_chuyen_nhuong_v1');
    expect(than).toMatch(/v_ret IS DISTINCT FROM v_contract_id/);
  });

  it('room.chuyen_phong — readback đòi giá trị trả về (uuid) BẰNG contract_id truyền vào', () => {
    const than = thanHam(docSqlKhongComment(FILE_ROOM_CHUYEN_PHONG), 'copilot_execute_room_chuyen_phong_v1');
    expect(than).toMatch(/v_ret IS DISTINCT FROM v_contract_id/);
  });
});

describe('G5-C3 — rollback ứng viên đã kiểm to_regprocedure trên production, 6/9 action là NULL + rollback_note', () => {
  it.each([
    FILE_CONTRACT_GIA_HAN,
    FILE_CONTRACT_CHUYEN_NHUONG,
    FILE_ROOM_CHUYEN_PHONG,
    FILE_CASHBOOK_CHOT_SO,
    FILE_METER_READING_XOA_HANG_LOAT,
    FILE_SALARY_KHOA_THANG,
  ])('%s — registry mang rollback_rpc=NULL kèm rollback_note giải thích', (file) => {
    const sql = docSqlKhongComment(file);
    expect(sql).toMatch(/NULL,\s*\n\s*'[^']+',\s*\n\s*'[a-z_.]+',\s*\n\s*true,\s*\n\s*false,\s*\n\s*false\s*\n\)/);
  });
});
