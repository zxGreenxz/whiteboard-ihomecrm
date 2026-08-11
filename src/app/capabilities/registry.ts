import { NETWORK_CENTER_RUNTIME_ENABLED } from "@/lib/network-center/runtime";
import { OPENCLAW_RUNTIME_ENABLED } from "@/lib/openclaw-zalo/runtime";
import type { CapabilityDefinition } from "./types";

/**
 * Registry bề mặt sản phẩm ở mức trang.
 *
 * Bắt đầu bằng đúng hai capability này vì chúng đã DRIFT THẬT: route được gác
 * sau cờ, nhưng tile ở launcher và mục ở sidebar từng bị bỏ sót — người dùng
 * giữ quyền nên vẫn thấy lối vào, bấm vào thì rơi ra 404. Các comment cảnh báo
 * nằm rải ở App.tsx, Sidebar.tsx và launcherTiles.ts đều nói về đúng sự cố đó.
 *
 * Ở lát này registry là nguồn ĐỐI CHIẾU: contract test đọc nó và kiểm bốn nơi
 * kia có khớp không. Việc cho các consumer sinh trực tiếp từ registry là lát
 * sau — đổi cùng lúc sẽ làm mất khả năng chỉ ra thứ gì gây ra sai lệch nếu có.
 */
export const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: "network-center",
    primaryRoute: "/network-center",
    label: "Trung tâm mạng",
    release: { enabled: NETWORK_CENTER_RUNTIME_ENABLED, runtimeModule: "network-center" },
    permission: { module: "network_center", action: "view" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: true,
      permissionPage: "/network-center",
    },
    docs: { systemDoc: "docs/he-thong/22-network-center.md" },
    e2e: { spec: ".e2e-fleet/specs/network-center.spec.ts" },
    risk: "infrastructure",
  },
  {
    id: "openclaw-zalo",
    primaryRoute: "/openclaw-zalo",
    label: "OpenClaw Zalo",
    release: { enabled: OPENCLAW_RUNTIME_ENABLED, runtimeModule: "openclaw-zalo" },
    permission: { module: "openclaw_zalo", action: "view" },
    surfaces: {
      desktopNav: true,
      mobileLauncher: true,
      permissionPage: "/openclaw-zalo",
    },
    docs: { systemDoc: "docs/he-thong/23-openclaw-zalo.md" },
    e2e: { spec: ".e2e-fleet/specs/openclaw-zalo.spec.ts" },
    risk: "security",
  },
];

export function capabilityById(id: string): CapabilityDefinition | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** Capability đang bật theo cờ runtime hiện tại. */
export function enabledCapabilities(): readonly CapabilityDefinition[] {
  return CAPABILITIES.filter((c) => c.release.enabled);
}
