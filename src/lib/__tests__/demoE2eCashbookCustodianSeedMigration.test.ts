import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

// Bài này canh migration 20260906014927 — fixture "người GIỮ SỔ" của org DEMO.
//
// Ca 6 ma trận L5 không xanh được vì cả hai đường duyệt đòi phiếu CÓ SỔ QUỸ, mà
// gán sổ quỹ phải đi qua `assert_cashbook_access_v2(..., 'CUSTODIAN', ...)`. Đo
// 06/09/2026: DEMO có 72 binding CUSTODIAN nhưng TẤT CẢ trỏ vào sổ `ZFleet Sổ …`
// đã xoá mềm — không sổ quỹ SỐNG nào có người giữ.
//
// Thứ bài này canh chặt nhất KHÔNG phải "có seed" mà là ba giới hạn của seed:
// chỉ org DEMO, chỉ một sổ, chỉ một người; và nó phải TỰ TẮT trên DB rỗng để
// Restore Drill không đổ vì một fixture.
const duongDan = 'supabase/migrations/20260906014927_demo_e2e_cashbook_custodian_seed_v1.sql';
const tho = docSql(duongDan);
const migration = boCommentSql(tho);

const ORG_DEMO = 'dddd0000-0000-4000-8000-000000000001';

describe('migration 20260906014927 — khung file', () => {
  it('đọc được file migration', () => {
    expect(tho.length).toBeGreaterThan(0);
  });

  it('đúng một cặp BEGIN/COMMIT và có lock_timeout', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('KHÔNG đổi schema, KHÔNG sửa hàm nào — chỉ dữ liệu fixture', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(migration).not.toMatch(/DROP\b/);
    expect(migration).not.toMatch(/ALTER TABLE/);
    expect(migration).not.toMatch(/CREATE TABLE/);
    expect(migration).not.toMatch(/GRANT\b/);
    expect(migration).not.toMatch(/REVOKE\b/);
  });

  it('KHÔNG nới hàng rào tiền: không chạm assert_cashbook_access_v2', () => {
    expect(migration).not.toMatch(/assert_cashbook_access/);
    expect(migration).not.toMatch(/finance_v2_has_covering_deny/);
  });
});

describe('migration 20260906014927 — phạm vi HẸP đúng ba chiều', () => {
  it('chỉ org DEMO, ghim bằng hằng số trong file (không tham số, không biến env)', () => {
    expect(migration).toMatch(new RegExp(`c_org\\s+constant uuid := '${ORG_DEMO}'`));
    // Không được có uuid tổ chức nào khác trong file.
    const orgKhac = (migration.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g) ?? [])
      .filter((u) => u !== `'${ORG_DEMO}'`);
    expect(orgKhac, `uuid lạ trong fixture DEMO: ${orgKhac.join(', ')}`).toHaveLength(0);
  });

  it('chỉ MỘT sổ quỹ, và là sổ tiền mặt chung — không phải sổ cấn trừ nội bộ', () => {
    expect(migration).toMatch(/c_so\s+constant text := 'DEMO Quỹ tiền mặt'/);
    expect(migration).not.toMatch(/Cấn trừ/);
    expect(migration).toMatch(/a\.deleted_at IS NULL/);
  });

  it('chỉ MỘT người, và là người tạo phiếu trong ca 6', () => {
    expect(migration).toMatch(/c_mail\s+constant text := 'demo\.chunha@username\.ihomecrm\.local'/);
    expect(migration).toMatch(/m\.status = 'ACTIVE'/);
  });

  it('chỉ cấp CUSTODIAN, binding mở, và ghi rõ đây là fixture', () => {
    expect(migration).toMatch(/'CUSTODIAN'/);
    expect(migration).not.toMatch(/'OPERATOR'/);
    expect(migration).not.toMatch(/'KNOWER'/);
    expect(migration).toMatch(/Fixture E2E org DEMO \(20260906014927\)/);
    expect(migration).toMatch(/KHONG phai quyen nghiep vu that/);
  });

  it('đúng MỘT câu INSERT, vào đúng bảng binding', () => {
    expect(migration.match(/INSERT INTO/g)).toHaveLength(1);
    expect(migration).toMatch(/INSERT INTO public\.cashbook_possession_bindings/);
    expect(migration).not.toMatch(/INSERT INTO public\.(accounts|income_expenses|organization_memberships)/);
  });
});

describe('migration 20260906014927 — tự tắt trên DB rỗng, chạy lại không đẻ dòng thứ hai', () => {
  it('thiếu sổ hoặc thiếu thành viên ⇒ NOTICE rồi RETURN, KHÔNG raise', () => {
    expect(migration).toMatch(/IF v_so IS NULL OR v_mem IS NULL THEN[\s\S]*?RAISE NOTICE[\s\S]*?RETURN;/);
  });

  it('bảng không có unique key nên phép idempotent là IF EXISTS … RETURN', () => {
    expect(migration).not.toMatch(/ON CONFLICT/);
    expect(migration).toMatch(/IF EXISTS \([\s\S]*?cashbook_possession_bindings b[\s\S]*?RETURN;/);
  });

  it('điều kiện "binding còn mở" viết đủ cả hai vế valid_from/valid_to', () => {
    expect(migration).toMatch(/b\.valid_from <= now\(\)/);
    expect(migration).toMatch(/b\.valid_to IS NULL OR b\.valid_to > now\(\)/);
  });
});

describe('migration 20260906014927 — nghiệm thu canh cả ba giới hạn', () => {
  const dat = migration.slice(migration.indexOf('DO $nghiem_thu'));

  it('có khối nghiệm thu và nó KHÔNG ghi gì', () => {
    expect(dat).not.toBe('');
    expect(dat).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });

  it('DB rỗng ⇒ không kết luận gì, đúng như thiết kế', () => {
    expect(dat).toMatch(/khong co fixture DEMO/);
    expect(dat).toMatch(/RETURN;/);
  });

  it('canh cả "có binding", "không trùng", và "đúng 1 sổ quỹ sống"', () => {
    expect(dat).toMatch(/chua co binding CUSTODIAN mo/);
    expect(dat).toMatch(/phep idempotent bi hong/);
    expect(dat).toMatch(/count\(DISTINCT b\.cashbook_id\)/);
    expect(dat).toMatch(/dang giu % so quy SONG \(mong doi dung 1\)/);
  });
});

describe('phép đo đột biến — nếu seed bị nới ra, bài này phải ĐỎ', () => {
  it('không có dòng nào cấp binding cho toàn bộ sổ quỹ của org', () => {
    // Một `INSERT … SELECT a.id FROM accounts a WHERE a.organization_id = c_org`
    // sẽ cấp custodian cho MỌI sổ quỹ — đó là nới hàng rào tiền, không phải fixture.
    // Cắt riêng CÂU INSERT: soi cả file thì khối nghiệm thu (vốn có SELECT … FROM
    // public.accounts) làm phép đo này báo động giả.
    const dau = migration.indexOf('INSERT INTO');
    const cauInsert = migration.slice(dau, migration.indexOf(';', dau) + 1);
    expect(cauInsert).toMatch(/VALUES/);
    expect(cauInsert).not.toMatch(/SELECT/);
    expect(cauInsert).not.toMatch(/FROM public\.accounts/);
  });

  it('không cấp cho nhiều người bằng IN/ANY danh sách email', () => {
    expect(migration).not.toMatch(/u\.email\s*(=\s*ANY|IN\s*\()/);
  });

  it('không đặt valid_to trong quá khứ (binding chết là seed vô nghĩa)', () => {
    expect(migration).not.toMatch(/valid_to\s*[,)]/);
  });
});
