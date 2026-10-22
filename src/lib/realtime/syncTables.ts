/**
 * Danh sách bảng mà hub realtime lắng nghe — DỮ LIỆU THUẦN, không import React.
 *
 * VÌ SAO TÁCH RA KHỎI useRealtimeDataSync.ts
 *   Danh sách này phải khớp publication `supabase_realtime` trên production.
 *   Lệch một chiều là im lặng hoàn toàn, và tệ hơn tưởng: hub là MỘT kênh, mà
 *   Realtime tạo subscription của cả kênh trong MỘT transaction — thiếu chỉ MỘT
 *   bảng trong publication thì transaction rollback và CẢ KÊNH (mọi bảng, kể cả
 *   bảng đã publish) mất postgres_changes. Callback subscribe() vẫn báo
 *   SUBSCRIBED; dấu vết duy nhất là thông điệp `system` (status 'error',
 *   extension 'postgres_changes') — subscribeResilient bắt nó và báo
 *   'interrupted' cho dải cảnh báo (RT-CLIENT-1, đo trên TEST 22/10/2026).
 *
 *   LUẬT PHÁT HÀNH: ADD bảng vào publication TRƯỚC khi client nghe bảng đó lên
 *   production; DROP bảng khỏi publication SAU khi mọi client còn nghe nó đã
 *   được promote và tải lại. Xem docs/he-thong/realtime-sync.md §2.
 *
 *   Đã có án lệ trong chính file hub: `contract_terminations` và
 *   `contract_transfers` từng KHÔNG nằm trong publication lẫn danh sách này, nên
 *   "mọi thay đổi thanh lý / chuyển phòng là im lặng hoàn toàn" (ghi chú Đợt 1).
 *
 *   `scripts/check-realtime-descriptors.mjs` đối chiếu danh sách này với
 *   publication thật. Nó đọc CHÍNH module này qua vite-node — không chép tay,
 *   vì repo đã có bốn ca "test kiểm bản chép thay vì kiểm code thật".
 */
export const REALTIME_SYNC_TABLES = [
  "invoices",
  "income_expenses",
  "reservation_deposit_settlements",
  "income_expense_supplements",
  "contracts",
  "rooms",
  "buildings",
  "jobs",
  "customers",
  // Rủi ro #5 của plan thu chi: ba bảng tiền dưới đây trước KHÔNG có mặt ở đây.
  // Hồi đó vô hại vì phiếu bất biến; từ Đợt 4/5/6 phiếu sửa/huỷ/chốt được nên
  // hai người đối chiếu quỹ sẽ đọc ra hai số khác nhau nếu không đồng bộ.
  "payments",
  "income_expense_items",
  "accounts",
  "cash_handovers",
  // Đợt 1: hai bảng VÒNG ĐỜI. Trước đây chúng không nằm trong publication
  // `supabase_realtime` lẫn danh sách này, nên mọi thay đổi thanh lý / chuyển
  // phòng là im lặng hoàn toàn.
  "contract_terminations",
  "contract_transfers",
  // 28/08 (audit 27/08 C-INFRA-7): hai bảng CẤU HÌNH PHÍ THEO TOÀ mà /thanh-toan
  // đọc — vắng ở đây thì máy này sửa cấu hình phí, máy kia phải F5 mới thấy.
  // Publication: 20260828130000_realtime_building_fee_tables.sql.
  "building_fee_accounts",
  "building_utility_accounts",
  // 21/10/2026 (RT-HUB-6): CÔNG TƠ — publication ở
  // 20261021…_realtime_publication_toi_uu.sql. Chưa áp migration đó lên
  // production thì check-realtime-descriptors đỏ hai bảng này, và client mới
  // chạy trên production lúc đó mất event của CẢ 19 bảng hub (không chỉ hai bảng
  // này — xem chú thích đầu file). Áp migration TRƯỚC khi promote client.
  "meter_readings",
  "meters",
] as const;

/** Union tên bảng, suy ra TỪ danh sách — không khai hai lần rồi trôi khỏi nhau. */
export type SyncTable = (typeof REALTIME_SYNC_TABLES)[number];
