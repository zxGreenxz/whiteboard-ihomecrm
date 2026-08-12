// Test bản đồ hệ thống. Chạy trên CATALOG THẬT (`permissionPages.ts`) — 42
// trang, 124 chức năng — chứ không phải fixture, vì thứ đáng kiểm ở đây là bản
// đồ có khớp sản phẩm thật hay không.
import { describe, expect, it } from 'vitest';
import type { PermissionsMap } from '@/lib/permissions';
import { VISIBLE_PAGE_GROUPS, UNSHIPPED_PAGE_KEYS } from '@/lib/permissionPages';
import {
  banDoGon,
  dongNguCanhTrang,
  moTaTrangKhop,
  timTrang,
  trangHienTai,
  trangHienTaiTrong,
} from '../banDoHeThong';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;
const STAFF_ROOMS_ONLY: PermissionsMap = { rooms: { view: true } };

/** Feature tối giản cho catalog dựng tay. */
const f = (module: string, action: string) =>
  ({ module, action, label: `Xem ${module}`, tier: 'view' }) as never;

describe('timTrang — chỉ đường theo việc cần làm', () => {
  it('tìm được trang theo tên việc, không cần biết tên trang', async () => {
    const k = timTrang('hoá đơn', SUPER);
    expect(k.length).toBeGreaterThan(0);
    expect(k[0].page.route).toBe('/invoices');
  });

  it('gõ KHÔNG DẤU vẫn ra', () => {
    expect(timTrang('hoa don', SUPER)[0].page.route).toBe('/invoices');
  });

  it('sàn chống-xanh-rỗng: catalog thật đủ lớn', () => {
    const soTrang = VISIBLE_PAGE_GROUPS.reduce((s, g) => s + g.pages.length, 0);
    const soChucNang = VISIBLE_PAGE_GROUPS.reduce(
      (s, g) => s + g.pages.reduce((t, p) => t + p.features.length, 0),
      0,
    );
    expect(soTrang).toBeGreaterThanOrEqual(30);
    expect(soChucNang).toBeGreaterThanOrEqual(100);
  });
});

describe('KHÔNG BAO GIỜ chỉ tới cánh cửa người dùng không mở được', () => {
  it('trang ngoài quyền không xuất hiện trong kết quả tìm', () => {
    const k = timTrang('lương thưởng hoa hồng', STAFF_ROOMS_ONLY);
    expect(k.every((x) => x.page.route !== '/settings/salary')).toBe(true);
    // và nói rộng hơn: mọi trang trả về đều có ít nhất một chức năng dùng được
    for (const x of k) expect(x.chucNang.length).toBeGreaterThan(0);
  });

  it('bản đồ gọn của nhân viên hẹp quyền NHỎ HƠN hẳn của superadmin', () => {
    const cuaSuper = banDoGon(SUPER);
    const cuaStaff = banDoGon(STAFF_ROOMS_ONLY);
    expect(cuaStaff.length).toBeLessThan(cuaSuper.length / 2);
    expect(cuaSuper).toContain('/invoices');
    expect(cuaStaff).not.toContain('/settings/salary');
  });

  it('mọi chức năng liệt kê ra đều là chức năng dùng được', () => {
    const k = timTrang('phòng', STAFF_ROOMS_ONLY);
    const mota = moTaTrangKhop(k);
    // Nhân viên chỉ có rooms.view: không được kể các thao tác họ không có.
    expect(mota).not.toMatch(/Xoá|Duyệt|Thanh lý/);
  });

  it('perms CHƯA TẢI ⇒ fail closed, và nói rõ là đang tải', () => {
    expect(timTrang('hoá đơn', undefined)).toHaveLength(0);
    expect(banDoGon(undefined)).toContain('Đang tải');
  });

  it('KHÔNG chào mời trang của sản phẩm chưa ship', () => {
    // Cờ runtime tắt ⇒ route không render. Chỉ người dùng tới đó là đưa họ tới
    // màn hình trắng — đúng cái hỏng mà UNSHIPPED_PAGE_KEYS tồn tại để tránh.
    const hien = new Set(VISIBLE_PAGE_GROUPS.flatMap((g) => g.pages.map((p) => p.key)));
    for (const chuaShip of UNSHIPPED_PAGE_KEYS) {
      expect(hien.has(chuaShip)).toBe(false);
    }
    const ban = banDoGon(SUPER);
    for (const chuaShip of UNSHIPPED_PAGE_KEYS) {
      expect(ban.toLowerCase()).not.toContain(chuaShip.replace(/_/g, '-'));
    }
  });
});

describe('trangHienTai — hiểu "cái này", "ở đây"', () => {
  it('khớp được trang từ đường dẫn con', () => {
    const t = trangHienTai('/invoices/abc-123', SUPER);
    expect(t?.page.route).toBe('/invoices');
  });

  it('khớp route DÀI NHẤT — kể cả khi route ngắn đứng TRƯỚC trong catalog', () => {
    // Catalog thật hôm nay xếp route dài trước route ngắn bao nó, nên "lấy cái
    // đầu tiên" và "lấy cái dài nhất" trùng kết quả — một test trên catalog
    // thật không phân biệt được hai cách. Dựng catalog đảo thứ tự để luật này
    // thật sự có người canh.
    const gia = [
      {
        key: 'g',
        label: 'Nhóm',
        pages: [
          { key: 'cha', label: 'Cài đặt', route: '/settings', features: [f('settings', 'view')] },
          { key: 'con', label: 'Danh mục', route: '/settings/categories', features: [f('settings', 'view')] },
        ],
      },
    ] as unknown as typeof VISIBLE_PAGE_GROUPS;
    const t = trangHienTaiTrong(gia, '/settings/categories/asset-types', SUPER);
    expect(t?.page.route).toBe('/settings/categories');
  });

  it('route "/" chỉ khớp đúng "/" — nếu không nó nuốt mọi đường dẫn', () => {
    expect(trangHienTai('/', SUPER)?.page.route).toBe('/');
    const sau = trangHienTai('/contracts', SUPER);
    expect(sau?.page.route).toBe('/contracts');
  });

  it('trang ngoài quyền ⇒ không nhận ngữ cảnh', () => {
    expect(trangHienTai('/settings/salary', STAFF_ROOMS_ONLY)).toBeNull();
  });

  it('đường dẫn lạ ⇒ null, không đoán bừa', () => {
    expect(trangHienTai('/khong-co-trang-nay', SUPER)).toBeNull();
    expect(dongNguCanhTrang('/khong-co-trang-nay', SUPER)).toBeNull();
  });

  it('dòng ngữ cảnh nêu đúng tên và route', () => {
    const d = dongNguCanhTrang('/invoices', SUPER)!;
    expect(d).toContain('/invoices');
    expect(d).toContain('NGỮ CẢNH');
  });
});
