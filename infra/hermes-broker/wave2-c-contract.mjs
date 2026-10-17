// Gói C đợt 2 — Xe, kho vật tư, lương, thông báo, Network Center. File của RIÊNG Gói C.
// Khai báo mỗi báo cáo bằng w2Report() (wave2-kit.mjs); mã báo cáo là khoá của object, khớp
// /^[a-z][a-z0-9_]{1,47}$/ và KHÔNG trùng mã của gói khác (wave2-registry.mjs kiểm khi nạp).
// SQL cùng gói: app_private.hermes_w2c_catalog_v1 (khớp từng trường với khai báo ở đây) và
// app_private.hermes_w2c_read_v1 — chỉ CREATE OR REPLACE trong migration 2026101803xxxx_hermes_w2c_*.sql.
// Gợi ý mã (kế hoạch khảo sát đợt 2, chưa ràng buộc): vehicles, materials, material_categories,
// material_purchases, material_usages, material_adjustments, warehouses, salary_month, my_salary,
// notifications, network_fleet, network_building, network_clients, network_devices, network_commands,
// network_config_diff.
// Ví dụ:
//   import { w2Report, id, nullable, longText, amount } from './wave2-kit.mjs';
//   export const W2C_REPORTS = Object.freeze({
//     vehicles: w2Report({ permission: 'vehicles.view', source: 'crm.vehicles', scope: 'rows', private: true,
//       title: '<mô tả cho mô hình>', params: ['query', 'buildingId', 'roomId'],
//       fields: { id, plate: nullable(longText(40)), buildingId: id, roomName: nullable(longText(100)) } }),
//   });
export const W2C_REPORTS = Object.freeze({});
