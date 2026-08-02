import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  OpenClawIdempotencyConflictError,
  parseOpenClawWriteResult,
} from "../useOpenClawMutations";

/**
 * Every browser write goes through the idempotency wrapper in
 * `app_private.openclaw_browser_operation_v1`. Reusing a `clientOperationId` with a
 * different request, or replaying a single-use operation, returns a normal 200
 * carrying `{version, conflict:true, reason}` - there is NO SQL error. Parsing that
 * with the route's strict result schema used to surface "unrecognized key: conflict"
 * to the operator instead of a conflict.
 */
const resultSchema = z.object({
  version: z.literal(1),
  knowledgeVersionId: z.string().uuid(),
}).strict();

const OK = { version: 1 as const, knowledgeVersionId: "dddd1000-0000-4000-8000-000000000001" };

describe("browser write result envelope", () => {
  it("turns a conflict into a typed error carrying the database's reason", () => {
    for (const reason of [
      "client operation id reused with a different request",
      "single-use operation replayed",
    ]) {
      let thrown: unknown;
      try {
        parseOpenClawWriteResult("openclaw_create_knowledge_source_v1", {
          version: 1,
          conflict: true,
          reason,
        }, resultSchema);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OpenClawIdempotencyConflictError);
      expect((thrown as OpenClawIdempotencyConflictError).reason).toBe(reason);
      // The message must not leak the raw envelope shape at the user.
      expect((thrown as Error).message).not.toContain("unrecognized");
    }
  });

  it("unwraps a replay to the result the first attempt produced", () => {
    const parsed = parseOpenClawWriteResult("openclaw_create_knowledge_source_v1", {
      version: 1,
      conflict: false,
      isReplay: true,
      requestHash: "a".repeat(64),
      safeResult: OK,
    }, resultSchema);
    expect(parsed).toEqual(OK);
  });

  it("passes a plain result straight through and still enforces the contract", () => {
    expect(parseOpenClawWriteResult("openclaw_create_knowledge_source_v1", OK, resultSchema))
      .toEqual(OK);
    // Strictness is not weakened by the envelope handling.
    expect(() => parseOpenClawWriteResult(
      "openclaw_create_knowledge_source_v1",
      { ...OK, surprise: true },
      resultSchema,
    )).toThrow();
  });
});
