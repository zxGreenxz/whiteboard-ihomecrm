import { describe, expect, it } from "vitest";

import { manageableBuildings } from "@/lib/door-access/view";
import { ALL_PAGES, canUse, featureValue, setPageViewOnly } from "@/lib/permissionPages";
import {
  ACTION_LABELS,
  MODULE_BY_KEY,
  actionsForModule,
  applyGlobalPreset,
  buildEmptyPermissions,
} from "@/lib/permissions";

/**
 * Cửa vân tay (chủ chốt 21/10 điểm 1): bốn quyền theo tòa — Xem, Mật khẩu tạm, Mở cửa từ xa,
 * Quản lý máy & vân tay. Khoá DB: door_access.view|temp_password|remote_unlock|manage_devices
 * (gate permission-catalog đòi catalog FE == khoá DB).
 */
describe("quyền Cửa vân tay", () => {
  it("đăng ký đúng module và bốn action", () => {
    expect(MODULE_BY_KEY.door_access?.label).toBe("Cửa vân tay");
    expect(actionsForModule("door_access")).toEqual(["view", "temp_password", "remote_unlock", "manage_devices"]);
    expect(ACTION_LABELS.temp_password).toBe("Mật khẩu tạm");
    expect(ACTION_LABELS.remote_unlock).toBe("Mở cửa từ xa");
    expect(ACTION_LABELS.manage_devices).toBe("Quản lý máy & vân tay");
  });

  it("trang quyền /cua-van-tay: Xem là tier view, ba quyền thao tác là elevated", () => {
    const page = ALL_PAGES.find((candidate) => candidate.key === "door_access");
    expect(page?.route).toBe("/cua-van-tay");
    expect(page?.features.map((feature) => `${feature.module}.${feature.action}:${feature.tier}:${feature.label}`)).toEqual([
      "door_access.view:view:Xem",
      "door_access.temp_password:elevated:Mật khẩu tạm",
      "door_access.remote_unlock:elevated:Mở cửa từ xa",
      "door_access.manage_devices:elevated:Quản lý máy & vân tay",
    ]);
  });

  it("preset 'chỉ xem' và 'quản lý' KHÔNG mở thao tác cửa", () => {
    const page = ALL_PAGES.find((candidate) => candidate.key === "door_access")!;
    const viewOnly = setPageViewOnly(buildEmptyPermissions(), page);
    expect(page.features.map((feature) => featureValue(viewOnly, feature))).toEqual([true, false, false, false]);

    const manage = applyGlobalPreset(buildEmptyPermissions(), "manage");
    expect(manage.door_access).toEqual({ view: true, temp_password: false, remote_unlock: false, manage_devices: false });
  });

  it("quyền theo tòa: có ở tòa A không mở ở tòa B; không hỏi tòa = 'ở đâu đó'", () => {
    const perms = { door_access: { manage_devices: { org_wide: false, building_ids: ["toa-a"] } } };
    expect(canUse(perms, "door_access", "manage_devices", "toa-a")).toBe(true);
    expect(canUse(perms, "door_access", "manage_devices", "toa-b")).toBe(false);
    expect(canUse(perms, "door_access", "manage_devices")).toBe(true);
    expect(canUse(perms, "door_access", "remote_unlock")).toBe(false);
  });

  it("ô chọn tòa của hộp gắn/sửa máy chỉ có tòa được Quản lý máy (dạng THẬT của get_my_permissions_v2)", () => {
    const buildings = [
      { id: "toa-a", name: "Tòa A", code: null, street_address: null },
      { id: "toa-b", name: "Tòa B", code: null, street_address: null },
    ];
    // Khoá có chiều BUILDING: máy chủ luôn trả org_wide=false + danh sách tòa, kể cả chủ công ty (phạm vi ORGANIZATION).
    const perms = { door_access: { manage_devices: { org_wide: false, building_ids: ["toa-a"] }, view: { org_wide: false, building_ids: ["toa-a", "toa-b"] } } };
    expect(manageableBuildings(buildings, perms).map((b) => b.id)).toEqual(["toa-a"]);
    const owner = { door_access: { manage_devices: { org_wide: false, building_ids: ["toa-a", "toa-b"] } } };
    expect(manageableBuildings(buildings, owner)).toHaveLength(2);
    expect(manageableBuildings(buildings, {})).toEqual([]);
  });
});
