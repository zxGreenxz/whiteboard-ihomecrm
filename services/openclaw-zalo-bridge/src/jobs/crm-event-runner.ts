import { applyDlp, evaluateGeneratedContent } from "../ai/dlp.js";
import { hashCanonicalSendPayload, parseOpenClawSendWorkClaimV1, snapshotCanonicalSendPayload, type CanonicalSendPayloadV1, type OpenClawCreateOutboxRequestV1, type OpenClawSendWorkClaimV1 } from "../runtime-api/schemas.js";
import { canonicalJson, payloadChecksum } from "../spool/checksum.js";
import {
  completeWorkRequest,
  humanDraftEvidence,
  noSendEvidence,
  payloadWithText,
} from "./inbound-automation-runner.js";
import { renderTemplate, type TemplateField } from "./template-renderer.js";

export async function runCrmEvent(
  claimValue: OpenClawSendWorkClaimV1,
  dependencies: {
    loadFrozenCrmEvent(payload: Extract<OpenClawSendWorkClaimV1["payload"], { kind: "CRM_EVENT" }>): Promise<{
      frozenIdentity: unknown;
      template: string;
      values: Partial<Record<TemplateField, string>>;
      requiredFields: TemplateField[];
      allowedCrmFields: TemplateField[];
      canonicalPayload: CanonicalSendPayloadV1;
      sourceSnapshotHash: string;
    }>;
    recheckCurrentState(claim: OpenClawSendWorkClaimV1): Promise<{ allowed: true } | { allowed: false; reasonCode: string }>;
    createOutbox(request: OpenClawCreateOutboxRequestV1): Promise<unknown>;
    completeWork(request: ReturnType<typeof completeWorkRequest>): Promise<unknown>;
    allowedUrlHosts?: readonly string[];
  },
) {
  const claim = parseOpenClawSendWorkClaimV1(claimValue);
  if (claim.payload.kind !== "CRM_EVENT") throw new TypeError("CRM runner received wrong work kind");
  const current = await dependencies.recheckCurrentState(claim);
  if (!current.allowed) {
    return await dependencies.completeWork(completeWorkRequest(claim, noSendEvidence(current.reasonCode)));
  }
  const frozen = await dependencies.loadFrozenCrmEvent(claim.payload);
  if (
    canonicalJson(frozen.frozenIdentity) !== canonicalJson(claim.payload) ||
    payloadChecksum(claim.payload.sourceEnvelope) !== claim.payload.sourceEnvelopeHash
  ) {
    throw new TypeError("CRM frozen identity mismatch");
  }
  const allowedCrmFields = new Set<TemplateField>(frozen.allowedCrmFields);
  if (
    Object.keys(frozen.values).some((field) => !allowedCrmFields.has(field as TemplateField)) ||
    frozen.requiredFields.some((field) => !allowedCrmFields.has(field))
  ) {
    return await dependencies.completeWork(completeWorkRequest(
      claim,
      noSendEvidence("CRM_FIELD_NOT_ALLOWED"),
    ));
  }
  const rendered = renderTemplate({
    template: frozen.template,
    values: frozen.values,
    requiredFields: frozen.requiredFields,
    allowedFields: frozen.allowedCrmFields,
  });
  if (!rendered.ok || rendered.text === undefined) {
    return await dependencies.completeWork(completeWorkRequest(
      claim,
      noSendEvidence(
        rendered.failure === "FIELD_NOT_ALLOWED"
          ? "CRM_FIELD_NOT_ALLOWED"
          : rendered.failure ?? "TEMPLATE_INVALID",
      ),
    ));
  }
  const policy = evaluateGeneratedContent({
    text: rendered.text,
    sourceChunks: [],
    allowedUrlHosts: dependencies.allowedUrlHosts ?? [],
  });
  if (!policy.ok) {
    const dlp = applyDlp(rendered.text, dependencies.allowedUrlHosts ?? []);
    return await dependencies.completeWork(completeWorkRequest(claim, humanDraftEvidence({
      reasonCode: policy.failure ?? "CONTENT_POLICY_BLOCKED",
      classification: null,
      confidence: null,
      findings: policy.findings ?? [],
      draftText: dlp.redacted,
    })));
  }
  const base: CanonicalSendPayloadV1 = {
    ...frozen.canonicalPayload,
    automationVersionId: claim.payload.automationVersionId,
    templateVersionId: claim.payload.templateVersionId ?? null,
    frozenInputs: {
      ...frozen.canonicalPayload.frozenInputs,
      campaignVersionId: claim.payload.campaignVersionId ?? null,
      scheduleVersion: null,
      subscriptionVersion: claim.payload.subscriptionVersion,
      subscriptionId: claim.payload.subscriptionId,
      occurrenceId: claim.payload.occurrenceId,
      sourceTable: claim.payload.sourceEnvelope.sourceTable,
      sourceId: claim.payload.sourceEnvelope.sourceId,
      sourceVersion: claim.payload.sourceEnvelope.sourceVersion,
      knowledgeVersionIds: [...claim.payload.knowledgeVersionIds],
      sourceSnapshotHash: frozen.sourceSnapshotHash,
      targetVersion: claim.payload.targetVersion,
      targetDirectoryRefreshedAt: claim.payload.targetDirectoryRefreshedAt,
      fieldMappingHash: claim.payload.fieldMappingHash,
    },
  };
  const canonicalPayload = payloadWithText(base, rendered.text);
  return await dependencies.createOutbox({
    version: 1,
    principalKind: "CHANNEL",
    claim,
    canonicalPayload,
    payloadHash: hashCanonicalSendPayload(canonicalPayload),
    sourceSnapshotHash: frozen.sourceSnapshotHash,
  });
}
