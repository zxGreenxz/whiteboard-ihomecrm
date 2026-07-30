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
  canFeature,
  type PermissionsMap,
} from "@/lib/permissions";

describe("OpenClaw Zalo permission catalog", () => {
  it("registers the exact eight deny-by-default actions", () => {
    expect(actionsForModule("openclaw_zalo")).toEqual([
      "view",
      "send",
      "manage_connections",
      "manage_automation",
      "manage_knowledge",
      "manage_handoff",
      "manage_operations",
      "audit",
    ]);
    expect(canFeature({}, "openclaw_zalo", "send")).toBe(false);
  });

  it("maps /openclaw-zalo to the approved permission tiers", () => {
    const page = ALL_PAGES.find((candidate) => candidate.route === "/openclaw-zalo");
    expect(page?.key).toBe("openclaw_zalo");
    expect(page?.features.map(({ action, tier }) => [action, tier])).toEqual([
      ["view", "view"],
      ["send", "manage"],
      ["manage_connections", "elevated"],
      ["manage_automation", "elevated"],
      ["manage_knowledge", "manage"],
      ["manage_handoff", "manage"],
      ["manage_operations", "elevated"],
      ["audit", "elevated"],
    ]);
  });

  it("does not grant OpenClaw elevated actions through the manage preset", () => {
    const permissions = applyGlobalPreset(buildEmptyPermissions(), "manage");
    expect(permissions.openclaw_zalo).toEqual({
      view: true,
      send: true,
      manage_connections: false,
      manage_automation: false,
      manage_knowledge: true,
      manage_handoff: true,
      manage_operations: false,
      audit: false,
    });
  });
});

describe("collection_cycle là quyền RIÊNG, phải cấp tường minh", () => {
  // Trước cutover V3, người có invoices.record_payment tự động xem được báo cáo
  // Chu kỳ Thu — Bàn giao nhờ cơ chế suy diễn. Nay phải cấp
  // reports_finance.collection_cycle tường minh (mẫu vai trò hoặc ngoại lệ).
  it("có record_payment nhưng KHÔNG có collection_cycle -> không xem được", () => {
    const managerPerms: PermissionsMap = {
      invoices: { record_payment: true, view: true },
      reports_finance: { view: false },
    };
    expect(canUse(managerPerms, "reports_finance", "collection_cycle")).toBe(false);
    expect(canUse(managerPerms, "reports_finance", "analysis")).toBe(false);
  });
  it("cấp tường minh thì xem được, và KHÔNG kéo theo báo cáo khác", () => {
    const p: PermissionsMap = { reports_finance: { collection_cycle: true } };
    expect(canUse(p, "reports_finance", "collection_cycle")).toBe(true);
    expect(canUse(p, "reports_finance", "analysis")).toBe(false);
    expect(canUse(p, "reports_finance", "daily_cashbook")).toBe(false);
  });
  it("không có gì thì không xem được", () => {
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

  it("không trùng key feature trong cùng 1 trang", () => {
    for (const p of ALL_PAGES) {
      const keys = p.features.map(featureKey);
      expect(new Set(keys).size, `trang ${p.key} có key trùng`).toBe(keys.length);
    }
  });
});

describe("gate quyền — KHÔNG suy diễn từ khoá khác", () => {
  // Cutover V3 (2026-07-26): get_my_permissions() trả đúng tập khoá mô hình tổ
  // chức cho phép. Khoá vắng mặt = KHÔNG có quyền. Ba bài dưới đây trước kia
  // kỳ vọng NGƯỢC LẠI (rơi về quyền gốc) — đó chính là thứ vừa gỡ.
  it("khoá vắng mặt là KHÔNG có quyền, không rơi về action gốc", () => {
    const p: PermissionsMap = { contracts: { view: true, edit: true } };
    expect(canUse(p, "contracts", "renew")).toBe(false);
    expect(canUse(p, "contracts", "terminate")).toBe(false);
    expect(canUse(p, "contracts", "approve")).toBe(false);
    expect(canUse(p, "contracts", "edit")).toBe(true);
  });

  it("không suy diễn xuyên module: invoices.record_payment không mở thu_tien", () => {
    const p: PermissionsMap = { invoices: { record_payment: true } };
    expect(canUse(p, "thu_tien", "view")).toBe(false);
    expect(canUse(p, "thu_tien", "collect")).toBe(false);
  });

  it("khoá set tường minh false thì tắt", () => {
    const p: PermissionsMap = { contracts: { edit: true, renew: false } };
    expect(canUse(p, "contracts", "renew")).toBe(false);
    expect(canUse(p, "contracts", "transfer")).toBe(false);
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

  it("pageStats chỉ đếm khoá thực sự có trong map", () => {
    const page = ALL_PAGES.find((p) => p.key === "thu_tien")!;
    const total = page.features.length;
    expect(pageStats({ invoices: { view: true, record_payment: true } }, page))
      .toEqual({ granted: 0, total });
    expect(pageStats({ thu_tien: { view: true, collect: true } }, page))
      .toEqual({ granted: 2, total });
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
