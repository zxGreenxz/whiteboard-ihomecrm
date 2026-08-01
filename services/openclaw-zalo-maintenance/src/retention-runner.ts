import { canonicalJson, sha256Hex } from "./runtime-client.js";
import { timestamp } from "./timestamp.js";
import { MaintenanceRetryableWorkError } from "./work-error.js";

export type RetentionSubjectKind =
  | "MESSAGE"
  | "AI_DRAFT"
  | "MEDIA"
  | "KNOWLEDGE"
  | "HEALTH"
  | "QR"
  | "AUDIT"
  | "POLICY"
  | "CONTROL"
  | "DELIVERY"
  | "UNKNOWN"
  | "SECURITY"
  | "CONSENT"
  | "RISK";

export type FinalDeleteWorkPayloadV1 = Readonly<{
  kind: "RETENTION_DELETE";
  deletePhase: "FINAL_DELETE";
  subjectKind: "MEDIA";
  subjectId: string;
  objectKey: string;
  retentionVersion: number;
  holdVersion: number;
  quarantineVersion: number;
  finalDeleteNotBefore: string;
}>;

export type RetentionWorkPayloadV1 =
  | Readonly<{
      kind: "RETENTION_DELETE";
      deletePhase: "QUARANTINE";
      subjectKind: RetentionSubjectKind;
      subjectId: string;
      retentionVersion: number;
      holdVersion: number;
    }>
  | FinalDeleteWorkPayloadV1;

export interface AuditWorkPayloadV1 {
  kind: "AUDIT_ANCHOR";
  auditRootId: string;
  rootDate: string;
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
  previousRootHash: string | null;
  merkleRootHash: string;
  rootHash: string;
  auditSigningKeyGeneration: number;
  auditSigningPublicKeyHash: string;
  anchorKey: string;
}

export interface MaintenanceWorkClaimV1 {
  version: 1;
  workItemId: string;
  organizationId: string;
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  sourceKey: string;
  claimToken: string;
  claimGeneration: number;
  fencingToken: number;
  leaseExpiresAt: string;
  payload: RetentionWorkPayloadV1 | AuditWorkPayloadV1;
}

export interface RetentionDeleteAuthorizedRecoveryV1 {
  version: 1;
  recoveryKind: "RETENTION_DELETE_AUTHORIZED";
  workItemId: string;
  organizationId: string;
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  sourceKey: string;
  claimToken: string;
  recoveryGeneration: number;
  recoveryLeaseExpiresAt: string;
  frozenClaim: Readonly<{
    maintenancePrincipalId: string;
    credentialGeneration: number;
    leaseGeneration: number;
    fencingToken: number;
    claimGeneration: number;
  }>;
  payload: FinalDeleteWorkPayloadV1;
  ticketId: string;
  ticketHash: string;
  ticket: Record<string, unknown>;
  authorizationHash: string;
  authorization: Record<string, unknown>;
  authorizationExpiresAt: string;
  gatewayReceipt: RetentionDeleteReceiptV1 | null;
}

export interface AuditVerifyAuthorizedRecoveryV1 {
  version: 1;
  recoveryKind: "AUDIT_VERIFY_AUTHORIZED";
  workItemId: string;
  organizationId: string;
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  sourceKey: string;
  claimToken: string;
  recoveryGeneration: number;
  recoveryLeaseExpiresAt: string;
  frozenClaim: Readonly<{
    maintenancePrincipalId: string;
    credentialGeneration: number;
    leaseGeneration: number;
    fencingToken: number;
    claimGeneration: number;
  }>;
  payload: AuditWorkPayloadV1;
  verifyTicketId: string;
  verifyTicketHash: string;
  verifyTicket: Record<string, unknown>;
  gatewayReceipt: Record<string, unknown> | null;
}

export type MaintenanceClaimItemV1 =
  | MaintenanceWorkClaimV1
  | RetentionDeleteAuthorizedRecoveryV1
  | AuditVerifyAuthorizedRecoveryV1;

export interface RetentionDeleteReceiptV1 {
  version: 1;
  receiptKind: "RETENTION_FINAL_DELETE";
  receiptId: string;
  organizationId: string;
  maintenancePrincipalId: string;
  workItemId: string;
  claimGeneration: number;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  objectKey: string;
  deletePhase: "FINAL_DELETE";
  holdVersion: number;
  quarantineVersion: number;
  deleteTicketJti: string;
  deleteAuthorizationJti: string;
  proofJti: string;
  objectStatus: "DELETED" | "NOT_FOUND";
  r2VersionOrEtag: string | null;
  completedAt: string;
  gatewaySigningKeyGeneration: number;
  signature: string;
}

export interface MaintenanceRuntimePort {
  post(
    path: string,
    body: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
}

export interface RetentionGatewayPort {
  deleteObject(request: Readonly<{
    ticketHeader: string;
    deleteAuthorizationHeader: string;
  }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const JTI = /^[A-Za-z0-9_-]{16,128}$/u;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  const result = record(value, name);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has non-canonical fields`);
  }
  return result;
}

function integer(value: unknown, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function string(value: unknown, pattern: RegExp | null, name: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function encodeSignedHeader(value: unknown): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

interface DeleteTicketResult {
  ticketId: string;
  ticketHash: string;
  deleteTicketJti: string;
  gatewaySigningKeyGeneration: number;
  receiptSigningKeyGeneration: number;
  ticket: Record<string, unknown>;
}

interface RetentionRecoveryArtifactContext {
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  recoveryGeneration: number;
  frozenClaim: RetentionDeleteAuthorizedRecoveryV1["frozenClaim"];
  oldTicketJti: string;
  oldAuthorizationJti: string;
}

function parseDeleteTicketResult(
  value: unknown,
  claim: MaintenanceWorkClaimV1,
  now: Date,
  allowExpired = false,
  recovery?: RetentionRecoveryArtifactContext,
): DeleteTicketResult {
  const result = exact(value, [
    "version", "ticketId", "ticketHash", "expiresAt", "state", "ticket",
  ], "delete ticket result");
  if (result.version !== 1 || result.state !== "TICKET_ISSUED") {
    throw new TypeError("delete ticket result state is invalid");
  }
  const ticketId = string(result.ticketId, UUID, "ticketId");
  const ticketHash = string(result.ticketHash, SHA256, "ticketHash");
  const resultExpiresAt = timestamp(result.expiresAt, "ticket.expiresAt");
  const normalTicketKeys = [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
    "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
    "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
    "maintenancePrincipalId", "workItemId",
    "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken",
    "deletePhase", "holdVersion", "quarantineVersion", "finalDeleteNotBefore", "signature",
  ] as const;
  const recoveryTicketKeys = [
    "version", "aud", "operation", "subject", "jti", "organizationId", "accountId",
    "objectKey", "sha256", "contentType", "contentLength", "sessionGeneration",
    "gatewayKeyGeneration", "receiptSigningKeyGeneration", "iat", "exp",
    "maintenancePrincipalId", "workItemId", "credentialGeneration", "leaseGeneration",
    "fencingToken", "recoveryKind", "recoveryGeneration", "replacesTicketJti",
    "replacesDeleteAuthorizationJti", "frozenClaim", "deletePhase", "holdVersion",
    "quarantineVersion", "finalDeleteNotBefore", "signature",
  ] as const;
  const ticket = exact(
    result.ticket,
    recovery === undefined ? normalTicketKeys : recoveryTicketKeys,
    "delete ticket",
  );
  const payload = claim.payload;
  let admissionMatches: boolean;
  if (recovery === undefined) {
    admissionMatches = ticket.maintenancePrincipalId === claim.maintenancePrincipalId &&
      ticket.claimGeneration === claim.claimGeneration &&
      ticket.credentialGeneration === claim.credentialGeneration &&
      ticket.leaseGeneration === claim.leaseGeneration &&
      ticket.fencingToken === claim.fencingToken;
  } else {
    const frozenClaim = exact(ticket.frozenClaim, [
      "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
      "claimGeneration",
    ], "delete recovery ticket frozen claim");
    admissionMatches = ticket.maintenancePrincipalId === recovery.maintenancePrincipalId &&
      ticket.credentialGeneration === recovery.credentialGeneration &&
      ticket.leaseGeneration === recovery.leaseGeneration &&
      ticket.fencingToken === recovery.fencingToken &&
      ticket.recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
      ticket.recoveryGeneration === recovery.recoveryGeneration &&
      ticket.replacesTicketJti === recovery.oldTicketJti &&
      ticket.replacesDeleteAuthorizationJti === recovery.oldAuthorizationJti &&
      frozenClaim.maintenancePrincipalId === recovery.frozenClaim.maintenancePrincipalId &&
      frozenClaim.credentialGeneration === recovery.frozenClaim.credentialGeneration &&
      frozenClaim.leaseGeneration === recovery.frozenClaim.leaseGeneration &&
      frozenClaim.fencingToken === recovery.frozenClaim.fencingToken &&
      frozenClaim.claimGeneration === recovery.frozenClaim.claimGeneration;
  }
  if (
    payload.kind !== "RETENTION_DELETE" || payload.deletePhase !== "FINAL_DELETE" ||
    ticket.version !== 1 || ticket.aud !== "openclaw-media-gateway" ||
    ticket.operation !== "DELETE" || ticket.subject !== "MAINTENANCE" ||
    ticket.accountId !== null ||
    ticket.organizationId !== claim.organizationId ||
    ticket.workItemId !== claim.workItemId || !admissionMatches ||
    ticket.objectKey !== payload.objectKey || ticket.deletePhase !== "FINAL_DELETE" ||
    ticket.holdVersion !== payload.holdVersion ||
    ticket.quarantineVersion !== payload.quarantineVersion ||
    !Number.isSafeInteger(ticket.gatewayKeyGeneration) || Number(ticket.gatewayKeyGeneration) < 1
  ) {
    throw new TypeError("delete ticket claim mismatch");
  }
  string(ticket.sha256, SHA256, "ticket.sha256");
  string(ticket.signature, SIGNATURE, "ticket.signature");
  string(ticket.contentType, null, "ticket.contentType");
  integer(ticket.contentLength, 1, "ticket.contentLength");
  integer(ticket.sessionGeneration, 0, "ticket.sessionGeneration");
  const issuedAt = integer(ticket.iat, 1, "ticket.iat");
  const expiresAt = integer(ticket.exp, 1, "ticket.exp");
  const deleteTicketJti = string(ticket.jti, JTI, "ticket.jti");
  const gatewaySigningKeyGeneration = integer(
    ticket.gatewayKeyGeneration,
    1,
    "ticket.gatewayKeyGeneration",
  );
  const receiptSigningKeyGeneration = integer(
    ticket.receiptSigningKeyGeneration,
    1,
    "ticket.receiptSigningKeyGeneration",
  );
  const payloadFinalDeleteAt = Math.floor(Date.parse(payload.finalDeleteNotBefore) / 1_000);
  const { signature: _signature, ...unsignedTicket } = ticket;
  const expectedTicketHash = sha256Hex(
    `ihome-openclaw-retention-delete-ticket-v1\0${canonicalJson(unsignedTicket)}`,
  );
  if (ticketHash !== expectedTicketHash) {
    throw new TypeError("delete ticket hash mismatch");
  }
  if (
    ticketId === deleteTicketJti || ticket.finalDeleteNotBefore !== payloadFinalDeleteAt ||
    Date.parse(resultExpiresAt) !== expiresAt * 1_000
  ) {
    throw new TypeError("delete ticket expiry mismatch");
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 60) {
    throw new TypeError("delete ticket lifetime is invalid");
  }
  if (
    !allowExpired &&
    (now.getTime() < issuedAt * 1_000 - 5_000 || now.getTime() >= expiresAt * 1_000)
  ) throw new MaintenanceRetryableWorkError("delete ticket lifetime is not active");
  return {
    ticketId,
    ticketHash,
    deleteTicketJti,
    gatewaySigningKeyGeneration,
    receiptSigningKeyGeneration,
    ticket,
  };
}

function parseDeleteAuthorization(
  value: unknown,
  claim: MaintenanceWorkClaimV1,
  ticket: DeleteTicketResult,
  now: Date,
  allowExpired = false,
  recovery?: RetentionRecoveryArtifactContext,
): Record<string, unknown> {
  const envelope = exact(value, [
    "version", "ticketId", "ticketHash", "deleteAuthorizationJti", "expiresAt", "state",
    "authorization",
  ], "delete authorization result");
  if (
    envelope.version !== 1 || envelope.ticketId !== ticket.ticketId ||
    envelope.state !== "DELETE_AUTHORIZED"
  ) throw new TypeError("delete authorization result version is invalid");
  const authorizationTicketHash = string(
    envelope.ticketHash,
    SHA256,
    "authorization ticketHash",
  );
  if (authorizationTicketHash !== ticket.ticketHash) {
    throw new TypeError("delete authorization ticket hash mismatch");
  }
  const resultAuthorizationJti = string(
    envelope.deleteAuthorizationJti,
    JTI,
    "deleteAuthorizationJti",
  );
  const resultExpiresAt = timestamp(envelope.expiresAt, "authorization result expiresAt");
  const normalAuthorizationKeys = [
    "version", "authorizationKind", "organizationId", "maintenancePrincipalId", "workItemId",
    "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken", "objectKey",
    "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti", "authorizationJti",
    "iat", "exp", "gatewaySigningKeyGeneration", "signature",
  ] as const;
  const recoveryAuthorizationKeys = [
    "version", "authorizationKind", "organizationId", "maintenancePrincipalId", "workItemId",
    "credentialGeneration", "leaseGeneration", "fencingToken", "recoveryKind",
    "recoveryGeneration", "replacesTicketJti", "replacesDeleteAuthorizationJti", "frozenClaim",
    "objectKey", "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti",
    "authorizationJti", "iat", "exp", "gatewaySigningKeyGeneration", "signature",
  ] as const;
  const proof = exact(
    envelope.authorization,
    recovery === undefined ? normalAuthorizationKeys : recoveryAuthorizationKeys,
    "delete authorization",
  );
  const payload = claim.payload;
  let admissionMatches: boolean;
  if (recovery === undefined) {
    admissionMatches = proof.maintenancePrincipalId === claim.maintenancePrincipalId &&
      proof.claimGeneration === claim.claimGeneration &&
      proof.credentialGeneration === claim.credentialGeneration &&
      proof.leaseGeneration === claim.leaseGeneration &&
      proof.fencingToken === claim.fencingToken;
  } else {
    const frozenClaim = exact(proof.frozenClaim, [
      "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
      "claimGeneration",
    ], "delete recovery authorization frozen claim");
    admissionMatches = proof.maintenancePrincipalId === recovery.maintenancePrincipalId &&
      proof.credentialGeneration === recovery.credentialGeneration &&
      proof.leaseGeneration === recovery.leaseGeneration &&
      proof.fencingToken === recovery.fencingToken &&
      proof.recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
      proof.recoveryGeneration === recovery.recoveryGeneration &&
      proof.replacesTicketJti === recovery.oldTicketJti &&
      proof.replacesDeleteAuthorizationJti === recovery.oldAuthorizationJti &&
      frozenClaim.maintenancePrincipalId === recovery.frozenClaim.maintenancePrincipalId &&
      frozenClaim.credentialGeneration === recovery.frozenClaim.credentialGeneration &&
      frozenClaim.leaseGeneration === recovery.frozenClaim.leaseGeneration &&
      frozenClaim.fencingToken === recovery.frozenClaim.fencingToken &&
      frozenClaim.claimGeneration === recovery.frozenClaim.claimGeneration;
  }
  if (
    payload.kind !== "RETENTION_DELETE" || payload.deletePhase !== "FINAL_DELETE" ||
    proof.version !== 1 || proof.authorizationKind !== "RETENTION_FINAL_DELETE" ||
    proof.organizationId !== claim.organizationId ||
    proof.workItemId !== claim.workItemId || !admissionMatches ||
    proof.objectKey !== payload.objectKey || proof.deletePhase !== "FINAL_DELETE" ||
    proof.holdVersion !== payload.holdVersion ||
    proof.quarantineVersion !== payload.quarantineVersion ||
    proof.deleteTicketJti !== ticket.deleteTicketJti ||
    proof.authorizationJti !== resultAuthorizationJti ||
    proof.gatewaySigningKeyGeneration !== ticket.gatewaySigningKeyGeneration
  ) {
    throw new TypeError("delete authorization claim mismatch");
  }
  string(proof.signature, SIGNATURE, "delete authorization signature");
  const issuedAt = Date.parse(timestamp(proof.iat, "authorization.iat"));
  const expiresAt = Date.parse(timestamp(proof.exp, "authorization.exp"));
  if (
    Date.parse(resultExpiresAt) !== expiresAt ||
    expiresAt <= issuedAt || expiresAt - issuedAt > 5_000
  ) {
    throw new TypeError("delete authorization lifetime is invalid");
  }
  if (
    !allowExpired && (now.getTime() < issuedAt - 5_000 || now.getTime() >= expiresAt)
  ) throw new MaintenanceRetryableWorkError(
    "delete authorization lifetime is not active",
  );
  return proof;
}

async function parseRetentionReceipt(
  value: unknown,
  claim: MaintenanceWorkClaimV1,
  ticket: DeleteTicketResult,
  authorization: Record<string, unknown>,
): Promise<RetentionDeleteReceiptV1> {
  const receipt = exact(value, [
    "version", "receiptKind", "receiptId", "organizationId", "maintenancePrincipalId",
    "workItemId", "claimGeneration", "credentialGeneration", "leaseGeneration", "fencingToken",
    "objectKey", "deletePhase", "holdVersion", "quarantineVersion", "deleteTicketJti",
    "deleteAuthorizationJti", "proofJti", "objectStatus", "r2VersionOrEtag", "completedAt",
    "gatewaySigningKeyGeneration", "signature",
  ], "retention receipt");
  const payload = claim.payload;
  if (
    payload.kind !== "RETENTION_DELETE" || payload.deletePhase !== "FINAL_DELETE" ||
    receipt.version !== 1 || receipt.receiptKind !== "RETENTION_FINAL_DELETE" ||
    receipt.organizationId !== claim.organizationId ||
    receipt.maintenancePrincipalId !== claim.maintenancePrincipalId ||
    receipt.workItemId !== claim.workItemId || receipt.claimGeneration !== claim.claimGeneration ||
    receipt.credentialGeneration !== claim.credentialGeneration ||
    receipt.leaseGeneration !== claim.leaseGeneration || receipt.fencingToken !== claim.fencingToken ||
    receipt.objectKey !== payload.objectKey || receipt.deletePhase !== "FINAL_DELETE" ||
    receipt.holdVersion !== payload.holdVersion ||
    receipt.quarantineVersion !== payload.quarantineVersion ||
    receipt.deleteTicketJti !== ticket.deleteTicketJti ||
    receipt.deleteAuthorizationJti !== authorization.authorizationJti ||
    receipt.proofJti !== authorization.authorizationJti ||
    receipt.gatewaySigningKeyGeneration !== ticket.receiptSigningKeyGeneration
  ) {
    throw new TypeError("retention receipt claim mismatch");
  }
  string(receipt.receiptId, UUID, "receiptId");
  string(receipt.deleteTicketJti, JTI, "receipt.deleteTicketJti");
  string(receipt.deleteAuthorizationJti, JTI, "receipt.deleteAuthorizationJti");
  string(receipt.proofJti, JTI, "receipt.proofJti");
  string(receipt.signature, SIGNATURE, "receipt.signature");
  timestamp(receipt.completedAt, "receipt.completedAt");
  if (
    (receipt.objectStatus === "DELETED" &&
      (typeof receipt.r2VersionOrEtag !== "string" || receipt.r2VersionOrEtag.length === 0)) ||
    (receipt.objectStatus === "NOT_FOUND" && receipt.r2VersionOrEtag !== null) ||
    (receipt.objectStatus !== "DELETED" && receipt.objectStatus !== "NOT_FOUND")
  ) {
    throw new TypeError("retention receipt object state is invalid");
  }
  return receipt as unknown as RetentionDeleteReceiptV1;
}

function parseRetentionRecoveryRefreshResult({
  value,
  frozenClaim,
  oldTicket,
  oldAuthorization,
  now,
  recoveryClaim,
}: {
  value: unknown;
  frozenClaim: MaintenanceWorkClaimV1;
  oldTicket: DeleteTicketResult;
  oldAuthorization: Record<string, unknown>;
  now: Date;
  recoveryClaim: RetentionDeleteAuthorizedRecoveryV1;
}): { ticket: DeleteTicketResult; authorization: Record<string, unknown> } {
  const result = exact(value, [
    "version", "ticketId", "ticketHash", "deleteAuthorizationJti", "expiresAt", "state",
    "replacesTicketJti", "replacesDeleteAuthorizationJti", "ticket", "authorization",
  ], "retention recovery refresh result");
  if (
    result.version !== 1 || result.state !== "RECOVERY_REFRESHED" ||
    result.ticketId !== oldTicket.ticketId ||
    result.replacesTicketJti !== oldTicket.deleteTicketJti ||
    result.replacesDeleteAuthorizationJti !== oldAuthorization.authorizationJti
  ) throw new TypeError("retention recovery refresh state is invalid");
  const ticketRecord = record(result.ticket, "refreshed delete ticket");
  const ticketExp = integer(ticketRecord.exp, 1, "refreshed ticket.exp");
  const recoveryContext: RetentionRecoveryArtifactContext = {
    maintenancePrincipalId: recoveryClaim.maintenancePrincipalId,
    credentialGeneration: recoveryClaim.credentialGeneration,
    leaseGeneration: recoveryClaim.leaseGeneration,
    fencingToken: recoveryClaim.fencingToken,
    recoveryGeneration: recoveryClaim.recoveryGeneration,
    frozenClaim: recoveryClaim.frozenClaim,
    oldTicketJti: oldTicket.deleteTicketJti,
    oldAuthorizationJti: string(
      oldAuthorization.authorizationJti,
      JTI,
      "oldAuthorization.authorizationJti",
    ),
  };
  const ticket = parseDeleteTicketResult({
    version: 1,
    ticketId: result.ticketId,
    ticketHash: result.ticketHash,
    expiresAt: new Date(ticketExp * 1_000).toISOString(),
    state: "TICKET_ISSUED",
    ticket: ticketRecord,
  }, frozenClaim, now, false, recoveryContext);
  if (ticket.deleteTicketJti === oldTicket.deleteTicketJti) {
    throw new TypeError("retention recovery ticket was not rotated");
  }
  const authorization = parseDeleteAuthorization({
    version: 1,
    ticketId: result.ticketId,
    ticketHash: result.ticketHash,
    deleteAuthorizationJti: result.deleteAuthorizationJti,
    expiresAt: result.expiresAt,
    state: "DELETE_AUTHORIZED",
    authorization: result.authorization,
  }, frozenClaim, ticket, now, false, recoveryContext);
  if (authorization.authorizationJti === oldAuthorization.authorizationJti) {
    throw new TypeError("retention recovery authorization was not rotated");
  }
  return { ticket, authorization };
}

function storedRetentionRecoveryContext(
  claim: RetentionDeleteAuthorizedRecoveryV1,
): RetentionRecoveryArtifactContext | undefined {
  if (claim.ticket.recoveryKind === undefined && claim.authorization.recoveryKind === undefined) {
    return undefined;
  }
  const ticket = record(claim.ticket, "stored retention recovery ticket");
  const authorization = record(claim.authorization, "stored retention recovery authorization");
  if (
    ticket.recoveryKind !== "RETENTION_DELETE_AUTHORIZED" ||
    authorization.recoveryKind !== "RETENTION_DELETE_AUTHORIZED"
  ) throw new TypeError("stored retention recovery kind is invalid");
  const frozen = exact(ticket.frozenClaim, [
    "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
    "claimGeneration",
  ], "stored retention recovery frozen claim");
  const frozenClaim = {
    maintenancePrincipalId: string(
      frozen.maintenancePrincipalId,
      UUID,
      "stored retention frozen maintenancePrincipalId",
    ),
    credentialGeneration: integer(
      frozen.credentialGeneration,
      1,
      "stored retention frozen credentialGeneration",
    ),
    leaseGeneration: integer(
      frozen.leaseGeneration,
      1,
      "stored retention frozen leaseGeneration",
    ),
    fencingToken: integer(frozen.fencingToken, 1, "stored retention frozen fencingToken"),
    claimGeneration: integer(
      frozen.claimGeneration,
      1,
      "stored retention frozen claimGeneration",
    ),
  };
  if (
    frozenClaim.maintenancePrincipalId !== claim.frozenClaim.maintenancePrincipalId ||
    frozenClaim.credentialGeneration !== claim.frozenClaim.credentialGeneration ||
    frozenClaim.leaseGeneration !== claim.frozenClaim.leaseGeneration ||
    frozenClaim.fencingToken !== claim.frozenClaim.fencingToken ||
    frozenClaim.claimGeneration !== claim.frozenClaim.claimGeneration
  ) throw new TypeError("stored retention recovery frozen lineage mismatch");
  const context = {
    maintenancePrincipalId: string(
      ticket.maintenancePrincipalId,
      UUID,
      "stored retention maintenancePrincipalId",
    ),
    credentialGeneration: integer(
      ticket.credentialGeneration,
      1,
      "stored retention credentialGeneration",
    ),
    leaseGeneration: integer(
      ticket.leaseGeneration,
      1,
      "stored retention leaseGeneration",
    ),
    fencingToken: integer(ticket.fencingToken, 1, "stored retention fencingToken"),
    recoveryGeneration: integer(
      ticket.recoveryGeneration,
      1,
      "stored retention recoveryGeneration",
    ),
    frozenClaim,
    oldTicketJti: string(ticket.replacesTicketJti, JTI, "stored retention replacesTicketJti"),
    oldAuthorizationJti: string(
      ticket.replacesDeleteAuthorizationJti,
      JTI,
      "stored retention replacesDeleteAuthorizationJti",
    ),
  };
  if (
    authorization.maintenancePrincipalId !== context.maintenancePrincipalId ||
    authorization.credentialGeneration !== context.credentialGeneration ||
    authorization.leaseGeneration !== context.leaseGeneration ||
    authorization.fencingToken !== context.fencingToken ||
    authorization.recoveryGeneration !== context.recoveryGeneration ||
    authorization.replacesTicketJti !== context.oldTicketJti ||
    authorization.replacesDeleteAuthorizationJti !== context.oldAuthorizationJti
  ) throw new TypeError("stored retention recovery artifact mismatch");
  return context;
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status = (error as { status?: unknown }).status;
  return status === undefined || status === null || (typeof status === "number" && status >= 500);
}

function expiredWithoutGatewayWork(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    (error as { status?: unknown }).status === 410 &&
    (error as { code?: unknown }).code === "TICKET_EXPIRED_NO_WORK";
}

async function retryExact<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt + 1 >= attempts) throw error;
    }
  }
  throw lastError;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function requireLeaseBudget(
  leaseExpiresAt: string,
  now: Date,
  requiredMs: number,
): void {
  const remainingMs = Date.parse(leaseExpiresAt) - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs < requiredMs) {
    throw new MaintenanceRetryableWorkError("maintenance claim has insufficient lease budget");
  }
}

function parseQuarantineResult(value: unknown, claim: MaintenanceWorkClaimV1): Record<string, unknown> {
  const result = exact(value, [
    "version", "workItemId", "tombstoneId", "subjectKind", "subjectId", "quarantinedAt", "state",
  ], "quarantine result");
  const payload = claim.payload;
  if (
    payload.kind !== "RETENTION_DELETE" || payload.deletePhase !== "QUARANTINE" ||
    result.version !== 1 || result.workItemId !== claim.workItemId || result.state !== "COMPLETE" ||
    result.subjectKind !== payload.subjectKind || result.subjectId !== payload.subjectId
  ) throw new TypeError("quarantine result claim mismatch");
  string(result.tombstoneId, UUID, "tombstoneId");
  timestamp(result.quarantinedAt, "quarantinedAt");
  return result;
}

function parseFinalizationResult(value: unknown, ticketId: string): Record<string, unknown> {
  const result = exact(value, [
    "version", "ticketId", "gatewayOutcome", "receiptHash", "finalized", "idempotentReplay",
  ], "retention finalization result");
  if (
    result.version !== 1 || result.ticketId !== ticketId ||
    (result.gatewayOutcome !== "DELETED" && result.gatewayOutcome !== "NOT_FOUND") ||
    result.finalized !== true || typeof result.idempotentReplay !== "boolean"
  ) throw new TypeError("retention finalization result is invalid");
  string(result.receiptHash, SHA256, "receiptHash");
  return result;
}

export async function runRetentionWork({
  claim,
  runtime,
  gateway,
  now = () => new Date(),
  retryAttempts = 2,
  runtimeAttemptTimeoutMs = 4_000,
  gatewayAttemptTimeoutMs = 2_000,
  leaseSafetyMs = 1_000,
}: {
  claim: MaintenanceWorkClaimV1 | RetentionDeleteAuthorizedRecoveryV1;
  runtime: MaintenanceRuntimePort;
  gateway: RetentionGatewayPort;
  now?: () => Date;
  retryAttempts?: number;
  runtimeAttemptTimeoutMs?: number;
  gatewayAttemptTimeoutMs?: number;
  leaseSafetyMs?: number;
}): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 1 || retryAttempts > 3) {
    throw new TypeError("retryAttempts must be between 1 and 3");
  }
  boundedInteger(runtimeAttemptTimeoutMs, 100, 10_000, "runtime attempt timeout");
  boundedInteger(gatewayAttemptTimeoutMs, 100, 4_000, "gateway attempt timeout");
  boundedInteger(leaseSafetyMs, 100, 5_000, "lease safety margin");
  if ("recoveryKind" in claim) {
    if (now().getTime() < Date.parse(claim.payload.finalDeleteNotBefore)) {
      throw new MaintenanceRetryableWorkError("retention grace period has not elapsed");
    }
    requireLeaseBudget(
      claim.recoveryLeaseExpiresAt,
      now(),
      runtimeAttemptTimeoutMs * retryAttempts * (claim.gatewayReceipt === null ? 2 : 1) +
        (claim.gatewayReceipt === null ? gatewayAttemptTimeoutMs * retryAttempts * 2 : 0) +
        leaseSafetyMs,
    );
    const frozenClaim: MaintenanceWorkClaimV1 = {
      version: 1,
      workItemId: claim.workItemId,
      organizationId: claim.organizationId,
      maintenancePrincipalId: claim.frozenClaim.maintenancePrincipalId,
      credentialGeneration: claim.frozenClaim.credentialGeneration,
      leaseGeneration: claim.frozenClaim.leaseGeneration,
      sourceKey: claim.sourceKey,
      claimToken: claim.claimToken,
      claimGeneration: claim.frozenClaim.claimGeneration,
      fencingToken: claim.frozenClaim.fencingToken,
      leaseExpiresAt: claim.recoveryLeaseExpiresAt,
      payload: claim.payload,
    };
    const ticketExp = integer(claim.ticket.exp, 1, "ticket.exp");
    const storedRecovery = storedRetentionRecoveryContext(claim);
    let ticket = parseDeleteTicketResult({
      version: 1,
      ticketId: claim.ticketId,
      ticketHash: claim.ticketHash,
      expiresAt: new Date(ticketExp * 1_000).toISOString(),
      state: "TICKET_ISSUED",
      ticket: claim.ticket,
    }, frozenClaim, now(), true, storedRecovery);
    const expectedAuthorizationHash = sha256Hex(
      `ihome-openclaw-retention-authorization-v1\0${canonicalJson(claim.authorization)}`,
    );
    if (claim.authorizationHash !== expectedAuthorizationHash) {
      throw new TypeError("delete authorization hash mismatch");
    }
    const authorizationJti = string(
      claim.authorization.authorizationJti,
      JTI,
      "authorization.authorizationJti",
    );
    let authorization = parseDeleteAuthorization({
      version: 1,
      ticketId: claim.ticketId,
      ticketHash: claim.ticketHash,
      deleteAuthorizationJti: authorizationJti,
      expiresAt: claim.authorizationExpiresAt,
      state: "DELETE_AUTHORIZED",
      authorization: claim.authorization,
    }, frozenClaim, ticket, now(), true, storedRecovery);
    const gatewayRequest = () => Object.freeze({
      ticketHeader: encodeSignedHeader(ticket.ticket),
      deleteAuthorizationHeader: encodeSignedHeader(authorization),
    });
    let receiptValue: unknown = claim.gatewayReceipt;
    if (receiptValue === null) {
      try {
        receiptValue = await retryExact(
          () => gateway.deleteObject(gatewayRequest(), {
            signal: AbortSignal.timeout(gatewayAttemptTimeoutMs),
          }),
          retryAttempts,
        );
      } catch (error) {
        if (!expiredWithoutGatewayWork(error)) throw error;
        const refreshed = parseRetentionRecoveryRefreshResult({
          value: await retryExact(
            () => runtime.post("/v1/maintenance/retention/authorize-delete", Object.freeze({
              version: 1,
              recoveryKind: "RETENTION_DELETE_AUTHORIZED" as const,
              workItemId: claim.workItemId,
              recoveryGeneration: claim.recoveryGeneration,
              claimToken: claim.claimToken,
              ticketId: claim.ticketId,
              expiredTicketJti: ticket.deleteTicketJti,
              expiredDeleteAuthorizationJti: string(
                authorization.authorizationJti,
                JTI,
                "authorization.authorizationJti",
              ),
              gatewayDenial: Object.freeze({
                status: 410 as const,
                code: "TICKET_EXPIRED_NO_WORK" as const,
              }),
            }), { signal: AbortSignal.timeout(runtimeAttemptTimeoutMs) }),
            retryAttempts,
          ),
          frozenClaim,
          oldTicket: ticket,
          oldAuthorization: authorization,
          now: now(),
          recoveryClaim: claim,
        });
        ticket = refreshed.ticket;
        authorization = refreshed.authorization;
        receiptValue = await retryExact(
          () => gateway.deleteObject(gatewayRequest(), {
            signal: AbortSignal.timeout(gatewayAttemptTimeoutMs),
          }),
          retryAttempts,
        );
      }
    }
    const gatewayReceipt = await parseRetentionReceipt(
      receiptValue,
      frozenClaim,
      ticket,
      authorization,
    );
    const completionBody = Object.freeze({
      version: 1,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED" as const,
      workItemId: claim.workItemId,
      recoveryGeneration: claim.recoveryGeneration,
      claimToken: claim.claimToken,
      ticketId: ticket.ticketId,
      gatewayReceipt,
    });
    const result = await retryExact(
      () => runtime.post("/v1/maintenance/work/complete", completionBody, {
        signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
      }),
      retryAttempts,
    );
    return parseFinalizationResult(result, ticket.ticketId);
  }
  if (claim.payload.kind !== "RETENTION_DELETE") {
    throw new TypeError("retention runner received another work kind");
  }
  if (claim.payload.deletePhase === "QUARANTINE") {
    const body = Object.freeze({
      version: 1,
      workItemId: claim.workItemId,
      claimGeneration: claim.claimGeneration,
      claimToken: claim.claimToken,
      subjectKind: claim.payload.subjectKind,
      subjectId: claim.payload.subjectId,
    });
    requireLeaseBudget(
      claim.leaseExpiresAt,
      now(),
      runtimeAttemptTimeoutMs * retryAttempts + leaseSafetyMs,
    );
    const result = await retryExact(
      () => runtime.post("/v1/maintenance/work/complete", body, {
        signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
      }),
      retryAttempts,
    );
    return parseQuarantineResult(result, claim);
  }

  if (now().getTime() < Date.parse(claim.payload.finalDeleteNotBefore)) {
    throw new MaintenanceRetryableWorkError("retention grace period has not elapsed");
  }
  requireLeaseBudget(
    claim.leaseExpiresAt,
    now(),
    runtimeAttemptTimeoutMs * retryAttempts * 3 +
      gatewayAttemptTimeoutMs * retryAttempts + leaseSafetyMs,
  );
  const deleteTicketBody = Object.freeze({
    version: 1,
    workItemId: claim.workItemId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken,
  });
  const ticket = parseDeleteTicketResult(await retryExact(
    () => runtime.post("/v1/maintenance/retention/delete-ticket", deleteTicketBody, {
      signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
    }),
    retryAttempts,
  ), claim, now());
  requireLeaseBudget(
    claim.leaseExpiresAt,
    now(),
    runtimeAttemptTimeoutMs * retryAttempts * 2 +
      gatewayAttemptTimeoutMs * retryAttempts + leaseSafetyMs,
  );
  const authorizationBody = Object.freeze({
    version: 1,
    workItemId: claim.workItemId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken,
  });
  const authorization = parseDeleteAuthorization(await retryExact(
    () => runtime.post("/v1/maintenance/retention/authorize-delete", authorizationBody, {
      signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
    }),
    retryAttempts,
  ), claim, ticket, now());
  requireLeaseBudget(
    claim.leaseExpiresAt,
    now(),
    runtimeAttemptTimeoutMs * retryAttempts +
      gatewayAttemptTimeoutMs * retryAttempts + leaseSafetyMs,
  );
  const gatewayRequest = Object.freeze({
    ticketHeader: encodeSignedHeader(ticket.ticket),
    deleteAuthorizationHeader: encodeSignedHeader(authorization),
  });
  const gatewayReceipt = await parseRetentionReceipt(await retryExact(
    () => gateway.deleteObject(gatewayRequest, {
      signal: AbortSignal.timeout(gatewayAttemptTimeoutMs),
    }),
    retryAttempts,
  ), claim, ticket, authorization);
  requireLeaseBudget(
    claim.leaseExpiresAt,
    now(),
    runtimeAttemptTimeoutMs * retryAttempts + leaseSafetyMs,
  );
  const completionBody = Object.freeze({
    version: 1,
    ticketId: ticket.ticketId,
    gatewayReceipt,
  });
  const result = await retryExact(
    () => runtime.post("/v1/maintenance/work/complete", completionBody, {
      signal: AbortSignal.timeout(runtimeAttemptTimeoutMs),
    }),
    retryAttempts,
  );
  return parseFinalizationResult(result, ticket.ticketId);
}
