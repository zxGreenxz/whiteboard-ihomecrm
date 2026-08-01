import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyIdempotency, makeClientOperationId } from "@/lib/openclaw-zalo/query-contract";

describe("OpenClaw client idempotency", () => {
  it("replays the same key/hash and rejects hash changes", () => {
    const hash = fc
      .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 })
      .map(characters => characters.join(""));
    fc.assert(
      fc.property(fc.uuid(), hash, hash, (key, sameHash, differentHash) => {
        expect(classifyIdempotency(key, sameHash, sameHash)).toBe("REPLAY");
        expect(classifyIdempotency(key, sameHash, differentHash)).toBe(
          sameHash === differentHash ? "REPLAY" : "CONFLICT",
        );
        expect(classifyIdempotency(key, sameHash, differentHash, `${key}-different`)).toBe("NEW");
        expect(classifyIdempotency(key, null, differentHash)).toBe("NEW");
      }),
      { numRuns: 200 },
    );
  });

  it("generates stable operation ids when supplied", () => {
    fc.assert(
      fc.property(fc.uuid(), operation => {
        expect(makeClientOperationId(operation)).toBe(operation);
      }),
      { numRuns: 100 },
    );
  });
});
