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
  | "PROMPT_LEAKAGE"
  | "INTERNAL_ONLY"
  | "CROSS_CUSTOMER_PII"
  | "URL_NOT_ALLOWED"
  | "CONTROL_CHARACTERS";

export interface DlpResult {
  ok: boolean;
  findings: DlpFinding[];
  redacted: string;
}

const SECRET_RULES: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gi,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi,
  /(?<![\w])["']?(?:password|passphrase|client[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|private[_-]?key|credential|secret|token)["']?\s*[:=]\s*(?:["'][^"'\r\n]*["']|[^\s,}\]\r\n]+)/gi,
  /\b(?:sk|rk|pk|sb_secret|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi,
];

const PROMPT_LEAKAGE = /\b(?:system\s+prompt|developer\s+message|hidden\s+instructions?|ignore\s+(?:all\s+)?previous\s+instructions?|internal\s+policy)\b/gi;
const INTERNAL_ONLY = /\b(?:INTERNAL_REVIEW_ONLY|RESTRICTED|internal[-\s]+only)\b/gi;
const PHONE_CANDIDATE = /(?<![\w])(?:\((?:\+?84|0)(?:[ \t\u00a0.\/-]?\d){2,3}\)|(?:\+?84|0))(?:[ \t\u00a0.\/-]?\d){6,10}(?![\w]|[ \t\u00a0.\/-]?\d)/g;
const NORMALIZED_VIETNAMESE_PHONE = /^(?:\+84|0)\d{8,10}$/u;

function normalizedPhone(value: string): string | null {
  const normalized = value.replace(/[() \t\u00a0.\/-]/g, "");
  return NORMALIZED_VIETNAMESE_PHONE.test(normalized) ? normalized : null;
}

const PII_RULES: Array<{ finding: DlpFinding; pattern: RegExp; replacement: string }> = [
  {
    finding: "EMAIL",
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    finding: "NATIONAL_ID",
    pattern: /(?<![\d])(?:\d[ .-]?){11}\d(?![ .-]?\d)/g,
    replacement: "[REDACTED_ID]",
  },
  {
    finding: "BANK_ACCOUNT",
    pattern: /(?<![\d])(?:\d[ .-]?){8,10}\d(?![ .-]?\d)/g,
    replacement: "[REDACTED_ACCOUNT]",
  },
];

/**
 * Deterministic by construction: the same input always yields the same findings
 * and the same redacted text, so a review decision is reproducible.
 */
export function applyDlp(
  text: string,
  allowedUrlHosts: readonly string[] = [],
  authorizedContext: readonly string[] = [],
  forbiddenExactValues: readonly string[] = [],
  crossCustomerBoundary = authorizedContext.length > 0,
): DlpResult {
  const findings = new Set<DlpFinding>();
  let redacted = text;
  const authorizedText = authorizedContext.join("\n").toLocaleLowerCase("en-US");

  const hasForbiddenControl = (character: string) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 8 || codePoint === 11 || codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) || codePoint === 127;
  };
  if ([...text].some(hasForbiddenControl)) {
    findings.add("CONTROL_CHARACTERS");
    redacted = [...redacted].filter((character) => !hasForbiddenControl(character)).join("");
  }

  const exactCanaries = [...new Set(forbiddenExactValues)]
    .filter((value) => value.length >= 8)
    .sort((left, right) => right.length - left.length);
  for (const canary of exactCanaries) {
    if (!redacted.includes(canary)) continue;
    findings.add(canary.startsWith("OPENCLAW_PROMPT_CANARY_") ? "PROMPT_LEAKAGE" : "CREDENTIAL");
    redacted = redacted.split(canary).join("[REDACTED]");
  }

  for (const pattern of SECRET_RULES) {
    redacted = redacted.replace(pattern, () => {
      findings.add("CREDENTIAL");
      return "[REDACTED]";
    });
    pattern.lastIndex = 0;
  }
  redacted = redacted.replace(PROMPT_LEAKAGE, () => {
    findings.add("PROMPT_LEAKAGE");
    return "[REDACTED_PROMPT]";
  });
  PROMPT_LEAKAGE.lastIndex = 0;
  redacted = redacted.replace(INTERNAL_ONLY, () => {
    findings.add("INTERNAL_ONLY");
    return "[REDACTED_INTERNAL]";
  });
  INTERNAL_ONLY.lastIndex = 0;

  const authorizedPhones = new Set<string>();
  for (const value of authorizedContext) {
    for (const match of value.matchAll(new RegExp(PHONE_CANDIDATE.source, PHONE_CANDIDATE.flags))) {
      const normalized = normalizedPhone(match[0]);
      if (normalized !== null) authorizedPhones.add(normalized);
    }
  }
  redacted = redacted.replace(PHONE_CANDIDATE, (match) => {
    const normalized = normalizedPhone(match);
    if (normalized === null) return match;
    if (authorizedPhones.has(normalized)) return match;
    findings.add("PHONE_NUMBER");
    if (crossCustomerBoundary) findings.add("CROSS_CUSTOMER_PII");
    return "[REDACTED_PHONE]";
  });
  PHONE_CANDIDATE.lastIndex = 0;

  for (const rule of PII_RULES) {
    redacted = redacted.replace(rule.pattern, (match) => {
      if (authorizedText.includes(String(match).toLocaleLowerCase("en-US"))) return String(match);
      findings.add(rule.finding);
      if (crossCustomerBoundary) findings.add("CROSS_CUSTOMER_PII");
      return rule.replacement;
    });
    rule.pattern.lastIndex = 0;
  }

  const allowedHost = (host: string) => allowedUrlHosts.some((entry) => {
    const normalized = entry.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });
  const replaceBlockedUrls = (
    pattern: RegExp,
    isAllowed: (match: RegExpMatchArray) => boolean,
  ) => {
    redacted = redacted.replace(pattern, (...args: unknown[]) => {
      const match = args.slice(0, -2) as unknown as RegExpMatchArray;
      if (isAllowed(match)) return match[0] ?? "";
      findings.add("URL_NOT_ALLOWED");
      return "[REDACTED_URL]";
    });
  };
  replaceBlockedUrls(
    /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#]+)[^\s]*/gi,
    (match) => ["http", "https"].includes((match[1] ?? "").toLowerCase()) &&
      allowedHost((match[2] ?? "").toLowerCase()),
  );
  replaceBlockedUrls(
    /(?<![\w/])\/\/([^\s/?#]+)[^\s]*/gi,
    (match) => allowedHost((match[1] ?? "").toLowerCase()),
  );
  replaceBlockedUrls(
    /(?<![\w/.:-])((?:\d{1,3}\.){3}\d{1,3})(?:\/[^\s]*)?/g,
    (match) => {
      const host = match[1] ?? "";
      return host.split(".").every((octet) => Number(octet) <= 255) && allowedHost(host);
    },
  );
  replaceBlockedUrls(
    /(?<![@\w/.:-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?:\/[^\s]*)?/gi,
    (match) => allowedHost((match[1] ?? "").toLowerCase()),
  );

  return { ok: findings.size === 0, findings: [...findings].sort(), redacted };
}

export {
  evaluateGeneratedContent,
  MAX_GENERATED_CODE_POINTS,
  type ContentPolicyFailure,
  type ContentPolicyResult,
} from "./content-policy.js";
