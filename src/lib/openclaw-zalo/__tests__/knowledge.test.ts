import { describe, expect, it } from "vitest";

import {
  classifyKnowledgeFailure,
  knowledgeActions,
  previewEmptyReason,
} from "../knowledge";

const base = {
  canManage: true,
  lifecycleState: "DRAFT" as const,
  hasValidationResult: false,
};

describe("knowledge actions", () => {
  it("offers nothing at all without manage_knowledge", () => {
    const actions = knowledgeActions({ ...base, canManage: false });
    for (const [name, state] of Object.entries(actions)) {
      expect(state.enabled, name).toBe(false);
      expect(state.blockedBy, name).toBe("PERMISSION");
    }
  });

  it("withholds publish until the draft has been validated", () => {
    // openclaw_publish_knowledge_v1 raises 55000 unless the current version is a
    // DRAFT carrying a validation_result, so offering it earlier only buys an error.
    expect(knowledgeActions(base).publish).toEqual({ enabled: false, blockedBy: "NOT_VALIDATED" });
    expect(knowledgeActions({ ...base, hasValidationResult: true }).publish)
      .toEqual({ enabled: true, blockedBy: null });
  });

  it("refuses to edit an archived source, which the server would silently resurrect", () => {
    // openclaw_update_knowledge_draft_v1 has NO lifecycle check: handed an ARCHIVED
    // source it writes a new DRAFT version and moves the source back to DRAFT. This
    // gate is deliberately stricter than the server.
    expect(knowledgeActions({ ...base, lifecycleState: "ARCHIVED" }).edit)
      .toEqual({ enabled: false, blockedBy: "LIFECYCLE" });
    expect(knowledgeActions({ ...base, lifecycleState: "PUBLISHED" }).edit.enabled).toBe(true);
  });

  it("only validates a draft", () => {
    for (const lifecycleState of ["PUBLISHED", "ARCHIVED"] as const) {
      expect(knowledgeActions({ ...base, lifecycleState }).validate, lifecycleState)
        .toEqual({ enabled: false, blockedBy: "LIFECYCLE" });
    }
    expect(knowledgeActions(base).validate.enabled).toBe(true);
  });

  it("archives a draft or a published version, never an archived one", () => {
    expect(knowledgeActions(base).archive.enabled).toBe(true);
    expect(knowledgeActions({ ...base, lifecycleState: "PUBLISHED" }).archive.enabled).toBe(true);
    expect(knowledgeActions({ ...base, lifecycleState: "ARCHIVED" }).archive.enabled).toBe(false);
  });
});

describe("failure classification", () => {
  it("separates the four things a write can do other than succeed", () => {
    // Each needs a different action from the operator, and only one of them is even
    // an exception - the idempotency conflict arrives as a normal 200 body.
    expect(classifyKnowledgeFailure({ conflict: true })).toBe("IDEMPOTENCY_CONFLICT");
    expect(classifyKnowledgeFailure({ code: "40001" })).toBe("VERSION_CONFLICT");
    expect(classifyKnowledgeFailure({ code: "P0002" })).toBe("NOT_FOUND");
    expect(classifyKnowledgeFailure({ code: "42501" })).toBe("PERMISSION_DENIED");
  });

  it("treats a domain refusal as its own case, not as a permission problem", () => {
    // 55000 arrives in English from the SQL while 42501 is already Vietnamese;
    // collapsing them produces one toast that reads as two different products.
    expect(classifyKnowledgeFailure({ code: "55000" })).toBe("PRECONDITION");
    expect(classifyKnowledgeFailure({ code: "22023" })).toBe("PRECONDITION");
  });

  it("does not guess at anything it does not recognise", () => {
    for (const value of [null, undefined, "boom", new Error("boom"), { code: "XX000" }]) {
      expect(classifyKnowledgeFailure(value)).toBe("UNKNOWN");
    }
  });
});

describe("retrieval preview empty state", () => {
  it("names the missing capability rather than blaming the query", () => {
    // No RPC and no job in this migration set writes openclaw_knowledge_chunks, so a
    // preview is always empty. Copy that blames the search term would send the
    // operator hunting for a better one forever.
    expect(previewEmptyReason({ hasPublishedVersion: true, matchCount: 0 }))
      .toBe("NO_CHUNKS_INGESTED");
    expect(previewEmptyReason({ hasPublishedVersion: false, matchCount: 0 }))
      .toBe("NOT_PUBLISHED");
    expect(previewEmptyReason({ hasPublishedVersion: true, matchCount: 3 })).toBeNull();
  });
});
