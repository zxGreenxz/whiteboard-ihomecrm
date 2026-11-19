import type { SyncEntry } from "./types";

/**
 * Descriptor realtime của miền VẬN HÀNH: kho phòng/toà nhà, công việc, khách
 * hàng, công tơ.
 *
 * ĐÍNH CHÍNH 21/10/2026 (RT-HUB-3): `rooms` và `buildings` từng CHỈ mang key
 * ["business-performance"], kèm chú thích "cố ý — danh sách phòng/toà đổi rất
 * hiếm". Đo lại thì sai ở chỗ quan trọng nhất: `rooms.status` đổi MỖI LẦN tạo,
 * thanh lý hay chuyển HĐ, còn Danh mục căn hộ / Sơ đồ toà (`rooms-with-contracts`)
 * không có ai invalidate — kể cả trên chính máy vừa sửa. Nay khai đủ key thật của
 * các màn đó (đã rg: useRooms, useRoomsWithContracts, useBuildings).
 *
 * `buildings` kèm ["rooms"] vì useRooms join tên/mã toà vào từng phòng.
 */
export const OPERATIONS_SYNC_ENTRIES: readonly SyncEntry[] = [
  {
    table: "rooms",
    keys: [
      ["business-performance"],
      ["rooms"], // useRooms / useRoom — dropdown, danh sách phòng
      ["rooms-with-contracts"], // Danh mục căn hộ + Sơ đồ toà
      ["room-detail-contracts"], // trang chi tiết phòng
      ["room-detail-tenants"],
      ["room-active-contract"], // dialog phòng trên sơ đồ toà
    ],
  },
  {
    table: "buildings",
    keys: [
      ["business-performance"],
      ["buildings"], // useBuildings / useBuilding
      ["rooms"],
    ],
  },
  { table: "jobs", keys: [["jobs"]], domain: "jobs" },
  // `customer-contracts` KHÔNG gắn ở đây dù REC_FIX RT-HUB-3 gợi ý: màn đó chỉ
  // hiện HĐ/phòng/toà của khách, không cột nào của `customers` — sửa tên khách
  // không đổi gì trên nó. Nó gắn ở entry contracts.
  { table: "customers", keys: [["customers"], ["customer-residence"]] },
  // 21/10/2026 (RT-HUB-6): CÔNG TƠ. Hai bảng vào publication ở migration
  // 20261021…_realtime_publication_toi_uu.sql — policy SELECT của cả hai theo
  // phạm vi toà (meters_select_rbac / meter_readings_select_rbac), đúng người
  // đang xem màn Chỉ số. Trước đó key công tơ chỉ được mutation trên CHÍNH máy
  // ghi invalidate: nhân viên ghi chỉ số trên điện thoại thì quản lý ở máy khác
  // vẫn thấy "chưa ghi" tới F5 ⇒ nhắc nhầm hoặc ghi trùng.
  {
    table: "meter_readings",
    keys: [
      ["meter-readings"],
      ["meter-reading-stats"],
      ["unrecorded-meters"],
      ["meters-with-latest-reading"],
      ["contract-meter-followups"],
    ],
  },
  {
    table: "meters",
    keys: [["meters"], ["meters-with-latest-reading"], ["unrecorded-meters"]],
  },
];
