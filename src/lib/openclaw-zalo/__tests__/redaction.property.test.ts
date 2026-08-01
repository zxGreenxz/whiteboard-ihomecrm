import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REDACTED_TOKEN, redactOpenClawSecrets } from "@/lib/openclaw-zalo/query-contract";

describe("OpenClaw redaction", () => {
  it("redacts claim and marker secrets without mutating input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (claimToken, markerNonce) => {
        const input = { claimToken, nested: { markerNonce }, safe: "ok" };
        const redacted = redactOpenClawSecrets(input);
        expect(redacted).toEqual({ claimToken: REDACTED_TOKEN, nested: { markerNonce: REDACTED_TOKEN }, safe: "ok" });
        expect(input).toEqual({ claimToken, nested: { markerNonce }, safe: "ok" });
      }),
      { numRuns: 200 },
    );
  });
});
