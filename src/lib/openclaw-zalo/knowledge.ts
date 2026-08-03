import type { KnowledgeSensitivity } from "./types";

export type KnowledgeLifecycle = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface KnowledgeSourceView {
  sourceId: string;
  title: string;
  sourceKind: string;
  sensitivity: KnowledgeSensitivity;
  lifecycleState: KnowledgeLifecycle;
  currentVersion: number;
  contentHash: string | null;
  /** Non-null once the validate step has recorded a result for the current draft. */
  validationResult: unknown;
}

export type KnowledgeAction = "edit" | "validate" | "publish" | "archive";

export interface KnowledgeActionState {
  enabled: boolean;
  /** Why not, in a form the UI can turn into copy. Null when enabled. */
  blockedBy: "PERMISSION" | "LIFECYCLE" | "NOT_VALIDATED" | null;
}

export interface KnowledgeActionInput {
  canManage: boolean;
  lifecycleState: KnowledgeLifecycle;
  hasValidationResult: boolean;
}

/**
 * Which knowledge actions are offerable, mirroring the server - plus ONE gate the
 * server does not have.
 *
 * `openclaw_update_knowledge_draft_v1` has no lifecycle check: handed an ARCHIVED
 * source it happily writes a new DRAFT version and moves the source back to DRAFT.
 * Nothing downstream expects that, so Edit is withheld here rather than left to
 * produce a silent resurrection. Where the client is STRICTER than the server, say
 * so - the alternative is a control that works and should not.
 */
export function knowledgeActions(input: KnowledgeActionInput): Record<KnowledgeAction, KnowledgeActionState> {
  const permission = (): KnowledgeActionState => ({ enabled: false, blockedBy: "PERMISSION" });
  if (!input.canManage) {
    return { edit: permission(), validate: permission(), publish: permission(), archive: permission() };
  }
  const isDraft = input.lifecycleState === "DRAFT";
  return {
    // Stricter than the server on purpose - see above.
    edit: isDraft || input.lifecycleState === "PUBLISHED"
      ? { enabled: true, blockedBy: null }
      : { enabled: false, blockedBy: "LIFECYCLE" },
    validate: isDraft
      ? { enabled: true, blockedBy: null }
      : { enabled: false, blockedBy: "LIFECYCLE" },
    // The server refuses publish with 55000 unless the current version is a DRAFT
    // carrying a validation result, so offering it earlier only buys an error.
    publish: !isDraft
      ? { enabled: false, blockedBy: "LIFECYCLE" }
      : input.hasValidationResult
        ? { enabled: true, blockedBy: null }
        : { enabled: false, blockedBy: "NOT_VALIDATED" },
    archive: input.lifecycleState === "ARCHIVED"
      ? { enabled: false, blockedBy: "LIFECYCLE" }
      : { enabled: true, blockedBy: null },
  };
}

export type KnowledgeFailure =
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "PRECONDITION"
  | "UNKNOWN";

/**
 * Sorts the four distinct things a knowledge write can do when it does not succeed.
 *
 * They need different words because they need different actions from the operator,
 * and only one of them is an exception at all:
 *
 *  - `{conflict: true}` arrives as a NORMAL 200 body. The client operation id was
 *    reused with a different request; mint a new one and retry.
 *  - 40001 means someone else moved the source. Reload and retry with the version
 *    that is now current.
 *  - P0002 comes from a `select ... into strict` and carries no message: the id is
 *    gone, or was never in this organization. Refetch the list.
 *  - 42501 is a real permission refusal, and its message is already Vietnamese.
 *
 * Domain refusals (55000) arrive in English from the SQL, which is why they are
 * mapped rather than shown raw - one toast reading half Vietnamese and half English
 * reads as two different products.
 */
export function classifyKnowledgeFailure(error: unknown): KnowledgeFailure {
  if (error !== null && typeof error === "object") {
    const conflict = (error as { conflict?: unknown }).conflict;
    if (conflict === true) return "IDEMPOTENCY_CONFLICT";
    const code = (error as { code?: unknown }).code;
    if (code === "40001") return "VERSION_CONFLICT";
    if (code === "P0002" || code === "02000") return "NOT_FOUND";
    if (code === "42501") return "PERMISSION_DENIED";
    if (code === "55000" || code === "22023") return "PRECONDITION";
  }
  return "UNKNOWN";
}

/**
 * Whether a retrieval preview returning nothing means "no match" or "nothing to
 * match against".
 *
 * There is no ingestion path in this migration set: no RPC and no job writes
 * `openclaw_knowledge_chunks`. A preview will therefore always come back empty, and
 * empty-state copy blaming the query would send the operator hunting for a better
 * search term forever.
 */
export function previewEmptyReason(input: {
  hasPublishedVersion: boolean;
  matchCount: number;
}): "NO_CHUNKS_INGESTED" | "NOT_PUBLISHED" | null {
  if (input.matchCount > 0) return null;
  return input.hasPublishedVersion ? "NO_CHUNKS_INGESTED" : "NOT_PUBLISHED";
}
