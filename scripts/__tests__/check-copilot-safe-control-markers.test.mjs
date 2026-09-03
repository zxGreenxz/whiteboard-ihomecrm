import assert from 'node:assert/strict';
import test from 'node:test';
import { laFileMobile, validateSafeControlMarkers } from '../check-copilot-safe-control-markers.mjs';

const CONTRACTS = [
  { key: 'rooms.list', safeControlIds: ['room.search', 'room.status-filter'] },
  { key: 'invoices.list', safeControlIds: ['invoice.month-filter', 'invoice.status-filter', 'invoice.search'] },
  { key: 'customers.list', safeControlIds: ['customer.search'] },
];

/** Bộ nguồn hợp lệ tối thiểu: desktop đủ marker, mobile đủ ÍT NHẤT một mỗi trang. */
function nguonHopLe() {
  return new Map([
    ['rooms.tsx', '<input data-ai-safe="rooms.list.room.search" /><button data-ai-safe="rooms.list.room.status-filter" />'],
    ['invoices.tsx', '<button data-ai-safe="invoices.list.invoice.month-filter" /><button data-ai-safe="invoices.list.invoice.status-filter" /><input data-ai-safe="invoices.list.invoice.search" />'],
    ['customers.tsx', '<input data-ai-safe="customers.list.customer.search" />'],
    ['RoomsMobilePage.tsx', '<input data-ai-safe="rooms.list.room.search" />'],
    ['InvoicesMobilePage.tsx', '<input data-ai-safe="invoices.list.invoice.search" />'],
    ['CustomersMobilePage.tsx', '<input data-ai-safe="customers.list.customer.search" />'],
  ]);
}

test('requires exactly the declared page-qualified safe-control markers', () => {
  assert.deepEqual(validateSafeControlMarkers(CONTRACTS, nguonHopLe()), []);
  assert.match(
    validateSafeControlMarkers(
      [{ key: 'rooms.list', safeControlIds: ['room.search'] }],
      new Map([['rooms.tsx', '<input data-ai-safe="rooms.list.room.unknown" />']]),
    ).join('\n'),
    /unknown marker/,
  );
  assert.match(
    validateSafeControlMarkers(CONTRACTS, new Map([['rooms.tsx', '<div />']])).join('\n'),
    /missing marker rooms\.list\.room\.search/,
  );
});

test('trung marker trong CUNG mot lop bien the la danh dau sai', () => {
  // Hai phần tử cùng ID trong một lần mount ⇒ `giaiSafeControl` ném
  // `nhieu_hon_mot` và control chết hẳn. Gate phải bắt ở tĩnh.
  assert.match(
    validateSafeControlMarkers(
      [{ key: 'rooms.list', safeControlIds: ['room.search'] }],
      new Map([['rooms.tsx', '<input data-ai-safe="rooms.list.room.search" /><input data-ai-safe="rooms.list.room.search" />']]),
    ).join('\n'),
    /duplicate marker/,
  );
  assert.match(
    validateSafeControlMarkers(
      [{ key: 'rooms.list', safeControlIds: ['room.search'] }],
      new Map([
        ['RoomsMobilePage.tsx', '<input data-ai-safe="rooms.list.room.search" />'],
        ['RoomsListMobile.tsx', '<input data-ai-safe="rooms.list.room.search" />'],
      ]),
    ).join('\n'),
    /duplicate marker/,
  );
});

test('cung marker o desktop VA mobile la hop le — hai bien the khong bao gio mount cung luc', () => {
  assert.deepEqual(
    validateSafeControlMarkers(
      [{ key: 'rooms.list', safeControlIds: ['room.search'] }],
      new Map([
        ['components/rooms/RoomListFilters.tsx', '<input data-ai-safe="rooms.list.room.search" />'],
        ['pages/rooms/RoomsMobilePage.tsx', '<input data-ai-safe="rooms.list.room.search" />'],
      ]),
    ),
    [],
  );
});

test('trang co control ma khong co marker nao trong bien the mobile ⇒ do', () => {
  // Trên điện thoại trang desktop KHÔNG mount: thiếu marker mobile nghĩa là
  // page-agent mù hẳn (`khong_thay`) ở đúng nơi người dùng đang đứng.
  const thieuMobile = nguonHopLe();
  thieuMobile.delete('CustomersMobilePage.tsx');
  assert.match(
    validateSafeControlMarkers(CONTRACTS, thieuMobile).join('\n'),
    /missing mobile marker for page customers\.list/,
  );

  // Trang không khai control nào thì không bị đòi marker mobile.
  assert.deepEqual(
    validateSafeControlMarkers([{ key: 'buildings.list', safeControlIds: [] }], new Map()),
    [],
  );
});

test('laFileMobile nhan dien theo TEN FILE, ca hai kieu dau phan cach', () => {
  assert.equal(laFileMobile('src/pages/rooms/RoomsMobilePage.tsx'), true);
  assert.equal(laFileMobile('src\\pages\\rooms\\RoomsMobilePage.tsx'), true);
  assert.equal(laFileMobile('src/components/rooms/RoomListFilters.tsx'), false);
  // Thư mục tên "mobile" KHÔNG đủ: quy ước là tên file, để phân lớp không phụ
  // thuộc chỗ đặt file.
  assert.equal(laFileMobile('src/components/sale-phong/mobile/Analytics.tsx'), false);
});
