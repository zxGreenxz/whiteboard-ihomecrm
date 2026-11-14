import { describe, expect, it } from 'vitest';

import type { MemberStatus, MemberType } from '@/hooks/useOrganizationAuthorization';
import {
  docSuKienDatLaiMatKhau,
  hienDatLaiMatKhauThanhVien,
  laSuKienDatLaiMatKhau,
  quyenDaXacNhan,
  RANDOM_PASSWORD_ALPHABET,
  RANDOM_PASSWORD_LENGTH,
  taoMatKhauNgauNhien,
  toChucDemoDaXacNhan,
} from '../resetUserPassword';

const LOAI: MemberType[] = ['OWNER', 'STAFF', 'SHAREHOLDER', 'PARTNER', 'SERVICE'];
const TRANG_THAI: MemberStatus[] = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'];

/** Ba trạng thái của cờ "tổ chức đang xem là công ty demo": có, không, chưa biết. */
const DEMO: (boolean | null)[] = [true, false, null];

const SUPER = { isSuperAdmin: true, isCompanyOwner: false, toChucLaDemo: false };
const CHU = { isSuperAdmin: false, isCompanyOwner: true, toChucLaDemo: false };
const CA_HAI = { isSuperAdmin: true, isCompanyOwner: true, toChucLaDemo: false };
const KHONG = { isSuperAdmin: false, isCompanyOwner: false, toChucLaDemo: false };

describe('hienDatLaiMatKhauThanhVien — cờ hiện nút ở trang Thành viên', () => {
  const tv = (memberType: MemberType, status: MemberStatus = 'ACTIVE', isSelf = false) => ({ memberType, status, isSelf });

  it('người xem không phải superadmin hay chủ công ty (kể cả đang tải/lỗi) ⇒ không hiện cho ai', () => {
    for (const toChucLaDemo of DEMO) {
      for (const loai of LOAI) {
        for (const tt of TRANG_THAI) expect(hienDatLaiMatKhauThanhVien({ ...KHONG, toChucLaDemo }, tv(loai, tt))).toBe(false);
      }
    }
  });

  it('không bao giờ hiện cho chính mình hay người đã bị thu hồi', () => {
    for (const boiCanh of [SUPER, CHU, CA_HAI]) {
      for (const loai of LOAI) {
        expect(hienDatLaiMatKhauThanhVien(boiCanh, tv(loai, 'ACTIVE', true))).toBe(false);
        expect(hienDatLaiMatKhauThanhVien(boiCanh, tv(loai, 'REVOKED'))).toBe(false);
      }
    }
  });

  it('superadmin: mọi loại thành viên còn hiệu lực, kể cả chủ sở hữu, cổ đông và ở công ty demo', () => {
    for (const toChucLaDemo of DEMO) {
      for (const loai of LOAI) {
        for (const tt of ['INVITED', 'ACTIVE', 'SUSPENDED'] as const) {
          const ca = `${loai}/${tt}/demo=${String(toChucLaDemo)}`;
          expect(hienDatLaiMatKhauThanhVien({ ...SUPER, toChucLaDemo }, tv(loai, tt)), ca).toBe(true);
          expect(hienDatLaiMatKhauThanhVien({ ...CA_HAI, toChucLaDemo }, tv(loai, tt)), ca).toBe(true);
        }
      }
    }
  });

  it('chủ công ty ở tổ chức thường: bỏ chủ sở hữu và cổ đông, còn lại thì hiện', () => {
    expect(hienDatLaiMatKhauThanhVien(CHU, tv('OWNER'))).toBe(false);
    expect(hienDatLaiMatKhauThanhVien(CHU, tv('SHAREHOLDER'))).toBe(false);
    for (const loai of ['STAFF', 'PARTNER', 'SERVICE'] as const) {
      for (const tt of ['INVITED', 'ACTIVE', 'SUSPENDED'] as const) {
        expect(hienDatLaiMatKhauThanhVien(CHU, tv(loai, tt)), `${loai}/${tt}`).toBe(true);
      }
    }
  });

  it('chủ công ty ở công ty demo, hoặc chưa biết có phải demo không (hồ sơ đang tải/lỗi) ⇒ ẩn hết', () => {
    for (const toChucLaDemo of [true, null]) {
      for (const loai of LOAI) {
        for (const tt of TRANG_THAI) {
          expect(hienDatLaiMatKhauThanhVien({ ...CHU, toChucLaDemo }, tv(loai, tt)), `${loai}/${tt}/demo=${String(toChucLaDemo)}`).toBe(false);
        }
      }
    }
  });
});

describe('toChucDemoDaXacNhan — cờ công ty demo từ hồ sơ tổ chức', () => {
  const hoSo = (isDemo: boolean, organizationId = 'org-1') => ({ organizationId, isDemo });

  it('hồ sơ đã tải đúng tổ chức đang xem ⇒ đúng cờ isDemo', () => {
    expect(toChucDemoDaXacNhan({ data: hoSo(true), isError: false }, 'org-1')).toBe(true);
    expect(toChucDemoDaXacNhan({ data: hoSo(false), isError: false }, 'org-1')).toBe(false);
  });

  it('đang tải, lỗi (kể cả còn dữ liệu cũ), hồ sơ của tổ chức khác hay chưa biết tổ chức đang xem ⇒ null', () => {
    expect(toChucDemoDaXacNhan({ data: undefined, isError: false }, 'org-1')).toBeNull();
    expect(toChucDemoDaXacNhan({ data: hoSo(false), isError: true }, 'org-1')).toBeNull();
    expect(toChucDemoDaXacNhan({ data: hoSo(false, 'org-2'), isError: false }, 'org-1')).toBeNull();
    expect(toChucDemoDaXacNhan({ data: hoSo(false), isError: false }, undefined)).toBeNull();
  });
});

describe('quyenDaXacNhan — chỉ `true` đã tải xong, không lỗi', () => {
  it.each([
    [{ data: true, isError: false }, true],
    [{ data: true }, true],
    [{ data: true, isError: true }, false], // lỗi nạp lại mà còn giữ dữ liệu cũ
    [{ data: undefined, isError: false }, false], // đang tải
    [{ data: false, isError: false }, false],
    [{ data: 'true', isError: false }, false],
    [{ data: 1, isError: false }, false],
  ])('%j ⇒ %s', (query, mongDoi) => {
    expect(quyenDaXacNhan(query)).toBe(mongDoi);
  });
});

describe('taoMatKhauNgauNhien', () => {
  const KHOP = new RegExp(`^[${RANDOM_PASSWORD_ALPHABET}]{${RANDOM_PASSWORD_LENGTH}}$`);

  it('12 ký tự từ bảng chữ không dễ nhầm, đủ chữ thường + chữ hoa + chữ số', () => {
    expect(RANDOM_PASSWORD_ALPHABET).not.toMatch(/[0O1lI]/);
    for (let i = 0; i < 200; i += 1) {
      const matKhau = taoMatKhauNgauNhien();
      expect(matKhau).toMatch(KHOP);
      expect(matKhau).toMatch(/[a-z]/);
      expect(matKhau).toMatch(/[A-Z]/);
      expect(matKhau).toMatch(/[0-9]/);
    }
  });

  it('lấy số từ nguồn ngẫu nhiên được bơm vào, bỏ số rơi vào phần dư', () => {
    const n = RANDOM_PASSWORD_ALPHABET.length;
    const tran = Math.floor(2 ** 32 / n) * n;
    // Mỗi lượt: một số trong phần dư (phải bỏ) rồi lần lượt chỉ số 0..; chữ thứ 0 là 'A', 24 là 'a', 49 là '2'.
    const chiSo = [24, 0, 49, 25, 1, 50, 26, 2, 51, 27, 3, 52];
    const fill = (mang: Uint32Array) => {
      mang.fill(0);
      mang[0] = tran; // >= trần ⇒ phải bỏ qua
      chiSo.forEach((so, i) => {
        mang[i + 1] = so + n; // cộng n để chắc chắn chỉ dùng phần dư của phép chia
      });
      return mang;
    };
    expect(taoMatKhauNgauNhien(fill)).toBe(chiSo.map((so) => RANDOM_PASSWORD_ALPHABET.charAt(so)).join(''));
  });

  it('nguồn ngẫu nhiên hỏng (toàn số 0) ⇒ báo lỗi, không lặp mãi', () => {
    expect(() => taoMatKhauNgauNhien((mang) => mang.fill(0))).toThrow(/Chưa tạo được mật khẩu ngẫu nhiên/);
  });
});

describe('nhật ký đặt lại mật khẩu (USER_PASSWORD_RESET / USER_PASSWORD_RESET_FAILED)', () => {
  it('nhận đúng hai loại dòng, không nhận loại khác', () => {
    expect(laSuKienDatLaiMatKhau('USER_PASSWORD_RESET')).toBe(true);
    expect(laSuKienDatLaiMatKhau('USER_PASSWORD_RESET_FAILED')).toBe(true);
    expect(laSuKienDatLaiMatKhau('MEMBER_AUTHORIZATION_UPDATED')).toBe(false);
  });

  it('đọc tên người được đặt lại', () => {
    expect(docSuKienDatLaiMatKhau({ via: 'COMPANY_OWNER', targetName: ' Nguyễn Văn A ', requestId: 'r' })).toEqual({ tenNguoiNhan: 'Nguyễn Văn A' });
    expect(docSuKienDatLaiMatKhau({ targetName: 'B', errorCode: 'weak_password' })).toEqual({ tenNguoiNhan: 'B' });
  });

  it('newState thiếu hoặc sai kiểu ⇒ không bịa tên', () => {
    expect(docSuKienDatLaiMatKhau(null)).toEqual({ tenNguoiNhan: null });
    expect(docSuKienDatLaiMatKhau({ targetName: 42 })).toEqual({ tenNguoiNhan: null });
    expect(docSuKienDatLaiMatKhau({ targetName: '   ' })).toEqual({ tenNguoiNhan: null });
  });
});
