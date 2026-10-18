// Gói C đợt 2 — Xe, kho vật tư, kho tài sản, thông báo, lương, Network Center. File của RIÊNG Gói C.
// Mỗi báo cáo khai bằng w2Report() (wave2-kit.mjs) và khớp từng trường với app_private.hermes_w2c_catalog_v1
// (migration 20261018030200_hermes_w2c_ops_read_v1). Quyền = khoá đọc của màn web; SQL quyết định cuối
// (CRM thật ∩ registry ∩ chính sách ∩ Read kết nối ∩ toà overlay). Mô hình INVOKER + RLS: hàm đọc của gói chạy
// bằng vai authenticated dưới RLS của người hỏi; nguồn = RPC web gọi thẳng (Network Center, salary_staff_months)
// hoặc hàm dùng chung public.<miền>_<báo cáo>_v1 (20261018030100) khi web đọc bảng qua PostgREST. Báo cáo theo
// toà: mọi hàng nêu buildingId (null chỉ khi kết nối toàn công ty).
import { w2Report, id, nullable, longText, code, amount, bool, count, date, instant, shaped } from './wave2-kit.mjs';

const text = max => nullable(longText(max));
const num = value => typeof value === 'number' && Number.isFinite(value);
const metric = nullable(num);
const month = value => typeof value === 'string' && /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$/.test(value);
const list = (max, fields) => value => Array.isArray(value) && value.length <= max && value.every(row => shaped(row, fields));
const object = fields => value => shaped(value, fields);
const money = nullable(amount);

const VEHICLE_KINDS = ['MOTORBIKE', 'ELECTRIC_BIKE', 'BICYCLE', 'CAR', 'OTHER'];
const NOTIFICATION_KINDS = ['NEW_INVOICE', 'PAYMENT_REMINDER', 'OVERDUE_INVOICE', 'CONTRACT_EXPIRING', 'ISSUE_RESOLVED', 'GENERAL_ANNOUNCEMENT',
  'CUSTOM', 'DEPOSIT_SHORTFALL', 'SALARY_BONUS', 'ACTION_REQUIRED', 'APPROVAL_RESULT'];
const TOTAL = Object.freeze({ total: count });
const LINE = { materialId: id, materialName: text(200), unit: text(40), quantity: amount };
const SALARY_AMOUNTS = { baseSalary: money, bonus: money, investment: money, commission: money, grossTotal: money, advances: money,
  roomRent: money, takeHome: money, paid: money, remaining: money };
const ONE_BUILDING = { scope: 'rows', params: ['buildingId'], required: ['buildingId'] };
const NC = 'network_center.view';

export const W2C_REPORTS = Object.freeze({
  // C1 /vehicles — useVehicles.ts:39-130 (trang desktop cố định MOTORBIKE: VehiclesPage.tsx:23,114; mobile mọi loại).
  vehicles: w2Report({ permission: 'vehicles.view', source: 'crm.vehicles_list_v1', scope: 'rows', private: true,
    title: 'Danh sách xe (biển số, loại, chủ xe, vé, phí gửi, toà/phòng) mới tạo trước; kind trống = mọi loại (trang web desktop chỉ xe máy). ' +
      'Tên/SĐT khách chỉ có khi được xem khách hàng ở toà đó. query tìm biển số/tên xe/chủ xe/tên khách.',
    params: ['query', 'kind', 'buildingId', 'roomId', 'customerId'], kinds: VEHICLE_KINDS, scopeKeys: ['customers.view'],
    fields: { id, kind: code, name: text(100), plate: text(40), color: text(60), ownerName: text(200), ticketNumber: text(60), parkingFee: amount,
      buildingId: nullable(id), buildingName: text(200), roomId: nullable(id), roomName: text(100), customerId: nullable(id),
      customerName: text(200), customerPhone: text(40) }, summary: TOTAL }),
  // C2 /materials — useMaterials.ts:20-62, MaterialsListContent.tsx:78-80.
  materials: w2Report({ permission: 'materials.view', source: 'crm.materials_items_v1', scope: 'organization',
    title: 'Vật tư trong kho: tồn, mức đặt lại, giá vốn bình quân; lowStock=true chỉ vật tư sắp hết (tồn <= mức đặt lại). Cần kết nối Toàn tổ chức.',
    params: ['query', 'categoryId', 'lowStock'],
    fields: { id, code: text(60), name: text(200), categoryId: nullable(id), categoryName: text(200), unit: text(40), onHand: amount,
      reorderLevel: amount, lowStock: bool, avgUnitCost: amount }, summary: { total: count, lowStock: count } }),
  material_categories: w2Report({ permission: 'materials.view', source: 'crm.materials_categories_v1', scope: 'organization',
    title: 'Danh mục vật tư kèm số vật tư đang dùng danh mục. Cần kết nối Toàn tổ chức.',
    fields: { id, name: text(200), description: text(500), materialCount: count }, summary: TOTAL }),
  // C3 /materials/purchases — useMaterialPurchases.ts:24-35.
  material_purchases: w2Report({ permission: 'materials.view', source: 'crm.materials_purchases_v1', scope: 'organization',
    title: 'Phiếu nhập vật tư mới trước (tổng tiền, dòng vật tư ≤50/phiếu); tên nhà cung cấp chỉ khi kết nối được xem nhà cung cấp. Cần Toàn tổ chức.',
    params: ['fromDate', 'toDate', 'supplierId'], scopeKeys: ['suppliers.view'],
    fields: { id, code: text(60), date, supplierId: nullable(id), supplierName: text(200), total: amount, notes: text(500), itemCount: count,
      items: list(50, { ...LINE, unitPrice: amount, lineTotal: amount }) }, summary: { total: count, amount } }),
  // C4 /materials/usages — useMaterialUsages.ts:18-35, MaterialUsagesContent.tsx:80-84.
  material_usages: w2Report({ permission: 'materials.view', source: 'crm.materials_usages_v1', scope: 'organization',
    title: 'Phiếu xuất dùng vật tư mới trước (người tạo, tổng SL, thành tiền theo giá lúc xuất); mã/tên công việc chỉ khi việc thuộc toà được xem công việc.',
    params: ['fromDate', 'toDate'], scopeKeys: ['tasks.view'],
    fields: { id, code: text(60), date, jobId: nullable(id), jobCode: text(60), jobTitle: text(200), creatorName: text(200), notes: text(500),
      itemCount: count, totalQuantity: amount, totalCost: amount, items: list(50, { ...LINE, unitCost: amount }) },
    summary: { total: count, cost: amount } }),
  // C5 /materials/adjustments — useMaterialAdjustments.ts:17-25.
  material_adjustments: w2Report({ permission: 'materials.view', source: 'crm.materials_adjustments_v1', scope: 'organization',
    title: 'Phiếu kiểm kê/điều chỉnh kho mới trước; kind IN=nhập thêm, OUT=bớt. Cần kết nối Toàn tổ chức.',
    params: ['fromDate', 'toDate', 'kind'], kinds: ['IN', 'OUT'],
    fields: { id, code: text(60), date, type: code, reason: text(500), itemCount: count, items: list(50, LINE) }, summary: TOTAL }),
  // C6 /settings/categories/warehouses — useAssetWarehouses.ts:14-38.
  warehouses: w2Report({ permission: 'warehouses.view', source: 'crm.warehouses_list_v1', scope: 'rows',
    title: 'Kho tài sản (tên, vị trí, toà). Kho không gắn toà chỉ hiện với kết nối Toàn tổ chức.',
    params: ['query', 'buildingId'], fields: { id, name: text(200), location: text(300), buildingId: nullable(id), buildingName: text(200) },
    summary: TOTAL }),
  // C9 /notifications — useNotifications.ts:88-140 (trần 200, chưa đọc = PENDING).
  notifications: w2Report({ permission: 'notifications.view', source: 'crm.notifications_inbox_v1', scope: 'self', private: true,
    title: 'Thông báo trong app của CHÍNH người hỏi thuộc công ty kết nối, mới trước, tối đa 200 như trang web; unreadOnly=true chỉ chưa đọc.',
    params: ['unreadOnly', 'kind'], kinds: NOTIFICATION_KINDS,
    fields: { id, type: code, subject: text(300), content: text(1000), unread: bool, createdAt: instant }, summary: { total: count, unread: count } }),
  // C8 /finance/my-salary — MySalaryPage.tsx:39-41,88; useManagerSalary.ts:567-583,615-665. Chỉ tháng ĐÃ CHỐT.
  my_salary: w2Report({ permission: 'assistant.salary.self', source: 'crm.salary_locked_month_v1', scope: 'self', private: true,
    title: 'Lương của CHÍNH người hỏi trong tháng ĐÃ CHỐT (số đã chốt); kind=adjustments: dòng thưởng/trừ tay, ledger: bảng kê việc. ' +
      'Tháng chưa chốt hoặc sau tháng được xem ⇒ unavailable=source_unavailable (web tính ở trình duyệt, không đoán).',
    params: ['month', 'kind'], required: ['month'], kinds: ['adjustments', 'ledger'],
    fields: { id, type: text(40), date: nullable(date), label: text(300), detail: text(300), amount: money },
    summary: { month, status: code, lockedAt: nullable(instant), roleTitle: text(100), workBonus: money, contractBonus: money,
      adjustmentsTotal: money, ...SALARY_AMOUNTS } }),
  // C7 /finance/salary — ManagerSalaryPage.tsx:104-107 (admin = salary.lock|manage_salary|distribute|super admin).
  salary_month: w2Report({ permission: 'salary.view', source: 'crm.salary_locked_month_v1', scope: 'organization', private: true,
    title: 'Lương quản lý trong tháng: người quản trị lương thấy mọi quản lý, người khác chỉ chính mình. Dòng chưa chốt: status DRAFT/NONE, số = null. ' +
      'Cả tháng chưa ai chốt ⇒ unavailable=source_unavailable. Cần Toàn tổ chức.',
    params: ['month', 'staffId'], required: ['month'],
    fields: { staffId: id, name: text(200), roleTitle: text(100), status: code, lockedAt: nullable(instant), ...SALARY_AMOUNTS },
    summary: { month, managers: count, locked: count, notLocked: count, grossTotal: amount, takeHomeTotal: amount, paidTotal: amount,
      remainingTotal: amount } }),
  // C10 /network-center — supabaseRepository.ts:192-218 → network_center_list_fleet_v1.
  network_fleet: w2Report({ permission: NC, source: 'crm.network_center_list_fleet_v1', scope: 'rows',
    title: 'Network Center: từng toà (router, tình trạng, CPU, PPPoE, sự cố mở, thiết bị đang kết nối, sao lưu gần nhất, uptime).',
    params: ['buildingId'],
    fields: { buildingId: id, buildingName: text(200), routerIdentity: text(200), routerModel: text(100), routerosVersion: text(60),
      lifecycleStatus: text(60), healthStatus: text(60), reachable: bool, lastSeenAt: nullable(instant), cpuPercent: metric,
      memoryUsedBytes: metric, memoryTotalBytes: metric, pppoeState: text(60), connectionCount: metric, arubaCount: metric, openIncidents: metric,
      activeClients: metric, lastBackupAt: nullable(instant), uptimePercent: metric, maintenanceActive: bool, rolloutState: text(60) },
    summary: { buildings: count, reachable: count, openIncidents: num, activeClients: num } }),
  // C11 /network-center/buildings/:id — supabaseRepository.ts:523-530 → network_center_get_building_v1.
  network_building: w2Report({ permission: NC, source: 'crm.network_center_get_building_v1', ...ONE_BUILDING,
    title: 'Network Center một toà: tổng quan router, bảo trì, và các sự cố đang mở (hàng). Cần buildingId.',
    fields: { id, buildingId: id, title: text(300), detail: text(1000), severity: text(60), status: text(60), openedAt: nullable(instant), acknowledgedAt: nullable(instant) },
    summary: { buildingName: text(200), roomsCount: metric, rolloutState: text(60),
      router: nullable(object({ identity: text(200), model: text(100), firmware: text(60), lifecycleStatus: text(60), reachable: bool,
        healthStatus: text(60), lastSeenAt: nullable(instant), cpuPercent: metric, memoryUsedBytes: metric, memoryTotalBytes: metric,
        temperatureC: metric, pppoeState: text(60), connectionCount: metric })),
      maintenance: nullable(object({ reason: text(300), status: text(60), startsAt: nullable(instant), endsAt: nullable(instant) })),
      changesPaused: nullable(bool), openIncidents: count, ports: count, backups: count } }),
  network_ports: w2Report({ permission: NC, source: 'crm.network_center_get_building_v1', ...ONE_BUILDING,
    title: 'Network Center một toà: các cổng router (vai trò, bật/tắt, trạng thái link, lưu lượng, lỗi). Cần buildingId.',
    fields: { id, buildingId: id, name: text(200), role: text(60), enabled: bool, protected: bool, linkState: text(60), rxBps: metric, txBps: metric,
      utilizationPercent: metric, errors: metric, discards: metric }, summary: TOTAL }),
  // C12 tab clients — supabaseRepository.ts:240-249 → network_center_list_clients_v1 (web: 100 mới nhất).
  network_clients: w2Report({ permission: NC, source: 'crm.network_center_list_clients_v1', ...ONE_BUILDING, params: ['buildingId', 'query'],
    private: true, scopeKeys: ['customers.view'],
    title: 'Thiết bị đang kết nối WiFi/hotspot của một toà (tên máy, IP, MAC, phòng, lưu lượng), mới thấy trước, tối đa 2000. ' +
      'Tên/ID khách và ID hợp đồng chỉ khi được xem khách hàng ở toà đó (chặt hơn web).',
    fields: { id, buildingId: id, hostname: text(200), address: text(64), macAddress: text(40), randomizedMac: bool, sessionType: text(60), connectionType: text(60),
      roomHint: text(100), roomId: nullable(id), customerId: nullable(id), customerName: text(200), contractId: nullable(id), rxBps: metric,
      txBps: metric, lastSeenAt: nullable(instant) }, summary: { total: count, customerNamesShown: bool } }),
  // C13 tab topology — supabaseRepository.ts:282-328 → network_center_list_aruba_v1 / _h196a_v1.
  network_aruba: w2Report({ permission: NC, source: 'crm.network_center_list_aruba_v1', ...ONE_BUILDING,
    title: 'Network Center một toà: điểm phát Aruba (tên, model, tình trạng, IP quản lý). Cần buildingId.',
    fields: { id, buildingId: id, name: text(200), model: text(100), lifecycleStatus: text(60), healthStatus: text(60), reachable: nullable(bool), address: text(64),
      lastSeenAt: nullable(instant) }, summary: TOTAL }),
  network_h196a: w2Report({ permission: NC, source: 'crm.network_center_list_h196a_v1', ...ONE_BUILDING,
    title: 'Network Center một toà: modem ZTE H196A phía sau router (tình trạng suy từ bảng bridge/ARP, IP). Cần buildingId.',
    fields: { id, buildingId: id, name: text(200), model: text(100), lifecycleStatus: text(60), healthStatus: text(60), reachable: nullable(bool), address: text(64),
      lastSeenAt: nullable(instant) }, summary: TOTAL }),
  // C14 tabs changes/audit/backups — supabaseRepository.ts:250-269, 407-421.
  network_commands: w2Report({ permission: NC, source: 'crm.network_center_list_commands_v1', ...ONE_BUILDING,
    title: 'Network Center một toà: lệnh thay đổi đã gửi (hành động, trạng thái, lý do); byMe = do chính người hỏi gửi. Cần buildingId.',
    fields: { id, buildingId: id, at: nullable(instant), action: text(100), status: text(60), reason: text(300), actorType: text(60), byMe: bool,
      finishedAt: nullable(instant) },
    summary: TOTAL }),
  network_audit: w2Report({ permission: NC, source: 'crm.network_center_list_audit_v1', ...ONE_BUILDING,
    title: 'Network Center một toà: nhật ký thao tác (hành động, kết quả, lý do, loại người làm); byMe = chính người hỏi. Cần buildingId.',
    fields: { id, buildingId: id, at: nullable(instant), action: text(100), status: text(60), reason: text(300), actorType: text(60), byMe: bool,
      finishedAt: nullable(instant) },
    summary: TOTAL }),
  network_backups: w2Report({ permission: NC, source: 'crm.network_center_get_building_v1', ...ONE_BUILDING,
    title: 'Network Center một toà: các bản sao lưu cấu hình gần nhất (≤50); dùng id làm fromId/toId của network_config_diff. Cần buildingId.',
    fields: { id, buildingId: id, at: nullable(instant), label: text(100), source: text(60) }, summary: TOTAL }),
  network_config_diff: w2Report({ permission: NC, source: 'crm.network_center_compare_snapshots_v1', scope: 'rows',
    params: ['buildingId', 'fromId', 'toId'], required: ['buildingId', 'fromId', 'toId'],
    title: 'So hai bản sao lưu cấu hình (đã che bí mật) của một toà: chỉ các dòng thêm/bớt. fromId/toId lấy từ network_backups.',
    fields: { line: count, buildingId: id, kind: code, text: text(500) }, summary: { changeCount: metric } }),
});

// Đề xuất mục web-parity.json (PR #194 chưa merge vào nền): Gói Z thêm marker `// hermes-parity:begin/end <id>`
// quanh đúng vùng web và mục bản đồ. kind=mirrored: hàm dùng chung chép bộ lọc web; rpc: Hermes gọi thẳng RPC web.
export const W2C_WEB_PARITY = Object.freeze([
  { id: 'w2c-vehicles-list', kind: 'mirrored', web: 'src/hooks/useVehicles.ts:39-130', hermes: 'public.vehicles_list_v1' },
  { id: 'w2c-materials-items', kind: 'mirrored', web: 'src/hooks/useMaterials.ts:20-62', hermes: 'public.materials_items_v1' },
  { id: 'w2c-materials-categories', kind: 'mirrored', web: 'src/hooks/useMaterialCategories.ts:12-28', hermes: 'public.materials_categories_v1' },
  { id: 'w2c-materials-purchases', kind: 'mirrored', web: 'src/hooks/useMaterialPurchases.ts:24-35', hermes: 'public.materials_purchases_v1' },
  { id: 'w2c-materials-usages', kind: 'mirrored', web: 'src/hooks/useMaterialUsages.ts:18-35', hermes: 'public.materials_usages_v1' },
  { id: 'w2c-materials-adjustments', kind: 'mirrored', web: 'src/hooks/useMaterialAdjustments.ts:17-25', hermes: 'public.materials_adjustments_v1' },
  { id: 'w2c-warehouses-list', kind: 'mirrored', web: 'src/hooks/useAssetWarehouses.ts:14-38', hermes: 'public.warehouses_list_v1' },
  { id: 'w2c-notifications-inbox', kind: 'mirrored', web: 'src/hooks/useNotifications.ts:88-140', hermes: 'public.notifications_inbox_v1' },
  { id: 'w2c-salary-locked', kind: 'mirrored', web: 'src/hooks/useManagerSalary.ts:113-125,567-583', hermes: 'public.salary_locked_month_v1' },
  { id: 'w2c-salary-lines', kind: 'mirrored', web: 'src/hooks/useManagerSalary.ts:337-384', hermes: 'public.salary_locked_lines_v1' },
  { id: 'w2c-salary-staff-months', kind: 'rpc', rpc: 'salary_staff_months', web: 'src/hooks/useManagerSalary.ts:639-665',
    hermes: 'app_private.hermes_w2c_read_v1' },
  { id: 'w2c-network-center', kind: 'rpc', rpc: ['network_center_list_fleet_v1', 'network_center_get_building_v1', 'network_center_list_clients_v1',
    'network_center_list_aruba_v1', 'network_center_list_h196a_v1', 'network_center_list_commands_v1', 'network_center_list_audit_v1',
    'network_center_compare_snapshots_v1'], web: 'src/lib/network-center/supabaseRepository.ts:192-421', hermes: 'app_private.hermes_w2c_read_v1' },
]);
