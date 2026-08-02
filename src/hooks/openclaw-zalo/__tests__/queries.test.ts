import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { openClawQueryKeys } from "@/hooks/openclaw-zalo/queryKeys";
import { selectOpenClawOrganization } from "@/hooks/openclaw-zalo/useOpenClawOrganization";
import { resetOpenClawCache } from "@/hooks/openclaw-zalo/useOpenClawRealtime";
import { projectOpenClawPermissions } from "@/hooks/openclaw-zalo/useOpenClawPermissions";
import { parseUnknownItems } from "@/lib/openclaw-zalo/validation";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

describe("OpenClaw query contracts", () => {
  it("includes both tenant and account in every scoped key", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (organizationId, accountId) => {
        const keys = [
          openClawQueryKeys.bootstrap(organizationId, accountId),
          // `overview` is deliberately NOT here: openclaw_get_overview_v1 counts the
          // whole organization, so an account-scoped key cached org-wide numbers per
          // account and let the UI present them as that account's. Its own scoping is
          // asserted in overviewScope.test.ts.
          openClawQueryKeys.conversations(organizationId, accountId),
          openClawQueryKeys.messages(organizationId, accountId, "33333333-3333-4333-8333-333333333333"),
          openClawQueryKeys.unknown(organizationId, accountId),
          openClawQueryKeys.knowledgeList(organizationId, accountId),
          openClawQueryKeys.automationList(organizationId, accountId),
          openClawQueryKeys.salesGroups(organizationId, accountId),
          openClawQueryKeys.schedules(organizationId, accountId),
        ];
        for (const key of keys) expect(key.slice(0, 3)).toEqual(["openclaw-zalo", organizationId, accountId]);
      }),
      { numRuns: 200 },
    );
  });

  it("never aliases organization or account caches", () => {
    expect(openClawQueryKeys.overview(ORG_A, ACCOUNT_A)).not.toEqual(openClawQueryKeys.overview(ORG_B, ACCOUNT_A));
    // Overview is organization-wide, so two accounts of the SAME organization must
    // share one cache entry; aliasing across organizations is what would be wrong.
    expect(openClawQueryKeys.overview(ORG_A, ACCOUNT_A)).toEqual(openClawQueryKeys.overview(ORG_A, ACCOUNT_B));
    expect(openClawQueryKeys.conversations(ORG_A, ACCOUNT_A))
      .not.toEqual(openClawQueryKeys.conversations(ORG_A, ACCOUNT_B));
  });

  it("projects resolved UNKNOWN without changing the historical state", () => {
    const items = parseUnknownItems({
      version: 1,
      limit: 1,
      items: [{
        outboxId: "33333333-3333-4333-8333-333333333333",
        accountId: ACCOUNT_A,
        payloadHash: "a".repeat(64),
        terminalAt: "2026-01-01T00:00:00Z",
        resolution_version: 1,
        authoritative_evidence_hash: "b".repeat(64),
        resolutionId: "44444444-4444-4444-8444-444444444444",
        outcome: "CONFIRMED_FAILED",
        new_outbox_id: null,
        resolvedAt: "2026-01-01T00:01:00Z",
      }],
    });
    expect(items[0].historicalState).toBe("UNKNOWN");
    expect(items[0].resolution?.outcome).toBe("CONFIRMED_FAILED");
  });

  it("keeps unresolved UNKNOWN explicit and rejects extra response fields", () => {
    const response = {
      version: 1,
      limit: 1,
      items: [{
        outboxId: "33333333-3333-4333-8333-333333333333",
        accountId: ACCOUNT_A,
        payloadHash: "a".repeat(64),
        terminalAt: "2026-01-01T00:00:00Z",
        resolution_version: 0,
        authoritative_evidence_hash: null,
        resolutionId: null,
        outcome: null,
        new_outbox_id: null,
        resolvedAt: null,
      }],
    };
    expect(parseUnknownItems(response)[0]).toMatchObject({ historicalState: "UNKNOWN", resolutionVersion: 0, resolution: null });
    expect(() => parseUnknownItems({ ...response, secret: "must fail strict parsing" })).toThrow();
  });

  it("rejects every partial UNKNOWN resolution projection", () => {
    const unresolved = {
      outboxId: "33333333-3333-4333-8333-333333333333",
      accountId: ACCOUNT_A,
      payloadHash: "a".repeat(64),
      terminalAt: "2026-01-01T00:00:00Z",
      resolution_version: 0,
      authoritative_evidence_hash: null,
      resolutionId: null,
      outcome: null,
      new_outbox_id: null,
      resolvedAt: null,
    };
    for (const field of ["authoritative_evidence_hash", "resolutionId", "outcome", "resolvedAt"] as const) {
      const partial = {
        ...unresolved,
        [field]: field === "authoritative_evidence_hash"
          ? "b".repeat(64)
          : field === "resolutionId"
            ? "44444444-4444-4444-8444-444444444444"
            : field === "outcome"
              ? "CONFIRMED_FAILED"
              : "2026-01-01T00:01:00Z",
      };
      expect(() => parseUnknownItems({ version: 1, limit: 1, items: [partial] })).toThrow();
    }
  });

  it("isolates permissions to the organization returned by the authorization context", () => {
    const context = {
      organizationId: ORG_A,
      membershipId: "33333333-3333-4333-8333-333333333333",
      memberType: "OWNER",
      authorizationVersion: 2,
      isPlatformAdmin: false,
      isOffboarded: false,
      organizations: [{ id: ORG_A, name: "A", isDemo: false, memberType: "OWNER" }],
      permissions: { "openclaw_zalo.view": true, "openclaw_zalo.manage_operations": true },
      scopeSets: [{ orgWide: true, buildingIds: [], cashbookIds: [] }],
      scopes: { "openclaw_zalo.view": 0, "openclaw_zalo.manage_operations": 0 },
    };
    expect(projectOpenClawPermissions(context, ORG_A)).toMatchObject({
      organizationId: ORG_A,
      actions: { view: true, manage_operations: true, send: false },
    });
    expect(() => projectOpenClawPermissions(context, ORG_B)).toThrow(/organization mismatch/i);
    expect(projectOpenClawPermissions({
      ...context,
      organizationId: null,
      membershipId: null,
      memberType: null,
      authorizationVersion: null,
      organizations: [],
      permissions: {},
      scopeSets: [],
      scopes: {},
    }, ORG_B)).toBeNull();
  });

  it("refuses to guess among multiple organizations", () => {
    expect(selectOpenClawOrganization([ORG_A, ORG_B], null)).toBeNull();
    expect(selectOpenClawOrganization([ORG_A, ORG_B], ORG_B)).toBe(ORG_B);
    expect(selectOpenClawOrganization([ORG_A], null)).toBe(ORG_A);
  });

  it("removes only OpenClaw cache entries on a scope change", async () => {
    const client = new QueryClient();
    client.setQueryData(openClawQueryKeys.overview(ORG_A, ACCOUNT_A), { value: "openclaw" });
    client.setQueryData(["invoices", ORG_A], { value: "crm" });
    await resetOpenClawCache(client);
    expect(client.getQueryData(openClawQueryKeys.overview(ORG_A, ACCOUNT_A))).toBeUndefined();
    expect(client.getQueryData(["invoices", ORG_A])).toEqual({ value: "crm" });
  });
});
