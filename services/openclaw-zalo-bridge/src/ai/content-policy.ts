import { applyDlp, type DlpFinding, type KnowledgeChunk } from "./dlp.js";

export type ContentPolicyFailure =
  | "EMPTY"
  | "TOO_LONG"
  | "DLP_BLOCKED"
  | "RESTRICTED_SOURCE";

export interface ContentPolicyResult {
  ok: boolean;
  failure?: ContentPolicyFailure;
  findings?: DlpFinding[];
}

export const MAX_GENERATED_CODE_POINTS = 4_000;

/** The deterministic final gate before generated text may create an outbox intent. */
export function evaluateGeneratedContent({
  text,
  sourceChunks,
  allowedUrlHosts = [],
  authorizedContext = [],
}: {
  text: string;
  sourceChunks: readonly KnowledgeChunk[];
  allowedUrlHosts?: readonly string[];
  authorizedContext?: readonly string[];
}): ContentPolicyResult {
  if (text.trim().length === 0) return { ok: false, failure: "EMPTY" };
  if (Array.from(text).length > MAX_GENERATED_CODE_POINTS) {
    return { ok: false, failure: "TOO_LONG" };
  }
  if (sourceChunks.some((chunk) => chunk.sensitivity === "RESTRICTED")) {
    return { ok: false, failure: "RESTRICTED_SOURCE" };
  }
  const dlp = applyDlp(text, allowedUrlHosts, authorizedContext);
  if (!dlp.ok) return { ok: false, failure: "DLP_BLOCKED", findings: dlp.findings };
  return { ok: true };
}
