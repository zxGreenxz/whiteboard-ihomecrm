/**
 * Knowledge sensitivity and deterministic DLP.
 *
 * The rule the tests enforce: only CUSTOMER_SAFE material may enter a
 * customer-facing prompt. INTERNAL_REVIEW_ONLY may inform a draft a human will
 * read before sending. RESTRICTED never enters outbound generation at all.
 */

export type Sensitivity = "CUSTOMER_SAFE" | "INTERNAL_REVIEW_ONLY" | "RESTRICTED";

export type PromptPurpose = "CUSTOMER_FACING" | "HUMAN_DRAFT_REVIEW";

export interface KnowledgeChunk {
  chunkId: string;
  sensitivity: Sensitivity;
  text: string;
}

export function selectChunksForPrompt(
  chunks: readonly KnowledgeChunk[],
  purpose: PromptPurpose,
): KnowledgeChunk[] {
  return chunks.filter((chunk) => {
    // RESTRICTED is excluded first and unconditionally, for every purpose.
    if (chunk.sensitivity === "RESTRICTED") return false;
    return purpose === "CUSTOMER_FACING" ? chunk.sensitivity === "CUSTOMER_SAFE" : true;
  });
}

export type DlpFinding =
  | "PHONE_NUMBER"
  | "EMAIL"
  | "NATIONAL_ID"
  | "BANK_ACCOUNT"
  | "CREDENTIAL"
  | "URL_NOT_ALLOWED"
  | "CONTROL_CHARACTERS";

export interface DlpResult {
  ok: boolean;
  findings: DlpFinding[];
  redacted: string;
}

const DLP_RULES: Array<{ finding: DlpFinding; pattern: RegExp; replacement: string }> = [
  {
    finding: "CREDENTIAL",
    pattern: /\b(?:password|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
    replacement: "[REDACTED]",
  },
  {
    finding: "EMAIL",
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    finding: "NATIONAL_ID",
    pattern: /(?<![\d])\d{12}(?![\d])/g,
    replacement: "[REDACTED_ID]",
  },
  // Phone numbers are matched before the generic account rule: a Vietnamese
  // mobile number also matches the 9-11 digit account shape, and reporting it
  // as an account would understate what leaked.
  {
    finding: "PHONE_NUMBER",
    pattern: /(?<![\w])(?:\+?84|0)\d{8,10}(?![\w])/g,
    replacement: "[REDACTED_PHONE]",
  },
  {
    finding: "BANK_ACCOUNT",
    pattern: /(?<![\d])\d{9,11}(?![\d])/g,
    replacement: "[REDACTED_ACCOUNT]",
  },
];

/**
 * Deterministic by construction: the same input always yields the same findings
 * and the same redacted text, so a review decision is reproducible.
 */
export function applyDlp(text: string, allowedUrlHosts: readonly string[] = []): DlpResult {
  const findings = new Set<DlpFinding>();
  let redacted = text;

  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    findings.add("CONTROL_CHARACTERS");
    redacted = redacted.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  }

  for (const rule of DLP_RULES) {
    if (rule.pattern.test(redacted)) {
      findings.add(rule.finding);
      redacted = redacted.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
    }
    rule.pattern.lastIndex = 0;
  }

  for (const match of redacted.matchAll(/https?:\/\/([^\s/]+)/gi)) {
    const host = (match[1] ?? "").toLowerCase();
    const allowed = allowedUrlHosts.some(
      (entry) => host === entry || host.endsWith(`.${entry}`),
    );
    if (!allowed) {
      findings.add("URL_NOT_ALLOWED");
      redacted = redacted.replace(match[0], "[REDACTED_URL]");
    }
  }

  return { ok: findings.size === 0, findings: [...findings].sort(), redacted };
}

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

/**
 * The final gate before an outbox intent may be created from generated text.
 */
export function evaluateGeneratedContent({
  text,
  sourceChunks,
  allowedUrlHosts = [],
}: {
  text: string;
  sourceChunks: readonly KnowledgeChunk[];
  allowedUrlHosts?: readonly string[];
}): ContentPolicyResult {
  if (text.trim().length === 0) return { ok: false, failure: "EMPTY" };
  if (Array.from(text).length > MAX_GENERATED_CODE_POINTS) {
    return { ok: false, failure: "TOO_LONG" };
  }
  if (sourceChunks.some((chunk) => chunk.sensitivity === "RESTRICTED")) {
    return { ok: false, failure: "RESTRICTED_SOURCE" };
  }
  const dlp = applyDlp(text, allowedUrlHosts);
  if (!dlp.ok) return { ok: false, failure: "DLP_BLOCKED", findings: dlp.findings };
  return { ok: true };
}