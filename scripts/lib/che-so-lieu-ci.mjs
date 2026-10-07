// Che số liệu production khỏi log CI công khai.
//
// Repo public từ 07/10/2026: log GitHub Actions ai cũng đọc được, kể cả người
// không đăng nhập. Script đối chiếu tiền chạy trên dữ liệu production, nên khi
// chạy trong CI chúng chỉ được in: đạt/lệch, số đếm và định danh chỗ lệch
// (mã sổ, mã tổ chức, nhãn nguồn A/B/C). KHÔNG in số tiền tuyệt đối, số dư, chênh
// lệch hay tên sổ do người dùng đặt. Chạy local vẫn in đủ để điều tra.
//
// Chỉ đổi CÁCH IN, không đổi phép so: phán quyết và mã thoát giữ nguyên.

/** Nhãn thay cho số tiền trên log CI. */
export const AN_TREN_CI = '‹ẩn trên CI›';

export const GHI_CHU_CI =
  'ℹ️  Log CI công khai: số tiền, số dư, chênh lệch và tên sổ được ẩn; phán quyết, số đếm và mã chỗ lệch giữ nguyên. Chạy local để xem chi tiết.';

/**
 * GitHub Actions luôn đặt CI=true. `CI=false`/`CI=0` là cách tắt phổ biến khi
 * chạy tay; mọi giá trị khác (kể cả lạ) coi là CI — lỡ che thừa còn hơn lỡ lộ.
 */
export function laLogCongKhai(env = process.env) {
  const v = String(env?.CI ?? '').trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0';
}

/** Số tiền VND: local in đủ theo vi-VN, CI thay bằng nhãn ẩn. */
export function dinhDangTien(n, env = process.env) {
  return laLogCongKhai(env) ? AN_TREN_CI : Number(n).toLocaleString('vi-VN');
}

/** Văn bản người dùng đặt (tên sổ quỹ…): CI bỏ hẳn, local giữ nguyên. */
export function vanBanNguoiDung(s, env = process.env) {
  return laLogCongKhai(env) ? '' : String(s ?? '');
}
