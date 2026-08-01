import { applyDlp, evaluateGeneratedContent } from "../ai/dlp.js";
import { hashCanonicalSendPayload, parseOpenClawSendWorkClaimV1, snapshotCanonicalSendPayload, type CanonicalSendPayloadV1, type OpenClawCreateOutboxRequestV1, type OpenClawSendWorkClaimV1 } from "../runtime-api/schemas.js";
import { canonicalJson } from "../spool/checksum.js";
import { renderTemplate, type TemplateField } from "./template-renderer.js";
import {
  completeWorkRequest,
  humanDraftEvidence,
  noSendEvidence,
  payloadWithText,
} from "./inbound-automation-runner.js";

export async function runScheduleOccurrence(
  claimValue: OpenClawSendWorkClaimV1,
  dependencies: {
    loadFrozenSchedule(payload: Extract<OpenClawSendWorkClaimV1["payload"], { kind: "SCHEDULE_OCCURRENCE" }>): Promise<{
      frozenIdentity: unknown;
      template: string;
      values: Partial<Record<TemplateField, string>>;
      requiredFields: TemplateField[];
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
  if (claim.payload.kind !== "SCHEDULE_OCCURRENCE") throw new TypeError("schedule runner received wrong work kind");
  const current = await dependencies.recheckCurrentState(claim);
  if (!current.allowed) {
    return await dependencies.completeWork(completeWorkRequest(claim, noSendEvidence(current.reasonCode)));
  }
  const frozen = await dependencies.loadFrozenSchedule(claim.payload);
  if (canonicalJson(frozen.frozenIdentity) !== canonicalJson(claim.payload)) {
    throw new TypeError("schedule frozen identity mismatch");
  }
  const rendered = renderTemplate({ template: frozen.template, values: frozen.values, requiredFields: frozen.requiredFields });
  if (!rendered.ok || rendered.text === undefined) {
    return await dependencies.completeWork(completeWorkRequest(
      claim,
      noSendEvidence(rendered.failure ?? "TEMPLATE_INVALID"),
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
    templateVersionId: claim.payload.templateVersionId,
    frozenInputs: {
      ...frozen.canonicalPayload.frozenInputs,
      campaignVersionId: claim.payload.campaignVersionId,
      scheduleVersion: claim.payload.scheduleVersion,
      subscriptionVersion: null,
      subscriptionId: null,
      occurrenceId: claim.payload.occurrenceId,
      sourceTable: "openclaw_schedule_snapshots",
      sourceId: claim.payload.scheduleId,
      sourceVersion: String(claim.payload.scheduleVersion),
      knowledgeVersionIds: [...claim.payload.knowledgeVersionIds],
      sourceSnapshotHash: frozen.sourceSnapshotHash,
      targetVersion: claim.payload.targetVersion,
      targetDirectoryRefreshedAt: claim.payload.targetDirectoryRefreshedAt,
      fieldMappingHash: null,
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
