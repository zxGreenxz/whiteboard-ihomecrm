import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaticRouter } from "react-router-dom/server";

import { FleetFilters } from "@/components/network-center/FleetFilters";
import { FleetOverview } from "@/components/network-center/FleetOverview";
import { FleetTable } from "@/components/network-center/FleetTable";
import { AuditTab } from "@/components/network-center/tabs/AuditTab";
import { BackupsTab } from "@/components/network-center/tabs/BackupsTab";
import { ClientsTab } from "@/components/network-center/tabs/ClientsTab";
import { ChangesTab } from "@/components/network-center/tabs/ChangesTab";
import { IncidentsTab } from "@/components/network-center/tabs/IncidentsTab";
import { InterfacesTab } from "@/components/network-center/tabs/InterfacesTab";
import { OverviewTab } from "@/components/network-center/tabs/OverviewTab";
import { TopologyTab } from "@/components/network-center/tabs/TopologyTab";
import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";

const actor = { id: "user-1", label: "Nguyễn An" };

function createSiteWithStructuredAction() {
  const repository = new DemoNetworkCenterRepository([
    { id: "building-a", name: "Tòa A", roomsCount: 10 },
  ]);
  const site = repository.getBuilding("building-a")!;
  const accessPort = site.interfaces.find(
    (networkInterface) => networkInterface.role === "lan" && networkInterface.status === "up",
  )!;

  repository.executeAction("building-a", {
    type: "cycle_access_port",
    reason: "Kiểm tra cổng truy cập tầng một",
    fields: {
      interfaceId: accessPort.id,
      durationSeconds: 10,
    },
    confirmation: site.router.identity,
  }, actor);

  return repository.getBuilding("building-a")!;
}

describe("network center audit and change details", () => {
  it("renders audit parameters, reason, and structured simulation result", () => {
    const html = renderToStaticMarkup(<AuditTab site={createSiteWithStructuredAction()} />);

    expect(html).toContain("Lý do ghi nhật ký:");
    expect(html).toContain("Kiểm tra cổng truy cập tầng một");
    expect(html).toContain("Tham số ghi nhận:");
    expect(html).toContain("interfaceId");
    expect(html).toContain("durationSeconds");
    expect(html).toContain("Kết quả mô phỏng:");
    expect(html).toContain("Trạng thái");
    expect(html).toContain("Kiểm tra");
    expect(html).toContain("Kết quả");
  });

  it("renders structured job target and action parameters with local simulation wording", () => {
    const html = renderToStaticMarkup(<ChangesTab site={createSiteWithStructuredAction()} />);

    expect(html).toContain("Mô phỏng cục bộ · không gọi router thật");
    expect(html).toContain("Mã thao tác:");
    expect(html).toContain("cycle_access_port");
    expect(html).toContain("Mục tiêu thực hiện:");
    expect(html).toContain("buildingId");
    expect(html).toContain("routerIdentity");
    expect(html).toContain("interfaceId");
    expect(html).toContain("Tham số thao tác:");
    expect(html).toContain("durationSeconds");
  });

  it("renders non-success job and stage statuses instead of hardcoded success", () => {
    const site = createSiteWithStructuredAction();
    site.jobs[0].status = "failed";
    site.jobs[0].stages[1].status = "failed";
    site.jobs[0].stages[2].status = "skipped";

    const html = renderToStaticMarkup(<ChangesTab site={site} />);

    expect(html).toContain("Thất bại");
    expect(html).toContain("Bỏ qua");
    expect(html).toContain("nc-job-status nc-status-failed");
    expect(html).toContain("nc-stage-failed");
    expect(html).toContain("nc-stage-skipped");
  });

  it("adds captions and body row headers to every network data table", () => {
    const site = createSiteWithStructuredAction();
    const controller = {
      canExecute: true,
      isDemo: true,
      executeDisabledMessage: "",
      compareRevisions: () => ({ fromRevisionId: "a", toRevisionId: "b", changeCount: 0, lines: [] }),
      captureConfiguration: () => undefined,
    } as any;
    const tables = [
      renderToStaticMarkup(<StaticRouter location="/network-center"><FleetTable fleet={[site]} /></StaticRouter>),
      renderToStaticMarkup(<InterfacesTab site={site} />),
      renderToStaticMarkup(<ClientsTab site={site} />),
      renderToStaticMarkup(<BackupsTab site={site} controller={controller} />),
      renderToStaticMarkup(<AuditTab site={site} />),
    ];

    for (const html of tables) {
      expect(html).toContain("<caption");
      expect(html).toContain("sr-only");
      expect(html).toContain('scope="row"');
    }
  });

  it("shows the protected uplink interface and its derived health before Aruba branches", () => {
    const site = createSiteWithStructuredAction();
    const uplink = site.interfaces.find((networkInterface) => networkInterface.role === "uplink")!;
    uplink.status = "down";

    const html = renderToStaticMarkup(<TopologyTab site={site} />);

    expect(html).toContain("Cổng uplink được bảo vệ");
    expect(html).toContain(uplink.name);
    expect(html).toContain("DOWN");
    expect(html.indexOf(uplink.name)).toBeLessThan(html.indexOf(site.arubaNodes[0].name));
  });

  it("keeps the incident rail before the building list in source order", () => {
    const repository = new DemoNetworkCenterRepository([
      { id: "building-a", name: "Tòa A", roomsCount: 10 },
    ]);
    const fleet = repository.listFleet();
    const controller = {
      fleet,
      canExecute: true,
      executeDisabledMessage: "",
      acknowledgeIncident: () => undefined,
    } as any;

    const html = renderToStaticMarkup(<StaticRouter location="/network-center"><FleetOverview controller={controller} /></StaticRouter>);

    expect(html.indexOf('id="incident-rail-title"')).toBeLessThan(html.indexOf('id="fleet-title"'));
  });

  it("offers a firmware drift filter", () => {
    const html = renderToStaticMarkup(
      <FleetFilters
        filters={{ search: "", health: "all", severity: "all", backup: "all", firmware: "drift" }}
        resultCount={1}
        totalCount={1}
        onChange={() => undefined}
        onReset={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Firmware"');
    expect(html).toContain('data-state="closed"');
    expect(html).not.toContain("Sai lệch firmware");
  });

  it("renders the incident timeline heading in Vietnamese", () => {
    const site = createSiteWithStructuredAction();
    const controller = {
      canExecute: true,
      executeDisabledMessage: "",
      acknowledgeIncident: () => undefined,
      createMaintenance: () => undefined,
      cancelMaintenance: () => undefined,
    } as any;

    const html = renderToStaticMarkup(<IncidentsTab site={site} controller={controller} />);

    expect(html).toContain("Dòng thời gian sự cố");
    expect(html).not.toContain("Incident timeline");
  });

  it("localizes visible operator copy across the network tabs", () => {
    const site = createSiteWithStructuredAction();
    const controller = {
      canExecute: true,
      isDemo: true,
      executeDisabledMessage: "",
      compareRevisions: () => ({ fromRevisionId: "a", toRevisionId: "b", changeCount: 0, lines: [] }),
      captureConfiguration: () => undefined,
      executeAction: () => undefined,
      createMaintenance: () => undefined,
    } as any;
    const overview = renderToStaticMarkup(<OverviewTab site={site} controller={controller} />);
    const incidents = renderToStaticMarkup(<IncidentsTab site={site} controller={controller} />);
    const backups = renderToStaticMarkup(<BackupsTab site={site} controller={controller} />);
    const clients = renderToStaticMarkup(<ClientsTab site={site} />);

    expect(overview).toContain("Dòng thời gian");
    expect(overview).not.toContain(">Timeline<");
    expect(incidents).toContain("Mức sẵn sàng mô phỏng");
    expect(incidents).toContain(">TẮT<");
    expect(backups).toContain("Mã băm và nội dung so sánh");
    expect(backups).not.toContain("Hash và diff");
    expect(clients).toContain("Người dùng / phiên demo");
  });
});
