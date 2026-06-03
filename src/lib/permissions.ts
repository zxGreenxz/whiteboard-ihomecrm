// Central registry of permission modules + groups + actions.
//
// 37 modules thực thi (35 gốc + shareholder_profit/personal_finance cho module
// Chia lợi nhuận cổ đông + Ví thu chi cá nhân).
// Tổ chức theo 8 nhóm UI để hiển thị accordion trong PermissionMatrix.

import type { Json } from "@/integrations/supabase/types";

export type ActionKey =
  | "view"
  | "create"
  | "edit"
  | "delete"
  | "record_payment"
  | "approve"
  | "print"
  | "export";

export type PermissionsMap = Record<string, Partial<Record<ActionKey, boolean>>>;

export interface ModuleDef {
  key: string;
  label: string;
  /** Special actions (ngoài 4 action chuẩn view/create/edit/delete) */
  extra?: ActionKey[];
}

export interface GroupDef {
  key: string;
  label: string;
  modules: ModuleDef[];
}

/** 8 nhóm UI × 37 module. Thứ tự = thứ tự hiển thị trong matrix. */
export const PERMISSION_GROUPS: GroupDef[] = [
  {
    key: "core",
    label: "Tổng quan",
    modules: [
      { key: "dashboard",     label: "Bảng tin" },
      { key: "notifications", label: "Thông báo" },
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
    ],
  },
  {
    key: "customers",
    label: "Khách hàng",
    modules: [
      { key: "leads",     label: "Khách hẹn",  extra: ["export"] },
      { key: "deposits",  label: "Đặt cọc",    extra: ["print"] },
      { key: "contracts", label: "Hợp đồng",   extra: ["approve", "print", "export"] },
      { key: "customers", label: "Cư dân",     extra: ["print", "export"] },
      { key: "vehicles",  label: "Phương tiện" },
    ],
  },
  {
    key: "finance",
    label: "Tài chính",
    modules: [
      { key: "cashbooks",       label: "Sổ quỹ" },
      { key: "meter_readings",  label: "Ghi chỉ số", extra: ["export"] },
      { key: "invoices",        label: "Hoá đơn",    extra: ["record_payment", "print", "export"] },
      { key: "income_expenses", label: "Thu chi",    extra: ["approve", "print", "export"] },
      { key: "excess_amounts",  label: "Tiền thừa" },
    ],
  },
  {
    key: "shareholder",
    label: "Cổ đông & Cá nhân",
    modules: [
      { key: "shareholder_profit", label: "Lợi nhuận cổ đông", extra: ["export"] },
      { key: "personal_finance",   label: "Ví thu chi cá nhân" },
    ],
  },
  {
    key: "assets",
    label: "Tài sản",
    modules: [
      { key: "assets",      label: "Tài sản" },
      { key: "asset_types", label: "Loại tài sản" },
      { key: "warehouses",  label: "Kho" },
      { key: "suppliers",   label: "Nhà cung cấp" },
    ],
  },
  {
    key: "ops",
    label: "Vận hành & Báo cáo",
    modules: [
      { key: "tasks",               label: "Công việc",      extra: ["approve"] },
      { key: "task_types",          label: "Loại công việc" },
      { key: "reports_real_estate", label: "Báo cáo BĐS",    extra: ["export"] },
      { key: "reports_finance",     label: "Báo cáo tài chính", extra: ["export"] },
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
    ],
  },
];

/** Flat module list (35 modules total). */
export const ALL_MODULES: ModuleDef[] = PERMISSION_GROUPS.flatMap((g) => g.modules);

/** Map key → ModuleDef for O(1) lookup. */
export const MODULE_BY_KEY: Record<string, ModuleDef> = Object.fromEntries(
  ALL_MODULES.map((m) => [m.key, m]),
);

/** Chuẩn 4 action mọi module đều có. */
export const CORE_ACTIONS: ActionKey[] = ["view", "create", "edit", "delete"];

/** Actions hiển thị cho 1 module = 4 core + extras tuỳ module. */
export function actionsForModule(moduleKey: string): ActionKey[] {
  const def = MODULE_BY_KEY[moduleKey];
  return [...CORE_ACTIONS, ...(def?.extra ?? [])];
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
  const out: PermissionsMap & { __superadmin?: boolean } = { __superadmin: true };
  for (const m of ALL_MODULES) {
    out[m.key] = Object.fromEntries(actionsForModule(m.key).map((a) => [a, true])) as Partial<Record<ActionKey, boolean>>;
  }
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

export function applyGlobalPreset(_perms: PermissionsMap, preset: Preset): PermissionsMap {
  const out: PermissionsMap = {};
  for (const m of ALL_MODULES) {
    const row: Partial<Record<ActionKey, boolean>> = {};
    for (const a of actionsForModule(m.key)) {
      switch (preset) {
        case "none":   row[a] = false; break;
        case "view":   row[a] = a === "view"; break;
        case "manage": row[a] = a === "view" || a === "create" || a === "edit" || a === "delete"; break;
        case "all":    row[a] = true; break;
      }
    }
    out[m.key] = row;
  }
  return out;
}
