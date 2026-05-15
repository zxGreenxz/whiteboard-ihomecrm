// Permission catalog — danh sách resource × action cho phép set quyền chi tiết.
//
// Mỗi resource có:
//   - 4 CRUD action chuẩn: view, create, edit, delete (subset tuỳ resource)
//   - 0..n special action: tuỳ entity (vd contract: terminate, invoice: approve, ...)
//
// Key (resource + action) phải khớp:
//   1. Key trong roles.permissions JSONB (DB)
//   2. Key dùng cho <Can resource="X" action="Y"> + <PermissionRoute>
//   3. Key user_can('X','Y') khi guard server-side
//
// Khi thêm/đổi resource/action: cập nhật ở 1 chỗ duy nhất tại file này.

export type CrudAction = "view" | "create" | "edit" | "delete";

export const CRUD_LABELS: Record<CrudAction, string> = {
  view: "Xem",
  create: "Tạo",
  edit: "Sửa",
  delete: "Xoá",
};

export type Domain =
  | "dashboard"
  | "customer"
  | "finance"
  | "data_master"
  | "operation"
  | "asset"
  | "reports"
  | "settings"
  | "comms"
  | "system";

export const DOMAIN_LABELS: Record<Domain, string> = {
  dashboard: "Bảng tin",
  customer: "Khách hàng",
  finance: "Tài chính",
  data_master: "Dữ liệu chung",
  operation: "Vận hành",
  asset: "Tài sản",
  reports: "Báo cáo",
  settings: "Cài đặt",
  comms: "Thông báo & nhắn tin",
  system: "Hệ thống",
};

export interface SpecialAction {
  key: string;
  label: string;
}

export interface ResourceDef {
  key: string;
  label: string;
  domain: Domain;
  crud: CrudAction[];
  specials?: SpecialAction[];
}

const ALL_CRUD: CrudAction[] = ["view", "create", "edit", "delete"];

export const PERMISSION_CATALOG: ResourceDef[] = [
  // ── Dashboard ──────────────────────────────────────────────
  { key: "dashboard",       label: "Bảng tin",      domain: "dashboard", crud: ["view"] },
  { key: "building_layout", label: "Sơ đồ toà nhà", domain: "dashboard", crud: ["view"] },

  // ── Customer ───────────────────────────────────────────────
  {
    key: "leads", label: "Khách hẹn xem", domain: "customer", crud: ALL_CRUD,
    specials: [
      { key: "convert", label: "Chuyển sang HĐ" },
      { key: "import",  label: "Nhập danh sách" },
    ],
  },
  {
    key: "deposits", label: "Cọc giữ chỗ", domain: "customer", crud: ALL_CRUD,
    specials: [
      { key: "convert_to_contract", label: "Chuyển sang HĐ" },
      { key: "refund",              label: "Hoàn cọc" },
    ],
  },
  {
    key: "contracts", label: "Hợp đồng", domain: "customer", crud: ALL_CRUD,
    specials: [
      { key: "terminate", label: "Huỷ hợp đồng" },
      { key: "transfer",  label: "Chuyển nhượng" },
      { key: "renew",     label: "Tái ký" },
      { key: "extend",    label: "Gia hạn" },
      { key: "print",     label: "In hợp đồng" },
      { key: "qr_share",  label: "Chia sẻ QR" },
      { key: "e_sign",    label: "Ký điện tử" },
    ],
  },
  {
    key: "customers", label: "Cư dân", domain: "customer", crud: ALL_CRUD,
    specials: [
      { key: "import",      label: "Nhập danh sách" },
      { key: "export",      label: "Xuất danh sách" },
      { key: "print_ct01",  label: "In CT01" },
    ],
  },
  { key: "vehicles", label: "Phương tiện", domain: "customer", crud: ALL_CRUD },

  // ── Finance ────────────────────────────────────────────────
  {
    key: "meter_readings", label: "Chốt công tơ", domain: "finance", crud: ALL_CRUD,
    specials: [
      { key: "bulk_close", label: "Chốt hàng loạt" },
      { key: "lock",       label: "Khoá kỳ" },
    ],
  },
  {
    key: "invoices", label: "Hoá đơn", domain: "finance", crud: ALL_CRUD,
    specials: [
      { key: "approve",        label: "Duyệt hoá đơn" },
      { key: "send",           label: "Gửi hoá đơn" },
      { key: "mark_paid",      label: "Đánh dấu đã thanh toán" },
      { key: "record_payment", label: "Ghi nhận thanh toán" },
      { key: "export",         label: "Xuất danh sách" },
      { key: "void",           label: "Huỷ hoá đơn" },
    ],
  },
  {
    key: "income_expenses", label: "Thu chi", domain: "finance", crud: ALL_CRUD,
    specials: [
      { key: "approve", label: "Duyệt phiếu" },
      { key: "refund",  label: "Hoàn tiền" },
      { key: "export",  label: "Xuất danh sách" },
    ],
  },
  {
    key: "cashbooks", label: "Sổ quỹ", domain: "finance", crud: ALL_CRUD,
    specials: [{ key: "transfer", label: "Chuyển quỹ" }],
  },
  {
    key: "excess_amounts", label: "Tiền thừa", domain: "finance", crud: ["view", "edit"],
    specials: [{ key: "refund", label: "Hoàn tiền thừa" }],
  },
  { key: "refund_log",   label: "Nhật ký hoàn tiền", domain: "finance", crud: ["view"] },

  // ── Operation ──────────────────────────────────────────────
  {
    key: "tasks", label: "Công việc", domain: "operation", crud: ALL_CRUD,
    specials: [
      { key: "assign",   label: "Phân công" },
      { key: "complete", label: "Hoàn thành" },
      { key: "comment",  label: "Bình luận" },
    ],
  },

  // ── Data master ────────────────────────────────────────────
  { key: "areas",          label: "Khu vực",        domain: "data_master", crud: ALL_CRUD },
  { key: "buildings",      label: "Toà nhà",        domain: "data_master", crud: ALL_CRUD },
  { key: "rooms",          label: "Phòng/Căn hộ",   domain: "data_master", crud: ALL_CRUD },
  { key: "beds",           label: "Giường",         domain: "data_master", crud: ALL_CRUD },
  { key: "services",       label: "Phí dịch vụ",    domain: "data_master", crud: ALL_CRUD },
  { key: "service_quotas", label: "Định mức",       domain: "data_master", crud: ALL_CRUD },
  { key: "meters",         label: "Công tơ",        domain: "data_master", crud: ALL_CRUD },
  { key: "floors",         label: "Tầng",           domain: "data_master", crud: ALL_CRUD },

  // ── Asset ──────────────────────────────────────────────────
  {
    key: "assets", label: "Tài sản", domain: "asset", crud: ALL_CRUD,
    specials: [
      { key: "movement",    label: "Luân chuyển" },
      { key: "maintenance", label: "Bảo trì" },
    ],
  },
  { key: "asset_types", label: "Loại tài sản", domain: "asset", crud: ALL_CRUD },
  { key: "warehouses",  label: "Kho",          domain: "asset", crud: ALL_CRUD },
  { key: "suppliers",   label: "Nhà cung cấp", domain: "asset", crud: ALL_CRUD },

  // ── Reports ────────────────────────────────────────────────
  {
    key: "reports_real_estate", label: "Báo cáo BĐS", domain: "reports", crud: ["view"],
    specials: [{ key: "export", label: "Xuất báo cáo" }],
  },
  {
    key: "reports_finance", label: "Báo cáo tài chính", domain: "reports", crud: ["view"],
    specials: [{ key: "export", label: "Xuất báo cáo" }],
  },
  {
    key: "reports_tasks", label: "Báo cáo công việc", domain: "reports", crud: ["view"],
    specials: [{ key: "export", label: "Xuất báo cáo" }],
  },

  // ── Settings ───────────────────────────────────────────────
  { key: "settings",           label: "Cài đặt chung",     domain: "settings", crud: ["view", "edit"] },
  { key: "categories",         label: "Danh mục",          domain: "settings", crud: ["view", "edit"] },
  { key: "templates",          label: "Biểu mẫu",          domain: "settings", crud: ALL_CRUD },
  { key: "signatures",         label: "Chữ ký",            domain: "settings", crud: ALL_CRUD },
  { key: "auto_debt",          label: "Gạch nợ tự động",   domain: "settings", crud: ["view", "edit"] },
  { key: "hotline",            label: "Hotline",           domain: "settings", crud: ["view", "edit"] },
  { key: "users",              label: "Nhân viên",         domain: "settings", crud: ALL_CRUD },
  { key: "roles",              label: "Loại tài khoản",    domain: "settings", crud: ALL_CRUD },
  { key: "task_types",         label: "Loại công việc",    domain: "settings", crud: ALL_CRUD },

  // ── Communications ─────────────────────────────────────────
  {
    key: "notifications", label: "Thông báo", domain: "comms", crud: ["view", "create", "edit"],
    specials: [{ key: "send", label: "Gửi thông báo" }],
  },
  {
    key: "messages", label: "Nhắn tin", domain: "comms", crud: ["view", "create", "edit"],
    specials: [{ key: "send", label: "Gửi tin nhắn" }],
  },
  {
    key: "zalo_oa", label: "Zalo OA", domain: "comms", crud: ["view", "edit"],
    specials: [{ key: "send", label: "Gửi qua Zalo" }],
  },

  // ── System ─────────────────────────────────────────────────
  { key: "subscription", label: "Gói cước",        domain: "system", crud: ["view", "edit"] },
  { key: "iot_devices",  label: "Thiết bị IoT",    domain: "system", crud: ["view", "edit"] },
  { key: "e_invoices",   label: "Hoá đơn điện tử", domain: "system", crud: ["view", "edit"] },
];

// ── Lookup helpers ────────────────────────────────────────────

const RESOURCE_BY_KEY = new Map<string, ResourceDef>(
  PERMISSION_CATALOG.map((r) => [r.key, r]),
);

export const getResource = (key: string): ResourceDef | undefined =>
  RESOURCE_BY_KEY.get(key);

export const allActionsOf = (resource: ResourceDef): string[] => [
  ...resource.crud,
  ...(resource.specials?.map((s) => s.key) ?? []),
];

export const labelOfAction = (resource: ResourceDef, action: string): string => {
  if ((CRUD_LABELS as Record<string, string>)[action]) {
    return CRUD_LABELS[action as CrudAction];
  }
  return resource.specials?.find((s) => s.key === action)?.label ?? action;
};

export const RESOURCES_BY_DOMAIN: Record<Domain, ResourceDef[]> = PERMISSION_CATALOG.reduce(
  (acc, r) => {
    (acc[r.domain] ||= []).push(r);
    return acc;
  },
  {} as Record<Domain, ResourceDef[]>,
);

export const DOMAIN_ORDER: Domain[] = [
  "dashboard",
  "customer",
  "finance",
  "operation",
  "data_master",
  "asset",
  "reports",
  "comms",
  "settings",
  "system",
];
