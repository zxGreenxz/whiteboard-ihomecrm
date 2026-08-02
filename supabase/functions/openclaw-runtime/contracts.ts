const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const MEDIA_OBJECT_KEY = new RegExp(
  `^v1/org/(${UUID_SOURCE})/account/(${UUID_SOURCE})/conversation/${UUID_SOURCE}` +
    `/message/${UUID_SOURCE}/media/(${UUID_SOURCE})/original$`,
);
const SHA256 = /^[0-9a-f]{64}$/;
const JTI = /^[A-Za-z0-9_-]{16,128}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!object(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function canonicalMediaObjectKey(
  value: unknown,
  organizationId: unknown,
  accountId: unknown,
  mediaId: unknown,
): value is string {
  if (typeof value !== "string") return false;
  const match = MEDIA_OBJECT_KEY.exec(value);
  return match !== null && match[1] === organizationId && match[2] === accountId &&
    match[3] === mediaId;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function boundedString(value: unknown, minimum = 1, maximum = 512): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf());
}

function versionOne(value: unknown): value is Record<string, unknown> {
  return object(value) && value.version === 1;
}

const MARKER_KEYS = [
  "version", "outboxId", "claimGeneration", "payloadHash", "fencingToken",
  "sessionGeneration", "controlVersion", "takeoverVersion", "markerNonce", "expiresAt",
] as const;

function validMarker(value: unknown): value is Record<string, unknown> {
  return exact(value, MARKER_KEYS) && value.version === 1 && uuid(value.outboxId) &&
    integer(value.claimGeneration, 1) && sha256(value.payloadHash) &&
    integer(value.fencingToken, 1) && integer(value.sessionGeneration) &&
    integer(value.controlVersion, 1) && integer(value.takeoverVersion) &&
    boundedString(value.markerNonce, 16, 256) && isoTimestamp(value.expiresAt);
}

function validAuthorization(value: unknown): value is Record<string, unknown> {
  return exact(value, ["version", "claimToken", "authorizationMarker"]) &&
    value.version === 1 && boundedString(value.claimToken, 32, 512) &&
    validMarker(value.authorizationMarker);
}

function sameMarker(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return MARKER_KEYS.every((key) => left[key] === right[key]);
}

const DELIVERY_REASONS = new Set([
  "ALL_PARTS_ACKNOWLEDGED",
  "PROVIDER_REJECTED_BEFORE_ACCEPT",
  "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF",
  "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF",
  "ACK_LOST_AFTER_HANDOFF",
]);

function validDeliveryEvidence(value: unknown): value is Record<string, unknown> {
  if (!exact(value, [
    "version", "evidenceKind", "outboxId", "claimGeneration", "payloadHash",
    "authorizationMarker", "totalPartCount", "knownProviderMessageIds",
    "possibleHandoffPrefixLength", "outcome", "reasonCode",
  ])) return false;
  if (
    value.version !== 1 || value.evidenceKind !== "OUTBOX_DELIVERY" || !uuid(value.outboxId) ||
    !integer(value.claimGeneration, 1) || !sha256(value.payloadHash) ||
    !validMarker(value.authorizationMarker) || !integer(value.totalPartCount, 1) ||
    Number(value.totalPartCount) > 20 || !Array.isArray(value.knownProviderMessageIds) ||
    !value.knownProviderMessageIds.every((entry) => boundedString(entry, 1, 255)) ||
    !integer(value.possibleHandoffPrefixLength) ||
    Number(value.possibleHandoffPrefixLength) > Number(value.totalPartCount) ||
    typeof value.outcome !== "string" || !["SENT", "FAILED", "UNKNOWN"].includes(value.outcome) ||
    typeof value.reasonCode !== "string" || !DELIVERY_REASONS.has(value.reasonCode)
  ) return false;
  const ids = value.knownProviderMessageIds.length;
  const prefix = Number(value.possibleHandoffPrefixLength);
  const parts = Number(value.totalPartCount);
  if (ids > prefix) return false;
  if (value.outcome === "SENT") {
    return value.reasonCode === "ALL_PARTS_ACKNOWLEDGED" && ids === parts && prefix === parts;
  }
  if (value.outcome === "FAILED") {
    return value.reasonCode === "PROVIDER_REJECTED_BEFORE_ACCEPT" && ids === 0 && prefix === 0;
  }
  return prefix >= 1 && [
    "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF",
    "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF",
    "ACK_LOST_AFTER_HANDOFF",
  ].includes(value.reasonCode);
}

function validOutboxCompletion(value: unknown): boolean {
  if (!exact(value, [
    "version", "authorization", "deliveryEvidence", "deliveryEvidenceHash", "outcome", "reasonCode",
  ]) || value.version !== 1 || !validAuthorization(value.authorization) ||
    !validDeliveryEvidence(value.deliveryEvidence) || !sha256(value.deliveryEvidenceHash)
  ) return false;
  const marker = value.authorization.authorizationMarker as Record<string, unknown>;
  const evidence = value.deliveryEvidence as Record<string, unknown>;
  return sameMarker(marker, evidence.authorizationMarker as Record<string, unknown>) &&
    evidence.outboxId === marker.outboxId && evidence.claimGeneration === marker.claimGeneration &&
    evidence.payloadHash === marker.payloadHash && value.outcome === evidence.outcome &&
    value.reasonCode === evidence.reasonCode;
}

const PRE_HANDOFF_REASONS = new Set([
  "AUTHORIZATION_EXPIRED", "LEASE_EXPIRED", "CELL_FENCED",
  "SESSION_GENERATION_CHANGED", "CONTROL_VERSION_CHANGED", "TAKEOVER_VERSION_CHANGED",
  "POLICY_CHANGED_BEFORE_HANDOFF", "ADAPTER_NOT_READY", "EGRESS_BLOCKED_BEFORE_HANDOFF",
]);

function validPreHandoffRequeue(value: unknown): boolean {
  if (!exact(value, [
    "version", "authorization", "outcome", "reasonCode", "preHandoffEvidence",
    "preHandoffEvidenceHash", "retryNotBefore",
  ]) || value.version !== 1 || value.outcome !== "SAFE_RETRY" ||
    typeof value.reasonCode !== "string" || !PRE_HANDOFF_REASONS.has(value.reasonCode) ||
    !validAuthorization(value.authorization) || !sha256(value.preHandoffEvidenceHash) ||
    !isoTimestamp(value.retryNotBefore)
  ) return false;
  const evidence = value.preHandoffEvidence;
  if (!exact(evidence, [
    "version", "evidenceKind", "outboxId", "claimGeneration", "payloadHash",
    "authorizationMarker", "reasonCode", "authorizedHandoffRecorded",
  ]) || evidence.version !== 1 || evidence.evidenceKind !== "OUTBOX_PRE_HANDOFF" ||
    !uuid(evidence.outboxId) || !integer(evidence.claimGeneration, 1) ||
    !sha256(evidence.payloadHash) || !validMarker(evidence.authorizationMarker) ||
    evidence.reasonCode !== value.reasonCode || evidence.authorizedHandoffRecorded !== false
  ) return false;
  const marker = value.authorization.authorizationMarker as Record<string, unknown>;
  return sameMarker(marker, evidence.authorizationMarker as Record<string, unknown>) &&
    evidence.outboxId === marker.outboxId && evidence.claimGeneration === marker.claimGeneration &&
    evidence.payloadHash === marker.payloadHash;
}

function validCanonicalPayload(
  value: unknown,
): value is Record<string, unknown> & {
  organizationId: string;
  accountId: string;
  frozenInputs: Record<string, unknown>;
} {
  if (!exact(value, [
    "version", "organizationId", "accountId", "target", "channel", "accountProfile",
    "idempotencyKey", "parts", "replyToProviderMessageId", "policyVersionId",
    "automationVersionId", "templateVersionId", "frozenInputs",
  ]) || value.version !== 1 || !uuid(value.organizationId) || !uuid(value.accountId) ||
    value.channel !== "zalouser" || !boundedString(value.accountProfile, 1, 128) ||
    !boundedString(value.idempotencyKey, 1, 255) || !uuid(value.policyVersionId) ||
    !(value.automationVersionId === null || uuid(value.automationVersionId)) ||
    !(value.templateVersionId === null || uuid(value.templateVersionId)) ||
    !(value.replyToProviderMessageId === null || boundedString(value.replyToProviderMessageId, 1, 255))
  ) return false;
  if (!exact(value.target, ["kind", "providerId"]) ||
    !["PEER", "SALES_GROUP"].includes(String(value.target.kind)) ||
    !boundedString(value.target.providerId, 1, 255)
  ) return false;
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 20) return false;
  if (!value.parts.every((part, index) => {
    if (!object(part) || part.version !== 1 || part.partIndex !== index) return false;
    if (part.kind === "TEXT") {
      return exact(part, ["version", "partIndex", "kind", "text"]) &&
        boundedString(part.text, 1, 8_000) && Array.from(part.text).length <= 2_000;
    }
    return part.kind === "MEDIA" &&
      exact(part, ["version", "partIndex", "kind", "objectKey", "sha256", "mime", "bytes"]) &&
      boundedString(part.objectKey, 1, 1_024) && sha256(part.sha256) &&
      boundedString(part.mime, 3, 255) && integer(part.bytes, 1) && Number(part.bytes) <= 52_428_800;
  })) return false;
  const frozenInputs = value.frozenInputs;
  return exact(frozenInputs, [
    "campaignVersionId", "scheduleVersion", "subscriptionVersion", "subscriptionId",
    "occurrenceId", "sourceTable", "sourceId", "sourceVersion", "knowledgeVersionIds",
    "sourceSnapshotHash", "targetVersion", "targetDirectoryRefreshedAt", "fieldMappingHash",
  ]) && integer(frozenInputs.targetVersion, 1) &&
    isoTimestamp(frozenInputs.targetDirectoryRefreshedAt) &&
    Array.isArray(frozenInputs.knowledgeVersionIds) &&
    frozenInputs.knowledgeVersionIds.every(uuid);
}

function validOutboxClaim(value: unknown): boolean {
  if (!exact(value, [
    "version", "outboxId", "organizationId", "accountId", "claimToken",
    "claimGeneration", "fencingToken", "sessionGeneration", "controlVersion",
    "takeoverVersion", "leaseExpiresAt", "payloadHash", "payload",
  ]) || value.version !== 1 || !uuid(value.outboxId) || !uuid(value.organizationId) ||
    !uuid(value.accountId) || !boundedString(value.claimToken, 32, 512) ||
    !integer(value.claimGeneration, 1) || !integer(value.fencingToken, 1) ||
    !integer(value.sessionGeneration, 1) || !integer(value.controlVersion, 1) ||
    !integer(value.takeoverVersion) || !isoTimestamp(value.leaseExpiresAt) ||
    !sha256(value.payloadHash) || !validCanonicalPayload(value.payload)
  ) return false;
  return value.payload.organizationId === value.organizationId &&
    value.payload.accountId === value.accountId;
}

const PREFLIGHT_DENIALS = new Set([
  "GLOBAL_STOP", "MODE_PAUSED", "ACCOUNT_PAUSED", "CAMPAIGN_CANCELLED", "TAKEOVER_ACTIVE",
  "SUPPRESSED", "CONSENT_MISSING", "POLICY_STALE", "QUIET_HOURS", "RATE_LIMITED",
  "GROUP_DIRECTORY_STALE", "GROUP_NOT_ALLOWLISTED",
]);

function validOutboxPreflightResult(value: unknown): boolean {
  if (!exact(value, [
    "version", "outboxId", "decision", "disposition", "transitionApplied",
    "canonicalPayload", "authorizationMarker", "databaseTime", "retryNotBefore",
  ]) || value.version !== 1 || !uuid(value.outboxId) || !isoTimestamp(value.databaseTime) ||
    typeof value.decision !== "string" || typeof value.transitionApplied !== "boolean"
  ) return false;
  if (value.decision === "ALLOWED") {
    return value.disposition === "HANDOFF_AUTHORIZED" && value.transitionApplied === false &&
      validCanonicalPayload(value.canonicalPayload) && validMarker(value.authorizationMarker) &&
      value.retryNotBefore === null;
  }
  if (!PREFLIGHT_DENIALS.has(value.decision)) return false;
  if (value.canonicalPayload !== null || value.authorizationMarker !== null ||
    value.transitionApplied !== true) return false;
  return value.decision === "CAMPAIGN_CANCELLED"
    ? value.disposition === "TERMINAL_NO_SEND" && value.retryNotBefore === null
    : value.disposition === "SAFE_RETRY" && isoTimestamp(value.retryNotBefore);
}

function validUuidList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 100 && value.every(uuid) &&
    new Set(value).size === value.length;
}

function validSendWorkPayload(value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false;
  if (value.kind === "INBOUND_AUTOMATION") {
    return exact(value, [
      "kind", "inboundEventId", "messageId", "conversationId", "targetId", "targetVersion",
      "targetDirectoryRefreshedAt", "automationVersionId", "knowledgeVersionIds",
      "eligibilityDecisionHash",
    ], ["templateVersionId"]) && uuid(value.inboundEventId) && uuid(value.messageId) &&
      uuid(value.conversationId) && uuid(value.targetId) && integer(value.targetVersion, 1) &&
      isoTimestamp(value.targetDirectoryRefreshedAt) && uuid(value.automationVersionId) &&
      validUuidList(value.knowledgeVersionIds) && sha256(value.eligibilityDecisionHash) &&
      (!("templateVersionId" in value) || uuid(value.templateVersionId));
  }
  if (value.kind === "SCHEDULE_OCCURRENCE") {
    return exact(value, [
      "kind", "scheduleId", "scheduleVersion", "occurrenceId", "campaignVersionId",
      "targetId", "targetVersion", "targetDirectoryRefreshedAt", "automationVersionId",
      "templateVersionId", "knowledgeVersionIds", "eligibilityDecisionHash",
    ]) && uuid(value.scheduleId) && integer(value.scheduleVersion, 1) &&
      uuid(value.occurrenceId) && uuid(value.campaignVersionId) && uuid(value.targetId) &&
      integer(value.targetVersion, 1) && isoTimestamp(value.targetDirectoryRefreshedAt) &&
      uuid(value.automationVersionId) && uuid(value.templateVersionId) &&
      validUuidList(value.knowledgeVersionIds) && sha256(value.eligibilityDecisionHash);
  }
  if (value.kind === "CRM_EVENT") {
    return exact(value, [
      "kind", "subscriptionId", "subscriptionVersion", "occurrenceId", "targetId",
      "targetVersion", "targetDirectoryRefreshedAt", "automationVersionId",
      "knowledgeVersionIds", "fieldMappingHash", "sourceEnvelope", "sourceEnvelopeHash",
    ], ["campaignVersionId", "templateVersionId"]) && uuid(value.subscriptionId) &&
      integer(value.subscriptionVersion, 1) && uuid(value.occurrenceId) &&
      uuid(value.targetId) && integer(value.targetVersion, 1) &&
      isoTimestamp(value.targetDirectoryRefreshedAt) && uuid(value.automationVersionId) &&
      validUuidList(value.knowledgeVersionIds) && sha256(value.fieldMappingHash) &&
      object(value.sourceEnvelope) && Object.keys(value.sourceEnvelope).length <= 100 &&
      sha256(value.sourceEnvelopeHash) &&
      (!("campaignVersionId" in value) || uuid(value.campaignVersionId)) &&
      (!("templateVersionId" in value) || uuid(value.templateVersionId));
  }
  return false;
}

function validMaintenancePayload(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === "AUDIT_ANCHOR") {
    return exact(value, [
      "kind", "auditRootId", "rootDate", "firstSequence", "lastSequence", "eventCount",
      "previousRootHash", "merkleRootHash", "rootHash", "auditSigningKeyGeneration",
      "auditSigningPublicKeyHash", "anchorKey",
    ]) && uuid(value.auditRootId) && typeof value.rootDate === "string" &&
      ISO_DATE.test(value.rootDate) && integer(value.firstSequence, 1) &&
      integer(value.lastSequence, Number(value.firstSequence)) && integer(value.eventCount, 1) &&
      Number(value.eventCount) === Number(value.lastSequence) - Number(value.firstSequence) + 1 &&
      (value.previousRootHash === null || sha256(value.previousRootHash)) &&
      sha256(value.merkleRootHash) && sha256(value.rootHash) &&
      integer(value.auditSigningKeyGeneration, 1) && sha256(value.auditSigningPublicKeyHash) &&
      boundedString(value.anchorKey, 1, 1_024);
  }
  if (value.kind !== "RETENTION_DELETE") return false;
  if (value.deletePhase === "QUARANTINE") {
    return exact(value, [
      "kind", "deletePhase", "subjectKind", "subjectId", "retentionVersion", "holdVersion",
    ]) && [
      "MESSAGE", "AI_DRAFT", "MEDIA", "KNOWLEDGE", "HEALTH", "QR", "AUDIT", "POLICY",
      "CONTROL", "DELIVERY", "UNKNOWN", "SECURITY", "CONSENT", "RISK",
    ].includes(String(value.subjectKind)) && uuid(value.subjectId) &&
      integer(value.retentionVersion, 1) && integer(value.holdVersion);
  }
  return value.deletePhase === "FINAL_DELETE" && exact(value, [
    "kind", "deletePhase", "subjectKind", "subjectId", "objectKey", "retentionVersion",
    "holdVersion", "quarantineVersion", "finalDeleteNotBefore",
  ]) && value.subjectKind === "MEDIA" && uuid(value.subjectId) &&
    boundedString(value.objectKey, 1, 1_024) && integer(value.retentionVersion, 1) &&
    integer(value.holdVersion) && integer(value.quarantineVersion, 1) &&
    isoTimestamp(value.finalDeleteNotBefore);
}

function validWorkClaim(value: unknown, principalKind: "CHANNEL" | "MAINTENANCE"): boolean {
  if (principalKind === "MAINTENANCE" && object(value) && "recoveryKind" in value) {
    const common = exact(value, value.recoveryKind === "AUDIT_VERIFY_AUTHORIZED" ? [
      "version", "recoveryKind", "workItemId", "organizationId", "maintenancePrincipalId",
      "credentialGeneration", "leaseGeneration", "fencingToken", "sourceKey", "claimToken",
      "recoveryGeneration", "recoveryLeaseExpiresAt", "frozenClaim", "payload",
      "verifyTicketId", "verifyTicketHash", "signatureHash", "verifyTicket", "gatewayReceipt",
    ] : [
      "version", "recoveryKind", "workItemId", "organizationId", "maintenancePrincipalId",
      "credentialGeneration", "leaseGeneration", "fencingToken", "sourceKey", "claimToken",
      "recoveryGeneration", "recoveryLeaseExpiresAt", "frozenClaim", "payload", "ticketId",
      "ticketHash", "ticket", "authorizationHash", "authorization",
      "authorizationExpiresAt", "gatewayReceipt",
    ]);
    if (!common || !["AUDIT_VERIFY_AUTHORIZED", "RETENTION_DELETE_AUTHORIZED"].includes(
      String(value.recoveryKind),
    ) || value.version !== 1 || !uuid(value.workItemId) || !uuid(value.organizationId) ||
      !uuid(value.maintenancePrincipalId) || !integer(value.credentialGeneration, 1) ||
      !integer(value.leaseGeneration, 1) || !integer(value.fencingToken, 1) ||
      !boundedString(value.sourceKey, 1, 512) || !boundedString(value.claimToken, 32, 512) ||
      !integer(value.recoveryGeneration, 1) || !isoTimestamp(value.recoveryLeaseExpiresAt) ||
      !object(value.frozenClaim) || !exact(value.frozenClaim, [
        "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
        "claimGeneration",
      ]) || !uuid(value.frozenClaim.maintenancePrincipalId) ||
      !integer(value.frozenClaim.credentialGeneration, 1) ||
      !integer(value.frozenClaim.leaseGeneration, 1) ||
      !integer(value.frozenClaim.fencingToken, 1) ||
      !integer(value.frozenClaim.claimGeneration, 1) || !validMaintenancePayload(value.payload)
    ) return false;
    if (value.recoveryKind === "AUDIT_VERIFY_AUTHORIZED") {
      const ticket = value.verifyTicket;
      if (!uuid(value.verifyTicketId) || !sha256(value.verifyTicketHash) ||
        !sha256(value.signatureHash) || !object(ticket)
      ) return false;
      const ticketRecord = ticket as Record<string, unknown>;
      const payload = value.payload as Record<string, unknown>;
      const originalTicket: boolean = exact(ticketRecord, [
          "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
          "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
          "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
          "maintenancePrincipalId", "workItemId", "claimGeneration", "credentialGeneration",
          "leaseGeneration", "fencingToken", "auditRootId", "rootHash", "signatureHash",
          "auditSigningKeyGeneration", "auditSigningPublicKeyHash", "signature",
        ]);
      const refreshedTicket: boolean = exact(ticketRecord, [
        "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
        "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
        "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
        "maintenancePrincipalId", "workItemId", "credentialGeneration", "leaseGeneration",
        "fencingToken", "recoveryKind", "recoveryGeneration", "replacesVerifyTicketJti",
        "frozenClaim", "auditRootId", "rootHash", "signatureHash",
        "auditSigningKeyGeneration", "auditSigningPublicKeyHash", "signature",
      ]);
      if (!originalTicket && !refreshedTicket) return false;
      const claimBinding = originalTicket
        ? ticketRecord.claimGeneration === value.frozenClaim.claimGeneration
        : ticketRecord.recoveryKind === value.recoveryKind &&
          ticketRecord.recoveryGeneration === value.recoveryGeneration &&
          uuid(ticketRecord.replacesVerifyTicketJti) &&
          sameFrozenMaintenanceClaim(ticketRecord.frozenClaim, value.frozenClaim);
      return claimBinding && ticketRecord.version === 1 &&
        ticketRecord.aud === "openclaw-media-gateway" &&
        ticketRecord.operation === "ANCHOR_VERIFY" && ticketRecord.subject === "MAINTENANCE" &&
        ticketRecord.jti === value.verifyTicketId &&
        ticketRecord.organizationId === value.organizationId &&
        ticketRecord.accountId === null && ticketRecord.objectKey === payload.anchorKey &&
        ticketRecord.workItemId === value.workItemId &&
        ticketRecord.auditRootId === payload.auditRootId &&
        ticketRecord.rootHash === payload.rootHash &&
        ticketRecord.signatureHash === value.signatureHash &&
        ticketRecord.auditSigningKeyGeneration === payload.auditSigningKeyGeneration &&
        ticketRecord.auditSigningPublicKeyHash === payload.auditSigningPublicKeyHash &&
        ticketRecord.maintenancePrincipalId === value.frozenClaim.maintenancePrincipalId &&
        ticketRecord.credentialGeneration === value.frozenClaim.credentialGeneration &&
        ticketRecord.leaseGeneration === value.frozenClaim.leaseGeneration &&
        ticketRecord.fencingToken === value.frozenClaim.fencingToken &&
        sha256(ticketRecord.sha256) && ticketRecord.contentType === "application/json" &&
        integer(ticketRecord.contentLength, 1) && ticketRecord.sessionGeneration === 0 &&
        integer(ticketRecord.gatewayKeyGeneration, 1) &&
        integer(ticketRecord.receiptSigningKeyGeneration, 1) && integer(ticketRecord.iat) &&
        integer(ticketRecord.exp) && Number(ticketRecord.exp) > Number(ticketRecord.iat) &&
        Number(ticketRecord.exp)-Number(ticketRecord.iat) <= 60 &&
        typeof ticketRecord.signature === "string" &&
        ED25519_SIGNATURE.test(ticketRecord.signature) &&
        (value.gatewayReceipt === null || validAuditReceipt(value.gatewayReceipt));
    }
    return uuid(value.ticketId) && sha256(value.ticketHash) && sha256(value.authorizationHash) &&
      isoTimestamp(value.authorizationExpiresAt) &&
      (value.gatewayReceipt === null || validRetentionReceipt(value.gatewayReceipt));
  }
  const principalKeys = principalKind === "CHANNEL"
    ? ["accountId", "cellId"]
    : ["maintenancePrincipalId"];
  if (!exact(value, [
    "version", "workItemId", "organizationId", ...principalKeys, "credentialGeneration",
    "leaseGeneration", "sourceKey", "claimToken", "claimGeneration", "fencingToken",
    "leaseExpiresAt", "payload",
  ]) || value.version !== 1 || !uuid(value.workItemId) || !uuid(value.organizationId) ||
    !integer(value.credentialGeneration, 1) || !integer(value.leaseGeneration, 1) ||
    !boundedString(value.sourceKey, 1, 512) || !boundedString(value.claimToken, 32, 512) ||
    !integer(value.claimGeneration, 1) || !integer(value.fencingToken, 1) ||
    !isoTimestamp(value.leaseExpiresAt) || !object(value.payload)
  ) return false;
  if (principalKind === "CHANNEL") {
    return uuid(value.accountId) && uuid(value.cellId) && validSendWorkPayload(value.payload);
  }
  return uuid(value.maintenancePrincipalId) && validMaintenancePayload(value.payload);
}

const DLP_FINDINGS = new Set([
  "PHONE_NUMBER", "EMAIL", "NATIONAL_ID", "BANK_ACCOUNT", "CREDENTIAL",
  "URL_NOT_ALLOWED", "CONTROL_CHARACTERS",
]);

function reasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value);
}

function validChannelCompletionEvidence(value: unknown, outcome: unknown): boolean {
  if (!object(value) || value.version !== 1) return false;
  if (outcome === "COMPLETE" && value.evidenceKind === "NO_SEND") {
    return exact(value, ["version", "evidenceKind", "reasonCode"]) && reasonCode(value.reasonCode);
  }
  if (outcome === "COMPLETE" && value.evidenceKind === "HUMAN_DRAFT") {
    if (!exact(value, [
      "version", "evidenceKind", "reasonCode", "classification", "confidenceBasisPoints",
      "findings", "draftText", "draftHash",
    ]) || !reasonCode(value.reasonCode) ||
      !(value.classification === null || boundedString(value.classification, 1, 128)) ||
      !(value.confidenceBasisPoints === null || integer(value.confidenceBasisPoints)) ||
      (typeof value.confidenceBasisPoints === "number" && value.confidenceBasisPoints > 10_000) ||
      !Array.isArray(value.findings) || value.findings.length > DLP_FINDINGS.size ||
      !value.findings.every((finding) => DLP_FINDINGS.has(String(finding))) ||
      new Set(value.findings).size !== value.findings.length ||
      !boundedString(value.draftText, 1, 8_000) || !sha256(value.draftHash)
    ) return false;
    return true;
  }
  return outcome !== "COMPLETE" && exact(value, [
    "version", "evidenceKind", "reasonCode", "failureFingerprint",
  ]) && value.evidenceKind === "WORK_FAILURE" && reasonCode(value.reasonCode) &&
    sha256(value.failureFingerprint);
}

function validSendWorkCompletion(value: unknown): boolean {
  if (!exact(value, [
    "version", "workItemId", "organizationId", "accountId", "cellId", "credentialGeneration",
    "leaseGeneration", "claimToken", "claimGeneration", "fencingToken", "outcome", "evidence",
    "evidenceHash", "retryAfterSeconds",
  ]) || value.version !== 1 || !uuid(value.workItemId) || !uuid(value.organizationId) ||
    !uuid(value.accountId) || !uuid(value.cellId) || !integer(value.credentialGeneration, 1) ||
    !integer(value.leaseGeneration, 1) || !boundedString(value.claimToken, 32, 512) ||
    !integer(value.claimGeneration, 1) || !integer(value.fencingToken, 1) ||
    !["COMPLETE", "RETRY", "FAILED", "DEAD_LETTER"].includes(String(value.outcome)) ||
    !validChannelCompletionEvidence(value.evidence, value.outcome) || !sha256(value.evidenceHash)
  ) return false;
  return value.outcome === "RETRY"
    ? integer(value.retryAfterSeconds, 1) && Number(value.retryAfterSeconds) <= 3_600
    : value.retryAfterSeconds === null;
}

function validRetentionReceipt(value: unknown): boolean {
  if (!exact(value, [
    "version", "receiptKind", "receiptId", "organizationId", "maintenancePrincipalId",
    "workItemId", "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken",
    "objectKey", "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti",
    "deleteAuthorizationJti", "proofJti", "objectStatus", "r2VersionOrEtag", "completedAt",
    "gatewaySigningKeyGeneration", "signature",
  ]) || value.version !== 1 || value.receiptKind !== "RETENTION_FINAL_DELETE" ||
    !uuid(value.receiptId) || !uuid(value.organizationId) || !uuid(value.maintenancePrincipalId) ||
    !uuid(value.workItemId) || !integer(value.claimGeneration, 1) ||
    !integer(value.credentialGeneration, 1) || !integer(value.leaseGeneration, 1) ||
    !integer(value.fencingToken, 1) || !boundedString(value.objectKey, 1, 1_024) ||
    value.deletePhase !== "FINAL_DELETE" || !integer(value.holdVersion) ||
    !integer(value.quarantineVersion, 1) || typeof value.deleteTicketJti !== "string" ||
    !JTI.test(value.deleteTicketJti) || typeof value.deleteAuthorizationJti !== "string" ||
    !JTI.test(value.deleteAuthorizationJti) || typeof value.proofJti !== "string" ||
    !JTI.test(value.proofJti) || !isoTimestamp(value.completedAt) ||
    !integer(value.gatewaySigningKeyGeneration, 1) || typeof value.signature !== "string" ||
    !ED25519_SIGNATURE.test(value.signature)
  ) return false;
  return (value.objectStatus === "DELETED" && boundedString(value.r2VersionOrEtag, 1, 512)) ||
    (value.objectStatus === "NOT_FOUND" && value.r2VersionOrEtag === null);
}

function validAuditReceipt(value: unknown): boolean {
  return exact(value, [
    "version", "receiptKind", "receiptId", "organizationId", "maintenancePrincipalId",
    "workItemId", "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken",
    "auditRootId", "rootHash", "anchorKey", "signatureHash", "auditSigningKeyGeneration",
    "verifyTicketJti", "objectVersionOrEtag", "verifiedAt", "gatewaySigningKeyGeneration", "signature",
  ]) && value.version === 1 && value.receiptKind === "AUDIT_ANCHOR_VERIFY" &&
    uuid(value.receiptId) && uuid(value.organizationId) && uuid(value.maintenancePrincipalId) &&
    uuid(value.workItemId) && integer(value.claimGeneration, 1) &&
    integer(value.credentialGeneration, 1) && integer(value.leaseGeneration, 1) &&
    integer(value.fencingToken, 1) && uuid(value.auditRootId) && sha256(value.rootHash) &&
    boundedString(value.anchorKey, 1, 1_024) && sha256(value.signatureHash) &&
    integer(value.auditSigningKeyGeneration, 1) && typeof value.verifyTicketJti === "string" &&
    JTI.test(value.verifyTicketJti) && boundedString(value.objectVersionOrEtag, 1, 512) &&
    isoTimestamp(value.verifiedAt) && integer(value.gatewaySigningKeyGeneration, 1) &&
    typeof value.signature === "string" && ED25519_SIGNATURE.test(value.signature);
}

function validMediaUploadReceipt(value: unknown): value is Record<string, unknown> {
  return exact(value, [
    "version", "receiptKind", "receiptId", "organizationId", "accountId", "cellId", "mediaId",
    "objectKey", "sha256", "contentType", "contentLength", "uploadTicketJti",
    "credentialGeneration", "leaseGeneration", "fencingToken", "sessionGeneration",
    "objectVersionOrEtag", "storedAt", "gatewaySigningKeyGeneration", "signature",
  ]) && value.version === 1 && value.receiptKind === "MEDIA_UPLOAD" &&
    uuid(value.receiptId) && uuid(value.organizationId) && uuid(value.accountId) &&
    uuid(value.cellId) && uuid(value.mediaId) &&
    canonicalMediaObjectKey(value.objectKey, value.organizationId, value.accountId, value.mediaId) &&
    sha256(value.sha256) && boundedString(value.contentType, 1, 255) &&
    integer(value.contentLength, 1) && Number(value.contentLength) <= 52_428_800 &&
    uuid(value.uploadTicketJti) && value.uploadTicketJti !== value.receiptId &&
    integer(value.credentialGeneration, 1) &&
    integer(value.leaseGeneration, 1) && integer(value.fencingToken, 1) &&
    integer(value.sessionGeneration, 1) && boundedString(value.objectVersionOrEtag, 1, 512) &&
    isoTimestamp(value.storedAt) && integer(value.gatewaySigningKeyGeneration, 1) &&
    typeof value.signature === "string" && ED25519_SIGNATURE.test(value.signature);
}

function validMaintenanceCompletion(value: unknown): boolean {
  if (!object(value) || value.version !== 1) return false;
  if ("outcome" in value) {
    const recovery = "recoveryKind" in value;
    const bindingKeys = recovery
      ? ["recoveryKind", "recoveryGeneration", "frozenClaim"]
      : ["claimGeneration"];
    if (!exact(value, [
      "version", "workItemId", "organizationId", "maintenancePrincipalId",
      "credentialGeneration", "leaseGeneration", "fencingToken", "claimToken",
      ...bindingKeys, "outcome", "evidence", "evidenceHash", "retryAfterSeconds",
    ]) || !uuid(value.workItemId) || !uuid(value.organizationId) ||
      !uuid(value.maintenancePrincipalId) || !integer(value.credentialGeneration, 1) ||
      !integer(value.leaseGeneration, 1) || !integer(value.fencingToken, 1) ||
      !boundedString(value.claimToken, 32, 512) ||
      !["RETRY", "FAILED", "DEAD_LETTER"].includes(String(value.outcome)) ||
      !object(value.evidence) || !exact(value.evidence, [
        "version", "evidenceKind", "reasonCode", "failureFingerprint",
      ]) || value.evidence.version !== 1 || value.evidence.evidenceKind !== "WORK_FAILURE" ||
      !reasonCode(value.evidence.reasonCode) || !sha256(value.evidence.failureFingerprint) ||
      !sha256(value.evidenceHash)
    ) return false;
    if (value.outcome === "RETRY"
      ? !integer(value.retryAfterSeconds, 1) || Number(value.retryAfterSeconds) > 3_600
      : value.retryAfterSeconds !== null) return false;
    return recovery
      ? ["AUDIT_VERIFY_AUTHORIZED", "RETENTION_DELETE_AUTHORIZED"].includes(
        String(value.recoveryKind),
      ) && integer(value.recoveryGeneration, 1) && validFrozenMaintenanceClaim(value.frozenClaim)
      : integer(value.claimGeneration, 1);
  }
  if (value.recoveryKind === "AUDIT_VERIFY_AUTHORIZED") {
    return exact(value, [
      "version", "recoveryKind", "workItemId", "recoveryGeneration", "claimToken",
      "verifyTicketJti", "gatewayReceipt",
    ]) && uuid(value.workItemId) && integer(value.recoveryGeneration, 1) &&
      boundedString(value.claimToken, 32, 512) && uuid(value.verifyTicketJti) &&
      validAuditReceipt(value.gatewayReceipt);
  }
  if (value.recoveryKind === "RETENTION_DELETE_AUTHORIZED") {
    return exact(value, [
      "version", "recoveryKind", "workItemId", "recoveryGeneration", "claimToken",
      "ticketId", "gatewayReceipt",
    ]) && uuid(value.workItemId) && integer(value.recoveryGeneration, 1) &&
      boundedString(value.claimToken, 32, 512) && uuid(value.ticketId) &&
      validRetentionReceipt(value.gatewayReceipt);
  }
  if ("ticketId" in value) {
    return exact(value, ["version", "ticketId", "gatewayReceipt"]) && uuid(value.ticketId) &&
      validRetentionReceipt(value.gatewayReceipt);
  }
  if ("gatewayReceipt" in value) {
    return exact(value, [
      "version", "workItemId", "claimGeneration", "claimToken", "verifyTicketJti", "gatewayReceipt",
    ]) && uuid(value.workItemId) && integer(value.claimGeneration, 1) &&
      boundedString(value.claimToken, 32, 512) && uuid(value.verifyTicketJti) &&
      validAuditReceipt(value.gatewayReceipt);
  }
  return exact(value, [
    "version", "workItemId", "claimGeneration", "claimToken", "subjectKind", "subjectId",
  ]) && uuid(value.workItemId) && integer(value.claimGeneration, 1) &&
    boundedString(value.claimToken, 32, 512) &&
    ["MESSAGE", "AI_DRAFT", "MEDIA"].includes(String(value.subjectKind)) && uuid(value.subjectId);
}

function validRetentionDeleteAuthorizationRequest(value: unknown): boolean {
  return exact(value, ["version", "workItemId", "claimGeneration", "claimToken"]) &&
    value.version === 1 && uuid(value.workItemId) && integer(value.claimGeneration, 1) &&
    boundedString(value.claimToken, 32, 512);
}

function validExpiredNoWorkDenial(value: unknown): boolean {
  return exact(value, ["status", "code"]) && value.status === 410 &&
    value.code === "TICKET_EXPIRED_NO_WORK";
}

function validFrozenMaintenanceClaim(value: unknown): boolean {
  return exact(value, [
    "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
    "claimGeneration",
  ]) && uuid(value.maintenancePrincipalId) && integer(value.credentialGeneration, 1) &&
    integer(value.leaseGeneration, 1) && integer(value.fencingToken, 1) &&
    integer(value.claimGeneration, 1);
}

function sameFrozenMaintenanceClaim(left: unknown, right: unknown): boolean {
  return object(left) && object(right) && validFrozenMaintenanceClaim(left) &&
    validFrozenMaintenanceClaim(right) &&
    left.maintenancePrincipalId === right.maintenancePrincipalId &&
    left.credentialGeneration === right.credentialGeneration &&
    left.leaseGeneration === right.leaseGeneration &&
    left.fencingToken === right.fencingToken &&
    left.claimGeneration === right.claimGeneration;
}

function validAuditRecoveryRefreshRequest(value: unknown): boolean {
  return exact(value, [
    "version", "operation", "recoveryKind", "workItemId", "recoveryGeneration",
    "claimToken", "expiredVerifyTicketJti", "gatewayDenial", "auditRootId", "rootHash",
    "anchorKey", "signatureHash", "auditSigningKeyGeneration",
    "auditSigningPublicKeyHash", "documentSha256", "documentByteLength",
  ]) && value.version === 1 && value.operation === "ANCHOR_VERIFY" &&
    value.recoveryKind === "AUDIT_VERIFY_AUTHORIZED" && uuid(value.workItemId) &&
    integer(value.recoveryGeneration, 1) && boundedString(value.claimToken, 32, 512) &&
    uuid(value.expiredVerifyTicketJti) && validExpiredNoWorkDenial(value.gatewayDenial) &&
    uuid(value.auditRootId) && sha256(value.rootHash) && boundedString(value.anchorKey, 1, 1_024) &&
    sha256(value.signatureHash) && integer(value.auditSigningKeyGeneration, 1) &&
    sha256(value.auditSigningPublicKeyHash) && sha256(value.documentSha256) &&
    integer(value.documentByteLength, 1) && Number(value.documentByteLength) <= 52_428_800;
}

function validRetentionRecoveryRefreshRequest(value: unknown): boolean {
  return exact(value, [
    "version", "recoveryKind", "workItemId", "recoveryGeneration", "claimToken", "ticketId",
    "expiredTicketJti", "expiredDeleteAuthorizationJti", "gatewayDenial",
  ]) && value.version === 1 && value.recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
    uuid(value.workItemId) && integer(value.recoveryGeneration, 1) &&
    boundedString(value.claimToken, 32, 512) && uuid(value.ticketId) &&
    uuid(value.expiredTicketJti) && uuid(value.expiredDeleteAuthorizationJti) &&
    validExpiredNoWorkDenial(value.gatewayDenial);
}

function validWorkCompletionResult(value: unknown): boolean {
  if (!exact(value, [
    "version", "workItemId", "claimGeneration", "outcome", "canonicalEvidenceHash",
    "completedAt", "retryNotBefore",
  ]) || value.version !== 1 || !uuid(value.workItemId) || !integer(value.claimGeneration, 1) ||
    !sha256(value.canonicalEvidenceHash) ||
    !["COMPLETED", "SAFE_RETRY", "DEAD_LETTER"].includes(String(value.outcome))
  ) return false;
  return value.outcome === "SAFE_RETRY"
    ? value.completedAt === null && isoTimestamp(value.retryNotBefore)
    : isoTimestamp(value.completedAt) && value.retryNotBefore === null;
}

function validSpecializedMaintenanceResult(value: unknown): boolean {
  if (!object(value) || value.version !== 1) return false;
  if (value.state === "FAILURE_RECORDED") {
    const bindingKey = "recoveryGeneration" in value ? "recoveryGeneration" : "claimGeneration";
    if (!exact(value, [
      "version", "state", "workItemId", bindingKey, "outcome", "canonicalEvidenceHash",
      "completedAt", "retryNotBefore",
    ]) || !uuid(value.workItemId) || !integer(value[bindingKey], 1) ||
      !["SAFE_RETRY", "FAILED", "DEAD_LETTER"].includes(String(value.outcome)) ||
      !sha256(value.canonicalEvidenceHash)
    ) return false;
    return value.outcome === "SAFE_RETRY"
      ? value.completedAt === null && isoTimestamp(value.retryNotBefore)
      : isoTimestamp(value.completedAt) && value.retryNotBefore === null;
  }
  if ("gatewayOutcome" in value) {
    return exact(value, [
      "version", "ticketId", "gatewayOutcome", "receiptHash", "finalized", "idempotentReplay",
    ]) && uuid(value.ticketId) && ["DELETED", "NOT_FOUND"].includes(String(value.gatewayOutcome)) &&
      sha256(value.receiptHash) && value.finalized === true && typeof value.idempotentReplay === "boolean";
  }
  if ("deleteAuthorizationJti" in value) {
    return exact(value, [
      "version", "ticketId", "ticketHash", "deleteAuthorizationJti", "expiresAt", "state",
    ]) && uuid(value.ticketId) && sha256(value.ticketHash) && uuid(value.deleteAuthorizationJti) &&
      isoTimestamp(value.expiresAt) && value.state === "DELETE_AUTHORIZED";
  }
  if ("auditRootId" in value) {
    return exact(value, ["version", "auditRootId", "gatewayReceiptHash", "idempotentReplay"]) &&
      uuid(value.auditRootId) && sha256(value.gatewayReceiptHash) &&
      typeof value.idempotentReplay === "boolean";
  }
  return exact(value, [
    "version", "workItemId", "tombstoneId", "subjectKind", "subjectId", "quarantinedAt", "state",
  ]) && uuid(value.workItemId) && uuid(value.tombstoneId) &&
    ["MESSAGE", "AI_DRAFT", "MEDIA"].includes(String(value.subjectKind)) &&
    uuid(value.subjectId) && isoTimestamp(value.quarantinedAt) && value.state === "COMPLETE";
}

function validRetentionDeleteTicketResult(value: unknown): boolean {
  if (!exact(value, [
    "version", "ticketId", "ticketHash", "expiresAt", "state", "ticket",
  ]) || value.version !== 1 || !uuid(value.ticketId) || !sha256(value.ticketHash) ||
    !isoTimestamp(value.expiresAt) || value.state !== "TICKET_ISSUED"
  ) return false;
  const ticket = value.ticket;
  if (!exact(ticket, [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
    "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
    "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp", "maintenancePrincipalId", "workItemId",
    "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken",
    "deletePhase", "quarantineVersion", "finalDeleteNotBefore", "holdVersion", "signature",
  ])) return false;
  return ticket.version === 1 && ticket.aud === "openclaw-media-gateway" &&
    ticket.operation === "DELETE" && ticket.subject === "MAINTENANCE" &&
    uuid(ticket.jti) && ticket.jti !== value.ticketId && uuid(ticket.organizationId) &&
    ticket.accountId === null && boundedString(ticket.objectKey, 1, 1_024) &&
    sha256(ticket.sha256) && boundedString(ticket.contentType, 3, 255) &&
    integer(ticket.contentLength, 1) && Number(ticket.contentLength) <= 52_428_800 &&
    ticket.sessionGeneration === 0 && integer(ticket.gatewayKeyGeneration, 1) &&
    integer(ticket.receiptSigningKeyGeneration, 1) &&
    integer(ticket.iat) && integer(ticket.exp) && Number(ticket.exp) > Number(ticket.iat) &&
    Number(ticket.exp) - Number(ticket.iat) <= 60 && uuid(ticket.maintenancePrincipalId) &&
    uuid(ticket.workItemId) && integer(ticket.claimGeneration, 1) &&
    integer(ticket.credentialGeneration, 1) && integer(ticket.leaseGeneration, 1) &&
    integer(ticket.fencingToken, 1) && ticket.deletePhase === "FINAL_DELETE" &&
    integer(ticket.quarantineVersion, 1) && integer(ticket.finalDeleteNotBefore) &&
    integer(ticket.holdVersion) && typeof ticket.signature === "string" &&
    ED25519_SIGNATURE.test(ticket.signature);
}

function validMediaTicketResult(
  value: unknown,
  subject: "RUNTIME" | "MAINTENANCE",
): boolean {
  if (!exact(value, [
    "version", "ticketId", "ticketHash", "expiresAt", "state", "ticket",
  ]) || value.version !== 1 || !uuid(value.ticketId) || !sha256(value.ticketHash) ||
    !isoTimestamp(value.expiresAt) || value.state !== "ISSUED"
  ) return false;
  const ticket = value.ticket;
  const subjectKeys = subject === "RUNTIME"
    ? ["cellId", "credentialGeneration", "leaseGeneration", "fencingToken"]
    : [
        "maintenancePrincipalId", "workItemId", "claimGeneration", "credentialGeneration",
        "leaseGeneration", "fencingToken", "auditRootId", "rootHash", "signatureHash",
        "auditSigningKeyGeneration", "auditSigningPublicKeyHash",
      ];
  if (!exact(ticket, [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
    "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
    "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp", ...subjectKeys, "signature",
  ])) return false;
  if (
    ticket.version !== 1 || ticket.aud !== "openclaw-media-gateway" ||
    ticket.subject !== subject || !uuid(ticket.jti) || ticket.jti !== value.ticketId ||
    !uuid(ticket.organizationId) || !boundedString(ticket.objectKey, 1, 1_024) ||
    !sha256(ticket.sha256) || !boundedString(ticket.contentType, 3, 255) ||
    !integer(ticket.contentLength, 1) || Number(ticket.contentLength) > 52_428_800 ||
    !integer(ticket.sessionGeneration) || !integer(ticket.gatewayKeyGeneration, 1) ||
    !integer(ticket.receiptSigningKeyGeneration, 1) ||
    !integer(ticket.iat) || !integer(ticket.exp) || Number(ticket.exp) <= Number(ticket.iat) ||
    Number(ticket.exp) - Number(ticket.iat) > 60 || typeof ticket.signature !== "string" ||
    !ED25519_SIGNATURE.test(ticket.signature)
  ) return false;
  if (subject === "RUNTIME") {
    return ticket.operation === "PUT" && uuid(ticket.accountId) && uuid(ticket.cellId) &&
      integer(ticket.credentialGeneration, 1) && integer(ticket.leaseGeneration, 1) &&
      integer(ticket.fencingToken, 1);
  }
  return ticket.accountId === null && ticket.sessionGeneration === 0 &&
    ["ANCHOR", "ANCHOR_VERIFY"].includes(String(ticket.operation)) &&
    ticket.contentType === "application/json" && uuid(ticket.maintenancePrincipalId) &&
    uuid(ticket.workItemId) && integer(ticket.claimGeneration, 1) &&
    integer(ticket.credentialGeneration, 1) && integer(ticket.leaseGeneration, 1) &&
    integer(ticket.fencingToken, 1) && uuid(ticket.auditRootId) && sha256(ticket.rootHash) &&
    sha256(ticket.signatureHash) && integer(ticket.auditSigningKeyGeneration, 1) &&
    sha256(ticket.auditSigningPublicKeyHash);
}

function validRetentionDeleteAuthorizationResult(value: unknown): boolean {
  if (!exact(value, [
    "version", "ticketId", "ticketHash", "deleteAuthorizationJti", "expiresAt", "state",
    "authorization",
  ]) || value.version !== 1 || !uuid(value.ticketId) || !sha256(value.ticketHash) ||
    !uuid(value.deleteAuthorizationJti) || !isoTimestamp(value.expiresAt) ||
    value.state !== "DELETE_AUTHORIZED"
  ) return false;
  const authorization = value.authorization;
  return exact(authorization, [
    "version", "authorizationKind", "organizationId", "maintenancePrincipalId", "workItemId",
    "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken", "objectKey",
    "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti", "authorizationJti",
    "iat", "exp", "gatewaySigningKeyGeneration", "signature",
  ]) && authorization.version === 1 &&
    authorization.authorizationKind === "RETENTION_FINAL_DELETE" &&
    uuid(authorization.organizationId) && uuid(authorization.maintenancePrincipalId) &&
    uuid(authorization.workItemId) && integer(authorization.claimGeneration, 1) &&
    integer(authorization.credentialGeneration, 1) && integer(authorization.leaseGeneration, 1) &&
    integer(authorization.fencingToken, 1) && boundedString(authorization.objectKey, 1, 1_024) &&
    authorization.deletePhase === "FINAL_DELETE" && integer(authorization.holdVersion) &&
    integer(authorization.quarantineVersion, 1) && uuid(authorization.deleteTicketJti) &&
    uuid(authorization.authorizationJti) &&
    authorization.authorizationJti === value.deleteAuthorizationJti &&
    isoTimestamp(authorization.iat) && isoTimestamp(authorization.exp) &&
    Date.parse(authorization.exp) > Date.parse(authorization.iat) &&
    Date.parse(authorization.exp) - Date.parse(authorization.iat) <= 5_000 &&
    integer(authorization.gatewaySigningKeyGeneration, 1) &&
    typeof authorization.signature === "string" && ED25519_SIGNATURE.test(authorization.signature);
}

function validAuditRecoveryRefreshResult(value: unknown): boolean {
  if (!exact(value, [
    "version", "ticketId", "ticketHash", "expiresAt", "state",
    "replacesVerifyTicketJti", "ticket",
  ]) || value.version !== 1 || value.state !== "RECOVERY_REFRESHED" ||
    !uuid(value.replacesVerifyTicketJti) || value.ticketId === value.replacesVerifyTicketJti
  ) return false;
  const ticket = value.ticket;
  return exact(ticket, [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
    "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
    "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
    "maintenancePrincipalId", "workItemId", "credentialGeneration", "leaseGeneration",
    "fencingToken", "recoveryKind", "recoveryGeneration", "replacesVerifyTicketJti",
    "frozenClaim", "auditRootId", "rootHash", "signatureHash", "auditSigningKeyGeneration",
    "auditSigningPublicKeyHash", "signature",
  ]) && ticket.version === 1 && ticket.aud === "openclaw-media-gateway" &&
    ticket.operation === "ANCHOR_VERIFY" && ticket.subject === "MAINTENANCE" &&
    uuid(ticket.jti) && ticket.jti === value.ticketId && uuid(ticket.organizationId) &&
    ticket.accountId === null && boundedString(ticket.objectKey, 1, 1_024) &&
    sha256(ticket.sha256) && ticket.contentType === "application/json" &&
    integer(ticket.contentLength, 1) && Number(ticket.contentLength) <= 52_428_800 &&
    ticket.sessionGeneration === 0 && integer(ticket.gatewayKeyGeneration, 1) &&
    integer(ticket.receiptSigningKeyGeneration, 1) && integer(ticket.iat) &&
    integer(ticket.exp) && Number(ticket.exp) > Number(ticket.iat) &&
    Number(ticket.exp) - Number(ticket.iat) <= 60 && uuid(ticket.maintenancePrincipalId) &&
    uuid(ticket.workItemId) && integer(ticket.credentialGeneration, 1) &&
    integer(ticket.leaseGeneration, 1) && integer(ticket.fencingToken, 1) &&
    ticket.recoveryKind === "AUDIT_VERIFY_AUTHORIZED" &&
    integer(ticket.recoveryGeneration, 1) &&
    ticket.replacesVerifyTicketJti === value.replacesVerifyTicketJti &&
    validFrozenMaintenanceClaim(ticket.frozenClaim) && uuid(ticket.auditRootId) &&
    sha256(ticket.rootHash) && sha256(ticket.signatureHash) &&
    integer(ticket.auditSigningKeyGeneration, 1) && sha256(ticket.auditSigningPublicKeyHash) &&
    typeof ticket.signature === "string" && ED25519_SIGNATURE.test(ticket.signature);
}

function validRetentionRecoveryRefreshResult(value: unknown): boolean {
  if (!exact(value, [
    "version", "ticketId", "ticketHash", "deleteAuthorizationJti", "expiresAt", "state",
    "replacesTicketJti", "replacesDeleteAuthorizationJti", "ticket", "authorization",
  ]) || value.version !== 1 || value.state !== "RECOVERY_REFRESHED" ||
    !uuid(value.replacesTicketJti) || !uuid(value.replacesDeleteAuthorizationJti) ||
    !object(value.ticket) || !object(value.authorization) ||
    value.ticket.jti === value.replacesTicketJti ||
    value.deleteAuthorizationJti === value.replacesDeleteAuthorizationJti ||
    value.authorization.deleteTicketJti !== value.ticket.jti
  ) return false;
  const ticket = value.ticket;
  const authorization = value.authorization;
  const ticketValid = exact(ticket, [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
    "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
    "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
    "maintenancePrincipalId", "workItemId", "credentialGeneration", "leaseGeneration",
    "fencingToken", "recoveryKind", "recoveryGeneration", "replacesTicketJti",
    "replacesDeleteAuthorizationJti", "frozenClaim", "deletePhase", "quarantineVersion",
    "finalDeleteNotBefore", "holdVersion", "signature",
  ]) && ticket.version === 1 && ticket.aud === "openclaw-media-gateway" &&
    ticket.operation === "DELETE" && ticket.subject === "MAINTENANCE" && uuid(ticket.jti) &&
    ticket.jti !== value.ticketId && uuid(ticket.organizationId) && ticket.accountId === null &&
    boundedString(ticket.objectKey, 1, 1_024) && sha256(ticket.sha256) &&
    boundedString(ticket.contentType, 3, 255) && integer(ticket.contentLength, 1) &&
    Number(ticket.contentLength) <= 52_428_800 && ticket.sessionGeneration === 0 &&
    integer(ticket.gatewayKeyGeneration, 1) && integer(ticket.receiptSigningKeyGeneration, 1) &&
    integer(ticket.iat) && integer(ticket.exp) && Number(ticket.exp) > Number(ticket.iat) &&
    Number(ticket.exp) - Number(ticket.iat) <= 60 && uuid(ticket.maintenancePrincipalId) &&
    uuid(ticket.workItemId) && integer(ticket.credentialGeneration, 1) &&
    integer(ticket.leaseGeneration, 1) && integer(ticket.fencingToken, 1) &&
    ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
    integer(ticket.recoveryGeneration, 1) && ticket.replacesTicketJti === value.replacesTicketJti &&
    ticket.replacesDeleteAuthorizationJti === value.replacesDeleteAuthorizationJti &&
    validFrozenMaintenanceClaim(ticket.frozenClaim) && ticket.deletePhase === "FINAL_DELETE" &&
    integer(ticket.quarantineVersion, 1) && integer(ticket.finalDeleteNotBefore) &&
    integer(ticket.holdVersion) && typeof ticket.signature === "string" &&
    ED25519_SIGNATURE.test(ticket.signature);
  const authorizationValid = exact(authorization, [
    "version", "authorizationKind", "organizationId", "maintenancePrincipalId", "workItemId",
    "credentialGeneration", "leaseGeneration", "fencingToken", "recoveryKind",
    "recoveryGeneration", "replacesTicketJti", "replacesDeleteAuthorizationJti",
    "frozenClaim", "objectKey", "deletePhase", "holdVersion", "quarantineVersion",
    "deleteTicketJti", "authorizationJti", "iat", "exp", "gatewaySigningKeyGeneration",
    "signature",
  ]) && authorization.version === 1 &&
    authorization.authorizationKind === "RETENTION_FINAL_DELETE" &&
    uuid(authorization.organizationId) && uuid(authorization.maintenancePrincipalId) &&
    authorization.workItemId === ticket.workItemId &&
    authorization.maintenancePrincipalId === ticket.maintenancePrincipalId &&
    authorization.credentialGeneration === ticket.credentialGeneration &&
    authorization.leaseGeneration === ticket.leaseGeneration &&
    authorization.fencingToken === ticket.fencingToken &&
    authorization.recoveryKind === ticket.recoveryKind &&
    authorization.recoveryGeneration === ticket.recoveryGeneration &&
    authorization.replacesTicketJti === value.replacesTicketJti &&
    authorization.replacesDeleteAuthorizationJti === value.replacesDeleteAuthorizationJti &&
    sameFrozenMaintenanceClaim(authorization.frozenClaim, ticket.frozenClaim) &&
    authorization.objectKey === ticket.objectKey && authorization.deletePhase === "FINAL_DELETE" &&
    authorization.holdVersion === ticket.holdVersion &&
    authorization.quarantineVersion === ticket.quarantineVersion &&
    authorization.deleteTicketJti === ticket.jti &&
    authorization.authorizationJti === value.deleteAuthorizationJti &&
    isoTimestamp(authorization.iat) && isoTimestamp(authorization.exp) &&
    Date.parse(authorization.exp) > Date.parse(authorization.iat) &&
    Date.parse(authorization.exp) - Date.parse(authorization.iat) <= 5_000 &&
    integer(authorization.gatewaySigningKeyGeneration, 1) &&
    typeof authorization.signature === "string" && ED25519_SIGNATURE.test(authorization.signature);
  return ticketValid && authorizationValid;
}

function validClaimRequest(value: unknown, allowedKinds: readonly string[]): boolean {
  return exact(value, ["version", "claimToken", "limit", "leaseSeconds", "requestedKinds"]) &&
    value.version === 1 && boundedString(value.claimToken, 32, 512) &&
    integer(value.limit, 1) && Number(value.limit) <= 25 &&
    integer(value.leaseSeconds, 5) && Number(value.leaseSeconds) <= 60 &&
    Array.isArray(value.requestedKinds) && value.requestedKinds.length > 0 &&
    value.requestedKinds.every((kind) => allowedKinds.includes(String(kind)));
}

function validRuntimeCommandResult(value: unknown): boolean {
  if (!object(value) || value.version !== 1 || !uuid(value.runtimeCommandId) ||
    !integer(value.claimGeneration, 1) || !boundedString(value.claimToken, 32, 512)
  ) return false;
  if (value.outcome === "PROVIDER_LOGGED_OUT") {
    return exact(value, [
      "version", "runtimeCommandId", "commandKind", "claimGeneration", "claimToken",
      "outcome", "result",
    ]) && value.commandKind === "DISCONNECT" && object(value.result) &&
      exact(value.result, [
        "version", "revocationId", "revokedSessionGeneration", "minimumSessionGeneration",
        "channel", "accountId", "credentialsCleared", "loggedOut", "status",
      ]) && value.result.version === 1 && uuid(value.result.revocationId) &&
      integer(value.result.revokedSessionGeneration, 1) &&
      integer(value.result.minimumSessionGeneration, 1) &&
      value.result.minimumSessionGeneration === Number(value.result.revokedSessionGeneration) + 1 &&
      value.result.channel === "zalouser" && uuid(value.result.accountId) &&
      value.result.credentialsCleared === false && value.result.loggedOut === true &&
      value.result.status === "PROVIDER_LOGGED_OUT";
  }
  return value.outcome === "FAILED" && exact(value, [
    "version", "runtimeCommandId", "commandKind", "claimGeneration", "claimToken",
    "outcome", "result",
  ]) && ["QR_LOGIN", "DISCONNECT"].includes(String(value.commandKind)) &&
    object(value.result) && exact(value.result, [
      "version", "reasonCode", "failureFingerprint", "status",
    ]) && value.result.version === 1 && reasonCode(value.result.reasonCode) &&
    sha256(value.result.failureFingerprint) && value.result.status === "FAILED_BEFORE_START";
}

function validRuntimeCommandStart(value: unknown): boolean {
  return exact(value, [
    "version", "runtimeCommandId", "commandKind", "claimGeneration", "claimToken", "payloadHash",
  ]) && value.version === 1 && uuid(value.runtimeCommandId) &&
    ["QR_LOGIN", "DISCONNECT"].includes(String(value.commandKind)) &&
    integer(value.claimGeneration, 1) && boundedString(value.claimToken, 32, 512) &&
    sha256(value.payloadHash);
}

function validRuntimeCommandResultAck(value: unknown): boolean {
  if (!exact(value, [
    "version", "runtimeCommandId", "commandKind", "claimGeneration", "outcome",
    "resultHash", "adoptSessionGeneration", "status",
  ]) || value.version !== 1 || !uuid(value.runtimeCommandId) ||
    !["QR_LOGIN", "DISCONNECT"].includes(String(value.commandKind)) ||
    !integer(value.claimGeneration, 1) || !sha256(value.resultHash) ||
    value.status !== "ACCEPTED"
  ) return false;
  return value.outcome === "PROVIDER_LOGGED_OUT"
    ? value.commandKind === "DISCONNECT" && integer(value.adoptSessionGeneration, 1)
    : value.outcome === "FAILED" && value.adoptSessionGeneration === null;
}

function validRuntimeCommandClaim(value: unknown): boolean {
  if (!exact(value, [
    "version", "runtimeCommandId", "commandKind", "commandVersion", "claimGeneration",
    "claimToken", "leaseExpiresAt", "sourceSessionGeneration", "targetSessionGeneration",
    "sourceConnectionGeneration", "targetConnectionGeneration", "expectedFencingToken",
    "executionState", "effectDeadlineAt", "payload", "payloadHash",
  ]) || value.version !== 1 || !uuid(value.runtimeCommandId) ||
    !["QR_LOGIN", "DISCONNECT"].includes(String(value.commandKind)) ||
    !integer(value.commandVersion, 1) || !integer(value.claimGeneration, 1) ||
    !boundedString(value.claimToken, 32, 512) || !isoTimestamp(value.leaseExpiresAt) ||
    !integer(value.sourceSessionGeneration, 1) || !integer(value.targetSessionGeneration, 1) ||
    !integer(value.sourceConnectionGeneration) || !integer(value.targetConnectionGeneration) ||
    !integer(value.expectedFencingToken, 1) ||
    !["LEASED", "STARTED"].includes(String(value.executionState)) ||
    !(value.effectDeadlineAt === null || isoTimestamp(value.effectDeadlineAt)) ||
    !sha256(value.payloadHash) || !object(value.payload)
  ) return false;
  return value.commandKind === "QR_LOGIN"
    ? exact(value.payload, ["version", "challengeId", "browserNonceHash"]) &&
      value.payload.version === 1 && uuid(value.payload.challengeId) &&
      sha256(value.payload.browserNonceHash)
    : exact(value.payload, [
        "version", "reasonCode", "revocationId", "revokedSessionGeneration",
        "minimumSessionGeneration",
      ]) && value.payload.version === 1 && reasonCode(value.payload.reasonCode) &&
      uuid(value.payload.revocationId) && integer(value.payload.revokedSessionGeneration, 1) &&
      integer(value.payload.minimumSessionGeneration, 1) &&
      value.payload.minimumSessionGeneration === Number(value.payload.revokedSessionGeneration) + 1;
}

function validHeartbeatRequest(value: unknown): boolean {
  if (!exact(value, [
    "version", "commandClaimToken", "commandLeaseSeconds", "commandStarts", "commandResults",
  ], ["severity", "healthKind", "status", "fingerprint", "contentFreeMetrics"]) ||
    value.version !== 1 || !boundedString(value.commandClaimToken, 32, 512) ||
    !integer(value.commandLeaseSeconds, 5) || Number(value.commandLeaseSeconds) > 60 ||
    !Array.isArray(value.commandStarts) || value.commandStarts.length > 8 ||
    !value.commandStarts.every(validRuntimeCommandStart) ||
    !Array.isArray(value.commandResults) || value.commandResults.length > 8 ||
    !value.commandResults.every(validRuntimeCommandResult)
  ) return false;
  return ["severity", "healthKind", "status", "fingerprint"].every((key) =>
    !(key in value) || boundedString(value[key], 1, 128)
  ) && (!("contentFreeMetrics" in value) || object(value.contentFreeMetrics));
}

const CAPACITY_CONTROLS = [
  "DISABLE_AUTOMATIC_VIDEO_FILE_CACHE",
  "PAUSE_NONCRITICAL_PROACTIVE_GROUP_MEDIA",
  "PAUSE_ALL_OUTBOUND_MEDIA",
  "PAUSE_OUTBOUND_AI_MEDIA",
] as const;

/**
 * Capacity controls ride back to the cell in the heartbeat response, which is the
 * only channel it already polls. The response contract is exact-keyed, so this
 * validator must exist for the key to survive at all - without it every heartbeat
 * fails RUNTIME_RESPONSE_INVALID and the whole runtime stops.
 */
function validCapacityControl(value: unknown): boolean {
  return exact(value, ["control", "appliedAt", "reasonFingerprint", "requiresManualResume"]) &&
    CAPACITY_CONTROLS.includes(String(value.control) as (typeof CAPACITY_CONTROLS)[number]) &&
    isoTimestamp(value.appliedAt) && boundedString(value.reasonFingerprint, 1, 128) &&
    typeof value.requiresManualResume === "boolean";
}

function validHeartbeatResult(value: unknown): boolean {
  return exact(value, [
    "version", "organizationId", "accountId", "cellId", "observedAt", "accepted", "authMode",
    "currentSessionGeneration", "currentConnectionGeneration", "commandResultAcks", "commands",
  ], ["capacityControls"]) &&
    // OPTIONAL on purpose. The Edge function and the migration deploy separately, so
    // a required key breaks heartbeats in BOTH orders: new Edge against old SQL sees
    // it missing, old Edge against new SQL sees an unexpected key. Optional accepts
    // either side being ahead, and still validates the payload whenever it is present.
    (!("capacityControls" in value) || (
      Array.isArray(value.capacityControls) &&
      value.capacityControls.length <= CAPACITY_CONTROLS.length &&
      value.capacityControls.every(validCapacityControl)
    )) &&
    value.version === 1 && uuid(value.organizationId) && uuid(value.accountId) &&
    uuid(value.cellId) && isoTimestamp(value.observedAt) && value.accepted === true &&
    ["NORMAL", "COMMAND_TRANSITION"].includes(String(value.authMode)) &&
    integer(value.currentSessionGeneration, 1) && integer(value.currentConnectionGeneration) &&
    Array.isArray(value.commandResultAcks) && value.commandResultAcks.length <= 8 &&
    value.commandResultAcks.every(validRuntimeCommandResultAck) &&
    Array.isArray(value.commands) && value.commands.length <= 8 &&
    value.commands.every(validRuntimeCommandClaim);
}

const TEMPLATE_FIELDS = new Set([
  "customerName", "roomCode", "buildingName", "amountDue", "dueDate", "invoiceCode",
  "meterReading", "periodLabel", "contactPhoneMasked",
]);

function validCurrentWorkState(value: unknown): boolean {
  if (!object(value) || typeof value.allowed !== "boolean") return false;
  return value.allowed
    ? exact(value, ["allowed"]) && value.allowed === true
    : exact(value, ["allowed", "reasonCode"]) && value.allowed === false &&
      typeof value.reasonCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.reasonCode);
}

function validTemplateValues(value: unknown): boolean {
  return object(value) && Object.keys(value).every((key) => TEMPLATE_FIELDS.has(key)) &&
    Object.values(value).every((entry) => typeof entry === "string" && entry.length <= 4_000);
}

function validRequiredFields(value: unknown): boolean {
  return Array.isArray(value) && value.length <= TEMPLATE_FIELDS.size &&
    value.every((entry) => typeof entry === "string" && TEMPLATE_FIELDS.has(entry)) &&
    new Set(value).size === value.length;
}

function validKnowledgeChunks(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 50 && value.every((chunk) =>
    exact(chunk, ["chunkId", "versionId", "sensitivity", "text"]) &&
    uuid(chunk.chunkId) && uuid(chunk.versionId) &&
    ["CUSTOMER_SAFE", "INTERNAL_REVIEW_ONLY", "RESTRICTED"].includes(String(chunk.sensitivity)) &&
    boundedString(chunk.text, 1, 4_000)
  );
}

function validAllowedCrmFields(value: unknown): boolean {
  return Array.isArray(value) && value.length <= TEMPLATE_FIELDS.size &&
    value.every((entry) => typeof entry === "string" && TEMPLATE_FIELDS.has(entry)) &&
    new Set(value).size === value.length;
}

function validWorkContextResult(value: unknown): boolean {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024) return false;
  if (!exact(value, [
    "version", "workItemId", "claimGeneration", "kind", "currentState", "frozenContext",
  ]) || value.version !== 1 || !uuid(value.workItemId) ||
    !integer(value.claimGeneration, 1) || !validCurrentWorkState(value.currentState) ||
    !object(value.frozenContext)
  ) return false;
  const context = value.frozenContext;
  if (value.kind === "INBOUND_AUTOMATION") {
    return exact(context, [
      "customerText", "knowledgeChunks", "canonicalPayload", "sourceSnapshotHash",
    ]) && typeof context.customerText === "string" && context.customerText.length <= 32_768 &&
      validKnowledgeChunks(context.knowledgeChunks) && validCanonicalPayload(context.canonicalPayload) &&
      sha256(context.sourceSnapshotHash) &&
      context.canonicalPayload.frozenInputs.sourceSnapshotHash === context.sourceSnapshotHash;
  }
  if (value.kind === "SCHEDULE_OCCURRENCE") return exact(context, [
    "frozenIdentity", "template", "values", "requiredFields", "canonicalPayload",
    "sourceSnapshotHash",
  ]) && validSendWorkPayload(context.frozenIdentity) &&
    context.frozenIdentity.kind === value.kind && boundedString(context.template, 1, 32_768) &&
    validTemplateValues(context.values) && validRequiredFields(context.requiredFields) &&
    validCanonicalPayload(context.canonicalPayload) && sha256(context.sourceSnapshotHash) &&
    context.canonicalPayload.frozenInputs.sourceSnapshotHash === context.sourceSnapshotHash;
  if (value.kind !== "CRM_EVENT") return false;
  return exact(context, [
    "frozenIdentity", "template", "values", "requiredFields", "allowedCrmFields",
    "canonicalPayload", "sourceSnapshotHash",
  ]) && validSendWorkPayload(context.frozenIdentity) && context.frozenIdentity.kind === "CRM_EVENT" &&
    boundedString(context.template, 1, 32_768) && validTemplateValues(context.values) &&
    validRequiredFields(context.requiredFields) && validAllowedCrmFields(context.allowedCrmFields) &&
    validCanonicalPayload(context.canonicalPayload) && sha256(context.sourceSnapshotHash) &&
    context.canonicalPayload.frozenInputs.sourceSnapshotHash === context.sourceSnapshotHash &&
    context.canonicalPayload.frozenInputs.fieldMappingHash === context.frozenIdentity.fieldMappingHash &&
    context.canonicalPayload.automationVersionId === context.frozenIdentity.automationVersionId;
}

function validInboundMediaMapping(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 20 && value.every((entry, index) =>
    exact(entry, ["manifestIndex", "mediaId"]) && entry.manifestIndex === index && uuid(entry.mediaId)
  );
}

function validInboundBatchResult(value: unknown): boolean {
  if (!exact(value, [
    "version", "requestId", "accepted", "deduplicated", "quarantined", "results",
  ]) || value.version !== 1 || !uuid(value.requestId) || !integer(value.accepted) ||
    !integer(value.deduplicated) || !integer(value.quarantined) || !Array.isArray(value.results)
  ) return false;
  let accepted = 0;
  let deduplicated = 0;
  let quarantined = 0;
  const indexes = new Set<number>();
  for (const result of value.results) {
    if (!object(result) || !integer(result.index) || Number(result.index) >= value.results.length ||
      indexes.has(Number(result.index))) return false;
    indexes.add(Number(result.index));
    if (result.status === "ACCEPTED") {
      if (!exact(result, [
        "index", "status", "inboundEventId", "messageId", "decisionId", "decisionKind",
        "noSendReason", "workItemId", "media",
      ]) || !uuid(result.inboundEventId) || !uuid(result.messageId) || !uuid(result.decisionId) ||
        !["NO_SEND", "WORK_ELIGIBLE"].includes(String(result.decisionKind)) ||
        !(result.noSendReason === null || boundedString(result.noSendReason, 1, 128)) ||
        !(result.workItemId === null || uuid(result.workItemId)) ||
        !validInboundMediaMapping(result.media) ||
        (result.decisionKind === "WORK_ELIGIBLE") !== (result.workItemId !== null)
      ) return false;
      accepted += 1;
    } else if (result.status === "DUPLICATE") {
      if (!exact(result, ["index", "status", "inboundEventId", "media"]) ||
        !uuid(result.inboundEventId) || !validInboundMediaMapping(result.media)
      ) return false;
      deduplicated += 1;
    } else if (result.status === "QUARANTINED") {
      if (!exact(result, ["index", "status", "collisionKind"]) || ![
        "CROSS_KIND", "PAIR_MISMATCH", "PAYLOAD_MISMATCH", "FINGERPRINT_COLLISION",
      ].includes(String(result.collisionKind))) return false;
      quarantined += 1;
    } else return false;
  }
  return accepted === value.accepted && deduplicated === value.deduplicated &&
    quarantined === value.quarantined && indexes.size === value.results.length;
}

export function validateRuntimeRequestBody(path: string, value: unknown): boolean {
  switch (path) {
    case "/v1/heartbeat":
      return validHeartbeatRequest(value);
    case "/v1/qr/publish":
      return exact(value, [
        "version", "challengeId", "runtimeCommandId", "claimGeneration", "claimToken",
        "ciphertextB64", "cipherIvB64", "authTagB64",
      ]) && value.version === 1 && uuid(value.challengeId) && uuid(value.runtimeCommandId) &&
        integer(value.claimGeneration, 1) && boundedString(value.claimToken, 32, 512) &&
        boundedString(value.ciphertextB64, 4, 240_000) &&
        boundedString(value.cipherIvB64, 16, 32) && boundedString(value.authTagB64, 20, 32);
    case "/v1/qr/result":
      return exact(value, ["version", "challengeId"]) && value.version === 1 && uuid(value.challengeId);
    case "/v1/outbox/claim":
      return exact(value, ["version", "claimToken", "limit", "leaseSeconds"]) &&
        value.version === 1 && boundedString(value.claimToken, 32, 512) &&
        integer(value.limit, 1) && Number(value.limit) <= 25 &&
        integer(value.leaseSeconds, 5) && Number(value.leaseSeconds) <= 60;
    case "/v1/outbox/preflight":
      return exact(value, ["version", "outboxId", "claimGeneration", "claimToken"]) &&
        value.version === 1 && uuid(value.outboxId) && integer(value.claimGeneration, 1) &&
        boundedString(value.claimToken, 32, 512);
    case "/v1/outbox/authorize-send":
      return validAuthorization(value);
    case "/v1/outbox/requeue":
      return validPreHandoffRequeue(value);
    case "/v1/outbox/complete":
      return validOutboxCompletion(value);
    case "/v1/work/claim":
      return validClaimRequest(value, ["INBOUND_AUTOMATION", "SCHEDULE_OCCURRENCE", "CRM_EVENT"]);
    case "/v1/work/context":
      return exact(value, ["version", "claim"]) && value.version === 1 &&
        validWorkClaim(value.claim, "CHANNEL");
    case "/v1/maintenance/work/claim":
      return validClaimRequest(value, ["RETENTION_DELETE", "AUDIT_ANCHOR"]);
    case "/v1/work/complete":
      return validSendWorkCompletion(value);
    case "/v1/maintenance/work/complete":
      return validMaintenanceCompletion(value);
    case "/v1/work/create-outbox":
      return exact(value, [
        "version", "principalKind", "claim", "canonicalPayload", "payloadHash", "sourceSnapshotHash",
      ]) && value.version === 1 && value.principalKind === "CHANNEL" &&
        validWorkClaim(value.claim, "CHANNEL") && validCanonicalPayload(value.canonicalPayload) &&
        sha256(value.payloadHash) && sha256(value.sourceSnapshotHash);
    case "/v1/media/upload-ticket":
      return exact(value, [
        "version", "mediaId", "operation", "verifiedSha256", "contentType", "contentLength",
      ]) && value.version === 1 && uuid(value.mediaId) && value.operation === "PUT" &&
        sha256(value.verifiedSha256) && boundedString(value.contentType, 1, 255) &&
        integer(value.contentLength, 1) && Number(value.contentLength) <= 52_428_800;
    case "/v1/media/upload-complete":
      return exact(value, ["version", "mediaId", "gatewayReceipt"]) && value.version === 1 &&
        uuid(value.mediaId) && validMediaUploadReceipt(value.gatewayReceipt) &&
        value.mediaId === value.gatewayReceipt.mediaId;
    case "/v1/maintenance/media/upload-ticket":
    case "/v1/maintenance/media/verify-ticket":
      if (path.endsWith("verify-ticket") && object(value) && "recoveryKind" in value) {
        return validAuditRecoveryRefreshRequest(value);
      }
      return exact(value, [
        "version", "operation", "workItemId", "claimGeneration", "claimToken", "auditRootId",
        "rootHash", "anchorKey", "signatureHash", "auditSigningKeyGeneration", "documentSha256",
        "auditSigningPublicKeyHash", "documentByteLength",
      ]) && value.version === 1 && uuid(value.workItemId) && integer(value.claimGeneration, 1) &&
        boundedString(value.claimToken, 32, 512) && uuid(value.auditRootId) &&
        sha256(value.rootHash) && boundedString(value.anchorKey, 1, 1_024) &&
        sha256(value.signatureHash) && integer(value.auditSigningKeyGeneration, 1) &&
        sha256(value.auditSigningPublicKeyHash) &&
        sha256(value.documentSha256) && integer(value.documentByteLength, 1) &&
        Number(value.documentByteLength) <= 52_428_800 &&
        value.operation === (path.endsWith("verify-ticket") ? "ANCHOR_VERIFY" : "ANCHOR");
    case "/v1/maintenance/retention/delete-ticket":
      return validRetentionDeleteAuthorizationRequest(value);
    case "/v1/maintenance/retention/authorize-delete":
      return object(value) && "recoveryKind" in value
        ? validRetentionRecoveryRefreshRequest(value)
        : validRetentionDeleteAuthorizationRequest(value);
    default:
      return false;
  }
}

function onlyVersionedObject(value: unknown): boolean {
  return versionOne(value);
}

export function validateRuntimeResponseBody(path: string, value: unknown): boolean {
  if (!versionOne(value)) return false;
  switch (path) {
    case "/v1/heartbeat":
      return validHeartbeatResult(value);
    case "/v1/inbound/batch":
      return validInboundBatchResult(value);
    case "/v1/outbox/claim":
      return exact(value, ["version", "items"]) && Array.isArray(value.items) &&
        value.items.length <= 25 && value.items.every(validOutboxClaim);
    case "/v1/outbox/preflight":
      return validOutboxPreflightResult(value);
    case "/v1/work/claim":
      return exact(value, ["version", "items"]) && Array.isArray(value.items) &&
        value.items.length <= 25 && value.items.every((item) => validWorkClaim(item, "CHANNEL"));
    case "/v1/work/context":
      return validWorkContextResult(value);
    case "/v1/maintenance/work/claim":
      return exact(value, ["version", "items", "unresolvedFailures"]) &&
        Array.isArray(value.items) && value.items.length <= 25 &&
        value.items.every((item) => validWorkClaim(item, "MAINTENANCE")) &&
        object(value.unresolvedFailures) && exact(value.unresolvedFailures, [
          "retentionDelete", "auditAnchor",
        ]) && integer(value.unresolvedFailures.retentionDelete) &&
        integer(value.unresolvedFailures.auditAnchor);
    case "/v1/work/complete":
    case "/v1/work/create-outbox":
      return validWorkCompletionResult(value);
    case "/v1/maintenance/work/complete":
      return validSpecializedMaintenanceResult(value);
    case "/v1/maintenance/retention/delete-ticket":
      return validRetentionDeleteTicketResult(value);
    case "/v1/media/upload-ticket":
      return validMediaTicketResult(value, "RUNTIME");
    case "/v1/media/upload-complete":
      return exact(value, ["version", "mediaId", "byteState", "receiptHash", "idempotentReplay"]) &&
        value.version === 1 && uuid(value.mediaId) && value.byteState === "AVAILABLE" &&
        sha256(value.receiptHash) && typeof value.idempotentReplay === "boolean";
    case "/v1/maintenance/media/upload-ticket":
    case "/v1/maintenance/media/verify-ticket":
      return path.endsWith("verify-ticket") && object(value) && value.state === "RECOVERY_REFRESHED"
        ? validAuditRecoveryRefreshResult(value)
        : validMediaTicketResult(value, "MAINTENANCE");
    case "/v1/maintenance/retention/authorize-delete":
      return object(value) && value.state === "RECOVERY_REFRESHED"
        ? validRetentionRecoveryRefreshResult(value)
        : validRetentionDeleteAuthorizationResult(value);
    default:
      return onlyVersionedObject(value);
  }
}
