import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

// G2-D dựng ba action L3 theo Nonce ABI v1 (`income_expense.annotate`,
// `reservation.set_hold_terms`, `zalo.set_conversation_flags`) và nối cặp writer
// thu/chi đang chạy vào cổng hành động + sổ.
//
// TEST NÀY GHIM MỘT THỨ DUY NHẤT: THỨ TỰ.
//   Nonce ABI v1 không phải là "gọi đủ mấy hàm"; nó là gọi ĐÚNG THỨ TỰ. Đảo hai
//   bước bất kỳ đều mở một cửa:
//     · cổng sau CAS `consumed_at`  ⇒ một action đang tắt vẫn tiêu được nonce
//     · advisory lock sau khi tra sổ audit ⇒ hai lượt cùng key cùng thấy "chưa
//       có" rồi cùng ghi
//     · RPC gốc trước CAS ⇒ hai cú bấm nhanh ghi hai lần
//   Nên mọi assertion dưới đây so VỊ TRÍ CHUỖI tăng dần, không chỉ "có mặt".
//
// MỌI assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN — cùng lý do đã ghi ở
// `copilotActionRegistryMigration.test.ts`: soi văn bản thô thì một hàng rào bị
// `-- ` hoá vẫn khớp regex trong khi Postgres đã ngừng đọc nó.
//
// Đây là test ĐỌC FILE. Hành vi thật do khối nghiệm thu trong từng migration và
// hai lượt dry-run trên production đo.

interface CaAction {
  ten: string;
  file: string;
  actionId: string;
  permissionKey: string;
  previewRpc: string;
  executeRpc: string;
  rpcGoc: string;
  entityTable: string;
}

const CAC_ACTION: readonly CaAction[] = [
  {
    ten: 'income_expense.annotate',
    file: 'supabase/migrations/20260903072353_copilot_action_income_expense_annotate_v1.sql',
    actionId: 'income_expense.annotate',
    permissionKey: 'income_expenses.edit',
    previewRpc: 'copilot_preview_income_expense_annotate_v1',
    executeRpc: 'copilot_execute_income_expense_annotate_v1',
    rpcGoc: 'annotate_income_expense_v1',
    entityTable: 'income_expenses',
  },
  {
    ten: 'reservation.set_hold_terms',
    file: 'supabase/migrations/20260903072912_copilot_action_reservation_hold_terms_v1.sql',
    actionId: 'reservation.set_hold_terms',
    permissionKey: 'deposits.edit',
    previewRpc: 'copilot_preview_reservation_hold_terms_v1',
    executeRpc: 'copilot_execute_reservation_hold_terms_v1',
    rpcGoc: 'set_reservation_hold_terms_v1',
    entityTable: 'reservation_hold_deadlines',
  },
  {
    ten: 'zalo.set_conversation_flags',
    file: 'supabase/migrations/20260903073048_copilot_action_zalo_conversation_flags_v1.sql',
    actionId: 'zalo.set_conversation_flags',
    permissionKey: 'chat_zalo.view',
    previewRpc: 'copilot_preview_zalo_conversation_flags_v1',
    executeRpc: 'copilot_execute_zalo_conversation_flags_v1',
    rpcGoc: 'zalo_set_conversation_flags',
    entityTable: 'zalo_conversations',
  },
];

const FILE_IE = CAC_ACTION[0].file;

/** Bản thô của migration đầu — CHỈ dùng cho bài kiểm đột biến ở cuối file. */
const thoIE = docSql(FILE_IE);

function doc(file: string): string {
  return boCommentSql(docSql(file));
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

describe.each(CAC_ACTION)('G2-D — action L3 $ten', (ca) => {
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
      expect(t).toMatch(
        /SET search_path = pg_catalog, public, app_private, extensions/,
      );
    }
  });

  it('xem trước: cổng chạy TRƯỚC khi phát nonce và trước khi tra thực thể', () => {
    const t = than(sql, ca.previewRpc);
    thuTuTang(t, [
      ['kiểm đăng nhập', /IF v_actor IS NULL THEN\s*\n\s*RAISE EXCEPTION 'unauthenticated'/],
      ['kiểm tổ chức', /organization_required/],
      ['cổng hành động', new RegExp(`copilot_action_gate_v1\\(\\s*\\n?\\s*'${ca.actionId.replace('.', '\\.')}'`)],
      ['fail-closed theo tổ chức', /entity_not_found/],
      ['dựng canonical', /v_canonical := jsonb_build_object\(/],
      ['ghi hàng xác nhận', /INSERT INTO app_private\.copilot_write_confirmations/],
      ['trả nonce một lần', /'confirmation_nonce',\s*encode\(v_nonce, 'hex'\)/],
    ]);
    // Hàng xác nhận phải mang ĐÚNG action_id làm `tool` và đúng khoá quyền —
    // đó là hợp đồng mà execute so lại, và lệch một chữ là mở đường tiêu nonce
    // của action này cho action khác.
    expect(t).toMatch(new RegExp(`'${ca.actionId.replace('.', '\\.')}', app_private\\.copilot_payload_hash_v1`));
    expect(t).toMatch(new RegExp(`'${ca.permissionKey.replace('.', '\\.')}', clock_timestamp\\(\\) \\+ interval '5 minutes'`));
  });

  it('thực thi: 9 bước đúng thứ tự ABI', () => {
    const t = than(sql, ca.executeRpc);
    thuTuTang(t, [
      ['regex nonce', /p_confirmation_nonce !~ '\^\[0-9a-fA-F\]\{64\}\$'/],
      ['khoá hàng xác nhận', /FOR UPDATE/],
      ['so hợp đồng tool/permission', /confirmation_contract_mismatch/],
      ['so payload_hash', /payload_changed/],
      ['cổng hành động lần hai', new RegExp(`copilot_action_gate_v1\\('${ca.actionId.replace('.', '\\.')}'`)],
      ['advisory lock', /pg_advisory_xact_lock\(hashtextextended\(v_key, 0\)\)/],
      ['tra sổ audit', /FROM public\.ai_write_audit a/],
      ['CAS consumed_at', /SET consumed_at = clock_timestamp\(\)/],
      ['gọi RPC gốc', new RegExp(`PERFORM public\\.${ca.rpcGoc}\\(`)],
      ['ghi ai_write_audit', /INSERT INTO public\.ai_write_audit/],
      ['ghi sổ hành động', /copilot_ledger_append_v1\(jsonb_build_object\(\s*\n\s*'event',\s*'action_executed'/],
    ]);
  });

  it('thực thi: readback hai đầu và digest sha256 của to_jsonb(row)', () => {
    const t = than(sql, ca.executeRpc);
    expect(t).toMatch(/SELECT to_jsonb\([a-z]+\) INTO v_before/);
    expect(t).toMatch(/SELECT to_jsonb\([a-z]+\) INTO v_after/);
    expect(t).toMatch(
      /extensions\.digest\(\s*\n?\s*convert_to\(v_after(::text)?, 'UTF8'\), 'sha256'\)|extensions\.digest\(convert_to\(v_after::text, 'UTF8'\), 'sha256'\)/,
    );
    expect(t).toMatch(/'entity_table',\s*'/);
    expect(t).toMatch(new RegExp(`'${ca.entityTable}'`));
  });

  it('thực thi: nhánh lặp trả `da_thuc_hien_truoc_do`, nhánh thường trả `da_thuc_hien`', () => {
    const t = than(sql, ca.executeRpc);
    expect(t).toMatch(/'status',\s*'da_thuc_hien_truoc_do'/);
    expect(t).toMatch(/'status',\s*'da_thuc_hien'/);
    expect(t).toMatch(/'ledger_id',\s*v_ledger_id/);
    // Khoá idempotency phải mang đủ 4 chiều: action, người, tổ chức, payload.
    expect(t).toMatch(
      new RegExp(
        `v_key := 'copilot_action:${ca.actionId.replace('.', '\\.')}:' \\|\\| v_actor::text`,
      ),
    );
    expect(t).toMatch(/\|\| v_org::text \|\| ':' \|\| encode\(v_hash, 'hex'\)/);
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
  });

  it('ACL: REVOKE PUBLIC/anon/service_role/authenticated rồi GRANT authenticated', () => {
    for (const ten of [ca.previewRpc, ca.executeRpc]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${ten}\\([a-z, ]+\\)\\s*\\n?\\s*FROM PUBLIC;`));
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

  it('registry: một hàng risk L3 / nonce_abi_v1 / click, đúng khoá quyền và cặp RPC', () => {
    expect(sql).toMatch(/INSERT INTO app_private\.copilot_action_registry/);
    expect(sql).toMatch(new RegExp(`'${ca.actionId.replace('.', '\\.')}',`));
    expect(sql).toMatch(/\n\s*'L3',\n\s*'nonce_abi_v1',\n\s*'click',/);
    expect(sql).toMatch(new RegExp(`'${ca.permissionKey.replace('.', '\\.')}',\\n\\s*'L3',`));
    expect(sql).toMatch(new RegExp(`'${ca.previewRpc}',\\n\\s*'${ca.executeRpc}',`));
    expect(sql).toMatch(/ON CONFLICT \(action_id\) DO NOTHING;/);
    // `rollback_rpc` không được rỗng: một action L3 mà không ai biết lùi thế nào
    // thì nó không phải L3.
    expect(sql).toMatch(new RegExp(`'${ca.rpcGoc}',`));
  });

  it('cờ kill switch: seed `disabled`, kẹp giữa hai lần set_config transition v2', () => {
    const iMo = sql.indexOf("set_config('app.copilot_feature_flag_transition', 'v2', true)");
    const iSeed = sql.indexOf('INSERT INTO public.copilot_feature_flags');
    const iDong = sql.indexOf("set_config('app.copilot_feature_flag_transition', '', true)");
    expect(iMo).toBeGreaterThan(-1);
    expect(iSeed).toBeGreaterThan(iMo);
    expect(iDong).toBeGreaterThan(iSeed);
    expect(sql).toMatch(
      new RegExp(`'action', '${ca.actionId.replace('.', '\\.')}', 'disabled'`),
    );
    expect(sql).toMatch(/ON CONFLICT \(scope, contract_id\) DO NOTHING;/);
  });

  it('khối nghiệm thu chỉ soi catalog — chạy được trên database rỗng', () => {
    const iNghiemThu = sql.indexOf('DO $nghiem_thu$');
    expect(iNghiemThu).toBeGreaterThan(-1);
    const khoi = sql.slice(iNghiemThu);
    expect(khoi).toMatch(/to_regprocedure\(/);
    // Chỉ được đọc bảng của CHÍNH file này (registry + cờ). Một truy vấn vào
    // bảng nghiệp vụ sẽ chết trên baseline schema-only và cuộn ngược cả file.
    for (const bang of ['public.income_expenses', 'public.zalo_conversations', 'public.reservation_hold_deadlines']) {
      expect(khoi).not.toMatch(new RegExp(`FROM ${bang.replace('.', '\\.')}\\b`));
    }
  });
});

describe('G2-D — action `income_expense.annotate` chỉ đụng GHI CHÚ', () => {
  const sql = doc(FILE_IE);

  it('gọi annotate_income_expense_v1 với hai tham số đính kèm luôn NULL', () => {
    const t = than(sql, 'copilot_execute_income_expense_annotate_v1');
    expect(t).toMatch(
      /PERFORM public\.annotate_income_expense_v1\(\s*\n?\s*v_voucher, NULL, NULL, v_notes, 'REPLACE', v_key\);/,
    );
  });

  it('không có đường nào nhận `add_attachments` / `remove_attachments` từ payload', () => {
    for (const ten of [
      'copilot_preview_income_expense_annotate_v1',
      'copilot_execute_income_expense_annotate_v1',
    ]) {
      const t = than(sql, ten);
      expect(t).not.toMatch(/attachments/i);
    }
  });

  it('xem trước chốt phạm vi TOÀ khi không có quyền toàn công ty', () => {
    const t = than(sql, 'copilot_preview_income_expense_annotate_v1');
    expect(t).toMatch(/authorized_scope_v3\('income_expenses\.edit', p_organization_id\)/);
    expect(t).toMatch(/v_ie\.building_id = ANY\(COALESCE\(v_scope\.building_ids/);
  });
});

describe('G2-D — phiếu mức TỔ CHỨC đòi quyền mức tổ chức (fail-closed)', () => {
  // Bản đầu chỉ chặn khi `building_id IS NOT NULL`, nên một phiếu KHÔNG gắn toà
  // lọt qua với người chỉ có quyền ở một toà. Không có toà để so KHÔNG phải
  // "không có gì để kiểm" — nó là "không phạm vi nào bao được phiếu này".
  for (const ca of CAC_ACTION.filter((x) => x.entityTable !== 'zalo_conversations')) {
    it(`${ca.ten} — xem trước chặn khi building_id NULL mà không org_wide`, () => {
      const t = than(doc(ca.file), ca.previewRpc);
      expect(t).toMatch(/v_ie\.building_id IS NULL/);
      // Đúng hình dạng "NULL HOẶC không thuộc mảng", không phải "NOT NULL VÀ …".
      expect(t).toMatch(
        /AND \(v_ie\.building_id IS NULL\s*\n\s*OR NOT \(v_ie\.building_id = ANY\(/,
      );
      expect(t).not.toMatch(/AND v_ie\.building_id IS NOT NULL/);
    });
  }
});

describe('G2-D — cặp writer thu/chi được nối vào cổng + sổ', () => {
  const sql = doc(FILE_IE);

  it('vỏ xem trước gọi cổng TRƯỚC khi uỷ quyền cho legacy', () => {
    const t = than(sql, 'copilot_preview_income_expense_v1');
    thuTuTang(t, [
      ['cổng hành động', /copilot_action_gate_v1\(\s*\n?\s*'income_expense\.create_draft'/],
      ['uỷ quyền legacy', /copilot_preview_income_expense_legacy_v1\(/],
    ]);
  });

  it('vỏ thực thi tra hàng xác nhận TRƯỚC cổng, và cổng đo trên tổ chức CỦA HÀNG', () => {
    const t = than(sql, 'copilot_execute_income_expense_v1');
    thuTuTang(t, [
      ['regex nonce', /p_confirmation_nonce !~ '\^\[0-9a-fA-F\]\{64\}\$'/],
      ['tra hàng xác nhận', /FROM app_private\.copilot_write_confirmations c/],
      ['so người gọi', /v_row\.user_id IS DISTINCT FROM v_actor/],
      ['so hợp đồng tool/permission', /confirmation_contract_mismatch/],
      ['tổ chức lấy từ hàng', /v_org := v_row\.organization_id;/],
      ['payload lệch tổ chức', /v_org_payload IS DISTINCT FROM v_org/],
      ['hàng rào hạng mục hạn chế', /copilot_ie_type_allowed_v1\(v_org, v_type, v_type_id\)/],
      ['cổng hành động', /copilot_action_gate_v1\('income_expense\.create_draft', v_org\)/],
      ['uỷ quyền legacy', /copilot_execute_income_expense_legacy_v1\(/],
      ['chỉ ghi sổ khi ghi thật', /IF \(v_result ->> 'status'\) = 'da_tao' THEN/],
      ['ghi sổ hành động', /copilot_ledger_append_v1\(jsonb_build_object\(/],
      ['sự kiện action_executed', /'event',\s*'action_executed'/],
    ]);
    expect(t).toMatch(/'permission_snapshot',\s*v_snapshot/);
    expect(t).toMatch(/'consent_kind',\s*'click'/);
    expect(t).toMatch(/'consent_id',\s*v_row\.id/);
    expect(t).toMatch(/'audit_id',\s*NULLIF\(v_result ->> 'audit_id', ''\)::uuid/);
    // TỔ CHỨC KHÔNG ĐƯỢC LẤY TỪ PAYLOAD. `p_payload` chưa được chứng minh khớp
    // `payload_hash` tại thời điểm cổng chạy (`legacy` mới là nơi so hash), nên
    // đọc org từ đó là để NGƯỜI GỌI chọn công ty mà cổng sẽ đo — cổng và lệnh
    // cấm khẩn cấp đo nhầm chỗ, và dòng sổ mang tên một tổ chức không liên quan.
    expect(t).not.toMatch(/v_org := \(p_payload ->> 'organization_id'\)::uuid;/);
    expect(t).toMatch(/'organization_id',\s*v_org/);
  });

  it('lượt LẶP không sinh dòng sổ nào — sổ đếm số lần GHI, không phải số lần BẤM', () => {
    const t = than(sql, 'copilot_execute_income_expense_v1');
    const dieuKien = t.indexOf("IF (v_result ->> 'status') = 'da_tao' THEN");
    const ghiSo = t.indexOf('copilot_ledger_append_v1(');
    const dongIf = t.lastIndexOf('END IF;');
    expect(dieuKien).toBeGreaterThan(-1);
    expect(ghiSo).toBeGreaterThan(dieuKien);
    expect(dongIf).toBeGreaterThan(ghiSo);
    // Ba RPC L3 cùng đợt trả `da_thuc_hien_truoc_do` rồi RETURN TRƯỚC khi tới sổ;
    // vỏ IE phải kể cùng một câu chuyện cho cùng một tình huống.
    for (const ca of CAC_ACTION) {
      const tt = than(doc(ca.file), ca.executeRpc);
      const lap = tt.indexOf("'da_thuc_hien_truoc_do'");
      const soCuaCa = tt.search(/'event',\s*'action_executed'/);
      expect(lap).toBeGreaterThan(-1);
      expect(soCuaCa).toBeGreaterThan(lap);
    }
  });

  it('KHÔNG chép lại thân cũ: hàng rào hạng mục hạn chế của 20260831110236 còn nguyên', () => {
    // Bản kế hoạch bảo chép thân từ 20260830171108. Làm thế sẽ XOÁ vỏ kiểm hạng
    // mục hạn chế mà 20260831110236 dựng lên. Hai `expect` này là chỗ bắt việc đó.
    for (const ten of ['copilot_preview_income_expense_v1', 'copilot_execute_income_expense_v1']) {
      const t = than(sql, ten);
      expect(t).toMatch(/copilot_ie_type_allowed_v1\(/);
      expect(t).toMatch(/copilot_(preview|execute)_income_expense_legacy_v1\(/);
    }
    // Và tuyệt đối không dựng lại thân gốc (dấu hiệu: tự sinh nonce trong vỏ).
    expect(than(sql, 'copilot_preview_income_expense_v1')).not.toMatch(/gen_random_bytes/);
  });
});

describe('G2-D — đột biến: bình luận hoá cổng phải làm test ĐỎ', () => {
  const MOC = "copilot_action_gate_v1('income_expense.create_draft', v_org)";
  const PIN = /copilot_action_gate_v1\('income_expense\.create_draft', v_org\)/;

  function binhLuanHoaCong(sqlTho: string): string {
    const dong = sqlTho.split('\n');
    const i = dong.findIndex((d) => d.includes(MOC));
    expect(i, 'không tìm thấy dòng cổng để đột biến').toBeGreaterThan(-1);
    dong[i] = `-- ${dong[i]}`;
    return dong.join('\n');
  }

  it('văn bản THÔ vẫn khớp pin sau khi bị bình luận hoá — đó chính là cái lỗ', () => {
    expect(binhLuanHoaCong(thoIE)).toMatch(PIN);
  });

  it('bản đã lột bình luận thì KHÔNG khớp nữa — cửa đã đóng', () => {
    expect(boCommentSql(binhLuanHoaCong(thoIE))).not.toMatch(PIN);
    expect(doc(FILE_IE)).toMatch(PIN);
  });
});
