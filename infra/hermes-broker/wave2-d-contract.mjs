// Gói D đợt 2 — Tài sản, danh mục, toà/phòng, báo cáo BĐS. File của RIÊNG Gói D.
// Khai báo mỗi báo cáo bằng w2Report() (wave2-kit.mjs); khớp từng trường với
// app_private.hermes_w2d_catalog_v1 và hàm đọc INVOKER (20261018040100); hàm dùng chung ở 20261018040000.
// Nguồn: hàm SQL DÙNG CHUNG public.<miền>_*_v1 (INVOKER + RLS của người hỏi, search_path rỗng, danh sách toà chỉ
// thu hẹp) theo đúng bộ lọc màn web đọc bảng thẳng; riêng dòng tiền phòng gọi thẳng RPC web get_room_cash_lifecycle_v1.
// Khoá đợt 1 dùng lại (đang bật trên production): assets.view, services.view, rooms.view ⇒ các báo cáo assets,
// services, rooms, room_detail sống ngay khi cổng + migration này deploy (không đợi Gói Z bật khoá).
// Rào công ty (20261018000700): mọi hàng SQL nêu organizationId từ cột organization_id của hàm dùng chung (bảng neo
// đã lọc công ty); cổng so với công ty kết nối rồi gỡ ⇒ fields KHÔNG khai organizationId.
// Chủ chốt 17/10: mọi đầu ra chỉ trả lời riêng (private). Bỏ D2 (ba trang PlaceholderPage, TEST 0 dòng) và
// D11 (trang giữ chỗ, không bảng).
import { w2Report, id, nullable, longText, code, amount, bool, count, date } from './wave2-kit.mjs';

const int = value => Number.isSafeInteger(value);
const month = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const text = max => nullable(longText(max));
const textList = (max, len) => value => Array.isArray(value) && value.length <= max && value.every(longText(len));
const shapedList = (max, fields) => value => Array.isArray(value) && value.length <= max &&
  value.every(row => row !== null && typeof row === 'object' && !Array.isArray(row) &&
    Object.keys(row).length === Object.keys(fields).length && Object.entries(fields).every(([key, check]) => Object.hasOwn(row, key) && check(row[key])));
const shapedOrNull = fields => value => value === null || shapedList(1, fields)([value]);

const ROOM = { roomId: id, roomName: text(100), buildingId: id, buildingName: text(200) };
const CONTRACT = { contractId: id, contractNumber: text(100), status: code };
const BUILDING_ROW = { buildingId: id, code: text(100), name: text(200), type: nullable(code), status: nullable(code), totalFloors: nullable(int),
  address: text(500), description: text(1000), areaNames: textList(20, 200), roomsTotal: count, roomsAvailable: count, roomsOccupied: count,
  roomsReserved: count, roomsMaintenance: count, roomsUnavailable: count, updatedOn: nullable(date) };
const BUILDING_SUMMARY = { total: count, active: count, inactive: count };
const ROOM_ROW = { roomId: id, name: text(100), code: text(100), buildingId: id, buildingName: text(200), floor: nullable(int), area: nullable(amount),
  rentPrice: amount, depositAmount: amount, maxOccupants: nullable(int), status: code, displayStatus: code };
const TOTAL = { total: count };
const RANGE = 'Không truyền ngày: như mặc định của trang web.';

export const W2D_REPORTS = Object.freeze({
  // D15 — Báo cáo BĐS (/reports/real-estate/*; src/hooks/reports/realEstateReports.ts)
  re_vacant_rooms: w2Report({ permission: 'reports_real_estate.vacant_rooms', source: 'crm.real_estate_vacant_rooms_v1', scope: 'rows', private: true,
    title: 'Báo cáo phòng trống: phòng không có HĐ đang hiệu lực (trừ phòng giữ chỗ), số ngày trống từ lần kết thúc HĐ gần nhất; lọc toà/tầng.',
    params: ['buildingId', 'floor'],
    fields: { ...ROOM, floor: nullable(int), area: nullable(amount), rentPrice: amount, status: code, lastEndDate: nullable(date), daysVacant: nullable(int) },
    summary: { total: count, vacantUpTo7Days: count, vacant8To30Days: count, vacantOver30Days: count, unknownSince: count } }),
  re_expiring: w2Report({ permission: 'reports_real_estate.expiring', source: 'crm.real_estate_expiring_contracts_v1', scope: 'rows', private: true,
    title: 'HĐ sắp hết hạn trong N ngày tới (mặc định 30): số ngày còn lại, giá thuê, phòng/tầng; tên/SĐT khách chỉ khi có quyền xem khách ở toà đó.',
    params: ['buildingId', 'floor', 'days'], scopeKeys: ['customers.view'],
    fields: { ...CONTRACT, startDate: nullable(date), endDate: date, daysLeft: int, rentPrice: amount, ...ROOM, floor: nullable(int),
      customerName: text(200), customerPhone: text(40), customerEmail: text(200) },
    summary: { days: count, total: count, within7Days: count, within8To15Days: count, within16To30Days: count } }),
  re_renewals_transfers: w2Report({ permission: 'reports_real_estate.renewals_transfers', source: 'crm.real_estate_renewals_transfers_v1', scope: 'rows',
    private: true, title: 'Gia hạn (phụ lục gia hạn đã duyệt) và chuyển nhượng HĐ trong kỳ: ngày, giá thuê mới, phòng, khách đại diện (cần quyền xem khách).',
    params: ['buildingId', 'fromDate', 'toDate'], scopeKeys: ['customers.view'],
    fields: { kind: code, eventId: id, contractId: id, contractNumber: text(100), eventDate: nullable(date), rentPrice: amount, ...ROOM,
      customerName: text(200) },
    summary: { total: count, renewals: count, transfers: count } }),
  re_promotions: w2Report({ permission: 'reports_real_estate.promotions', source: 'crm.real_estate_promotions_v1', scope: 'rows', private: true,
    title: 'HĐ có khuyến mại ký trong kỳ: giảm giá/giá sau giảm tính như web, kèm số tháng và mức giảm mỗi tháng ghi trên HĐ.',
    params: ['buildingId', 'fromDate', 'toDate'], scopeKeys: ['customers.view'],
    fields: { ...CONTRACT, signedDate: nullable(date), startDate: nullable(date), endDate: nullable(date), rentPrice: amount, discountType: code,
      discountAmount: amount, savings: amount, effectiveRent: amount, promotionName: text(200), discountMonths: nullable(int),
      amountPerMonth: nullable(amount), ...ROOM, customerName: text(200) },
    summary: { total: count, active: count, totalSavings: amount, avgSavings: amount, withDiscountTerms: count } }),
  re_new_leases: w2Report({ permission: 'reports_real_estate.new_leases', source: 'crm.real_estate_new_leases_v1', scope: 'rows', private: true,
    title: `HĐ mới ký trong kỳ (mặc định tháng này): giá thuê, cọc, thời hạn (tháng), tổng giá trị. ${RANGE}`,
    params: ['buildingId', 'fromDate', 'toDate'], scopeKeys: ['customers.view'],
    fields: { ...CONTRACT, signedDate: nullable(date), startDate: nullable(date), endDate: nullable(date), rentPrice: amount, totalDeposit: amount,
      paymentCycle: nullable(code), durationMonths: int, totalValue: amount, ...ROOM, customerName: text(200), customerPhone: text(40) },
    summary: { fromDate: nullable(date), toDate: nullable(date), total: count, totalValue: amount, avgRent: amount, avgDurationMonths: int } }),
  re_terminations: w2Report({ permission: 'reports_real_estate.terminations', source: 'crm.real_estate_terminations_v1', scope: 'rows', private: true,
    title: `HĐ thanh lý/hết hạn có ngày kết thúc trong kỳ (mặc định đầu tháng tới hôm nay): loại, ghi chú, cọc, tỉ lệ so với tổng HĐ. ${RANGE}`,
    params: ['buildingId', 'fromDate', 'toDate'], scopeKeys: ['customers.view'],
    fields: { ...CONTRACT, startDate: nullable(date), endDate: nullable(date), actualEndDate: nullable(date), effectiveEndDate: date,
      durationDays: nullable(int), rentPrice: amount, totalDeposit: amount, terminationType: text(40), note: text(300), ...ROOM,
      customerName: text(200), customerPhone: text(40) },
    summary: { fromDate: nullable(date), toDate: nullable(date), total: count, terminated: count, expired: count, totalContracts: count,
      terminationRatePct: amount } }),
  re_expense_ratio: w2Report({ permission: 'reports_real_estate.expense_ratio', source: 'crm.real_estate_expense_ratio_v1', scope: 'rows', private: true,
    title: 'Tỷ lệ chi phí/doanh thu (mặc định 6 tháng): summary/byMonth gộp mọi toà như web, hàng theo toà. kind=month|category|type; query = đúng tên nhóm chi. Phần chi cần quyền danh mục.',
    params: ['buildingId', 'fromDate', 'toDate', 'query', 'kind'], kinds: ['month', 'category', 'type'],
    scopeKeys: ['categories.view', 'income_expenses.restricted_view'],
    // Một khuôn hàng cho ba kind (theo toà): month ⇒ month/revenue/expense/ratioPct; category ⇒ month/category/expense; type ⇒ category/typeName/expense.
    fields: { buildingId: id, buildingName: text(200), month: nullable(month), category: text(200), typeName: text(200), revenue: nullable(amount), expense: amount, ratioPct: nullable(amount) },
    summary: { fromMonth: month, toMonth: month, totalRevenue: amount, totalExpense: amount, avgRatioPct: amount, peakMonth: nullable(month),
      peakRatioPct: nullable(amount), byMonth: shapedList(13, { month, revenue: amount, expense: amount, ratioPct: nullable(amount) }), categories: textList(100, 200), expenseTypesVisible: bool, category: text(200) } }),

  // D1 — Tài sản (/assets; useAssets.ts:146-199)
  assets: w2Report({ permission: 'assets.view', source: 'crm.assets_list_v1', scope: 'rows', private: true,
    title: 'Tài sản: mã, tên, loại, số lượng, giá trị (giá mua × SL), tình trạng, vị trí, nhà cung cấp (cần quyền NCC), ngày mua; query tìm tên/mã/loại.',
    params: ['buildingId', 'roomId', 'categoryId', 'status', 'query'], statuses: ['NEW', 'GOOD', 'FAIR', 'POOR', 'BROKEN'], scopeKeys: ['suppliers.view'],
    fields: { id, code: text(100), name: text(200), categoryName: text(200), quantity: int, totalValue: amount, condition: nullable(code),
      buildingId: nullable(id), buildingName: text(200), roomId: nullable(id), roomName: text(100), supplierName: text(200), purchaseDate: nullable(date) },
    summary: { total: count, totalValue: amount, goodOrNew: count, poorOrBroken: count } }),
  // D3/D4/D5 — Dịch vụ, định mức, nhà cung cấp
  services: w2Report({ permission: 'services.view', source: 'crm.services_list_v1', scope: 'rows', private: true,
    title: 'Dịch vụ theo toà áp dụng (mỗi hàng một toà × dịch vụ; chưa gắn toà = buildingId null, chỉ Toàn tổ chức): mã, tên, loại phí, cách tính, đơn giá, mặc định.',
    params: ['buildingId', 'kind'], kinds: ['TIEN_PHI_DICH_VU', 'TIEN_DIEN', 'TIEN_NUOC', 'TIEN_PHI_KHAC', 'TIEN_VE_SINH'],
    fields: { buildingId: nullable(id), buildingName: text(200), id, code: text(100), name: text(200), feeType: nullable(code), pricingType: nullable(code),
      unit: text(40), unitPrice: amount, isDefault: bool },
    summary: { total: count, links: count } }),
  service_quotas: w2Report({ permission: 'service_quotas.view', source: 'crm.service_quotas_list_v1', scope: 'organization', private: true,
    title: 'Định mức dịch vụ (bậc giá điện/nước…): tên, mô tả, các bậc từ–đến và đơn giá.',
    fields: { id, name: text(200), description: text(500), tierCount: count,
      tiers: shapedList(50, { tierNumber: int, fromValue: amount, toValue: nullable(amount), unitPrice: amount }) },
    summary: TOTAL }),
  suppliers: w2Report({ permission: 'suppliers.view', source: 'crm.suppliers_list_v1', scope: 'organization', private: true,
    title: 'Nhà cung cấp: chỉ tên (như mọi màn web).', fields: { id, name: text(200) }, summary: TOTAL }),
  // D6 — Công tơ (/settings/meters; useMeters.ts:216-240)
  meters: w2Report({ permission: 'meters.view', source: 'crm.meters_list_v1', scope: 'rows', private: true,
    title: 'Công tơ: mã, tên, loại, trạng thái, toà/phòng, chỉ số đầu, chỉ số chốt gần nhất và ngày chốt.',
    params: ['buildingId', 'roomId', 'kind'], kinds: ['ELECTRICITY', 'WATER', 'GAS', 'OTHER'],
    fields: { id, code: text(100), name: text(200), meterType: nullable(code), status: text(40), buildingId: id, buildingName: text(200),
      roomId: nullable(id), roomName: text(100), initialReading: nullable(amount), latestReading: nullable(amount), latestReadingDate: nullable(date) },
    summary: TOTAL }),
  // D7/D8 — Toà, khu, chi tiết toà (/buildings; useBuildings.ts, useAreas.ts)
  buildings: w2Report({ permission: 'buildings.view', source: 'crm.buildings_list_v1', scope: 'rows', private: true,
    title: 'Danh sách toà: mã, tên, địa chỉ, trạng thái, khu, số phòng theo trạng thái; query tìm tên/mã/đường; areaId lọc theo khu.',
    params: ['query', 'status', 'areaId'], statuses: ['ACTIVE', 'INACTIVE', 'MAINTENANCE'], fields: BUILDING_ROW, summary: BUILDING_SUMMARY }),
  areas: w2Report({ permission: 'buildings.view', source: 'crm.areas_list_v1', scope: 'rows', private: true,
    title: 'Khu/cụm toà: mỗi hàng một khu × toà trong phạm vi (khu chưa có toà = buildingId null, chỉ Toàn tổ chức): mã, tên, trạng thái.',
    fields: { id, code: text(100), name: text(200), status: text(40), buildingId: nullable(id), buildingName: text(200) },
    summary: { total: count, links: count } }),
  building_detail: w2Report({ permission: 'buildings.view', source: 'crm.buildings_list_v1', scope: 'rows', private: true,
    title: 'Chi tiết một toà: mã, loại hình, trạng thái, số tầng, địa chỉ, mô tả, khu, số phòng theo trạng thái (không hoa hồng/tài khoản).',
    params: ['buildingId'], required: ['buildingId'], fields: BUILDING_ROW, summary: BUILDING_SUMMARY }),
  // D9 — Phòng (/apartments; useRooms.ts, RoomDetailPage.tsx) và dòng tiền phòng (/thu-tien)
  rooms: w2Report({ permission: 'rooms.view', source: 'crm.rooms_list_v1', scope: 'rows', private: true,
    title: 'Danh sách phòng: tầng, diện tích, giá thuê, cọc, sức chứa, trạng thái và trạng thái hiển thị (trống/đang thuê/sắp hết hạn/giữ chỗ). status: ACTIVE=trống, INACTIVE=ngưng.',
    params: ['buildingId', 'floor', 'status', 'query'], statuses: ['ACTIVE', 'INACTIVE', 'RESERVED'], fields: ROOM_ROW,
    summary: { total: count, available: count, expiringSoon: count, reserved: count } }),
  room_detail: w2Report({ permission: 'rooms.view', source: 'crm.room_tenancy_v1', scope: 'rows', private: true,
    title: 'Chi tiết một phòng: thông tin phòng, HĐ đang hiệu lực (cần quyền HĐ) và người đang ở (cần quyền khách).',
    params: ['roomId'], required: ['roomId'], scopeKeys: ['contracts.view', 'customers.view'],
    fields: { ...ROOM_ROW, contractVisible: bool,
      contract: shapedOrNull({ contractId: id, contractNumber: text(100), startDate: nullable(date), endDate: nullable(date), rentPrice: amount }),
      tenantsVisible: bool, tenants: shapedList(20, { name: text(200), phone: text(40), isRepresentative: bool }) } }),
  room_cash_lifecycle: w2Report({ permission: 'thu_tien.view', source: 'crm.get_room_cash_lifecycle_v1', scope: 'rows', private: true,
    title: 'Dòng tiền vòng đời một phòng (như màn Thu tiền): sự kiện HĐ, cọc, hoá đơn, thu, thanh lý, hoàn cọc, hoa hồng; tóm tắt HĐ và các khoảng trống.',
    params: ['roomId', 'fromDate', 'toDate'], required: ['roomId'],
    fields: { buildingId: id, type: code, date, contractId: nullable(id), amount: nullable(amount), trusted: bool },
    summary: { roomId: id, roomName: text(100), buildingId: id, buildingName: text(200),
      contracts: shapedList(50, { id, number: text(100), status: nullable(code), startDate: nullable(date), endDate: nullable(date),
        actualEndDate: nullable(date), rentPrice: amount, totalDeposit: amount }),
      vacancies: shapedList(100, { fromDate: nullable(date), toDate: nullable(date), days: nullable(int) }) } }),
  // D10 — Tầng (/settings/categories/floors): khoá báo cáo theo toà buildings.view (RLS floors); hàm dùng chung còn đòi
  // categories.view như route web (khoá công ty chỉ được làm khoá báo cáo scope organization).
  floors: w2Report({ permission: 'buildings.view', source: 'crm.floors_list_v1', scope: 'rows', private: true,
    title: 'Tầng của các toà: số tầng, tên, mô tả, trạng thái.', params: ['buildingId'],
    fields: { id, buildingId: id, buildingName: text(200), floorNumber: int, name: text(100), description: text(500), status: text(40) }, summary: TOTAL }),
  // D12/D13/D14 — Loại thu chi, loại việc, hotline
  ie_types: w2Report({ permission: 'categories.view', source: 'crm.income_expense_types_list_v1', scope: 'organization', private: true,
    title: 'Loại thu/chi (hạng mục): tên, nhóm, mô tả, mặc định, cờ hệ thống/ẩn, đã lưu trữ; không gồm hạng mục hạn chế, lương, cổ đông.',
    params: ['kind'], kinds: ['income', 'expense'],
    fields: { id, type: code, name: text(200), category: text(200), description: text(500), isDefault: bool, systemOnly: bool, manualHidden: bool,
      quickEntryHidden: bool, archived: bool },
    summary: TOTAL }),
  task_types: w2Report({ permission: 'task_types.view', source: 'crm.job_types_list_v1', scope: 'organization', private: true,
    title: 'Loại công việc: bộ phận, nhóm việc, hạn gọi khách/tiếp nhận/hoàn thành (phút), giờ hành chính; query tìm tên.',
    params: ['query'], scopeKeys: ['tasks.view'],
    fields: { id, name: text(200), departmentName: text(200), jobGroupName: text(200), customerContactDeadlineMinutes: nullable(int),
      acceptanceDeadlineMinutes: nullable(int), completionDeadlineMinutes: nullable(int), businessHoursOnly: nullable(bool), isActive: nullable(bool) },
    summary: TOTAL }),
  hotlines: w2Report({ permission: 'hotline.view', source: 'crm.hotlines_list_v1', scope: 'organization', private: true,
    title: 'Hotline nội bộ: tên, số điện thoại, mô tả, đang hoạt động.',
    fields: { id, name: text(200), phoneNumber: text(40), description: text(500), isActive: nullable(bool) }, summary: TOTAL }),
});
