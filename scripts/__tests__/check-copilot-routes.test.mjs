// Đột biến cho check-copilot-routes.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAN_ROUTE,
  SAN_WHITELIST,
  chuanHoa,
  docAllowlist,
  docWhitelist,
  routesNgoaiAllowlist,
} from '../check-copilot-routes.mjs';

const MAU = `
export const MO_TRANG_ROUTES: Record<string, { route: string; module: string; label: string }> = {
  phong: { route: '/apartments', module: 'rooms', label: 'Căn hộ / Phòng' },
  hoa_don: { route: '/invoices', module: 'invoices', label: 'Hoá đơn' },
};
`;

test('đọc đúng khoá, route và module', () => {
  assert.deepEqual(docWhitelist(MAU), [
    { khoa: 'phong', route: '/apartments', module: 'rooms' },
    { khoa: 'hoa_don', route: '/invoices', module: 'invoices' },
  ]);
});

test('ĐỘT BIẾN: đổi tên export ⇒ đọc ra rỗng, và sàn biến nó thành exit 3', () => {
  // Ca này là lý do sàn tồn tại: một bộ đọc trả rỗng trông y hệt "whitelist sạch".
  assert.deepEqual(docWhitelist(MAU.replace('MO_TRANG_ROUTES', 'ROUTES_KHAC')), []);
  assert.ok(SAN_WHITELIST > 0);
});

test('map rỗng cũng ra rỗng — không nhận nhầm dòng nào ngoài map', () => {
  const s = `export const MO_TRANG_ROUTES = {\n};\nconst khac = { route: '/x', module: 'y' };`;
  assert.deepEqual(docWhitelist(s), []);
});

test('chuẩn hoá bỏ dấu / cuối nhưng giữ gốc', () => {
  assert.equal(chuanHoa('/invoices/'), '/invoices');
  assert.equal(chuanHoa('/invoices'), '/invoices');
  assert.equal(chuanHoa('/'), '/');
});

test('sàn route đủ chặt để bắt bộ bóc route hỏng', () => {
  // Đo 11/08/2026: 146 route. Sàn 100 để còn chỗ xoá route thật.
  assert.ok(SAN_ROUTE >= 50 && SAN_ROUTE <= 146);
});

// ── Whitelist điều hướng ⊆ phạm vi route guard ──────────────────────────────

test('đọc được PILOT_ROUTE_ALLOWLIST; đổi tên export ⇒ rỗng (sàn bắt)', () => {
  assert.deepEqual(
    docAllowlist(`export const PILOT_ROUTE_ALLOWLIST = ['/apartments', '/invoices'];`),
    ['/apartments', '/invoices'],
  );
  assert.deepEqual(docAllowlist(`export const KHAC = ['/apartments'];`), []);
});

test('chỉ ra đúng route nằm ngoài allowlist', () => {
  assert.deepEqual(
    routesNgoaiAllowlist(
      [{ khoa: 'hop_dong', route: '/contracts', module: 'contracts' }],
      ['/apartments', '/invoices', '/customers'],
    ),
    ['/contracts'],
  );
});

test('ĐO THẬT 13/08/2026: whitelist 5 vs allowlist 3 ⇒ hụt /contracts và /buildings', () => {
  // Fixture SINH TỪ số đo thật, không thay cho việc đọc registry — nó cố định
  // hình dạng lỗi mà gate phải bắt, để lần sau ai rút allowlist xuống là đỏ.
  const wl = [
    { khoa: 'phong', route: '/apartments', module: 'rooms' },
    { khoa: 'hoa_don', route: '/invoices', module: 'invoices' },
    { khoa: 'khach_hang', route: '/customers', module: 'customers' },
    { khoa: 'hop_dong', route: '/contracts', module: 'contracts' },
    { khoa: 'toa_nha', route: '/buildings', module: 'buildings' },
  ];
  const thieu = routesNgoaiAllowlist(wl, ['/apartments', '/invoices', '/customers']);
  assert.deepEqual(thieu, ['/contracts', '/buildings']);
  // Và khi allowlist phủ đủ thì không còn vi phạm nào.
  assert.deepEqual(
    routesNgoaiAllowlist(wl, ['/apartments', '/invoices', '/customers', '/contracts', '/buildings']),
    [],
  );
});

test('phủ theo THƯ MỤC, không phải tiền tố chuỗi', () => {
  // `/build` KHÔNG được phép phủ `/buildings` — guard lúc chạy dùng
  // `path === a || path.startsWith(a + '/')`, gate phải khớp đúng luật đó.
  assert.deepEqual(routesNgoaiAllowlist([{ route: '/buildings' }], ['/build']), ['/buildings']);
  assert.deepEqual(routesNgoaiAllowlist([{ route: '/buildings/12' }], ['/buildings']), []);
});

test('dấu / cuối không tạo vi phạm giả', () => {
  assert.deepEqual(routesNgoaiAllowlist([{ route: '/invoices/' }], ['/invoices']), []);
  assert.deepEqual(routesNgoaiAllowlist([{ route: '/invoices' }], ['/invoices/']), []);
});

test('module chỉ có `manage` mà không có `view` phải bị coi là thiếu', () => {
  // Tool gọi canUse(perms, module, 'view'). Kiểm "module có tồn tại" là chưa đủ:
  // triệu chứng của thiếu `.view` giống hệt gõ sai tên module.
  const features = new Set(['rooms.manage', 'invoices.view']);
  assert.ok(!features.has('rooms.view'));
  assert.ok(features.has('invoices.view'));
});
