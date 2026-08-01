import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { openClawQueryKeys } from "@/hooks/openclaw-zalo/queryKeys";
import { selectOpenClawOrganization } from "@/hooks/openclaw-zalo/useOpenClawOrganization";
import { resetOpenClawCache } from "@/hooks/openclaw-zalo/useOpenClawRealtime";
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
          openClawQueryKeys.overview(organizationId, accountId),
          openClawQueryKeys.conversations(organizationId, accountId),
          openClawQueryKeys.messages(organizationId, accountId, "33333333-3333-4333-8333-333333333333"),
          openClawQueryKeys.unknown(organizationId, accountId),
        ];
        for (const key of keys) expect(key.slice(0, 3)).toEqual(["openclaw-zalo", organizationId, accountId]);
      }),
      { numRuns: 200 },
    );
  });

  it("never aliases organization or account caches", () => {
    expect(openClawQueryKeys.overview(ORG_A, ACCOUNT_A)).not.toEqual(openClawQueryKeys.overview(ORG_B, ACCOUNT_A));
    expect(openClawQueryKeys.overview(ORG_A, ACCOUNT_A)).not.toEqual(openClawQueryKeys.overview(ORG_A, ACCOUNT_B));
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
