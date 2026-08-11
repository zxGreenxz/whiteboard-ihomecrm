import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaticRouter } from "react-router-dom/server";

import { TooltipProvider } from "@/components/ui/tooltip";
import { FleetOverview } from "@/components/network-center/FleetOverview";
import { SettingsTab } from "@/components/network-center/tabs/SettingsTab";
import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";

/**
 * "Chưa cấu hình" là trạng thái BÌNH THƯỜNG của một tenant chưa provisioning —
 * đúng trạng thái của 17/36 toà mà tài khoản chủ nhìn thấy trên production ngày
 * 04/08/2026. Nó phải hiện ra như trạng thái rỗng bình tĩnh, KHÔNG phải thẻ đỏ,
 * và tuyệt đối không được thay bằng số liệu bịa.
 */
function demoSite(): NetworkBuilding {
  const repository = new DemoNetworkCenterRepository([
    { id: "building-a", name: "Tòa A", roomsCount: 10 },
  ]);
  return repository.getBuilding("building-a")!;
}

function unprovisionedSite(): NetworkBuilding {
  return {
    ...demoSite(),
    settings: null,
    settingsVersion: null,
    interfaces: [],
    incidents: [],
    revisions: [],
    jobs: [],
    audit: [],
    clients: [],
  };
}

function controllerStub(fleet: NetworkBuilding[]): NetworkCenterController {
  return {
    fleet,
    isDemo: false,
    canExecute: false,
    executeDisabledMessage: "Tài khoản chỉ có quyền xem.",
    acknowledgeIncident: async (): Promise<void> => undefined,
    updateSettings: async (): Promise<void> => undefined,
  } as unknown as NetworkCenterController;
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <StaticRouter location="/network-center">
      <TooltipProvider>{node}</TooltipProvider>
    </StaticRouter>,
  );
}

describe("Network Center — trạng thái rỗng vs thất bại", () => {
  it("tab Cài đặt của toà chưa cấu hình hiện trạng thái rỗng, không hiện số liệu bịa", () => {
    const site = unprovisionedSite();
    const html = render(<SettingsTab site={site} controller={controllerStub([site])} />);

    expect(html).toContain("Chưa cấu hình Network Center");
    expect(html).not.toContain("Chu kỳ kiểm tra (giây)");
    expect(html).not.toContain("Giờ backup");
  });

  it("tab Cài đặt của toà đã cấu hình vẫn hiện đúng giá trị thật", () => {
    const site = demoSite();
    const html = render(<SettingsTab site={site} controller={controllerStub([site])} />);

    expect(html).toContain("Chu kỳ kiểm tra (giây)");
    expect(html).not.toContain("Chưa cấu hình Network Center");
  });

  it("hạm đội nói rõ toà nào chưa tải được chi tiết thay vì im lặng", () => {
    const healthy = demoSite();
    const degraded: NetworkBuilding = {
      ...demoSite(),
      buildingId: "building-b",
      buildingName: "Tòa B",
      detailError: "Dịch vụ Network Center từ chối yêu cầu",
    };
    const html = render(<FleetOverview controller={controllerStub([healthy, degraded])} />);

    expect(html).toContain("Chưa tải được chi tiết");
    const failureList = html.match(/<ul class="nc-detail-failures">.*?<\/ul>/s)?.[0] ?? "";
    expect(failureList).toContain("Tòa B");
    expect(failureList).toContain("Dịch vụ Network Center từ chối yêu cầu");
    expect(failureList).not.toContain("Tòa A");
  });

  it("hạm đội bình thường KHÔNG hiện cảnh báo chi tiết", () => {
    const html = render(<FleetOverview controller={controllerStub([demoSite()])} />);

    expect(html).not.toContain("Chưa tải được chi tiết");
  });
});
