// Gói D đợt 2 — Tài sản, danh mục, toà/phòng, báo cáo BĐS. File của RIÊNG Gói D.
// Khai báo mỗi báo cáo bằng w2Report() (wave2-kit.mjs); mã báo cáo là khoá của object, khớp
// /^[a-z][a-z0-9_]{1,47}$/ và KHÔNG trùng mã của gói khác (wave2-registry.mjs kiểm khi nạp).
// SQL cùng gói: app_private.hermes_w2d_catalog_v1 (khớp từng trường với khai báo ở đây) và
// app_private.hermes_w2d_read_v1 — chỉ CREATE OR REPLACE trong migration 2026101804xxxx_hermes_w2d_*.sql.
// Gợi ý mã (kế hoạch khảo sát đợt 2, chưa ràng buộc): assets, asset_summary, asset_categories,
// asset_movements, asset_maintenance, services, service_quotas, suppliers, meters, buildings, areas,
// building_detail, rooms, room_detail, floors, ie_types, task_types, hotlines, re_vacant_rooms,
// re_expiring, re_renewals_transfers, re_promotions, re_new_leases, re_terminations, re_expense_ratio.
// Ví dụ:
//   import { w2Report, id, nullable, longText, count } from './wave2-kit.mjs';
//   export const W2D_REPORTS = Object.freeze({
//     floors: w2Report({ permission: 'buildings.view', source: 'crm.floors', scope: 'rows',
//       title: '<mô tả cho mô hình>', params: ['buildingId'],
//       fields: { id, buildingId: id, buildingName: nullable(longText(200)), floorNumber: count } }),
//   });
export const W2D_REPORTS = Object.freeze({});
