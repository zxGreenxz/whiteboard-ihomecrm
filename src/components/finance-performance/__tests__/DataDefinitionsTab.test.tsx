import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildBusinessPerformanceFilters } from "@/lib/businessPerformance";
import { DataDefinitionsTab } from "../DataDefinitionsTab";

const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUILDING_ID = "11111111-1111-4111-8111-111111111111";

describe("DataDefinitionsTab", () => {
  it("documents only the canonical business-performance RPC sources", () => {
    const filters = buildBusinessPerformanceFilters(
      "2024-02",
      [BUILDING_ID],
      "ACCRUAL",
      ORGANIZATION_ID,
    );

    const html = renderToStaticMarkup(<DataDefinitionsTab filters={filters} />);

    expect(html).toContain("business_performance_organizations_v1");
    expect(html).toContain("business_performance_pnl_v1");
    expect(html).toContain("business_performance_snapshot_v1");
    expect(html).not.toContain("fa_monthly_pnl_accrual");
    expect(html).not.toContain("fa_snapshot_kpis");
  });
});
