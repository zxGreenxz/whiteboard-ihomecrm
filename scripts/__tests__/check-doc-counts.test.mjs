import { describe, expect, it } from 'vitest';
import { CLAIMS, demSqlTuDanhSach, demTrungVersionTuDanhSach, kiemTra } from '../check-doc-counts.mjs';

// Gate này lấy TÀI LIỆU làm đích sửa (có --fix), nên nó sai là nó ghi số sai vào
// tài liệu. Bản đầu tôi viết đếm thiếu thư mục con và suýt "sửa" con số 15 đúng
// thành 1 — với loại gate biết ghi, đếm sai còn tệ hơn không đếm.

const claimGia = (re, that) => ({ re, dem: () => that, moTa: 'thử' });

describe('kiemTra', () => {
  it('khớp khi số trong tài liệu bằng số đếm được', () => {
    const r = kiemTra('Repository hiện có 627 file trong thư mục', claimGia(/(hiện có\s+)(\d+)(\s+file)/, 627));
    expect(r.trangThai).toBe('khop');
  });

  it('báo lệch kèm cả hai con số', () => {
    const r = kiemTra('Repository hiện có 625 file trong thư mục', claimGia(/(hiện có\s+)(\d+)(\s+file)/, 627));
    expect(r.trangThai).toBe('lech');
    expect(r.khai).toBe(625);
    expect(r.that).toBe(627);
  });

  it('báo MẤT NEO khi câu văn đổi — không được im lặng bỏ qua', () => {
    // Đây là chế độ hỏng nguy hiểm nhất: viết lại câu là gate ngừng kiểm mãi mãi
    // mà vẫn xanh. Phải phân biệt được với "khớp".
    const r = kiemTra('Repository có tất cả 627 tệp trong thư mục', claimGia(/(hiện có\s+)(\d+)(\s+file)/, 627));
    expect(r.trangThai).toBe('khong-tim-thay');
  });

  it('bắt đúng số ĐẦU TIÊN khớp mẫu, không bắt nhầm số khác trong câu', () => {
    const r = kiemTra('Có 33 nhóm trùng; hiện có 627 file trong repo', claimGia(/(hiện có\s+)(\d+)(\s+file)/, 627));
    expect(r.khai).toBe(627);
  });
});

describe('danh sách CLAIMS', () => {
  it('mỗi mục có đủ file, mẫu, cách đếm và mô tả', () => {
    expect(CLAIMS.length).toBeGreaterThan(0);
    for (const c of CLAIMS) {
      expect(typeof c.file, 'thiếu file').toBe('string');
      expect(c.re instanceof RegExp, `${c.file} thiếu regex`).toBe(true);
      expect(typeof c.dem, `${c.file} thiếu hàm đếm`).toBe('function');
      expect(typeof c.moTa, `${c.file} thiếu mô tả`).toBe('string');
    }
  });

  it('mọi mẫu đều có đúng 3 nhóm bắt để --fix ghép lại được', () => {
    // --fix thay bằng `$1<số>$3`, nên mẫu phải tách được phần trước / số / phần sau.
    // Mẫu thiếu nhóm sẽ làm --fix ghi ra câu văn hỏng.
    for (const c of CLAIMS) {
      const nguon = c.re.source;
      const soNhom = new RegExp(`${nguon}|`).exec('').length - 1;
      expect(soNhom, `${c.file}: mẫu có ${soNhom} nhóm, cần 3`).toBe(3);
    }
  });

  it('hàm đếm trả số nguyên không âm', () => {
    for (const c of CLAIMS) {
      const n = c.dem();
      expect(Number.isInteger(n), `${c.file}: đếm ra ${n}`).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('đếm từ danh sách INDEX — con số phải tái lập được từ commit (28/08/2026)', () => {
  // Bản cũ demSql/demTrungVersion quét ĐĨA: một file .sql untracked của phiên
  // song song làm --fix ghi 709 vào docs trong khi CI (đọc cây commit) chỉ thấy
  // 707 → đỏ. Đã xảy ra thật, chữa tay ở c9f3937f; đây là bản mã hoá.
  const danhSach = [
    'supabase/migrations/20260101000000_a.sql',
    'supabase/migrations/20260101000000_b.sql',
    'supabase/migrations/20260102000000_c.SQL',
    'supabase/migrations/nhom/20260103000000_con.sql',
    'supabase/migrations-archive/20200101000000_cu.sql',
    'supabase/migrations/ghi-chu.md',
  ];

  it('demSqlTuDanhSach đếm đệ quy, không phân biệt hoa thường, đúng thư mục', () => {
    expect(demSqlTuDanhSach(danhSach, 'supabase/migrations')).toBe(4);
    expect(demSqlTuDanhSach(danhSach, 'supabase/migrations-archive')).toBe(1);
  });

  it('demSqlTuDanhSach không lẫn thư mục có tên là tiền tố của nhau', () => {
    // 'supabase/migrations-archive/...' KHÔNG được tính vào 'supabase/migrations'.
    expect(demSqlTuDanhSach(['supabase/migrations-archive/x.sql'], 'supabase/migrations')).toBe(0);
  });

  it('demTrungVersionTuDanhSach chỉ xét file ngay trong supabase/migrations, nhóm theo version', () => {
    const kq = demTrungVersionTuDanhSach(danhSach);
    expect(kq.soNhom).toBe(1);
    expect(kq.soFile).toBe(2);
  });
});
