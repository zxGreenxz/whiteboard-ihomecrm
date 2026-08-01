import { describe, expect, it } from "vitest";

import {
  authorizeMaintenance,
  channelStateAffectsMaintenance,
  MAINTENANCE_WORK_KINDS,
  type MaintenanceAuthState,
} from "../src/runtime-client.js";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";
const NOW = 1_785_062_400_000;

function state(overrides: Partial<MaintenanceAuthState> = {}): MaintenanceAuthState {
  return {
    principal: {
      version: 1,
      principalKind: "MAINTENANCE",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 4,
    },
    credentialEnabled: true,
    credentialRevoked: false,
    leaseStatus: "ACTIVE",
    leaseExpiresAtEpochMs: NOW + 60_000,
    currentCredentialGeneration: 2,
    currentLeaseGeneration: 3,
    currentFencingToken: 4,
    allowedScopes: ["maintenance.claim", "maintenance.complete"],
    ...overrides,
  };
}

function authorize(overrides: Record<string, unknown> = {}) {
  return authorizeMaintenance({
    state: state(),
    expectedOrganizationId: ORGANIZATION_ID,
    operation: "maintenance.claim",
    workKind: "RETENTION_DELETE",
    nowEpochMs: NOW,
    ...overrides,
  } as Parameters<typeof authorizeMaintenance>[0]);
}

describe("Maintenance principal authentication", () => {
  it("authorizes an organization-scoped maintenance credential", () => {
    expect(authorize()).toEqual({ allowed: true });
  });

  it("succeeds with no active Zalo account and an offline channel cell", () => {
    // There is no channel input at all in the decision, which is the invariant.
    expect(channelStateAffectsMaintenance()).toBe(false);
    expect(authorize()).toEqual({ allowed: true });
  });

  it("refuses a principal from another organization", () => {
    expect(
      authorize({ expectedOrganizationId: "aaaa0000-0000-4000-8000-000000000001" }).denial,
    ).toBe("WRONG_ORGANIZATION");
  });

  it("refuses a channel principal masquerading as maintenance", () => {
    expect(
      authorize({
        state: state({
          principal: {
            ...state().principal,
            principalKind: "CHANNEL" as never,
          },
        }),
      }).denial,
    ).toBe("WRONG_PRINCIPAL_KIND");
  });

  it("refuses a disabled or revoked credential", () => {
    expect(authorize({ state: state({ credentialEnabled: false }) }).denial)
      .toBe("CREDENTIAL_DISABLED");
    expect(authorize({ state: state({ credentialRevoked: true }) }).denial)
      .toBe("CREDENTIAL_REVOKED");
  });

  it("refuses a stale credential, lease, or fencing generation", () => {
    expect(authorize({ state: state({ currentCredentialGeneration: 3 }) }).denial)
      .toBe("STALE_CREDENTIAL_GENERATION");
    expect(authorize({ state: state({ currentLeaseGeneration: 4 }) }).denial)
      .toBe("STALE_LEASE_GENERATION");
    expect(authorize({ state: state({ currentFencingToken: 5 }) }).denial)
      .toBe("STALE_FENCING_TOKEN");
  });

  it("refuses an inactive or expired lease", () => {
    expect(authorize({ state: state({ leaseStatus: "EXPIRED" }) }).denial)
      .toBe("LEASE_NOT_ACTIVE");
    expect(authorize({ state: state({ leaseExpiresAtEpochMs: NOW }) }).denial)
      .toBe("LEASE_EXPIRED");
  });

  it("refuses an operation outside the granted scopes", () => {
    expect(
      authorize({ state: state({ allowedScopes: ["maintenance.claim"] }), operation: "maintenance.complete" })
        .denial,
    ).toBe("SCOPE_NOT_GRANTED");
  });

  it("refuses a send-work kind on a maintenance route", () => {
    for (const workKind of ["INBOUND_AUTOMATION", "SCHEDULE_OCCURRENCE", "CRM_EVENT"]) {
      expect(authorize({ workKind }).denial, workKind).toBe("WORK_KIND_FORBIDDEN");
    }
    for (const workKind of MAINTENANCE_WORK_KINDS) {
      expect(authorize({ workKind }), workKind).toEqual({ allowed: true });
    }
  });
});