import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchOpenClawDeadLetters,
  fetchOpenClawHealthEvents,
  fetchOpenClawUnknown,
  fetchOpenClawUnknownResolution,
} from "@/hooks/openclaw-zalo/useOpenClawOperations";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn() } }));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OUTBOX = "33333333-3333-4333-8333-333333333333";
const RESOLUTION = "44444444-4444-4444-8444-444444444444";
const HASH = "a".repeat(64);
const NOW = "2026-08-02T00:00:00Z";

describe("OpenClaw account-scoped operations", () => {
  const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => rpc.mockReset());

  it("passes account scope to the database before bounded UNKNOWN/dead-letter/health queries", async () => {
    rpc
      .mockResolvedValueOnce({
        data: {
          version: 1,
          limit: 1,
          items: [{
            outboxId: OUTBOX,
            accountId: ACCOUNT,
            payloadHash: HASH,
            terminalAt: NOW,
            resolution_version: 0,
            authoritative_evidence_hash: null,
            resolutionId: null,
            outcome: null,
            new_outbox_id: null,
            resolvedAt: null,
          }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { version: 1, limit: 1, items: [] }, error: null })
      .mockResolvedValueOnce({ data: { version: 1, limit: 1, items: [] }, error: null });

    await fetchOpenClawUnknown(ORG, ACCOUNT, 1);
    await fetchOpenClawDeadLetters(ORG, ACCOUNT, 1);
    await fetchOpenClawHealthEvents(ORG, ACCOUNT, 1);

    expect(rpc.mock.calls.map(call => call[0])).toEqual([
      "openclaw_list_unknown_by_account_v1",
      "openclaw_list_dead_letters_by_account_v1",
      "openclaw_list_health_events_by_account_v1",
    ]);
    for (const [, args] of rpc.mock.calls) {
      expect(args.p_request).toMatchObject({
        version: 1,
        organizationId: ORG,
        accountId: ACCOUNT,
        limit: 1,
      });
    }
  });

  it("reloads a 40001 winner by exact organization/account/outbox identity", async () => {
    const winner = {
      version: 1,
      resolutionId: RESOLUTION,
      organizationId: ORG,
      accountId: ACCOUNT,
      outboxId: OUTBOX,
      resolutionVersion: 1,
      outcome: "CONFIRMED_FAILED",
      newOutboxId: null,
      authoritativeEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0",
      authoritativeEvidenceHash: HASH,
      reasonCode: "OPERATOR_CONFIRMED_FAILED",
      resolvedBy: "55555555-5555-4555-8555-555555555555",
      resolvedAt: NOW,
    };
    rpc.mockResolvedValueOnce({ data: winner, error: null });

    await expect(fetchOpenClawUnknownResolution(ORG, ACCOUNT, OUTBOX)).resolves.toEqual(winner);
    expect(rpc).toHaveBeenCalledWith("openclaw_get_unknown_resolution_v1", {
      p_request: { version: 1, organizationId: ORG, accountId: ACCOUNT, outboxId: OUTBOX },
    });
  });
});
