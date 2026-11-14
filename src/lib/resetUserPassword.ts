import type { MemberStatus, MemberType } from '@/hooks/useOrganizationAuthorization';

/**
 * Phần thuần của tính năng "superadmin / chủ công ty đặt lại mật khẩu cho người khác".
 *
 * Hàng rào thật nằm ở hàm Edge `admin-reset-user-password` (gọi qua `datLaiMatKhauNguoiDung` trong
 * src/lib/edgeFunctions.ts). Các hàm ở đây chỉ quyết định HIỆN nút, dựng mật khẩu ngẫu nhiên và đọc
 * dòng nhật ký — ẩn nút là để gọn, không phải để chặn.
 */

/** Các ký tự từ `tu` tới `den` (theo mã), bỏ những ký tự có trong `bo`. */
const khoangKyTu = (tu: string, den: string, bo = '') =>
  Array.from({ length: den.charCodeAt(0) - tu.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(tu.charCodeAt(0) + i))
    .filter((c) => !bo.includes(c))
    .join('');

/**
 * Bảng chữ của mật khẩu ngẫu nhiên: bỏ 0/O/1/l/I để đọc cho nhau qua điện thoại không nhầm.
 * Dựng lúc chạy chứ không viết nguyên văn: chuỗi 57 ký tự gán cho tên có chữ PASSWORD bị gitleaks
 * (generic-api-key) đọc là khoá bí mật.
 */
export const RANDOM_PASSWORD_ALPHABET = khoangKyTu('A', 'Z', 'IO') + khoangKyTu('a', 'z', 'l') + khoangKyTu('2', '9');
export const RANDOM_PASSWORD_LENGTH = 12;

type RandomFill = (array: Uint32Array) => Uint32Array;

const cryptoFill: RandomFill = (array) => crypto.getRandomValues(array);

/**
 * Mật khẩu ngẫu nhiên 12 ký tự từ `RANDOM_PASSWORD_ALPHABET`, bằng `crypto.getRandomValues`.
 *
 * Bỏ các số rơi vào phần dư (2^32 không chia hết cho cỡ bảng chữ) để mọi ký tự có xác suất như
 * nhau. Luôn có đủ chữ thường, chữ hoa và chữ số: Supabase Auth có thể bật luật đòi đủ ba loại, và
 * không có ràng buộc này thì cứ khoảng 1/6 lần sẽ ra mật khẩu không có chữ số.
 */
export function taoMatKhauNgauNhien(fill: RandomFill = cryptoFill): string {
  const n = RANDOM_PASSWORD_ALPHABET.length;
  const tran = Math.floor(2 ** 32 / n) * n;
  for (let lan = 0; lan < 32; lan += 1) {
    const so = fill(new Uint32Array(RANDOM_PASSWORD_LENGTH * 4));
    let matKhau = '';
    for (const x of so) {
      if (x >= tran) continue;
      matKhau += RANDOM_PASSWORD_ALPHABET.charAt(x % n);
      if (matKhau.length === RANDOM_PASSWORD_LENGTH) break;
    }
    if (matKhau.length === RANDOM_PASSWORD_LENGTH && /[a-z]/.test(matKhau) && /[A-Z]/.test(matKhau) && /[0-9]/.test(matKhau)) {
      return matKhau;
    }
  }
  // Chỉ tới được đây khi nguồn ngẫu nhiên hỏng (vd trả toàn số 0): báo lỗi, không lặp mãi.
  throw new Error('Chưa tạo được mật khẩu ngẫu nhiên. Tự nhập mật khẩu mới.');
}

/**
 * Trạng thái một truy vấn quyền ⇒ cờ. Chỉ dữ liệu `true` đã tải xong và không lỗi mới tính:
 * đang tải hoặc lỗi (kể cả khi còn giữ dữ liệu cũ) thì coi như không có quyền.
 */
export function quyenDaXacNhan(query: { data?: unknown; isError?: boolean }): boolean {
  return query.data === true && query.isError !== true;
}

/**
 * Tổ chức đang xem có phải công ty demo không, từ `useOrganizationProfile()`.
 *
 * `null` = chưa biết: hồ sơ đang tải, lỗi, hoặc là hồ sơ của tổ chức khác với danh sách thành viên
 * đang hiện (vừa đổi công ty, một trong hai truy vấn chưa kịp nạp lại).
 */
export function toChucDemoDaXacNhan(
  query: { data?: { organizationId: string; isDemo: boolean }; isError?: boolean },
  organizationId: string | undefined,
): boolean | null {
  if (query.isError === true || !query.data || !organizationId) return null;
  return query.data.organizationId === organizationId ? query.data.isDemo : null;
}

export interface BoiCanhDatLaiMatKhau {
  /** `quyenDaXacNhan(useIsSuperAdmin())`. */
  isSuperAdmin: boolean;
  /** `quyenDaXacNhan(useIsOrgOwner())` — chủ theo vai hệ thống TENANT_OWNER. */
  isCompanyOwner: boolean;
  /** `toChucDemoDaXacNhan(…)`: tổ chức đang xem là công ty demo; `null` = chưa biết. */
  toChucLaDemo: boolean | null;
}

/**
 * Có hiện nút "Đặt lại mật khẩu" trên thẻ thành viên không.
 *
 * Superadmin: mọi thành viên trừ chính mình và người đã bị thu hồi. Chủ công ty: như trên nhưng bỏ
 * chủ sở hữu và cổ đông, và không gì cả ở công ty demo (mật khẩu chủ demo công bố trên trang
 * Sandbox) — chưa biết có phải demo không thì cũng ẩn. Máy chủ chặn đúng các trường hợp này (cùng
 * superadmin và người còn thuộc tổ chức khác mà chủ này không làm chủ, phần trang này không biết).
 */
export function hienDatLaiMatKhauThanhVien(
  boiCanh: BoiCanhDatLaiMatKhau,
  thanhVien: { isSelf: boolean; status: MemberStatus; memberType: MemberType },
): boolean {
  if (!boiCanh.isSuperAdmin && !boiCanh.isCompanyOwner) return false;
  if (thanhVien.isSelf || thanhVien.status === 'REVOKED') return false;
  if (boiCanh.isSuperAdmin) return true;
  if (boiCanh.toChucLaDemo !== false) return false;
  return thanhVien.memberType !== 'OWNER' && thanhVien.memberType !== 'SHAREHOLDER';
}

/**
 * Hai loại dòng nhật ký của việc đặt lại mật khẩu (SQL `user_password_reset_begin_v1` / `finish_v1`):
 * `USER_PASSWORD_RESET` ghi ngay lúc bắt đầu, `USER_PASSWORD_RESET_FAILED` đính chính khi chắc chắn
 * chưa đổi được.
 */
export function laSuKienDatLaiMatKhau(eventType: string): boolean {
  return eventType === 'USER_PASSWORD_RESET' || eventType === 'USER_PASSWORD_RESET_FAILED';
}

/** Phần riêng của dòng nhật ký đặt lại mật khẩu (`newState` do SQL ghi). */
export function docSuKienDatLaiMatKhau(newState: Record<string, unknown> | null): {
  tenNguoiNhan: string | null;
} {
  const ten = newState?.targetName;
  return { tenNguoiNhan: typeof ten === 'string' && ten.trim() ? ten.trim() : null };
}
