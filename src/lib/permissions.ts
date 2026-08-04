// Central registry of permission modules + actions.
//
// Từ 2026-06-11 (redesign trang phân quyền): registry mở rộng thành ~40 module
// với action CHI TIẾT theo từng chức năng trên từng trang (gia hạn/chuyển
// nhượng/thanh lý HĐ, duyệt/huỷ hoá đơn, chốt/chi lợi nhuận, từng báo cáo…).
//
// - Hình dạng vẫn là { "<module>": { "<action>": true } }, nhưng từ 2026-07-26
//   nó được DỰNG từ role_permissions/overrides chứ không đọc JSONB nữa.
// - Nguồn quyền: RPC get_my_permissions() đọc mô hình tổ chức
//   (organization_memberships + role_bindings + member_permission_overrides).
//   Khoá không có trong map = KHÔNG có quyền. Không còn suy diễn từ khoá khác.
// - Tổ chức hiển thị theo TRANG nằm ở src/lib/permissionPages.ts (catalog).

import type { Json } from "@/integrations/supabase/types";

export type ActionKey =
  // 4 action chuẩn
  | "view"
  | "create"
  | "edit"
  | "delete"
  // action chung cũ
  | "record_payment"
  | "approve"
  | "print"
  | "export"
  // Cờ phạm vi: thấy + ghi thu chi cho MỌI toà ngay trong form thu chi
  // (chỉ module income_expenses).
  | "all_buildings"
  // Hạng mục thu chi HẠN CHẾ (vd Quản Lý) — chỉ module income_expenses:
  //   restricted_create: thấy & chọn hạng mục hạn chế khi TẠO phiếu.
  //   restricted_view:   thấy & sửa phiếu hạng mục hạn chế trong BẢNG.
  | "restricted_create"
  | "restricted_view"
  // sale_phong: tạo nhanh phiếu cọc trên trang công khai /r/:token.
  | "create_deposit"
  // sale_phong: xem tab "Thống kê" (đo đếm trang công khai /r/:token).
  | "view_analytics"
  // ===== Action chi tiết theo chức năng (2026-06-11) =====
  // Bảng tin
  | "view_finance"
  // Sale phòng
  | "manage_tokens"
  | "manage_settings"
  | "manage_images"
  | "edit_floor_plan"
  | "manage_pass_listings"
  // Lead / Cọc
  | "convert"
  | "refund"
  // Hợp đồng
  | "renew"
  | "transfer"
  | "terminate"
  | "handover"
  // Cư dân
  | "import"
  // Sổ quỹ
  | "share"
  // Hoá đơn / Thu chi
  | "cancel"
  // Thu tiền (mobile)
  | "collect"
  | "undo"
  | "report"
  // Lợi nhuận cổ đông
  | "lock"
  | "unlock"
  | "distribute"
  | "manage_shareholders"
  | "manage_salary"
  // Tài sản
  | "move"
  | "maintain"
  // Công việc
  | "complete"
  // Phân quyền nhân viên
  | "manage_templates"
  // Kênh chat (Zalo)
  | "send"
  | "manage_automation"
  | "manage_connections"
  | "manage_knowledge"
  | "manage_handoff"
  | "manage_operations"
  | "audit"
  // Báo cáo BĐS (từng báo cáo)
  | "vacant_rooms"
  | "expiring"
  | "renewals_transfers"
  | "occupancy"
  | "promotions"
  | "new_leases"
  | "terminations"
  | "expense_ratio"
  // Báo cáo tài chính (từng báo cáo)
  | "daily_cashbook"
  | "cash_flow"
  | "profit_distribution"
  | "debt"
  | "customer_debt"
  | "payment_schedule"
  | "overpayment"
  | "deposits_report"
  | "analysis"
  | "handover_report"
  // Đối soát/chốt số sổ quỹ (báo cáo bàn giao)
  | "reconcile"
  // Báo cáo chu kỳ Thu → Bàn giao (theo tòa quản lý)
  | "collection_cycle"
  // AI Copilot: cho phép agent điều khiển UI (experimental — pilot)
  | "ui_control"
  // ===== Khoá của mô hình phân quyền mới (2026-07-26) =====
  // 11 khoá này CÓ trong permission_definitions nhưng trước đây không có nhãn
  // tiếng Việt nào ở FE, nên bảng phân quyền không hiển thị được chúng —
  // người dùng không có cách nào cấp/thu hồi. Đã đối chiếu: 219 khoá DB vs 208
  // khoá FE, thiếu đúng 11 khoá này.
  | "emergency_override"          // approvals — cửa thoát của chủ sở hữu
  | "manage_custody"              // cashbooks — giao/nhận giữ sổ
  | "post"                        // cashbooks — ghi sổ (hạch toán)
  | "close"                       // cashbooks — đề nghị chốt & bàn giao quỹ
  | "close_confirm"               // cashbooks — xác nhận nhận bàn giao (khoá vĩnh viễn)
  | "reverse"                     // income_expenses — đảo bút toán
  | "self_approve_within_limit"   // income_expenses — tự duyệt dưới ngưỡng
  | "pay_manager"                 // shareholder_profit — chi lương quản lý
  // Trung tâm mạng: thao tác allowlist, không fallback từ quyền quản lý chung.
  | "execute";

export type PermissionsMap = Record<string, Partial<Record<ActionKey, boolean>>>;

export interface ModuleDef {
  key: string;
  label: string;
  /**
   * Override 4 action chuẩn — module nào không có đủ CRUD (vd dashboard chỉ
   * view) khai báo ở đây. Mặc định = view/create/edit/delete.
   */
  core?: ActionKey[];
  /** Action chi tiết ngoài core. */
  extra?: ActionKey[];
}

export interface GroupDef {
  key: string;
  label: string;
  modules: ModuleDef[];
}

/** Nhóm UI × module. Thứ tự = thứ tự hiển thị. */
export const PERMISSION_GROUPS: GroupDef[] = [
  {
    key: "core",
    label: "Tổng quan",
    modules: [
      { key: "dashboard",     label: "Bảng tin", core: ["view"], extra: ["view_finance"] },
      { key: "notifications", label: "Thông báo", core: ["view", "create", "edit", "delete"] },
      // LƯU Ý (PLAN.md F14): quyền này để phân quyền STAFF; kill switch/pilot
      // thật nằm ở ai_copilot_entitlements + ai_copilot_settings (server).
      { key: "ai_copilot",    label: "AI Copilot", core: ["view"], extra: ["ui_control"] },
    ],
  },
  {
    key: "chat",
    label: "Kênh chat",
    modules: [
      {
        key: "chat_zalo",
        label: "Chat Zalo",
        core: ["view"],
        extra: ["send", "manage_automation", "manage_templates"],
      },
      {
        key: "openclaw_zalo",
        label: "OpenClaw Zalo cá nhân",
        core: ["view"],
        extra: [
          "send",
          "manage_connections",
          "manage_automation",
          "manage_knowledge",
          "manage_handoff",
          "manage_operations",
          "audit",
        ],
      },
    ],
  },
  {
    key: "real_estate",
    label: "Bất động sản",
    modules: [
      { key: "areas",     label: "Khu vực" },
      { key: "buildings", label: "Toà nhà" },
      { key: "rooms",     label: "Căn hộ / Phòng" },
      { key: "services",  label: "Dịch vụ" },
      {
        key: "sale_phong",
        label: "Sale Phòng",
        core: ["view", "edit"],
        extra: ["manage_tokens", "manage_settings", "manage_images", "edit_floor_plan", "manage_pass_listings", "create_deposit", "view_analytics"],
      },
    ],
  },
  {
    key: "customers",
    label: "Khách hàng",
    modules: [
      { key: "leads",     label: "Khách hẹn",  extra: ["convert", "export"] },
      { key: "deposits",  label: "Đặt cọc",    extra: ["convert", "refund", "print"] },
      { key: "contracts", label: "Hợp đồng",   extra: ["approve", "renew", "transfer", "terminate", "handover", "print", "export"] },
      { key: "customers", label: "Cư dân",     extra: ["import", "print", "export"] },
      { key: "vehicles",  label: "Phương tiện" },
    ],
  },
  {
    key: "finance",
    label: "Tài chính",
    modules: [
      { key: "cashbooks",       label: "Sổ quỹ", extra: ["share", "manage_custody", "post", "close", "close_confirm"] },
      { key: "meter_readings",  label: "Ghi chỉ số", extra: ["export"] },
      { key: "invoices",        label: "Hoá đơn",    extra: ["approve", "cancel", "record_payment", "print", "export"] },
      { key: "thu_tien",        label: "Thu tiền (mobile)", core: ["view"], extra: ["collect", "undo", "report"] },
      { key: "income_expenses", label: "Thu chi",    extra: ["approve", "cancel", "print", "export", "all_buildings", "restricted_create", "restricted_view", "reverse", "self_approve_within_limit"] },
      { key: "approvals",       label: "Duyệt khẩn cấp", core: [], extra: ["emergency_override"] },
      { key: "excess_amounts",  label: "Tiền thừa" },
    ],
  },
  {
    key: "shareholder",
    label: "Cổ đông & Cá nhân",
    modules: [
      {
        key: "shareholder_profit",
        label: "Lợi nhuận cổ đông",
        core: ["view"],
        extra: ["lock", "unlock", "distribute", "manage_shareholders", "pay_manager", "export"],
      },
      {
        key: "salary",
        label: "Bảng lương quản lý",
        core: ["view"],
        extra: ["lock", "unlock", "distribute", "manage_salary", "export"],
      },
      { key: "personal_finance", label: "Ví thu chi cá nhân" },
    ],
  },
  {
    key: "assets",
    label: "Tài sản & Kho",
    modules: [
      { key: "assets",      label: "Tài sản", extra: ["move", "maintain"] },
      { key: "materials",   label: "Vật tư" },
      { key: "asset_types", label: "Loại tài sản" },
      { key: "warehouses",  label: "Kho" },
      { key: "suppliers",   label: "Nhà cung cấp" },
    ],
  },
  {
    key: "ops",
    label: "Vận hành & Báo cáo",
    modules: [
      { key: "network_center", label: "Trung tâm mạng", core: ["view", "execute"] },
      { key: "tasks",      label: "Công việc", extra: ["complete", "approve"] },
      { key: "task_types", label: "Loại công việc" },
      {
        key: "reports_real_estate",
        label: "Báo cáo BĐS",
        core: ["view"],
        extra: ["vacant_rooms", "expiring", "renewals_transfers", "occupancy", "promotions", "new_leases", "terminations", "expense_ratio", "export"],
      },
      {
        key: "reports_finance",
        label: "Báo cáo tài chính",
        core: ["view"],
        // "debt"/"customer_debt" đã gỡ khỏi UI cấu hình (2 BC công nợ xoá ở Phase 7,
        // nghiệp vụ nợ chuyển về /thu-tien). Union ActionKey vẫn giữ 2 key này để
        // JSON role cũ đã lưu không bị coi là invalid (legacy-tolerant, không migration).
        extra: ["analysis", "daily_cashbook", "cash_flow", "profit_distribution", "payment_schedule", "overpayment", "deposits_report", "handover_report", "reconcile", "collection_cycle", "export"],
      },
    ],
  },
  {
    key: "settings",
    label: "Cấu hình hệ thống",
    modules: [
      { key: "meters",         label: "Đồng hồ / Công tơ" },
      { key: "service_quotas", label: "Định mức dịch vụ" },
      { key: "auto_debt",      label: "Gạch nợ tự động" },
      { key: "hotline",        label: "Hotline" },
      { key: "categories",     label: "Danh mục khác" },
      { key: "templates",      label: "Biểu mẫu / Chữ ký" },
      { key: "settings",       label: "Cài đặt chung" },
      { key: "users",          label: "Phân quyền nhân viên", extra: ["manage_templates"] },
    ],
  },
];

/** Flat module list. */
export const ALL_MODULES: ModuleDef[] = PERMISSION_GROUPS.flatMap((g) => g.modules);

/** Map key → ModuleDef for O(1) lookup. */
export const MODULE_BY_KEY: Record<string, ModuleDef> = Object.fromEntries(
  ALL_MODULES.map((m) => [m.key, m]),
);

/** Chuẩn 4 action mặc định. */
export const CORE_ACTIONS: ActionKey[] = ["view", "create", "edit", "delete"];

/** Actions hiển thị cho 1 module = core (hoặc override) + extras. */
export function actionsForModule(moduleKey: string): ActionKey[] {
  const def = MODULE_BY_KEY[moduleKey];
  return [...(def?.core ?? CORE_ACTIONS), ...(def?.extra ?? [])];
}

export const ACTION_LABELS: Record<ActionKey, string> = {
  view:           "Xem",
  create:         "Tạo",
  edit:           "Sửa",
  delete:         "Xoá",
  record_payment: "Thu tiền",
  approve:        "Duyệt",
  print:          "In",
  export:         "Xuất",
  all_buildings:  "Mọi toà nhà",
  restricted_create: "Tạo phiếu hạng mục hạn chế",
  restricted_view:   "Xem/sửa phiếu hạng mục hạn chế",
  create_deposit: "Tạo cọc nhanh",
  view_analytics: "Xem thống kê truy cập",
  view_finance:   "Xem số liệu tài chính",
  manage_tokens:  "Link chia sẻ",
  manage_settings: "Cài đặt hiển thị",
  manage_images:  "Ảnh sale",
  edit_floor_plan: "Sơ đồ toạ độ",
  manage_pass_listings: "Khách nhờ sale (pass)",
  convert:        "Chuyển đổi",
  refund:         "Hoàn / bỏ cọc",
  renew:          "Gia hạn",
  transfer:       "Chuyển nhượng",
  terminate:      "Thanh lý",
  handover:       "Bàn giao tài sản",
  import:         "Nhập file",
  share:          "Chia sẻ",
  cancel:         "Huỷ",
  collect:        "Thu tiền",
  undo:           "Hoàn tác",
  report:         "Báo cáo",
  lock:           "Chốt tháng",
  unlock:         "Mở khoá",
  distribute:     "Chi lợi nhuận",
  manage_shareholders: "Quản lý cổ đông",
  manage_salary:  "Cấu hình lương",
  move:           "Di chuyển",
  maintain:       "Bảo trì",
  complete:       "Hoàn thành",
  manage_templates: "Quản lý mẫu",
  send:           "Gửi tin",
  manage_automation: "Quản lý tự động hoá",
  manage_connections: "Quản lý kết nối Zalo cá nhân",
  manage_knowledge: "Quản lý tri thức OpenClaw",
  manage_handoff: "Quản lý bàn giao hội thoại",
  manage_operations: "Quản lý vận hành OpenClaw",
  audit:          "Xem nhật ký kiểm toán OpenClaw",
  vacant_rooms:   "BC Phòng trống",
  expiring:       "BC HĐ sắp hết hạn",
  renewals_transfers: "BC Gia hạn & CN",
  occupancy:      "BC Lấp đầy",
  promotions:     "BC Khuyến mãi",
  new_leases:     "BC Cho thuê mới",
  terminations:   "BC Bỏ trả / thanh lý",
  expense_ratio:  "BC Tỉ lệ chi phí",
  daily_cashbook: "BC Sổ quỹ ngày",
  cash_flow:      "BC Dòng tiền",
  profit_distribution: "BC Phân bổ LN",
  // debt/customer_debt: 2 BC công nợ đã xoá (Phase 7) — giữ nhãn để nơi nào còn
  // hiển thị key legacy trong role cũ không rơi về key thô.
  debt:           "BC Công nợ HĐ mới (đã bỏ)",
  customer_debt:  "BC Khách nợ tiền (đã bỏ)",
  payment_schedule: "BC Lịch thanh toán",
  overpayment:    "BC Tiền thừa",
  deposits_report: "BC Danh sách cọc",
  analysis:       "BC Phân tích tài chính",
  handover_report: "BC Bàn giao tiền & Đối soát",
  reconcile:      "Chốt số / đối soát sổ",
  collection_cycle: "BC Chu kỳ Thu — Bàn giao",
  emergency_override: "Duyệt khẩn cấp (cửa thoát chủ sở hữu)",
  manage_custody: "Giao / nhận giữ sổ quỹ",
  close:          "Đề nghị chốt & bàn giao quỹ",
  close_confirm:  "Xác nhận nhận bàn giao (khoá vĩnh viễn)",
  post:           "Ghi sổ (hạch toán)",
  reverse:        "Đảo bút toán",
  self_approve_within_limit: "Tự duyệt phiếu dưới ngưỡng",
  pay_manager:    "Chi lương quản lý",
  ui_control:     "AI điều khiển trang (experimental)",
  execute:        "Thực thi",
};

/** Build empty permissions for all modules (mọi action = false). */
export function buildEmptyPermissions(): PermissionsMap {
  const out: PermissionsMap = {};
  for (const m of ALL_MODULES) {
    out[m.key] = Object.fromEntries(actionsForModule(m.key).map((a) => [a, false])) as Partial<Record<ActionKey, boolean>>;
  }
  return out;
}

/** Build "view-only" permissions (mọi module có view=true, còn lại false). */
export function buildViewOnlyPermissions(): PermissionsMap {
  const out: PermissionsMap = {};
  for (const m of ALL_MODULES) {
    out[m.key] = Object.fromEntries(actionsForModule(m.key).map((a) => [a, a === "view"])) as Partial<Record<ActionKey, boolean>>;
  }
  return out;
}

/** Build "full access" permissions (mọi module mọi action = true, kèm __superadmin). */
export function buildFullPermissions(): PermissionsMap & { __superadmin?: boolean } {
  const out: PermissionsMap = {};
  for (const m of ALL_MODULES) {
    out[m.key] = Object.fromEntries(actionsForModule(m.key).map((a) => [a, true])) as Partial<Record<ActionKey, boolean>>;
  }
  (out as any).__superadmin = true;
  return out;
}

/** Parse JSONB từ DB thành PermissionsMap (chấp nhận shape khác nhau, default empty). */
export function parsePermissions(input: Json | null | undefined): PermissionsMap {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as unknown as PermissionsMap;
  }
  return {};
}

/** Có sentinel super_admin? */
export function isSuperAdminPerms(perms: PermissionsMap | null | undefined): boolean {
  return !!(perms as any)?.__superadmin;
}

/** Check 1 action — mirror SQL helper. */
export function can(
  perms: PermissionsMap | null | undefined,
  moduleKey: string,
  action: ActionKey = "view",
): boolean {
  if (!perms) return false;
  if ((perms as any).__superadmin) return true;
  return !!perms[moduleKey]?.[action];
}

/**
 * Check 1 action chi tiết trên permission map.
 *
 * Sau cutover V3 (2026-07-26): get_my_permissions() trả ĐÚNG tập khoá mà mô
 * hình tổ chức cho phép, nên "khoá vắng mặt" = KHÔNG có quyền, chấm hết.
 * Cơ chế suy diễn cũ đã gỡ — nó lấy quyền từ một action khác, tức cấp ngầm
 * thứ máy chủ vừa từ chối.
 */
export function canFeature(
  perms: PermissionsMap | null | undefined,
  moduleKey: string,
  action: ActionKey,
): boolean {
  if (!perms) return false;
  if ((perms as any).__superadmin) return true;
  return !!perms[moduleKey]?.[action];
}

/** Đếm số (module, action) = true. Loại sentinel __superadmin khỏi đếm. */
export function countTrueActions(perms: PermissionsMap | null | undefined): number {
  if (!perms || (perms as any).__superadmin) return 0;
  let n = 0;
  for (const mod of Object.values(perms)) {
    if (mod && typeof mod === "object") {
      for (const v of Object.values(mod)) if (v) n++;
    }
  }
  return n;
}

/** Diff 2 permission maps: trả về danh sách `${module}.${action}` khác nhau. */
export function diffPermissions(
  a: PermissionsMap | null | undefined,
  b: PermissionsMap | null | undefined,
): { module: string; action: ActionKey; from: boolean; to: boolean }[] {
  const out: { module: string; action: ActionKey; from: boolean; to: boolean }[] = [];
  if (isSuperAdminPerms(a) !== isSuperAdminPerms(b)) {
    // Treat the super-admin sentinel as a "phantom" diff so UI can highlight it.
    return [{ module: "__superadmin", action: "view" as ActionKey, from: !!isSuperAdminPerms(a), to: !!isSuperAdminPerms(b) }];
  }
  for (const m of ALL_MODULES) {
    for (const act of actionsForModule(m.key)) {
      const av = !!a?.[m.key]?.[act];
      const bv = !!b?.[m.key]?.[act];
      if (av !== bv) out.push({ module: m.key, action: act, from: av, to: bv });
    }
  }
  return out;
}

/** Toggle all actions của 1 module sang `value`. */
export function setModuleAll(
  perms: PermissionsMap,
  moduleKey: string,
  value: boolean,
): PermissionsMap {
  const next = { ...(perms[moduleKey] || {}) };
  for (const a of actionsForModule(moduleKey)) next[a] = value;
  return { ...perms, [moduleKey]: next };
}

/** Toggle 1 action cụ thể. */
export function setModuleAction(
  perms: PermissionsMap,
  moduleKey: string,
  action: ActionKey,
  value: boolean,
): PermissionsMap {
  const next = { ...(perms[moduleKey] || {}) };
  next[action] = value;
  return { ...perms, [moduleKey]: next };
}

/** Apply preset cho TOÀN BỘ matrix: "none" / "view" / "manage" / "all". */
export type Preset = "none" | "view" | "manage" | "all";

/**
 * Action thuộc nhóm "quản lý" (preset manage): CRUD + các thao tác nghiệp vụ
 * thường ngày. Các action nhạy cảm (duyệt, chốt/mở khoá LN, mọi-toà, phân
 * quyền nhân viên…) KHÔNG nằm trong preset manage — xem ELEVATED bên catalog.
 */
const MANAGE_ACTIONS = new Set<ActionKey>([
  "view", "create", "edit", "delete",
  "record_payment", "print", "export",
  "view_finance",
  "manage_tokens", "manage_settings", "manage_images", "edit_floor_plan", "manage_pass_listings",
  "convert", "refund", "renew", "transfer", "handover", "import", "share",
  "cancel", "collect", "undo", "report", "move", "maintain", "complete",
  "send", "manage_automation", "manage_knowledge", "manage_handoff", "manage_templates",
  "vacant_rooms", "expiring", "renewals_transfers", "occupancy", "promotions",
  "new_leases", "terminations", "expense_ratio",
  "daily_cashbook", "cash_flow", "profit_distribution",
  "payment_schedule", "overpayment", "deposits_report",
  "analysis",
]);

export function applyGlobalPreset(_perms: PermissionsMap, preset: Preset): PermissionsMap {
  const out: PermissionsMap = {};
  for (const m of ALL_MODULES) {
    const row: Partial<Record<ActionKey, boolean>> = {};
    // Module "users" (phân quyền nhân viên) là quyền nhạy cảm — preset
    // view/manage không tự cấp, chỉ preset "all" (hoặc tick tay) mới mở.
    const sensitiveModule = m.key === "users";
    for (const a of actionsForModule(m.key)) {
      switch (preset) {
        case "none":   row[a] = false; break;
        case "view":   row[a] = !sensitiveModule && a === "view"; break;
        case "manage": {
          const openClawElevated = m.key === "openclaw_zalo" && a === "manage_automation";
          row[a] = !sensitiveModule && !openClawElevated && MANAGE_ACTIONS.has(a);
          break;
        }
        case "all":    row[a] = true; break;
      }
    }
    out[m.key] = row;
  }
  return out;
}
