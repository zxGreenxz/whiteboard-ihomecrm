import assert from 'node:assert/strict';
import test from 'node:test';
import { duongDanChuan, laFileMobile, validateSafeControlMarkers } from '../check-copilot-safe-control-markers.mjs';

const CONTRACTS = [
  { key: 'rooms.list', safeControlIds: ['room.search', 'room.status-filter'], markerFileHint: 'rooms' },
  { key: 'invoices.list', safeControlIds: ['invoice.month-filter', 'invoice.status-filter', 'invoice.search'], markerFileHint: 'invoices' },
  { key: 'customers.list', safeControlIds: ['customer.search'], markerFileHint: 'customers' },
];

/** Bộ nguồn hợp lệ tối thiểu: mỗi trang đủ marker ở CẢ hai lớp, đúng vùng file. */
function nguonHopLe() {
  return new Map([
    ['src/components/rooms/RoomListFilters.tsx', '<input data-ai-safe="rooms.list.room.search" /><button data-ai-safe="rooms.list.room.status-filter" />'],
    ['src/components/invoices/InvoiceListFilters.tsx', '<button data-ai-safe="invoices.list.invoice.month-filter" /><button data-ai-safe="invoices.list.invoice.status-filter" /><input data-ai-safe="invoices.list.invoice.search" />'],
    ['src/components/customers/CustomerListToolbar.tsx', '<input data-ai-safe="customers.list.customer.search" />'],
    ['src/pages/rooms/RoomsMobilePage.tsx', '<input data-ai-safe="rooms.list.room.search" />'],
    ['src/pages/invoices/InvoicesMobilePage.tsx', '<input data-ai-safe="invoices.list.invoice.search" />'],
    ['src/pages/customers/CustomersMobilePage.tsx', '<input data-ai-safe="customers.list.customer.search" />'],
  ]);
}

const TRANG_PHONG = [{ key: 'rooms.list', safeControlIds: ['room.search'], markerFileHint: 'rooms' }];

/** Một trang Phòng hợp lệ tối thiểu — nền cho các phép đột biến. */
function nguonPhong() {
  return new Map([
    ['src/components/rooms/RoomListFilters.tsx', '<input data-ai-safe="rooms.list.room.search" />'],
    ['src/pages/rooms/RoomsMobilePage.tsx', '<input data-ai-safe="rooms.list.room.search" />'],
  ]);
}

test('requires exactly the declared page-qualified safe-control markers', () => {
  assert.deepEqual(validateSafeControlMarkers(CONTRACTS, nguonHopLe()), []);
  assert.match(
    validateSafeControlMarkers(
      TRANG_PHONG,
      new Map([['src/components/rooms/RoomListFilters.tsx', '<input data-ai-safe="rooms.list.room.unknown" />']]),
    ).join('\n'),
    /unknown marker/,
  );
  assert.match(
    validateSafeControlMarkers(CONTRACTS, new Map()).join('\n'),
    /missing marker rooms\.list\.room\.search/,
  );
});

test('trung marker trong CUNG mot lop bien the la danh dau sai', () => {
  // Hai phần tử cùng ID trong một lần mount ⇒ `giaiSafeControl` ném
  // `nhieu_hon_mot` và control chết hẳn. Gate phải bắt ở tĩnh.
  const trungDesktop = nguonPhong();
  trungDesktop.set(
    'src/components/rooms/RoomListFilters.tsx',
    '<input data-ai-safe="rooms.list.room.search" /><input data-ai-safe="rooms.list.room.search" />',
  );
  assert.match(validateSafeControlMarkers(TRANG_PHONG, trungDesktop).join('\n'), /duplicate marker/);

  const trungMobile = nguonPhong();
  trungMobile.set('src/pages/rooms/RoomsListMobile.tsx', '<input data-ai-safe="rooms.list.room.search" />');
  assert.match(validateSafeControlMarkers(TRANG_PHONG, trungMobile).join('\n'), /duplicate marker/);
});

test('cung marker o desktop VA mobile la hop le — hai bien the khong bao gio mount cung luc', () => {
  assert.deepEqual(validateSafeControlMarkers(TRANG_PHONG, nguonPhong()), []);
});

test('trang co control ma khong co marker nao trong bien the mobile ⇒ do', () => {
  // Trên điện thoại trang desktop KHÔNG mount: thiếu marker mobile nghĩa là
  // page-agent mù hẳn (`khong_thay`) ở đúng nơi người dùng đang đứng.
  const thieuMobile = nguonHopLe();
  thieuMobile.delete('src/pages/customers/CustomersMobilePage.tsx');
  assert.match(
    validateSafeControlMarkers(CONTRACTS, thieuMobile).join('\n'),
    /missing mobile marker for page customers\.list/,
  );

  // Trang không khai control nào thì không bị đòi marker (mobile lẫn desktop),
  // và cũng không bị đòi markerFileHint.
  assert.deepEqual(
    validateSafeControlMarkers([{ key: 'buildings.list', safeControlIds: [] }], new Map()),
    [],
  );
});

test('trang co control ma khong co marker nao trong bien the DESKTOP ⇒ do', () => {
  // Đối xứng với luật mobile: bỏ file desktop thì người dùng máy tính mất control.
  const thieuDesktop = nguonHopLe();
  thieuDesktop.delete('src/components/customers/CustomerListToolbar.tsx');
  assert.match(
    validateSafeControlMarkers(CONTRACTS, thieuDesktop).join('\n'),
    /missing desktop marker for page customers\.list/,
  );
});

test('marker dat NHAM trang khac khong duoc tinh — dot bien rooms → CustomersMobilePage', () => {
  // Lỗ hổng thật của bản trước: gate chỉ đối chiếu marker với DANH SÁCH control,
  // nên marker của Phòng nằm trong file Khách hàng vẫn "đếm hộ" cho trang Phòng,
  // còn trang Khách hàng thì mang một control không phải của nó.
  const nham = nguonHopLe();
  nham.set('src/pages/rooms/RoomsMobilePage.tsx', '<div />');
  nham.set(
    'src/pages/customers/CustomersMobilePage.tsx',
    '<input data-ai-safe="customers.list.customer.search" /><input data-ai-safe="rooms.list.room.search" />',
  );
  const loi = validateSafeControlMarkers(CONTRACTS, nham).join('\n');
  assert.match(loi, /CustomersMobilePage\.tsx: marker rooms\.list\.room\.search outside page area "rooms"/);
  assert.match(loi, /missing mobile marker for page rooms\.list/);
});

test('thieu markerFileHint tren trang co control ⇒ do (fail-closed)', () => {
  // Không có hint thì gate KHÔNG biết marker nằm đúng vùng nào. "Không biết"
  // phải là đỏ, không phải bỏ qua.
  assert.match(
    validateSafeControlMarkers([{ key: 'rooms.list', safeControlIds: ['room.search'] }], nguonPhong()).join('\n'),
    /page rooms\.list declares safeControlIds without markerFileHint/,
  );
});

test('laFileMobile nhan dien theo TEN FILE, ca hai kieu dau phan cach', () => {
  assert.equal(laFileMobile('src/pages/rooms/RoomsMobilePage.tsx'), true);
  assert.equal(laFileMobile(String.raw`src\pages\rooms\RoomsMobilePage.tsx`), true);
  assert.equal(laFileMobile('src/components/rooms/RoomListFilters.tsx'), false);
  // Thư mục tên "mobile" KHÔNG đủ: quy ước là tên file, để phân lớp không phụ
  // thuộc chỗ đặt file.
  assert.equal(laFileMobile('src/components/sale-phong/mobile/Analytics.tsx'), false);

  // Bay that: neu tach basename bang regex chi biet dau `/`, thi tren Windows
  // (`path.join` sinh dau cheo nguoc) ham do "Mobile" tren CA duong dan va
  // mot component DESKTOP nam duoi thu muc ten `Mobile` bi xep nham lop mobile.
  // Hai cap duoi day canh dung cho do — ca hai kieu dau phan cach.
  assert.equal(laFileMobile(String.raw`src\pages\Mobile\RoomListFilters.tsx`), false);
  assert.equal(laFileMobile('src/pages/Mobile/RoomListFilters.tsx'), false);
  assert.equal(laFileMobile(String.raw`src\pages\rooms\RoomsMobilePage.tsx`), true);
  assert.equal(laFileMobile('src/pages/rooms/RoomsMobilePage.tsx'), true);
});

test('duongDanChuan quy ve dau gach cheo xuoi', () => {
  assert.equal(duongDanChuan(String.raw`src\pages\rooms\RoomsMobilePage.tsx`), 'src/pages/rooms/RoomsMobilePage.tsx');
  assert.equal(duongDanChuan('src/pages/rooms/RoomsMobilePage.tsx'), 'src/pages/rooms/RoomsMobilePage.tsx');
});
