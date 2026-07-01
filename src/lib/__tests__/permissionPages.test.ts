// Test catalog phân quyền theo trang (permissionPages.ts) + registry
// (permissions.ts): phủ đủ key, fallback legacy, preset, thống kê trang.

import { describe, it, expect } from "vitest";
import {
  ALL_PAGES,
  ALL_PAGE_FEATURES,
  featureKey,
  featureValue,
  canUse,
  findOrphanRegistryKeys,
  pageStats,
  setPageAll,
  setPageViewOnly,
} from "@/lib/permissionPages";
import {
  ALL_MODULES,
  MODULE_BY_KEY,
  actionsForModule,
  applyGlobalPreset,
  buildEmptyPermissions,
  type PermissionsMap,
} from "@/lib/permissions";

describe("collection_cycle: người thu tiền tự xem được (fallback record_payment)", () => {
  // Quản lý (Quản Lý Tòa): reports_finance.view = false nhưng invoices.record_payment = true.
  const managerPerms: PermissionsMap = {
    invoices: { record_payment: true, view: true },
    reports_finance: { view: false, edit: false, create: false, delete: false, export: false },
  };
  it("collection_cycle = TRUE cho người có invoices.record_payment (dù reports_finance.view=false)", () => {
    expect(canUse(managerPerms, "reports_finance", "collection_cycle")).toBe(true);
    // Không mở các báo cáo tài chính khác:
    expect(canUse(managerPerms, "reports_finance", "analysis")).toBe(false);
    expect(canUse(managerPerms, "reports_finance", "daily_cashbook")).toBe(false);
  });
  it("collection_cycle = FALSE cho người không thu tiền & không có reports_finance", () => {
    expect(canUse({ leads: { view: true } } as PermissionsMap, "reports_finance", "collection_cycle")).toBe(false);
  });
});

describe("catalog ↔ registry consistency", () => {
  it("mọi (module × action) trong registry đều có mặt trong catalog (không quyền mồ côi)", () => {
    expect(findOrphanRegistryKeys()).toEqual([]);
  });

  it("mọi feature trong catalog trỏ về module + action có thật trong registry", () => {
    for (const ft of ALL_PAGE_FEATURES) {
      const mod = MODULE_BY_KEY[ft.module];
      expect(mod, `module ${ft.module} (feature ${featureKey(ft)})`).toBeTruthy();
      expect(
        actionsForModule(ft.module),
        `action ${featureKey(ft)} phải nằm trong registry`,
      ).toContain(ft.action);
    }
  });

  it("fallback của feature trỏ về MODULE có thật (action có thể là key legacy đã gỡ khỏi registry)", () => {
    // Fallback đọc JSONB cũ — key như sale_phong.edit / shareholder_profit.edit
    // không còn trong registry mới nhưng vẫn nằm trong permissions cũ của DB,
    // nên chỉ ràng buộc module tồn tại.
    for (const ft of ALL_PAGE_FEATURES) {
      if (!ft.fallback) continue;
      const m = ft.fallback.module ?? ft.module;
      expect(MODULE_BY_KEY[m], `fallback module của ${featureKey(ft)} (${m})`).toBeTruthy();
    }
  });

  it("không trùng key feature trong cùng 1 trang", () => {
    for (const p of ALL_PAGES) {
      const keys = p.features.map(featureKey);
      expect(new Set(keys).size, `trang ${p.key} có key trùng`).toBe(keys.length);
    }
  });
});

describe("fallback legacy (canFeature/featureValue)", () => {
  it("JSONB cũ KHÔNG có key chi tiết → rơi về quyền gốc", () => {
    // Giả lập template cũ: chỉ có contracts.edit = true, không có key renew.
    const legacy: PermissionsMap = { contracts: { view: true, edit: true } };
    expect(canUse(legacy, "contracts", "renew")).toBe(true);     // fb edit
    expect(canUse(legacy, "contracts", "terminate")).toBe(true); // fb edit
    expect(canUse(legacy, "contracts", "approve")).toBe(false);  // không fb
  });

  it("key chi tiết đã set tường minh thì thắng fallback", () => {
    const perms: PermissionsMap = {
      contracts: { edit: true, renew: false },
    };
    expect(canUse(perms, "contracts", "renew")).toBe(false);
    expect(canUse(perms, "contracts", "transfer")).toBe(true); // vẫn fb edit
  });

  it("fallback xuyên module: thu_tien rơi về invoices.record_payment", () => {
    const legacy: PermissionsMap = { invoices: { record_payment: true } };
    expect(canUse(legacy, "thu_tien", "view")).toBe(true);
    expect(canUse(legacy, "thu_tien", "collect")).toBe(true);
    expect(canUse(legacy, "thu_tien", "undo")).toBe(true);
  });

  it("__superadmin bypass mọi check", () => {
    const sa = { __superadmin: true } as unknown as PermissionsMap;
    expect(canUse(sa, "users", "delete")).toBe(true);
    expect(featureValue(sa, ALL_PAGE_FEATURES[0])).toBe(true);
  });
});

describe("preset & thao tác trang", () => {
  it("preset manage KHÔNG cấp module users (phân quyền) và action nhạy cảm", () => {
    const p = applyGlobalPreset(buildEmptyPermissions(), "manage");
    expect(p.users?.view).toBe(false);
    expect(p.users?.edit).toBe(false);
    expect(p.contracts?.approve).toBe(false);
    expect(p.contracts?.terminate).toBe(false);
    expect(p.income_expenses?.all_buildings).toBe(false);
    expect(p.shareholder_profit?.lock).toBe(false);
    // nhưng vẫn cấp thao tác thường ngày
    expect(p.contracts?.renew).toBe(true);
    expect(p.invoices?.record_payment).toBe(true);
  });

  it("setPageAll / setPageViewOnly ghi key tường minh đúng tier", () => {
    const page = ALL_PAGES.find((p) => p.key === "contracts")!;
    const all = setPageAll(buildEmptyPermissions(), page, true);
    expect(pageStats(all, page).granted).toBe(page.features.length);

    const viewOnly = setPageViewOnly(all, page);
    for (const ft of page.features) {
      expect(featureValue(viewOnly, ft)).toBe(ft.tier === "view");
    }
  });

  it("pageStats đếm theo giá trị hiệu lực (gồm fallback)", () => {
    const page = ALL_PAGES.find((p) => p.key === "thu_tien")!;
    const legacy: PermissionsMap = {
      invoices: { view: true, record_payment: true },
    };
    // view/collect/undo fb record_payment, report fb invoices.view → đủ 4
    expect(pageStats(legacy, page)).toEqual({ granted: 4, total: 4 });
  });

  it("registry build helpers phủ đủ mọi module", () => {
    const empty = buildEmptyPermissions();
    for (const m of ALL_MODULES) {
      expect(Object.keys(empty[m.key] ?? {}).sort()).toEqual(
        [...actionsForModule(m.key)].sort(),
      );
    }
  });
});
