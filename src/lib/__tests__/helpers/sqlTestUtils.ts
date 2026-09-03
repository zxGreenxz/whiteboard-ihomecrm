// Tiện ích dùng chung cho các test ghim nội dung file migration SQL.
//
// VÌ SAO PHẢI CÓ MỘT BẢN DUY NHẤT
//   Bốn file test của đợt G1 mỗi file tự khai một `boCommentSql` riêng, và cả
//   bốn đều là `source.replace(/--[^\n]*/g, '')`. Một dòng như thế có HAI lỗ:
//
//   1. Phần lớn assertion KHÔNG hề đi qua nó. Regex chạy thẳng trên văn bản gốc
//      nên một predicate bị bình luận hoá — `-- AND b.id = ANY(v_buildings)` —
//      vẫn khớp regex và test vẫn XANH, trong khi hàng rào thật đã biến mất.
//      Đây không phải giả thuyết: đúng lớp lỗi đó là lý do đợt vá này tồn tại.
//
//   2. Nó cắt cả `--` nằm TRONG chuỗi. `'a--b'` thành `'a`, chuỗi hở, và mọi
//      regex sau đó đọc một thân hàm méo. Hôm nay chưa file nào dính, nhưng một
//      test sai âm thầm thì không ai đi tìm.
//
//   Nên bản dùng chung này quét theo trạng thái chuỗi: chỉ cắt `--` khi đang ở
//   NGOÀI một literal `'...'`. Dollar-quote (`$fn$ ... $fn$`) KHÔNG được coi là
//   chuỗi — thân hàm plpgsql nằm trong đó và bình luận trong thân hàm chính là
//   thứ phải cắt.
//
//   Postgres chạy với `standard_conforming_strings = on`, nên trong literal chỉ
//   có một cách thoát dấu nháy: viết hai lần (`''`). Backslash không thoát gì.

import { existsSync, readFileSync } from 'node:fs';

/**
 * Bỏ mọi bình luận `--` khỏi SQL, giữ nguyên số dòng và giữ nguyên nội dung
 * chuỗi literal.
 *
 * Trả lại chuỗi có cùng số dòng để thông báo lỗi của vitest vẫn chỉ đúng chỗ.
 */
export function boCommentSql(source: string): string {
  let ket_qua = '';
  let trongChuoi = false;
  let i = 0;
  while (i < source.length) {
    const ky_tu = source[i];
    if (trongChuoi) {
      ket_qua += ky_tu;
      if (ky_tu === "'") {
        // `''` là một dấu nháy được thoát, không phải điểm đóng chuỗi.
        if (source[i + 1] === "'") {
          ket_qua += "'";
          i += 2;
          continue;
        }
        trongChuoi = false;
      }
      i += 1;
      continue;
    }
    if (ky_tu === "'") {
      trongChuoi = true;
      ket_qua += ky_tu;
      i += 1;
      continue;
    }
    if (ky_tu === '-' && source[i + 1] === '-') {
      // Nuốt tới hết dòng, KHÔNG nuốt ký tự xuống dòng.
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    ket_qua += ky_tu;
    i += 1;
  }
  return ket_qua;
}

/**
 * Các dòng có toán tử `LIKE`/`ILIKE` THẬT — tức nằm ngoài mọi chuỗi literal.
 *
 * Không thể chỉ `sql.match(/LIKE/g)`: chữ "LIKE" xuất hiện trong `COMMENT ON
 * FUNCTION ... IS '...'` và trong thông điệp RAISE, và một bài kiểm "mọi LIKE
 * đều có ESCAPE" sẽ đỏ vì một câu văn xuôi. Cắt cả bình luận rồi vẫn không đủ:
 * chuỗi literal thì phải giữ, vì `ESCAPE '\'` chính là một chuỗi literal.
 */
export function dongCoLike(source: string): string[] {
  const ra: string[] = [];
  let trongChuoi = false;
  let dauDong = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ky_tu = source[i];
    if (ky_tu === '\n') {
      dauDong = i + 1;
      continue;
    }
    if (trongChuoi) {
      if (ky_tu === "'") {
        if (source[i + 1] === "'") {
          i += 1;
          continue;
        }
        trongChuoi = false;
      }
      continue;
    }
    if (ky_tu === "'") {
      trongChuoi = true;
      continue;
    }
    if (ky_tu !== 'L' && ky_tu !== 'I') continue;
    const con_lai = source.slice(i);
    const khop = /^(?:ILIKE|LIKE)\b/.exec(con_lai);
    if (!khop) continue;
    // Phải là đầu một từ, không phải đuôi của `UNLIKE`/`ALIKE`.
    if (i > 0 && /[A-Za-z0-9_]/.test(source[i - 1])) continue;
    const hetDong = source.indexOf('\n', i);
    ra.push(source.slice(dauDong, hetDong < 0 ? source.length : hetDong));
    i += khop[0].length - 1;
  }
  return ra;
}

/** Đọc một file SQL, chuẩn hoá CRLF; trả chuỗi rỗng nếu không có file. */
export function docSql(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
}

/**
 * Đọc một file SQL rồi bỏ bình luận ngay. Đây là dạng MẶC ĐỊNH mà mọi assertion
 * nội dung nên dùng; bản còn bình luận chỉ dành cho vài test cố ý soi chú thích.
 */
export function docSqlKhongComment(path: string): string {
  return boCommentSql(docSql(path));
}

/**
 * Thân của một `CREATE OR REPLACE FUNCTION <schema>.<tên>` cho tới khai báo hàm
 * kế tiếp hoặc tới khối ACL.
 *
 * KHÔNG neo vào `$fn$;`: vài RPC là `LANGUAGE sql` và đóng bằng `$$;`. Một bộ
 * tách chỉ biết một trong hai sẽ lặng lẽ trả thân RỖNG, và mọi `expect(...)`
 * dạng "không chứa X" sẽ xanh trên một chuỗi rỗng.
 */
export function thanHam(source: string, ten: string, schema = 'public'): string {
  const start = source.search(
    new RegExp(String.raw`create or replace function ${schema}\.${ten}\s*\(`, 'i'),
  );
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/CREATE OR REPLACE FUNCTION/i);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/im);
  const ends = [nextFn, acl].filter((index) => index >= 0);
  return ends.length === 0 ? source.slice(start) : source.slice(start, start + 1 + Math.min(...ends));
}

/** Danh sách tham số của một khai báo hàm, đã chuẩn hoá khoảng trắng. */
export function chuKyHam(source: string, ten: string, schema = 'public'): string {
  const start = source.search(
    new RegExp(String.raw`create or replace function ${schema}\.${ten}\s*\(`, 'i'),
  );
  if (start < 0) return '';
  const open = source.indexOf('(', start);
  const close = source.indexOf(')', open);
  return source
    .slice(open + 1, close)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
