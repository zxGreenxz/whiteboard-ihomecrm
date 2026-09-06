import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

// Bài này canh migration 20260906010543 — fast-follow của G5-C3.
//
// Hàng registry `salary.khoa_thang` mang một dòng runbook SAI: "Khong tim thay
// unlock_salary_month_v1 tren production … muon mo khoa thi can thiep DB tay".
// Đo lại 06/09/2026: hàm CÓ THẬT trên production với chữ ký
// `(p_period_month date, p_staff_ids uuid[], p_idempotency_key text)`. Một ghi chú
// nói "không có đường lùi" khi đường lùi tồn tại thì tệ hơn không ghi gì — nó đẩy
// người trực đi sửa `salary_monthly` bằng tay, bỏ qua cửa quyền `salary.unlock`,
// khoá tổ chức và sổ `canonical_write_operations`.
//
// Nhưng hàm đó KHÔNG được tạo bởi migration nào trong repo (drift prod↔lane), nên
// phép ghi phải có điều kiện `to_regprocedure`: trên DB rỗng của Restore Drill hàm
// không tồn tại và registry phải TIẾP TỤC nói NULL. Bài này canh cả hai nhánh.
const duongDan =
  'supabase/migrations/20260906010543_copilot_action_salary_khoa_thang_rollback_v1.sql';
const tho = docSql(duongDan);
const migration = boCommentSql(tho);

// File đóng băng vẫn sống trong repo — dùng chính nó làm phép đo đột biến thay vì
// chép một bản vào file test.
const dongBang = boCommentSql(
  docSql('supabase/migrations/20260903224418_copilot_action_salary_khoa_thang_v1.sql'),
);

describe('migration 20260906010543 — khung file', () => {
  it('đọc được file migration', () => {
    expect(tho.length).toBeGreaterThan(0);
  });

  it('đúng một cặp BEGIN/COMMIT và có lock_timeout', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('chỉ cập nhật DỮ LIỆU registry, không DDL, không đụng hàm nào', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(migration).not.toMatch(/DROP FUNCTION/);
    expect(migration).not.toMatch(/ALTER TABLE/);
    expect(migration).not.toMatch(/CREATE TABLE/);
    expect(migration.match(/UPDATE app_private\.copilot_action_registry/g)).toHaveLength(1);
  });

  it('chạy lại hai lượt không hỏng: UPDATE có WHERE khoá chính, không INSERT', () => {
    expect(migration).toMatch(/WHERE action_id = 'salary\.khoa_thang';/);
    expect(migration).not.toMatch(/INSERT INTO app_private\.copilot_action_registry/);
  });
});

describe('migration 20260906010543 — phép ghi CÓ ĐIỀU KIỆN, không nói tên hàm không gọi được', () => {
  it('gác bằng to_regprocedure đúng chữ ký ba tham số', () => {
    expect(migration.match(/to_regprocedure\('public\.unlock_salary_month_v1\(date, uuid\[\], text\)'\)/g))
      .toHaveLength(2); // một ở khối ghi, một ở khối nghiệm thu
  });

  it('không có hàm thì THOÁT sớm, không ghi gì', () => {
    expect(migration).toMatch(/IF NOT v_co_ham THEN[\s\S]*?RETURN;[\s\S]*?END IF;/);
  });

  it('đòi hàng seed phải có trước — thứ tự migration là điều kiện, không phải may mắn', () => {
    expect(migration).toMatch(/khong thay hang registry salary\.khoa_thang/);
  });

  it('điền đúng tên hàm nghịch đảo', () => {
    expect(migration).toMatch(/SET rollback_rpc = 'unlock_salary_month_v1',/);
  });
});

describe('migration 20260906010543 — ghi chú mới phải nói đủ điều kiện gọi được', () => {
  for (const phai of [
    'p_staff_ids uuid\\[\\]',
    'salary\\.unlock',
    'salary\\.unlock\\.v1 = CANONICAL',
    'canonical_write_operations',
    'LOCKED ve DRAFT',
    'copilot_plan_steps\\.canonical',
    'KHONG doc duoc tu before_digest',
    'Copilot KHONG tu dong goi',
  ]) {
    it(`ghi chú có "${phai}"`, () => {
      expect(migration).toMatch(new RegExp(phai));
    });
  }

  it('câu nói ngược cũ không còn trong ghi chú mới', () => {
    const khoiGhi = migration.slice(
      migration.indexOf('SET rollback_rpc'),
      migration.indexOf('$nghiem_thu$'),
    );
    expect(khoiGhi).not.toMatch(/Khong tim thay unlock_salary_month_v1/);
  });
});

describe('migration 20260906010543 — nghiệm thu canh CẢ HAI nhánh', () => {
  const dat = migration.slice(migration.indexOf('DO $nghiem_thu'));

  it('có khối nghiệm thu và không ghi dữ liệu', () => {
    expect(dat).not.toBe('');
    expect(dat).not.toMatch(/\b(INSERT INTO|UPDATE app_private|DELETE FROM)\b/);
  });

  it('nhánh CÓ hàm: registry phải trỏ tới nó và câu nói ngược phải biến mất', () => {
    expect(dat).toMatch(/v_rpc IS DISTINCT FROM 'unlock_salary_month_v1'/);
    expect(dat).toMatch(/ghi chu van con cau noi nguoc/);
  });

  it('nhánh KHÔNG có hàm: cấm điền tên hàm không gọi được', () => {
    expect(dat).toMatch(/IF v_rpc IS NOT NULL THEN/);
    expect(dat).toMatch(/registry van tro tan/);
  });

  it('hai chiều đều giữ hàng ở L5 + direct_l5_v1 + step_up + không uỷ quyền đứng', () => {
    expect(dat).toMatch(/risk = 'L5' AND executor_kind = 'direct_l5_v1' AND consent_required = 'step_up'/);
    expect(dat).toMatch(/grantable = false/);
    expect(dat).toMatch(/version = 1/);
    expect(dat).toMatch(/execute_rpc = 'copilot_execute_salary_khoa_thang_v1'/);
  });
});

describe('phép đo đột biến — file ĐÓNG BĂNG phải cho thấy lỗi đang có thật', () => {
  it('đọc được file đóng băng', () => {
    expect(dongBang.length).toBeGreaterThan(0);
  });

  it('bản seed CŨ đặt rollback_rpc NULL kèm câu "khong tim thay" — đúng chỗ cần vá', () => {
    expect(dongBang).toMatch(/Khong tim thay unlock_salary_month_v1 tren production/);
  });

  it('khối nghiệm thu của file đóng băng vẫn đòi NULL — nên KHÔNG được sửa nó', () => {
    expect(dongBang).toMatch(/AND rollback_rpc IS NULL/);
  });

  it('không migration nào trong repo tạo unlock_salary_month_v1 — đó là lý do phải có điều kiện', () => {
    // Nếu một ngày hàm được đưa vào sổ migration thì bài này đỏ, và đó là tin
    // TỐT: lúc đó điều kiện `to_regprocedure` thành dư và nên gán thẳng.
    expect(dongBang).not.toMatch(/CREATE OR REPLACE FUNCTION public\.unlock_salary_month_v1/);
  });
});
