import { createHash } from "node:crypto";

import {
  applyDlp,
  evaluateGeneratedContent,
  type DlpFinding,
  type KnowledgeChunk,
} from "../ai/dlp.js";
import { promptCanaryForRequest } from "../ai/cell-agent-client.js";
import { buildRetrievalContext, type VersionedKnowledgeChunk } from "../ai/retrieval-context.js";
import { chunkByCodePoints } from "../outbox/pre-dispatch.js";
import {
  hashCanonicalSendPayload,
  parseOpenClawSendWorkClaimV1,
  snapshotCanonicalSendPayload,
  type CanonicalSendPayloadV1,
  type OpenClawChannelWorkCompletionRequestV1,
  type OpenClawCreateOutboxRequestV1,
  type OpenClawSendWorkClaimV1,
  type OpenClawWorkCompletionEvidenceV1,
} from "../runtime-api/schemas.js";
import { canonicalJson } from "../spool/checksum.js";

export const SEND_WORK_COMPLETION_DOMAIN = "ihome-openclaw-send-work-completion-v1\0";
export const HUMAN_DRAFT_DOMAIN = "ihome-openclaw-human-draft-v1\0";
export const WORK_FAILURE_DOMAIN = "ihome-openclaw-work-failure-v1\0";
const REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
const MAX_DRAFT_CODE_POINTS = 8_000;
const MIN_AUTO_REPLY_CONFIDENCE = 0.9;
const SENSITIVE_INPUT_REVIEW_PLACEHOLDER = "[REDACTED_SENSITIVE_INPUT_REQUIRES_MANUAL_REVIEW]";

export function workEvidenceHash(evidence: unknown): string {
  return createHash("sha256")
    .update(SEND_WORK_COMPLETION_DOMAIN, "utf8")
    .update(canonicalJson(evidence), "utf8")
    .digest("hex");
}

export function completeWorkRequest(
  claim: OpenClawSendWorkClaimV1,
  evidence: Exclude<OpenClawWorkCompletionEvidenceV1, { evidenceKind: "WORK_FAILURE" }>,
): OpenClawChannelWorkCompletionRequestV1 {
  return {
    version: 1,
    workItemId: claim.workItemId,
    organizationId: claim.organizationId,
    accountId: claim.accountId,
    cellId: claim.cellId,
    credentialGeneration: claim.credentialGeneration,
    leaseGeneration: claim.leaseGeneration,
    claimToken: claim.claimToken,
    claimGeneration: claim.claimGeneration,
    fencingToken: claim.fencingToken,
    outcome: "COMPLETE",
    evidence,
    evidenceHash: workEvidenceHash(evidence),
    retryAfterSeconds: null,
  };
}

export function retryWorkRequest(
  claim: OpenClawSendWorkClaimV1,
  error: unknown,
): OpenClawChannelWorkCompletionRequestV1 {
  const candidate = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : {};
  const fingerprintInput = {
    name: typeof candidate.name === "string" && candidate.name.length > 0
      ? candidate.name.slice(0, 128)
      : "Error",
    code: typeof candidate.code === "string" && candidate.code.length > 0
      ? candidate.code.slice(0, 128)
      : null,
  };
  const evidence: Extract<OpenClawWorkCompletionEvidenceV1, { evidenceKind: "WORK_FAILURE" }> = {
    version: 1,
    evidenceKind: "WORK_FAILURE",
    reasonCode: "WORK_HANDLER_FAILED",
    failureFingerprint: createHash("sha256")
      .update(WORK_FAILURE_DOMAIN, "utf8")
      .update(canonicalJson(fingerprintInput), "utf8")
      .digest("hex"),
  };
  return {
    version: 1,
    workItemId: claim.workItemId,
    organizationId: claim.organizationId,
    accountId: claim.accountId,
    cellId: claim.cellId,
    credentialGeneration: claim.credentialGeneration,
    leaseGeneration: claim.leaseGeneration,
    claimToken: claim.claimToken,
    claimGeneration: claim.claimGeneration,
    fencingToken: claim.fencingToken,
    outcome: "RETRY",
    evidence,
    evidenceHash: workEvidenceHash(evidence),
    retryAfterSeconds: 30,
  };
}

function normalizedReasonCode(reasonCode: string): string {
  if (!REASON_CODE.test(reasonCode)) throw new TypeError("work completion reason code is invalid");
  return reasonCode;
}

export function noSendEvidence(
  reasonCode: string,
): Extract<OpenClawWorkCompletionEvidenceV1, { evidenceKind: "NO_SEND" }> {
  return { version: 1, evidenceKind: "NO_SEND", reasonCode: normalizedReasonCode(reasonCode) };
}

function persistedDraftText(value: string): string {
  const bounded = [...value].slice(0, MAX_DRAFT_CODE_POINTS).join("");
  return bounded.length === 0 ? "[REDACTED]" : bounded;
}

function normalizedGroundingText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("vi-VN");
}

function hasExtractiveGrounding(draftText: string, sourceChunks: readonly KnowledgeChunk[]): boolean {
  const draft = normalizedGroundingText(draftText);
  return draft.length > 0 && sourceChunks.some((chunk) =>
    normalizedGroundingText(chunk.text).includes(draft)
  );
}

export function humanDraftEvidence(input: {
  reasonCode: string;
  classification: string | null;
  confidence: number | null;
  findings: readonly DlpFinding[];
  draftText: string;
}): Extract<OpenClawWorkCompletionEvidenceV1, { evidenceKind: "HUMAN_DRAFT" }> {
  if (input.classification !== null && input.classification.length === 0) {
    throw new TypeError("human draft classification is invalid");
  }
  if (input.confidence !== null && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new TypeError("human draft confidence is invalid");
  }
  const draftText = persistedDraftText(input.draftText);
  return {
    version: 1,
    evidenceKind: "HUMAN_DRAFT",
    reasonCode: normalizedReasonCode(input.reasonCode),
    classification: input.classification,
    confidenceBasisPoints: input.confidence === null ? null : Math.round(input.confidence * 10_000),
    findings: [...new Set(input.findings)].sort(),
    draftText,
    draftHash: createHash("sha256").update(HUMAN_DRAFT_DOMAIN, "utf8").update(draftText, "utf8").digest("hex"),
  };
}

export function payloadWithText(
  base: CanonicalSendPayloadV1,
  text: string,
): CanonicalSendPayloadV1 {
  const parts = chunkByCodePoints(text).map((chunk, partIndex) => ({
    version: 1 as const,
    partIndex,
    kind: "TEXT" as const,
    text: chunk,
  }));
  if (parts.length === 0) throw new TypeError("generated payload is empty");
  return snapshotCanonicalSendPayload({ ...base, parts });
}

export interface InboundFrozenContext {
  customerText: string;
  knowledgeChunks: VersionedKnowledgeChunk[];
  canonicalPayload: CanonicalSendPayloadV1;
  sourceSnapshotHash: string;
}

interface InboundDependencies {
  loadFrozenContext(claim: OpenClawSendWorkClaimV1): Promise<InboundFrozenContext>;
  recheckCurrentState(
    claim: OpenClawSendWorkClaimV1,
  ): Promise<{ allowed: true } | { allowed: false; reasonCode: string }>;
  agent: {
    classifyAndDraft(input: {
      requestId: string;
      customerText: string;
      context: Array<{ chunkId: string; text: string }>;
      purpose: "CUSTOMER_FACING";
    }): Promise<{
      version: 1;
      classification: string;
      disposition: "AUTO_REPLY" | "HUMAN_DRAFT" | "NO_SEND";
      draftText: string;
      confidence: number;
      knowledgeChunkIds: string[];
    }>;
  };
  createOutbox(request: OpenClawCreateOutboxRequestV1): Promise<unknown>;
  completeWork(request: OpenClawChannelWorkCompletionRequestV1): Promise<unknown>;
  allowedUrlHosts: readonly string[];
  knownSecretValues?: readonly string[];
}

function assertInboundLineage(
  claim: OpenClawSendWorkClaimV1 & { payload: Extract<OpenClawSendWorkClaimV1["payload"], { kind: "INBOUND_AUTOMATION" }> },
  context: InboundFrozenContext,
): CanonicalSendPayloadV1 {
  if (context.sourceSnapshotHash !== claim.payload.eligibilityDecisionHash) {
    throw new TypeError("inbound frozen source hash mismatch");
  }
  const base: CanonicalSendPayloadV1 = {
    ...context.canonicalPayload,
    automationVersionId: claim.payload.automationVersionId,
    templateVersionId: claim.payload.templateVersionId ?? null,
    frozenInputs: {
      ...context.canonicalPayload.frozenInputs,
      campaignVersionId: null,
      scheduleVersion: null,
      subscriptionVersion: null,
      subscriptionId: null,
      occurrenceId: null,
      sourceTable: null,
      sourceId: null,
      sourceVersion: null,
      knowledgeVersionIds: [...claim.payload.knowledgeVersionIds],
      sourceSnapshotHash: context.sourceSnapshotHash,
      targetVersion: claim.payload.targetVersion,
      targetDirectoryRefreshedAt: claim.payload.targetDirectoryRefreshedAt,
      fieldMappingHash: null,
    },
  };
  return base;
}

export async function runInboundAutomation(
  claimValue: OpenClawSendWorkClaimV1,
  dependencies: InboundDependencies,
): Promise<unknown> {
  const claim = parseOpenClawSendWorkClaimV1(claimValue);
  if (claim.payload.kind !== "INBOUND_AUTOMATION") {
    throw new TypeError("inbound runner received the wrong work kind");
  }
  const typedClaim = claim as OpenClawSendWorkClaimV1 & {
    payload: Extract<OpenClawSendWorkClaimV1["payload"], { kind: "INBOUND_AUTOMATION" }>;
  };
  const current = await dependencies.recheckCurrentState(claim);
  if (!current.allowed) {
    return await dependencies.completeWork(completeWorkRequest(claim, noSendEvidence(current.reasonCode)));
  }

  const context = await dependencies.loadFrozenContext(claim);
  const basePayload = assertInboundLineage(typedClaim, context);
  const retrieval = buildRetrievalContext({
    purpose: "CUSTOMER_FACING",
    frozenKnowledgeVersionIds: claim.payload.knowledgeVersionIds,
    chunks: context.knowledgeChunks,
  });
  const forbiddenExactValues = [
    ...(dependencies.knownSecretValues ?? []),
    promptCanaryForRequest(claim.workItemId),
  ];
  const customerDlp = applyDlp(
    context.customerText,
    dependencies.allowedUrlHosts,
    [],
    forbiddenExactValues,
    false,
  );
  const customerContainsPromptCanary = context.customerText.includes(
    promptCanaryForRequest(claim.workItemId),
  );
  if (customerDlp.findings.includes("CREDENTIAL") || customerContainsPromptCanary) {
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: customerContainsPromptCanary ? "PROMPT_INJECTION_RISK" : "DLP_BLOCKED",
      classification: null,
      confidence: null,
      findings: customerDlp.findings,
      draftText: SENSITIVE_INPUT_REVIEW_PLACEHOLDER,
    })));
  }
  const customerPromptInjectionRisk = customerDlp.findings.some((finding) =>
    finding === "PROMPT_LEAKAGE" || finding === "INTERNAL_ONLY"
  );
  const retrievalDlp = applyDlp(
    retrieval.map((chunk) => chunk.text).join("\n"),
    dependencies.allowedUrlHosts,
    [context.customerText],
    forbiddenExactValues,
    true,
  );
  if (!retrievalDlp.ok) {
    const hasPromptBoundaryFinding = retrievalDlp.findings.some((finding) =>
      finding === "PROMPT_LEAKAGE" || finding === "INTERNAL_ONLY"
    );
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: hasPromptBoundaryFinding ? "PROMPT_INJECTION_RISK" : "DLP_BLOCKED",
      classification: null,
      confidence: null,
      findings: retrievalDlp.findings,
      draftText: SENSITIVE_INPUT_REVIEW_PLACEHOLDER,
    })));
  }
  const result = await dependencies.agent.classifyAndDraft({
    requestId: claim.workItemId,
    customerText: context.customerText,
    context: retrieval,
    purpose: "CUSTOMER_FACING",
  });
  const promptChunkIds = new Set(retrieval.map((chunk) => chunk.chunkId));
  const hasUnknownKnowledgeReference = result.knowledgeChunkIds.some(
    (chunkId) => !promptChunkIds.has(chunkId),
  );
  const draftDlp = applyDlp(
    result.draftText,
    dependencies.allowedUrlHosts,
    [context.customerText],
    forbiddenExactValues,
    true,
  );
  if (hasUnknownKnowledgeReference) {
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: "AI_KNOWLEDGE_REFERENCE_INVALID",
      classification: result.classification,
      confidence: result.confidence,
      findings: draftDlp.findings,
      draftText: draftDlp.redacted,
    })));
  }
  if (result.disposition === "NO_SEND") {
    return await dependencies.completeWork(completeWorkRequest(
      claim,
      noSendEvidence(draftDlp.ok ? "AI_NO_SEND" : "DLP_BLOCKED"),
    ));
  }
  if (result.disposition === "HUMAN_DRAFT") {
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: !draftDlp.ok
        ? "DLP_BLOCKED"
        : customerPromptInjectionRisk ? "PROMPT_INJECTION_RISK" : "AI_REVIEW_REQUIRED",
      classification: result.classification,
      confidence: result.confidence,
      findings: draftDlp.findings,
      draftText: draftDlp.redacted,
    })));
  }
  if (
    result.classification !== "CUSTOMER_SUPPORT" ||
    result.confidence < MIN_AUTO_REPLY_CONFIDENCE
  ) {
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: !draftDlp.ok
        ? "DLP_BLOCKED"
        : customerPromptInjectionRisk ? "PROMPT_INJECTION_RISK" : "AI_REVIEW_REQUIRED",
      classification: result.classification,
      confidence: result.confidence,
      findings: draftDlp.findings,
      draftText: draftDlp.redacted,
    })));
  }
  if (!draftDlp.ok) {
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: "DLP_BLOCKED",
      classification: result.classification,
      confidence: result.confidence,
      findings: draftDlp.findings,
      draftText: draftDlp.redacted,
    })));
  }
  if (customerPromptInjectionRisk) {
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: "PROMPT_INJECTION_RISK",
      classification: result.classification,
      confidence: result.confidence,
      findings: customerDlp.findings,
      draftText: result.draftText,
    })));
  }

  const sourceChunks: KnowledgeChunk[] = context.knowledgeChunks
    .filter((chunk) => result.knowledgeChunkIds.includes(chunk.chunkId))
    .map(({ chunkId, sensitivity, text }) => ({ chunkId, sensitivity, text }));
  if (
    result.knowledgeChunkIds.length === 0 ||
    sourceChunks.length === 0 ||
    sourceChunks.some((chunk) => chunk.sensitivity !== "CUSTOMER_SAFE") ||
    !hasExtractiveGrounding(result.draftText, sourceChunks)
  ) {
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: "AI_GROUNDING_REQUIRED",
      classification: result.classification,
      confidence: result.confidence,
      findings: [],
      draftText: result.draftText,
    })));
  }
  const policy = evaluateGeneratedContent({
    text: result.draftText,
    sourceChunks,
    allowedUrlHosts: dependencies.allowedUrlHosts,
    authorizedContext: [context.customerText],
  });
  if (!policy.ok) {
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: policy.failure ?? "CONTENT_POLICY_BLOCKED",
      classification: result.classification,
      confidence: result.confidence,
      findings: policy.findings ?? [],
      draftText: draftDlp.redacted,
    })));
  }

  const canonicalPayload = payloadWithText(basePayload, result.draftText);
  const request: OpenClawCreateOutboxRequestV1 = {
    version: 1,
    principalKind: "CHANNEL",
    claim,
    canonicalPayload,
    payloadHash: hashCanonicalSendPayload(canonicalPayload),
    sourceSnapshotHash: context.sourceSnapshotHash,
  };
  return await dependencies.createOutbox(request);
}
