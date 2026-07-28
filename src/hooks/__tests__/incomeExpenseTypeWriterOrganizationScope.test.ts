import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const maintenanceSource = readFileSync(
  new URL("../useMaintenanceBatch.ts", import.meta.url),
  "utf8",
);
const copilotSource = readFileSync(
  new URL("../../copilot/tools/writeTools.ts", import.meta.url),
  "utf8",
);

describe("income/expense type writers keep organization scope", () => {
  it("resolves maintenance types from the one organization owning every batch building", () => {
    expect(maintenanceSource).toMatch(/const organizationId\s*=/);
    expect(maintenanceSource).toMatch(/\.eq\(['"]organization_id['"], organizationId\)/);
    expect(maintenanceSource).toMatch(/organization_id:\s*organizationId/);
    expect(maintenanceSource).toMatch(/resolveOwnType\(s, organizationId, uid\)/);
  });

  it("resolves the Copilot category from the selected building organization", () => {
    expect(copilotSource).toMatch(/select\(['"]id, name, organization_id['"]\)/);
    expect(copilotSource).toMatch(/resolveType\(args\.hang_muc, ieType, building\.organization_id\)/);
    expect(copilotSource).toMatch(/\.eq\(['"]organization_id['"], organizationId\)/);
  });
});
