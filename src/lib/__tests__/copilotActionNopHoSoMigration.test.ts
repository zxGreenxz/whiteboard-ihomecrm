import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

// Hàng registry `income_expense.nop_ho_so` là LỐI VÀO duy nhất của đường
// `maker_submit_v1` — nhánh mà `copilot_plan_create_v1` và
// `copilot_plan_execute_step_v1` (20260903100253) đã hiện thực nhưng không có
// action nào khai. Mười ba giá trị trong hàng đó là hợp đồng: đổi một trường là
// đổi hành vi của máy kế hoạch mà không ai phải sửa một dòng code nào.
//
// MỌI assertion chạy trên bản ĐÃ LỘT BÌNH LUẬN. Ở một file gần như toàn INSERT,
// điều đó quan trọng hơn bình thường: khối giải thích ở đầu file có nhắc TỪNG
// giá trị của hàng seed, nên một bài kiểm soi văn bản thô sẽ xanh ngay cả khi
// lệnh INSERT đã bị bình luận hoá sạch.
const migrationPath =
  'supabase/migrations/20260903102931_copilot_action_income_expense_nop_ho_so_v1.sql';

const tho = docSql(migrationPath);
const migration = boCommentSql(tho);

/** Danh sách giá trị của lệnh INSERT vào registry, đã chuẩn hoá khoảng trắng. */
const khoiValues = (() => {
  const i = migration.search(/INSERT INTO app_private\.copilot_action_registry/i);
  if (i < 0) return '';
  const j = migration.indexOf('ON CONFLICT (action_id)', i);
  return migration.slice(i, j < 0 ? migration.length : j).replace(/\s+/g, ' ');
})();

describe('G3-T1 phụ — seed action income_expense.nop_ho_so', () => {
  it('tồn tại, một cặp BEGIN/COMMIT, không tạo/sửa hàm nào', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(migration.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
    // File này CHỈ gieo dữ liệu. Một `CREATE FUNCTION` lọt vào đây nghĩa là ai đó
    // đang sửa hành vi trong một migration mà tên nó nói là "thêm một hàng".
    expect(migration).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    expect(migration).not.toMatch(/CREATE TABLE/i);
    expect(migration).not.toMatch(/ALTER TABLE/i);
    expect(migration).not.toMatch(/DROP /i);
  });

  it('tiền đề CỨNG là registry + bảng cờ; máy kế hoạch chỉ cứng ở trạng thái nửa vời', () => {
    expect(migration).toMatch(/20260903043956 phai chay truoc/);
    expect(migration).toMatch(/20260828170000 phai chay truoc/);
    // Bảng kế hoạch ĐÃ có mà thiếu helper = 20260903100253 chạy dở dang, và một
    // hàng registry trỏ vào helper không tồn tại là cái bẫy im lặng đúng nghĩa.
    expect(migration).toMatch(
      /to_regclass\('app_private\.copilot_plans'\) IS NOT NULL\s*AND to_regprocedure\('app_private\.copilot_plan_submit_voucher_v1\(uuid, uuid, uuid, integer\)'\) IS NULL THEN\s*RAISE EXCEPTION/,
    );
    // Vắng hẳn thì chỉ cảnh báo: hàng này là DỮ LIỆU, nó nằm yên cho tới khi máy
    // kế hoạch chạy, và forward lane chạy theo tên file nên thứ tự luôn đúng.
    expect(migration).toMatch(
      /to_regclass\('app_private\.copilot_plans'\) IS NULL THEN\s*RAISE WARNING/,
    );
  });

  // Mười ba giá trị, ghim từng cái. Đây là toàn bộ nội dung của file.
  it('ghim đủ mười ba giá trị của hàng registry, đúng thứ tự cột', () => {
    expect(khoiValues).not.toBe('');
    const mong = [
      "'income_expense.nop_ho_so'",
      '1,',
      "'Nộp phiếu thu/chi vào hộp chờ duyệt'",
      "'income_expenses.create'",
      "'L5'",
      "'maker_submit_v1'",
      "'click'",
      "'approval_request_pending'",
      "'approval_requests'",
      "'income_expenses'",
      'NULL',
      "'income_expense.nop_ho_so'",
      'true',
    ];
    let vt = -1;
    for (const m of mong) {
      const moi = khoiValues.indexOf(m, vt + 1);
      expect(moi, `thiếu hoặc sai thứ tự: ${m}`).toBeGreaterThan(vt);
      vt = moi;
    }
    // `preview_rpc` và `execute_rpc` cùng mang tên helper — hai lần, không hơn.
    expect(
      (khoiValues.match(/'copilot_plan_submit_voucher_v1'/g) ?? []).length,
    ).toBe(2);
  });

  // Hàng phải qua CẢ HAI CHECK theo hàng của G2-A. Bài kiểm này đo chính chuỗi
  // tên hàm, không đo migration của G2-A — nên nó đỏ nếu ai đó đổi `execute_rpc`
  // sang một tên có động từ cấm mà quên rằng CSDL sẽ từ chối cả hàng.
  it('tên RPC trong hàng qua được l5_row_check và l6_forbidden', () => {
    const ten = 'copilot_plan_submit_voucher_v1';
    expect(ten).not.toMatch(
      /(approve|decide|_post_|posting|delete|remove|reverse|grant|revoke|permission|role)/,
    );
    expect(ten).not.toMatch(/(sql|secret|deploy|migration|drop|truncate|pg_)/);
    // Và đúng hình dạng mà `copilot_action_registry_rpc_name_shape` đòi.
    expect(ten).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)?$/);
  });

  // `flag_contract_id = action_id` có CHECK ở tầng dữ liệu; ghim ở đây vì hậu
  // quả khi lệch là kill switch bấm một chỗ, tắt một chỗ khác.
  it('flag_contract_id bằng action_id', () => {
    expect(migration).toMatch(/IF v_row\.flag_contract_id IS DISTINCT FROM v_row\.action_id THEN/);
  });

  it('quyền là quyền TẠO, không phải quyền duyệt', () => {
    expect(khoiValues).toContain("'income_expenses.create'");
    // `income_expenses.approve` là khoá của NGƯỜI DUYỆT. Xuất hiện ở đây nghĩa là
    // đường nộp hồ sơ đang đòi quyền duyệt — bước đầu tiên trên con đường mà cả
    // kiến trúc L5 dựng ra để chặn.
    expect(migration).not.toContain('income_expenses.approve');
  });

  it('không có RPC lùi, nhưng có ghi chú lùi', () => {
    expect(migration).toMatch(/Rut ho so qua giao dien duyet \(WITHDRAWN\/CANCELLED\)/);
  });

  it('gieo cờ ở trạng thái disabled, có dấu giao dịch v2, ON CONFLICT DO NOTHING', () => {
    expect(migration).toMatch(
      /SELECT set_config\('app\.copilot_feature_flag_transition', 'v2', true\);/,
    );
    expect(migration).toMatch(
      /SELECT set_config\('app\.copilot_feature_flag_transition', '', true\);/,
    );
    expect(migration).toMatch(
      /'action', 'income_expense\.nop_ho_so', 'disabled'/,
    );
    expect(migration).toMatch(/ON CONFLICT \(scope, contract_id\) DO NOTHING/);
    expect(migration).toMatch(/ON CONFLICT \(action_id\) DO NOTHING/);
    // Không bật gì. Bật là việc của đợt rollout, qua RPC CAS có reason/evidence.
    expect(migration).not.toMatch(/'shadow'/);
    expect(migration).not.toMatch(/'enabled'/);
    expect(migration).not.toMatch(/UPDATE public\.copilot_feature_flags/i);
  });

  it('chạy lại được lượt hai: chỉ hai INSERT, cả hai đều ON CONFLICT DO NOTHING', () => {
    const soInsert = (migration.match(/INSERT INTO/g) ?? []).length;
    const soOnConflict = (migration.match(/ON CONFLICT/g) ?? []).length;
    expect(soInsert).toBe(2);
    expect(soOnConflict).toBe(2);
  });
});

describe('G3-T1 phụ — nghiệm thu chỉ soi catalog và hai hàng vừa gieo', () => {
  const khoi = migration.slice(migration.lastIndexOf('DO $nghiem_thu$'));

  it('không đọc bảng nghiệp vụ nào (chạy được trên database rỗng)', () => {
    expect(khoi).not.toBe('');
    expect(khoi).not.toMatch(/FROM public\.income_expenses/);
    expect(khoi).not.toMatch(/FROM public\.approval_requests/);
    expect(khoi).not.toMatch(/FROM public\.organizations/);
    expect(khoi).not.toMatch(/INSERT INTO/);
  });

  it('kiểm từng trường của hàng, không chỉ kiểm hàng tồn tại', () => {
    for (const truong of [
      "v_row.risk IS DISTINCT FROM 'L5'",
      "v_row.executor_kind IS DISTINCT FROM 'maker_submit_v1'",
      "v_row.consent_required IS DISTINCT FROM 'click'",
      "v_row.permission_key IS DISTINCT FROM 'income_expenses.create'",
      "v_row.verify_kind IS DISTINCT FROM 'approval_request_pending'",
      "v_row.produces_entity_table IS DISTINCT FROM 'approval_requests'",
      "v_row.consumes_ref_table IS DISTINCT FROM 'income_expenses'",
      'v_row.rollback_rpc IS NOT NULL',
    ]) {
      expect(khoi, truong).toContain(truong);
    }
  });

  // Nếu bước trước không sinh ra đúng thứ bước này tiêu thụ thì `{$ref_step:n}`
  // bị `copilot_plan_create_v1` từ chối, và cả chuỗi "tạo nháp → nộp hồ sơ" chết
  // ở bước lập kế hoạch — muộn hơn ba giai đoạn so với chỗ phát hiện được.
  it('khẳng định chuỗi $ref_step có nghĩa: create_draft sinh ra income_expenses', () => {
    expect(khoi).toMatch(
      /r\.action_id = 'income_expense\.create_draft'\s*AND r\.produces_entity_table = v_row\.consumes_ref_table/,
    );
  });

  it('khẳng định cờ có mặt và helper tồn tại đúng chữ ký bốn tham số', () => {
    expect(khoi).toMatch(/copilot_rollout_seed_thieu_action_contract: income_expense\.nop_ho_so/);
    expect(khoi).toMatch(
      /to_regprocedure\('app_private\.copilot_plan_submit_voucher_v1\(uuid, uuid, uuid, integer\)'\) IS NULL/,
    );
  });
});

// ---------------------------------------------------------------------------
// Bài kiểm đột biến — chứng minh các pin ở trên KHÔNG phải màu xanh rỗng.
// Ở file này nó đáng giá hơn bình thường: khối chú thích đầu file nhắc TỪNG giá
// trị của hàng seed, nên một bài kiểm soi văn bản thô sẽ xanh cả khi lệnh INSERT
// đã bị bình luận hoá sạch.
// ---------------------------------------------------------------------------
describe('G3-T1 phụ — pin phải đỏ khi lệnh INSERT bị bình luận hoá', () => {
  function binhLuanHoaInsertRegistry(sql: string): string {
    const dong = sql.split('\n');
    const i = dong.findIndex((d) =>
      d.includes('INSERT INTO app_private.copilot_action_registry'));
    expect(i, 'không tìm thấy lệnh INSERT registry để đột biến').toBeGreaterThan(-1);
    // Nuốt cả khối cột + khối VALUES cho tới ON CONFLICT.
    for (let j = i; j < dong.length; j += 1) {
      const het = dong[j].includes('ON CONFLICT (action_id)');
      dong[j] = `-- ${dong[j]}`;
      if (het) break;
    }
    return dong.join('\n');
  }

  it('văn bản THÔ vẫn khớp mọi giá trị sau khi bị bình luận hoá — đó chính là cái lỗ', () => {
    const dotBien = binhLuanHoaInsertRegistry(tho);
    // Chú thích đầu file nhắc lại đủ giá trị, nên bản thô vẫn "trông đúng".
    expect(dotBien).toContain("'maker_submit_v1'");
    expect(dotBien).toContain("'approval_request_pending'");
  });

  it('bản đã lột bình luận thì khối VALUES biến mất — cửa đã đóng', () => {
    const dotBien = boCommentSql(binhLuanHoaInsertRegistry(tho));
    expect(dotBien).not.toMatch(/INSERT INTO app_private\.copilot_action_registry/);
    // `'approval_request_pending'` còn sót ở khối nghiệm thu là ĐÚNG — nó kiểm
    // hàng trong DATABASE, không kiểm văn bản. Thứ phải biến mất là khối VALUES.
    expect(dotBien).not.toMatch(/'maker_submit_v1',[\s\S]{0,20}'click'/);
    // Bản không đột biến vẫn khớp, để bài kiểm này không xanh vì lý do sai.
    expect(migration).toMatch(/INSERT INTO app_private\.copilot_action_registry/);
    expect(khoiValues).toContain("'approval_request_pending'");
  });
});
