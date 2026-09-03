// Contract test cho migration vá bảo mật G1-FIXWAVE.
//
// Mười sáu hàm ở đây ĐÃ chạy trên production; migration này chỉ CREATE OR REPLACE
// cùng chữ ký. Không thể gọi thật từ vitest (cần cluster + JWT), nên thứ được
// ghim là đúng cái mà một lần "dọn dẹp" sau này dễ đánh rơi nhất: hàng rào quyền,
// predicate sao chép từ RLS, cửa cờ rollout, và escape của LIKE.
//
// MỌI assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN. Bốn file test G1 trước
// đây chạy regex trên văn bản thô, nên `-- AND b.id = ANY(v_buildings)` vẫn làm
// test xanh. Xem `sqlTestUtils.test.ts` để thấy bài kiểm đột biến của luật này.
import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, dongCoLike, thanHam } from './helpers/sqlTestUtils';

const DUONG_DAN = 'supabase/migrations/20260903050215_copilot_read_rpc_hardening_v2.sql';
const tho = docSql(DUONG_DAN);
const sql = boCommentSql(tho);

/** Bốn migration G1 mà bản v2 này thay thân — chữ ký phải khớp khít từng cái. */
const NGUON: Record<string, string> = {
  contracts: 'supabase/migrations/20260902193151_copilot_read_rpc_contracts_ie_approvals_v1.sql',
  operations: 'supabase/migrations/20260902203258_copilot_read_rpc_operations_v1.sql',
  reports: 'supabase/migrations/20260902213111_copilot_report_rpc_v1.sql',
  sensitive: 'supabase/migrations/20260902224859_copilot_read_rpc_sensitive_v1.sql',
};
const nguonSql: Record<string, string> = Object.fromEntries(
  Object.entries(NGUON).map(([ten, path]) => [ten, docSql(path)]),
);

/** Mười sáu hàm được phát hành lại, kèm migration đã ship chúng lần đầu. */
const HAM: Record<string, keyof typeof NGUON> = {
  copilot_contract_search_v1: 'contracts',
  copilot_income_expense_search_v1: 'contracts',
  copilot_pending_requests_v1: 'contracts',
  copilot_lead_search_v1: 'operations',
  copilot_meter_readings_v1: 'operations',
  copilot_vehicle_search_v1: 'operations',
  copilot_material_stock_v1: 'operations',
  copilot_invoice_search_v1: 'operations',
  copilot_customer_search_v1: 'operations',
  copilot_report_expense_ratio_v1: 'reports',
  copilot_report_daily_cashbook_v1: 'reports',
  copilot_report_cash_flow_v1: 'reports',
  copilot_salary_summary_v1: 'sensitive',
  copilot_shareholder_profit_v1: 'sensitive',
  copilot_zalo_conversations_v1: 'sensitive',
  copilot_network_status_v1: 'sensitive',
};

/**
 * KHOÁ QUYỀN THEO TỪNG HÀM, KHAI TƯỜNG MINH.
 *
 * Bản test cũ dùng regex `[a-z_]+\.view`, thứ khớp với BẤT KỲ khoá nào — đổi
 * `salary.view` thành `leads.view` vẫn xanh. Một bảng tra tay thì đổi khoá là
 * phải sửa test, và đó chính là lúc người sửa phải nghĩ.
 */
const KHOA_QUYEN: Record<string, string> = {
  copilot_contract_search_v1: 'contracts.view',
  copilot_income_expense_search_v1: 'income_expenses.view',
  copilot_pending_requests_v1: 'income_expenses.view',
  copilot_lead_search_v1: 'leads.view',
  copilot_meter_readings_v1: 'meter_readings.view',
  copilot_vehicle_search_v1: 'vehicles.view',
  copilot_material_stock_v1: 'materials.view',
  copilot_invoice_search_v1: 'invoices.view',
  copilot_customer_search_v1: 'customers.view',
  copilot_report_expense_ratio_v1: 'reports_real_estate.expense_ratio',
  copilot_report_daily_cashbook_v1: 'reports_finance.daily_cashbook',
  copilot_report_cash_flow_v1: 'reports_finance.cash_flow',
  copilot_salary_summary_v1: 'salary.view',
  copilot_shareholder_profit_v1: 'shareholder_profit.view',
  copilot_zalo_conversations_v1: 'chat_zalo.view',
  copilot_network_status_v1: 'network_center.view',
};

/** Ba tool miền nhạy cảm và contract cờ rollout của chúng (A5). */
const CO_ROLLOUT: Record<string, string> = {
  copilot_salary_summary_v1: 'copilot.sensitive.salary',
  copilot_shareholder_profit_v1: 'copilot.sensitive.shareholder-profit',
  copilot_network_status_v1: 'copilot.sensitive.network',
};

const than = (ten: string, schema = 'public') => boCommentSql(thanHam(tho, ten, schema));

describe('migration khung — một giao dịch, chỉ thay thân, nghiệm thu bằng catalog', () => {
  it('tồn tại và là một giao dịch có trần khoá', () => {
    expect(tho).not.toBe('');
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('mọi DDL đều là CREATE OR REPLACE — chạy lại lượt hai không hỏng', () => {
    expect(sql.match(/^\s*CREATE (?!OR REPLACE)[A-Z]/gm) ?? []).toEqual([]);
  });

  it('không ghi một dòng dữ liệu nào', () => {
    expect(sql).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+\w+\.|DELETE\s+FROM|TRUNCATE)\b/i);
  });

  it('nghiệm thu chỉ soi catalog nên chạy được trên DB rỗng', () => {
    const start = sql.indexOf('DO $nghiem_thu$');
    expect(start).toBeGreaterThan(0);
    const block = sql.slice(start);
    expect(block).toMatch(/to_regprocedure/);
    expect(block).toMatch(/has_function_privilege\('anon'/);
    expect(block).toMatch(/has_function_privilege\('service_role'/);
    // Một SELECT vào bảng nghiệp vụ ở đây sẽ phá tính chất "chạy trên DB rỗng".
    expect(block).not.toMatch(/FROM public\.[a-z_]+/i);
  });

  it('khai rõ tiền đề thay vì để lỗi hiện ra dưới dạng "function does not exist"', () => {
    const start = sql.indexOf('DO $tien_de$');
    expect(start).toBeGreaterThan(0);
    const block = sql.slice(start, sql.indexOf('$tien_de$;') + 10);
    expect(block).toContain('app_private.copilot_fold_text_v1(text)');
    expect(block).toContain('public.copilot_org_scope_buildings_v1(text, uuid)');
    expect(block).toContain('app_private.authorized_scope_v3(text, uuid)');
    expect(block).toContain('public.copilot_feature_flags');
  });

  it('phát hành lại đúng 16 hàm, không thừa không thiếu', () => {
    const lan = sql.match(/CREATE OR REPLACE FUNCTION public\.copilot_/g) ?? [];
    expect(lan).toHaveLength(Object.keys(HAM).length);
    expect(Object.keys(HAM)).toHaveLength(16);
  });
});

describe('chữ ký không được xê dịch — CREATE OR REPLACE lệch chữ ký là đẻ overload', () => {
  for (const [ham, nguon] of Object.entries(HAM)) {
    it(`${ham}: chữ ký khớp nguyên văn ${nguon}`, () => {
      const cu = chuKyHam(nguonSql[nguon], ham);
      const moi = chuKyHam(tho, ham);
      expect(cu, `${ham}: không đọc được chữ ký gốc`).not.toBe('');
      expect(moi, `${ham}: không được phát hành lại ở migration này`).not.toBe('');
      expect(moi, `${ham}: chữ ký đã xê dịch -> sẽ đẻ overload chứ không thay thế`).toBe(cu);
    });
  }
});

describe('A1 — PERFORM không phải hàng rào; quyền phải được ĐỌC và phải RAISE', () => {
  // Ba hàm từng chỉ `PERFORM` helper rồi vứt kết quả. Helper trả mảng RỖNG cho
  // người không có quyền (nó chỉ raise khi thiếu tổ chức / mất tư cách thành
  // viên), nên "PERFORM helper" khẳng định tư cách thành viên và KHÔNG khẳng
  // định quyền. Ghim cả ba mảnh: đọc scope, gán vào biến, và raise 42501.
  // CỬA PHẢI ĐỌC ĐÚNG SỐ TRỤC MÀ KHOÁ ĐÓ CÓ.
  //
  // `authorized_scope_v3` trả ba trục (org_wide, building_ids, cashbook_ids),
  // nhưng khoá nào CÓ trục nào là do `permission_definitions.scope_kinds` quyết
  // định (20260713110100). Đọc THIẾU một trục mà khoá thật sự có = khoá cửa vào
  // mặt người được cấp hợp lệ; đọc THỪA một trục mà khoá không có = viết một
  // predicate không bao giờ chạy rồi tưởng đó là hàng rào. Bảng dưới chép từ
  // migration khai quyền, không suy từ tên khoá.
  const TRUC_CUA_KHOA: Record<string, { cashbook: boolean }> = {
    // income_expenses.view = {ORGANIZATION, AREA, BUILDING, CASHBOOK} — :96
    copilot_pending_requests_v1: { cashbook: true },
    // materials.view = {ORGANIZATION, AREA, BUILDING}
    copilot_material_stock_v1: { cashbook: false },
  };

  for (const ham of ['copilot_material_stock_v1', 'copilot_pending_requests_v1'] as const) {
    it(`${ham}: đọc authorized_scope_v3 đúng khoá rồi raise not_permitted khi rỗng`, () => {
      const body = than(ham);
      expect(body, ham).not.toBe('');
      const khoa = KHOA_QUYEN[ham].replace('.', '\\.');
      expect(body, `${ham}: không đọc authorized_scope_v3 với khoá của chính trang`).toMatch(
        new RegExp(String.raw`authorized_scope_v3\('${khoa}', p_organization_id\)`),
      );
      const coSoQuy = TRUC_CUA_KHOA[ham].cashbook;
      expect(body, `${ham}: không GÁN kết quả scope vào biến`).toMatch(
        coSoQuy ? /INTO v_org_wide, v_buildings, v_cashbooks/ : /INTO v_org_wide, v_buildings/,
      );
      if (coSoQuy) {
        // Người giữ MỘT SỔ QUỸ và không toà nào là người được cấp hợp lệ. Cửa
        // chỉ nhìn org_wide + buildings sẽ khoá đúng thủ quỹ ra khỏi hộp duyệt
        // của chính họ — fail-closed nhầm người vẫn là một lỗi.
        expect(body, `${ham}: cửa bỏ quên trục SỔ QUỸ mà khoá này có`).toMatch(
          /IF NOT v_org_wide\s*\n\s*AND COALESCE\(cardinality\(v_buildings\), 0\) = 0\s*\n\s*AND COALESCE\(cardinality\(v_cashbooks\), 0\) = 0 THEN/,
        );
      } else {
        expect(body, `${ham}: thiếu cửa fail-closed`).toMatch(
          /IF NOT v_org_wide AND COALESCE\(cardinality\(v_buildings\), 0\) = 0 THEN/,
        );
        // Khoá không có trục CASHBOOK thì không được đọc trục đó: một predicate
        // luôn-rỗng đội lốt hàng rào là thứ khó thấy nhất khi đọc lại.
        expect(body, `${ham}: đọc trục SỔ QUỸ cho một khoá không có trục đó`).not.toMatch(
          /v_cashbooks/,
        );
      }
      expect(body, ham).toMatch(/RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501'/);
    });
  }

  it('copilot_salary_summary_v1: salary.view vẫn bắt buộc, thiếu là 42501', () => {
    const body = than('copilot_salary_summary_v1');
    expect(body).toMatch(/authorized_scope_v3\('salary\.view', p_organization_id\)/);
    expect(body).toMatch(/INTO v_xem_duoc, v_buildings/);
    expect(body).toMatch(
      /IF NOT v_xem_duoc AND COALESCE\(cardinality\(v_buildings\), 0\) = 0 THEN/,
    );
    // Mọi khoá `salary.*` là {ORGANIZATION} — không có trục SỔ QUỸ để đọc.
    expect(body).not.toMatch(/v_cashbooks/);
  });

  it('PERFORM còn lại chỉ để giữ mã lỗi tổ chức, luôn đi kèm một cửa thật', () => {
    // Giữ `PERFORM` là có chủ ý: nó khiến một tổ chức sai vẫn trả
    // `organization_required` (22023) thay vì `not_permitted` (42501). Nhưng
    // hàm nào còn PERFORM thì BẮT BUỘC phải có thêm một lần đọc authorized_scope_v3.
    for (const [ham] of Object.entries(HAM)) {
      const body = than(ham);
      if (!/PERFORM\s+public\.copilot_org_scope_buildings_v1/.test(body)) continue;
      expect(body, `${ham}: còn PERFORM mà không có cửa quyền thật`).toMatch(
        /authorized_scope_v3\(/,
      );
      expect(body, `${ham}: còn PERFORM mà không raise 42501`).toMatch(/ERRCODE = '42501'/);
    }
  });

  it('không hàm nào chỉ PERFORM helper mà bỏ qua kết quả', () => {
    for (const ham of Object.keys(HAM)) {
      const body = than(ham);
      const coPerform = /PERFORM\s+public\.copilot_org_scope_buildings_v1/.test(body);
      const coGan = /v_buildings\s*:=\s*public\.copilot_org_scope_buildings_v1/.test(body);
      // `copilot_invoice_search_v1` là `LANGUAGE sql`: nó không có biến để gán,
      // nên nó nhúng THẲNG lời gọi vào predicate — dạng dùng-kết-quả chặt nhất.
      const coNhung = /=\s*ANY\(public\.copilot_org_scope_buildings_v1\(/.test(body);
      const coScope = /authorized_scope_v3\(/.test(body);
      expect(
        coPerform || coGan || coNhung || coScope,
        `${ham}: không có hàng rào tổ chức nào`,
      ).toBe(true);
      if (coPerform && !coGan) {
        expect(coScope, `${ham}: PERFORM đơn độc — đúng lỗ hổng A1`).toBe(true);
      }
    }
  });
});

describe('A2/A3 — hàng KHÔNG gắn toà phải mang đúng predicate của RLS', () => {
  it('copilot_vehicle_search_v1: chép predicate của vehicles_select_rbac', () => {
    const body = than('copilot_vehicle_search_v1');
    expect(body).toMatch(/v\.building_id IS NULL/);
    expect(body).toMatch(/v\.user_id = ANY\(public\.current_visible_owner_ids\(\)\)/);
    // Nhánh org_wide đơn độc chính là lỗ hổng — nó không được phép còn.
    expect(body).not.toMatch(/\(b\.id IS NOT NULL OR \(v\.building_id IS NULL AND v_org_wide\)\)/);
  });

  it('copilot_meter_readings_v1: chỉ admin đọc được chỉ số không gắn toà', () => {
    const body = than('copilot_meter_readings_v1');
    const predicate =
      /\(b\.id IS NOT NULL OR \(mr\.building_id IS NULL AND v_org_wide AND \(public\.is_admin\(\) OR public\.is_super_admin\(\)\)\)\)/g;
    // Hai chỗ: khối tổng hợp và khối danh sách. Vá một chỗ quên chỗ kia thì con
    // số tổng vẫn rò rỉ đúng thứ mà danh sách đã che.
    expect(body.match(predicate) ?? []).toHaveLength(2);
    expect(body).not.toMatch(/\(b\.id IS NOT NULL OR \(mr\.building_id IS NULL AND v_org_wide\)\)/);
  });

  it('vẫn ràng kết quả vào tập toà của server', () => {
    for (const ham of [
      'copilot_meter_readings_v1',
      'copilot_vehicle_search_v1',
      'copilot_lead_search_v1',
    ] as const) {
      const body = than(ham);
      expect(body, ham).toMatch(/v_buildings\s*:=\s*public\.copilot_org_scope_buildings_v1\(/);
      expect(body, ham).toMatch(/b\.id\s*=\s*ANY\(v_buildings\)/);
    }
  });
});

describe('A4 — "cả công ty" của bảng lương là ba khoá QUẢN LÝ, không phải salary.view', () => {
  const body = () => than('copilot_salary_summary_v1');

  it('công tắc org-wide đọc lock / manage_salary / distribute', () => {
    const b = body();
    for (const khoa of ['salary.lock', 'salary.manage_salary', 'salary.distribute']) {
      expect(b, khoa).toContain(`'${khoa}'`);
    }
    expect(b).toMatch(/bool_or\(COALESCE\(s\.org_wide, false\)\)\s*INTO v_org_wide/);
  });

  it('salary.view KHÔNG còn là công tắc org-wide', () => {
    const b = body();
    // Khoá vẫn phải có mặt (nó là điều kiện để hỏi), nhưng không được nằm ở
    // dòng gán v_org_wide.
    expect(b).toMatch(/authorized_scope_v3\('salary\.view', p_organization_id\)/);
    expect(b).not.toMatch(/INTO v_org_wide\s*\n\s*FROM app_private\.authorized_scope_v3\('salary\.view'/);
  });

  it('câu trả lời tự khai phạm vi nó sinh ra từ nhánh nào', () => {
    expect(body()).toMatch(/'pham_vi', CASE WHEN v_org_wide THEN 'toan_cong_ty' ELSE '\w+' END/);
  });

  it('không có grant nào thì lọc về đúng dòng của chính người hỏi', () => {
    expect(body()).toMatch(/v_org_wide OR sm\.staff_id = v_actor/);
  });
});

describe('A5 — cờ rollout được đọc TRÊN SERVER, deny-by-default', () => {
  it('helper tồn tại, STABLE, SECURITY DEFINER, search_path ghim', () => {
    const body = than('copilot_page_flag_allows_v1', 'app_private');
    expect(body).not.toBe('');
    expect(body).toMatch(/RETURNS boolean/);
    expect(body).toMatch(/\bSTABLE\b/);
    expect(body).toMatch(/\bSECURITY DEFINER\b/);
    expect(body).toMatch(/SET search_path = pg_catalog, public, app_private/);
  });

  it('helper từ chối theo cả bốn hướng có thể sai', () => {
    const body = than('copilot_page_flag_allows_v1', 'app_private');
    expect(body).toMatch(/f\.scope = 'page'/);
    expect(body).toMatch(/f\.contract_id = p_contract_id/);
    expect(body).toMatch(/f\.state IN \('shadow', 'enabled'\)/);
    expect(body).toMatch(/f\.canary_org IS NULL OR f\.canary_org = p_organization_id/);
    expect(body).toMatch(/f\.expires_at IS NULL OR f\.expires_at > now\(\)/);
    // EXISTS: không có dòng nào = false. Đó là deny-by-default.
    expect(body).toMatch(/SELECT EXISTS \(/);
  });

  for (const [ham, contract] of Object.entries(CO_ROLLOUT)) {
    it(`${ham}: gọi cửa cờ với contract ${contract} và raise đúng mã`, () => {
      const body = than(ham);
      expect(body, ham).toContain(
        `app_private.copilot_page_flag_allows_v1('${contract}', p_organization_id)`,
      );
      expect(body, ham).toMatch(
        /IF NOT app_private\.copilot_page_flag_allows_v1\([^)]*\) THEN/,
      );
      expect(body, ham).toMatch(
        /RAISE EXCEPTION 'copilot_feature_disabled' USING ERRCODE = '42501'/,
      );
    });
  }

  it('chỉ ba hàm miền nhạy cảm mang cửa cờ — không quét bừa sang hàm khác', () => {
    const goi = sql.match(/copilot_page_flag_allows_v1\('copilot\.sensitive\./g) ?? [];
    expect(goi).toHaveLength(3);
  });

  for (const ham of Object.keys(CO_ROLLOUT)) {
    it(`${ham}: khẳng định TỔ CHỨC chạy TRƯỚC cửa cờ`, () => {
      // Một tổ chức không tồn tại / không ACTIVE / không phải của mình phải nghe
      // `organization_required` (22023) — mã panel dùng để bảo "chọn công ty".
      // Nếu cửa cờ chạy trước, cùng câu hỏi đó trả `copilot_feature_disabled`:
      // vừa sai hướng dẫn cho người dùng, vừa là một oracle nhỏ (câu trả lời phụ
      // thuộc vào một dòng rollout thay vì vào tư cách thành viên).
      const body = than(ham);
      const viTriToChuc = body.search(/copilot_org_scope_buildings_v1\(/);
      const viTriCo = body.search(/copilot_page_flag_allows_v1\(/);
      expect(viTriToChuc, `${ham}: không có khẳng định tổ chức`).toBeGreaterThan(-1);
      expect(viTriCo, `${ham}: không có cửa cờ`).toBeGreaterThan(-1);
      expect(
        viTriToChuc,
        `${ham}: cửa cờ đứng TRƯỚC khẳng định tổ chức — tổ chức rác sẽ trả 42501 thay vì 22023`,
      ).toBeLessThan(viTriCo);
    });
  }
});

describe('A6 — LIKE có escape, cửa sổ ngày có trần, service_role bị cắt', () => {
  it('helper escape thoát đúng ba ký tự và thoát backslash TRƯỚC', () => {
    const body = than('copilot_like_escape_v1', 'app_private');
    expect(body).not.toBe('');
    expect(body).toMatch(/\bIMMUTABLE\b/);
    // Thứ tự không phải chuyện thẩm mỹ: thoát backslash sau cùng sẽ nhân đôi
    // chính những backslash mà hàm này vừa chèn vào.
    const thuTu = body.match(/replace\(/g) ?? [];
    expect(thuTu).toHaveLength(3);
    expect(body.indexOf("'%'")).toBeGreaterThan(body.indexOf("'\\'"));
  });

  it('KHÔNG còn một LIKE/ILIKE nào thiếu ESCAPE', () => {
    // Quét trên bản đã lột bình luận, và chỉ tính LIKE nằm NGOÀI chuỗi literal:
    // chữ "LIKE" trong một câu COMMENT không phải toán tử.
    const moiLike = dongCoLike(sql);
    const thieu = moiLike.filter((dong) => !/ESCAPE\s+'\\'/.test(dong));
    expect(thieu, `LIKE thiếu ESCAPE:\n${thieu.join('\n')}`).toHaveLength(0);
    expect(moiLike.length).toBeGreaterThanOrEqual(20);
  });

  it('mọi needle đi qua copilot_like_escape_v1', () => {
    const needle = sql.match(/v_needle := CASE[\s\S]*?END;/g) ?? [];
    expect(needle.length).toBeGreaterThanOrEqual(6);
    for (const khoi of needle) {
      expect(khoi).toContain('app_private.copilot_like_escape_v1(');
    }
    // Hai hàm nội suy thẳng p_search / v_query cũng phải qua helper.
    expect(than('copilot_invoice_search_v1')).not.toMatch(/ILIKE '%' \|\| p_search \|\| '%'/);
    expect(than('copilot_customer_search_v1')).not.toMatch(/ILIKE '%' \|\| v_query \|\| '%'/);
  });

  it('ba báo cáo tài chính chặn cửa sổ ngày quá ba năm', () => {
    for (const ham of [
      'copilot_report_daily_cashbook_v1',
      'copilot_report_cash_flow_v1',
      'copilot_report_expense_ratio_v1',
    ] as const) {
      const body = than(ham);
      expect(body, ham).toMatch(/> 1096/);
      expect(body, ham).toMatch(/RAISE EXCEPTION 'invalid_date_window' USING ERRCODE = '22023'/);
    }
  });

  it('join khách hàng của tìm-hoá-đơn đã có bộ lọc công ty và xoá mềm', () => {
    const body = than('copilot_invoice_search_v1');
    expect(body).toMatch(/c\.organization_id = p_organization_id/);
    expect(body).toMatch(/c\.deleted_at IS NULL/);
    expect(body).toMatch(/cc\.organization_id = p_organization_id/);
  });

  it('REVOKE service_role cho đủ 24 RPC của hai migration operations/report', () => {
    for (const ham of [
      'copilot_lead_search_v1',
      'copilot_meter_readings_v1',
      'copilot_vehicle_search_v1',
      'copilot_tasks_v1',
      'copilot_material_stock_v1',
      'copilot_available_rooms_v1',
      'copilot_invoice_search_v1',
      'copilot_financial_pnl_v1',
      'copilot_occupancy_v1',
      'copilot_occupancy_upcoming_v1',
      'copilot_invoice_stats_v1',
      'copilot_deposit_summary_v1',
      'copilot_customer_search_v1',
      'copilot_expiring_contracts_v1',
      'copilot_report_vacant_rooms_v1',
      'copilot_report_renewals_v1',
      'copilot_report_terminations_v1',
      'copilot_report_new_leases_v1',
      'copilot_report_expense_ratio_v1',
      'copilot_report_daily_cashbook_v1',
      'copilot_report_cash_flow_v1',
      'copilot_report_payment_schedule_v1',
      'copilot_report_overpayment_v1',
      'copilot_report_deposits_v1',
    ]) {
      expect(sql, ham).toMatch(
        new RegExp(String.raw`REVOKE ALL ON FUNCTION public\.${ham}\([^)]*\) FROM service_role;`),
      );
    }
  });

  it('mọi lệnh phụ thuộc vai đều có guard to_regrole', () => {
    expect(sql).toMatch(/IF to_regrole\('anon'\) IS NOT NULL THEN/);
    expect(sql).toMatch(/IF to_regrole\('authenticated'\) IS NOT NULL THEN/);
    expect(sql).toMatch(/IF to_regrole\('service_role'\) IS NOT NULL THEN/);
  });
});

describe('ACL — mọi hàm phát hành lại giữ nguyên bộ quyền của nó', () => {
  for (const ham of Object.keys(HAM)) {
    it(`${ham}: revoke PUBLIC/anon/authenticated rồi grant lại authenticated`, () => {
      for (const vai of ['PUBLIC', 'anon', 'authenticated']) {
        expect(sql, `${ham} / ${vai}`).toMatch(
          new RegExp(String.raw`REVOKE ALL ON FUNCTION public\.${ham}\([^)]*\) FROM ${vai};`),
        );
      }
      expect(sql, ham).toMatch(
        new RegExp(String.raw`GRANT EXECUTE ON FUNCTION public\.${ham}\([^)]*\) TO authenticated;`),
      );
    });
  }

  it('hai helper app_private ở lại mức chủ sở hữu, không grant cho ai', () => {
    for (const helper of [
      String.raw`app_private\.copilot_like_escape_v1\(text\)`,
      String.raw`app_private\.copilot_page_flag_allows_v1\(text, uuid\)`,
    ]) {
      for (const vai of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
        expect(sql, `${helper} / ${vai}`).toMatch(
          new RegExp(String.raw`REVOKE ALL ON FUNCTION ${helper} FROM ${vai};`),
        );
      }
      expect(sql, helper).not.toMatch(
        new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${helper} TO`),
      );
    }
  });
});

describe('D2 — chú thích của material_stock nói đúng việc helper KHÔNG từ chối', () => {
  it('COMMENT mới đính chính câu "helper denies" của migration cũ', () => {
    const start = sql.indexOf('COMMENT ON FUNCTION public.copilot_material_stock_v1');
    expect(start).toBeGreaterThan(0);
    const comment = sql.slice(start, sql.indexOf(';', start));
    expect(comment).toMatch(/does NOT deny/i);
    expect(comment).toMatch(/authorized_scope_v3/);
    expect(comment).toMatch(/42501/);
  });
});

describe('biên giới công ty — mọi alias có organization_id đều mang bộ lọc', () => {
  /** Alias có cột `organization_id` trong từng thân hàm, liệt kê tay. */
  const ALIAS: Record<string, string[]> = {
    copilot_lead_search_v1: ['l', 'b', 'rm'],
    copilot_meter_readings_v1: ['mr', 'b', 'rm'],
    copilot_vehicle_search_v1: ['v', 'b', 'rm', 'cst'],
    copilot_material_stock_v1: ['m', 'mc'],
    copilot_zalo_conversations_v1: ['c'],
  };

  for (const [ham, aliases] of Object.entries(ALIAS)) {
    it(`${ham}: ${aliases.join(', ')}`, () => {
      const body = than(ham);
      for (const alias of aliases) {
        expect(body, `${ham}: alias "${alias}" thiếu organization_id = p_organization_id`).toMatch(
          new RegExp(String.raw`\b${alias}\.organization_id\s*=\s*p_organization_id\b`),
        );
      }
    });
  }
});
