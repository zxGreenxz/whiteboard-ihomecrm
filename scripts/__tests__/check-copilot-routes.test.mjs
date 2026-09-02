// Đột biến cho check-copilot-routes.
//
// Từ 02/09/2026 gate không còn đọc ba danh sách viết tay bằng regex: phạm vi
// điều hướng và allowlist UI-control đều SINH TỪ `COPILOT_PAGE_CONTRACTS`
// (src/copilot/pageScope.ts), nên gate nạp giá trị thật qua vite-node rồi đối
// chiếu với chính contract. Test ở đây khoá các HÀM THUẦN làm phép đối chiếu —
// phần duy nhất còn có thể im lặng sai.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAN_DIEU_HUONG,
  SAN_PILOT,
  SAN_ROUTE,
  TEN_ALLOWLIST,
  chuanHoa,
  docTenAllowlist,
  lechUiControl,
  routesNgoaiHopDong,
} from '../check-copilot-routes.mjs';

test('chuẩn hoá bỏ dấu / cuối nhưng giữ gốc', () => {
  assert.equal(chuanHoa('/invoices/'), '/invoices');
  assert.equal(chuanHoa('/invoices'), '/invoices');
  assert.equal(chuanHoa('/'), '/');
});

test('sàn route đủ chặt để bắt bộ bóc route hỏng', () => {
  // Đo 11/08/2026: 146 route. Sàn 100 để còn chỗ xoá route thật.
  assert.ok(SAN_ROUTE >= 50 && SAN_ROUTE <= 146);
});

test('sàn điều hướng bắt được cả bộ nạp hỏng lẫn phạm vi teo về pilot cũ', () => {
  // Đo 02/09/2026: 19 route điều hướng sinh từ 47 contract. Sàn phải NẰM TRÊN
  // con số 3 của ba danh sách tay cũ, nếu không một lần rơi về pilot cũ (hoặc
  // một bộ nạp trả rỗng) vẫn trông y hệt "phạm vi sạch".
  assert.ok(SAN_DIEU_HUONG > 3, 'sàn phải cao hơn 3 trang pilot cũ');
  assert.ok(SAN_DIEU_HUONG <= 19, 'sàn không được cao hơn số đo thật, kẻo gate đỏ vô cớ');
});

// ── Điều hướng ⊆ contract ────────────────────────────────────────────────────

test('ĐỘT BIẾN: thêm route TAY ngoài contract ⇒ gate chỉ đúng route đó', () => {
  // Đây là hình dạng lỗi mà lát G1-A tồn tại để chặn: ai đó thấy thiếu một
  // trang và nhét thẳng vào danh sách điều hướng thay vì khai contract. Route
  // đó khi ấy không có `dataClass`, không có `mode`, không có rollout key —
  // tức là một bề mặt Copilot không ai duyệt.
  const hopDong = ['/apartments', '/invoices', '/customers', '/tasks'];
  assert.deepEqual(
    routesNgoaiHopDong([{ key: 'tay', route: '/finance/salary' }], hopDong),
    ['/finance/salary'],
  );
  assert.deepEqual(
    routesNgoaiHopDong([{ key: 'tasks.list', route: '/tasks' }], hopDong),
    [],
  );
});

test('so khớp TUYỆT ĐỐI, không phải tiền tố — `/build` không phủ `/buildings`', () => {
  // Điều hướng trỏ tới một route cụ thể, nên phép so phải là bằng nhau. Nới
  // thành tiền tố sẽ cho `/finance/salary` lọt qua vì có contract `/finance/cashbooks`.
  assert.deepEqual(routesNgoaiHopDong([{ route: '/buildings' }], ['/build']), ['/buildings']);
  assert.deepEqual(routesNgoaiHopDong([{ route: '/finance/salary' }], ['/finance/cashbooks']), [
    '/finance/salary',
  ]);
});

test('dấu / cuối không tạo vi phạm giả', () => {
  assert.deepEqual(routesNgoaiHopDong([{ route: '/invoices/' }], ['/invoices']), []);
  assert.deepEqual(routesNgoaiHopDong([{ route: '/invoices' }], ['/invoices/']), []);
});

test('danh sách rỗng ra rỗng — sàn là thứ bắt ca này, không phải hàm này', () => {
  assert.deepEqual(routesNgoaiHopDong([], ['/apartments']), []);
});

// ── Allowlist UI-control == contract có control ──────────────────────────────

test('allowlist UI-control phải KHỚP ĐÚNG tập contract có safeControlIds', () => {
  const coControl = ['/apartments', '/invoices', '/customers'];
  assert.deepEqual(lechUiControl(coControl, coControl), { thieu: [], thua: [] });
});

test('ĐỘT BIẾN: nới allowlist bằng tay ⇒ "thừa"; rút bớt ⇒ "thiếu"', () => {
  // Hai chiều, không chỉ một. Chỉ kiểm "allowlist ⊆ contract" thì ai đó xoá
  // `safeControlIds` của một trang mà quên rút allowlist vẫn xanh — và ngược
  // lại, chỉ kiểm ⊇ thì nới allowlist bằng tay lại lọt. Cả hai đều mở phạm vi
  // thao tác cho page-agent ở nơi chưa có control nào được duyệt.
  const coControl = ['/apartments', '/invoices', '/customers'];
  assert.deepEqual(lechUiControl([...coControl, '/contracts'], coControl), {
    thieu: [],
    thua: ['/contracts'],
  });
  assert.deepEqual(lechUiControl(['/apartments'], coControl), {
    thieu: ['/invoices', '/customers'],
    thua: [],
  });
});

test('thứ tự khai không tạo lệch giả', () => {
  assert.deepEqual(lechUiControl(['/invoices', '/apartments'], ['/apartments', '/invoices']), {
    thieu: [],
    thua: [],
  });
});

test('module chỉ có `manage` mà không có `view` phải bị coi là thiếu', () => {
  // Tool gọi canUse(perms, module, action) theo đúng contract. Kiểm "module có
  // tồn tại" là chưa đủ: triệu chứng của thiếu action giống hệt gõ sai tên module.
  const features = new Set(['rooms.manage', 'invoices.view']);
  assert.ok(!features.has('rooms.view'));
  assert.ok(features.has('invoices.view'));
});

// ── Chỗ RUNTIME đọc allowlist ────────────────────────────────────────────────

test('đọc đúng tên biểu thức làm allowlist mặc định của page-agent', () => {
  assert.equal(
    docTenAllowlist('  const allowlist = params.allowlist ?? PILOT_UI_CONTROL_ROUTES;\n'),
    'PILOT_UI_CONTROL_ROUTES',
  );
  assert.equal(TEN_ALLOWLIST, 'PILOT_UI_CONTROL_ROUTES');
});

test('ĐỘT BIẾN: bí danh ở giữa ⇒ gate bắt, dù mọi con số vẫn xanh', () => {
  // Đây là lỗ đã bị chỉ ra: gate nạp giá trị của PILOT_UI_CONTROL_ROUTES (bên
  // SẢN XUẤT), nên `const X = [...PILOT_UI_CONTROL_ROUTES, '/contracts']` rồi
  // cho createAgent dùng X sẽ nới phạm vi ĐỨNG của page-agent mà không con số
  // nào đổi. Cách duy nhất bắt được là nhìn vào chỗ runtime thực sự đọc.
  const ten = docTenAllowlist('const allowlist = params.allowlist ?? PILOT_ROUTE_ALLOWLIST;');
  assert.equal(ten, 'PILOT_ROUTE_ALLOWLIST');
  assert.notEqual(ten, TEN_ALLOWLIST);
});

test('ĐỘT BIẾN: mảng viết tại chỗ ⇒ chuỗi rỗng (vi phạm), không phải null', () => {
  // Rỗng và null phải khác nhau: rỗng = "đọc được và nó sai" (exit 1),
  // null = "không đo được" (exit 3). Gộp hai cái thì một bộ đọc hỏng sẽ được
  // báo cáo như một vi phạm có thật, và ngược lại.
  assert.equal(docTenAllowlist("const allowlist = params.allowlist ?? ['/apartments', '/contracts'];"), '');
  assert.equal(docTenAllowlist('const allowlist = params.allowlist;'), null);
  assert.equal(docTenAllowlist('không có gì ở đây'), null);
});

test('sàn route UI-control giữ đúng 3 trang pilot làm mức chống-xanh-rỗng', () => {
  assert.equal(SAN_PILOT, 3);
});
