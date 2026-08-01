import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateSendPolicy, POLICY_REASON_PRECEDENCE } from "@/lib/openclaw-zalo/policy";

describe("OpenClaw policy", () => {
  it("uses the documented precedence", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: POLICY_REASON_PRECEDENCE.length, maxLength: POLICY_REASON_PRECEDENCE.length }), flags => {
        const result = evaluateSendPolicy(Object.fromEntries(POLICY_REASON_PRECEDENCE.map((reason, index) => [reason, flags[index]])));
        const expected = POLICY_REASON_PRECEDENCE.find((reason, index) => flags[index]) ?? "ALLOWED";
        expect(result.reason).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});
