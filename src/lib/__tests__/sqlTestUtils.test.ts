// Test cho chính công cụ mà mọi test migration khác dựa vào.
//
// `boCommentSql` là thứ đứng giữa "predicate còn đó" và "predicate đã bị bình
// luận hoá". Nếu nó sai, tất cả các test dùng nó đều sai theo mà vẫn XANH — nên
// nó phải có bài kiểm đột biến của riêng mình, chạy hoàn toàn trong bộ nhớ.
import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, thanHam } from './helpers/sqlTestUtils';

describe('boCommentSql', () => {
  it('cắt bình luận cuối dòng nhưng giữ nguyên số dòng', () => {
    const sql = ['SELECT 1;  -- một', 'SELECT 2;', '-- cả dòng', 'SELECT 3;'].join('\n');
    const ra = boCommentSql(sql);
    expect(ra.split('\n')).toHaveLength(4);
    expect(ra).not.toMatch(/một|cả dòng/);
    expect(ra).toMatch(/SELECT 1;/);
    expect(ra).toMatch(/SELECT 3;/);
  });

  it('KHÔNG cắt `--` nằm trong chuỗi literal', () => {
    const sql = "SELECT 'a--b' AS x;  -- chú thích thật";
    const ra = boCommentSql(sql);
    expect(ra).toContain("'a--b'");
    expect(ra).not.toContain('chú thích thật');
  });

  it('hiểu dấu nháy được thoát bằng cách viết hai lần', () => {
    const sql = "SELECT 'it''s -- fine';  -- bỏ cái này";
    const ra = boCommentSql(sql);
    expect(ra).toContain("'it''s -- fine'");
    expect(ra).not.toContain('bỏ cái này');
  });

  it('vẫn cắt bình luận nằm trong thân dollar-quote', () => {
    // Thân hàm plpgsql nằm giữa `$fn$ ... $fn$`. Bình luận Ở TRONG đó chính là
    // thứ phải cắt — nếu coi dollar-quote là chuỗi thì bài kiểm đột biến dưới
    // đây không bao giờ đỏ.
    const sql = ['CREATE FUNCTION f() AS $fn$', 'BEGIN', '  -- giấu ở đây', 'END', '$fn$;'].join('\n');
    expect(boCommentSql(sql)).not.toContain('giấu ở đây');
  });

  // ĐỘT BIẾN — đây là lý do tồn tại của cả file này.
  //
  // Lấy một predicate chịu lực, bình luận hoá nó, rồi khẳng định regex CHẠY
  // TRÊN BẢN ĐÃ LỘT COMMENT sẽ trượt. Bản chạy trên văn bản gốc vẫn khớp, và
  // đó đúng là cái bẫy mà bốn file test G1 đã dính.
  it('một predicate bị `--` phải làm assertion đỏ', () => {
    const goc = [
      'FROM public.materials m',
      'WHERE m.organization_id = p_organization_id',
      '  AND b.id = ANY(v_buildings)',
    ].join('\n');
    const dotBien = goc.replace('  AND b.id = ANY(v_buildings)', '  -- AND b.id = ANY(v_buildings)');
    const predicate = /b\.id = ANY\(v_buildings\)/;

    expect(goc).toMatch(predicate);
    expect(boCommentSql(goc)).toMatch(predicate);

    // Cái bẫy: bản THÔ vẫn khớp dù hàng rào đã chết.
    expect(dotBien).toMatch(predicate);
    // Bản đã lột comment thì không.
    expect(boCommentSql(dotBien)).not.toMatch(predicate);
  });
});

describe('thanHam / chuKyHam', () => {
  const sql = [
    'CREATE OR REPLACE FUNCTION public.mot_ham(p_a uuid, p_b integer DEFAULT 20)',
    'RETURNS jsonb LANGUAGE sql STABLE',
    "AS $$ SELECT '{}'::jsonb $$;",
    '',
    'CREATE OR REPLACE FUNCTION public.ham_hai(p_c text)',
    'RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;',
    '',
    'REVOKE ALL ON FUNCTION public.mot_ham(uuid, integer) FROM PUBLIC;',
  ].join('\n');

  it('cắt đúng một thân hàm, không lấn sang hàm kế tiếp', () => {
    const than = thanHam(sql, 'mot_ham');
    expect(than).toContain('p_b integer DEFAULT 20');
    expect(than).not.toContain('ham_hai');
  });

  it('dừng ở khối ACL khi hàm là hàm cuối', () => {
    const than = thanHam(sql, 'ham_hai');
    expect(than).toContain('p_c text');
    expect(than).not.toContain('REVOKE ALL');
  });

  it('trả rỗng cho hàm không tồn tại thay vì trả cả file', () => {
    expect(thanHam(sql, 'khong_co_ham_nay')).toBe('');
  });

  it('đọc được danh sách tham số đã chuẩn hoá', () => {
    expect(chuKyHam(sql, 'mot_ham')).toBe('p_a uuid, p_b integer default 20');
  });
});
