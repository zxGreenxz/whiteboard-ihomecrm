import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isOpenClawSerializationFailure, resolveUnknownWithWinnerReload } from "@/hooks/openclaw-zalo/useOpenClawMutations";
import { unknownResolutionRequestSchema } from "@/lib/openclaw-zalo/validation";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTBOX = "33333333-3333-4333-8333-333333333333";

describe("OpenClaw mutation contracts", () => {
  it("accepts each immutable UNKNOWN resolution outcome and rejects mismatched reasons", () => {
    const outcomes = [
      ["CONFIRMED_SENT", "OPERATOR_CONFIRMED_SENT"],
      ["CONFIRMED_FAILED", "OPERATOR_CONFIRMED_FAILED"],
      ["NEW_INTENT_CREATED", "OPERATOR_CREATED_NEW_INTENT"],
    ] as const;
    fc.assert(
      fc.property(fc.constantFrom(...outcomes), ([outcome, reasonCode]) => {
        const request = {
          version: 1,
          organizationId: ORG,
          outboxId: OUTBOX,
          expectedResolutionVersion: 0,
          expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0" as const,
          expectedEvidenceHash: "a".repeat(64),
          outcome,
          reasonCode,
          operatorEvidenceHash: "b".repeat(64),
          ...(outcome === "NEW_INTENT_CREATED" ? {
            newIntent: {
              clientOperationId: "44444444-4444-4444-8444-444444444444",
              targetId: "55555555-5555-4555-8555-555555555555",
              sourceDraftId: "66666666-6666-4666-8666-666666666666",
              expectedDraftVersion: 1,
              replyToMessageId: null,
            },
          } : {}),
        };
        expect(unknownResolutionRequestSchema.parse(request).outcome).toBe(outcome);
      }),
      { numRuns: 100 },
    );
    expect(() => unknownResolutionRequestSchema.parse({
      version: 1,
      organizationId: ORG,
      outboxId: OUTBOX,
      expectedResolutionVersion: 0,
      expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0",
      expectedEvidenceHash: "a".repeat(64),
      outcome: "CONFIRMED_SENT",
      reasonCode: "OPERATOR_CONFIRMED_FAILED",
      operatorEvidenceHash: "b".repeat(64),
    })).toThrow();
  });

  it("recognizes CAS loss so the caller can reload the winner", () => {
    expect(isOpenClawSerializationFailure({ code: "40001", message: "winner" })).toBe(true);
    expect(isOpenClawSerializationFailure({ code: "23505", message: "duplicate" })).toBe(false);
  });

  it("reloads the immutable winner after 40001 without creating a second operation", async () => {
    const operationId = "44444444-4444-4444-8444-444444444444";
    const seenOperationIds: string[] = [];
    const winner = { resolutionId: "55555555-5555-4555-8555-555555555555" };
    const result = await resolveUnknownWithWinnerReload(
      async () => {
        seenOperationIds.push(operationId);
        throw { code: "40001", message: "concurrent winner" };
      },
      async () => winner,
    );
    expect(result).toBe(winner);
    expect(seenOperationIds).toEqual([operationId]);
  });
});
