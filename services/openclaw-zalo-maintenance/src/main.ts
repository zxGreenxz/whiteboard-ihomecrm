#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import {
  runAuditAnchorWork,
  validateAuditSigningPrivateKey,
  type AuditGatewayPort,
} from "./audit-anchor-runner.js";
import { assertAuditLineageRoot } from "./audit-lineage.js";
import {
  closeMaintenanceHealthServer,
  createMaintenanceHealthServer,
  createMaintenanceHealthState,
  type MaintenanceHealthState,
  type MaintenanceUnresolvedFailures,
} from "./health.js";
import {
  runRetentionWork,
  type AuditWorkPayloadV1,
  type AuditVerifyAuthorizedRecoveryV1,
  type FinalDeleteWorkPayloadV1,
  type MaintenanceClaimItemV1,
  type MaintenanceRuntimePort,
  type MaintenanceWorkClaimV1,
  type RetentionDeleteAuthorizedRecoveryV1,
  type RetentionGatewayPort,
} from "./retention-runner.js";
import {
  canonicalJson,
  createMaintenanceRuntimeClient,
  requestSignal,
  sha256Hex,
} from "./runtime-client.js";
import { readBoundedUtf8Response } from "./bounded-response.js";
import { timestamp } from "./timestamp.js";
import { MaintenanceRetryableWorkError } from "./work-error.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const JTI = /^[A-Za-z0-9_-]{16,128}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_GATEWAY_RESPONSE_BYTES = 1_048_576;
const CLAIM_RESPONSE_BUDGET_SECONDS = 10;
const AUDIT_RUNNER_BUDGET_SECONDS = 31;
const FAILURE_REPORT_BUDGET_SECONDS = 5;
const CLAIM_HANDOFF_MARGIN_SECONDS = 1;
const MINIMUM_MAINTENANCE_LEASE_SECONDS =
  CLAIM_RESPONSE_BUDGET_SECONDS + AUDIT_RUNNER_BUDGET_SECONDS +
  FAILURE_REPORT_BUDGET_SECONDS + CLAIM_HANDOFF_MARGIN_SECONDS;
const MEDIA_VARIANTS = new Set(["original", "thumbnail", "preview"]);

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const result = record(value, name);
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${name} has non-canonical fields`);
  }
  return result;
}

function string(value: unknown, pattern: RegExp | null, name: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    (pattern !== null && !pattern.test(value))
  ) throw new TypeError(`${name} is invalid`);
  return value;
}

function integer(value: unknown, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function date(value: unknown, name: string): string {
  const result = string(value, DATE, name);
  const parsed = Date.parse(`${result}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== result) {
    throw new TypeError(`${name} is invalid`);
  }
  return result;
}

function canonicalMediaObjectKey(
  value: unknown,
  organizationId: string,
  mediaId: string,
): string {
  const key = string(value, null, "payload.objectKey");
  const parts = key.split("/");
  const hasControlCharacter = [...key].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    key.length > 1_024 || key !== key.normalize("NFC") || hasControlCharacter ||
    parts.length !== 12 || parts[0] !== "v1" || parts[1] !== "org" ||
    parts[2] !== organizationId || parts[3] !== "account" || !UUID.test(parts[4] ?? "") ||
    parts[5] !== "conversation" || !UUID.test(parts[6] ?? "") || parts[7] !== "message" ||
    !UUID.test(parts[8] ?? "") || parts[9] !== "media" || parts[10] !== mediaId ||
    !MEDIA_VARIANTS.has(parts[11] ?? "")
  ) {
    throw new TypeError("payload.objectKey is not canonical");
  }
  return key;
}

function parseFinalDeletePayload(
  value: unknown,
  organizationId: string,
): FinalDeleteWorkPayloadV1 {
  const payload = exact(value, [
    "kind", "deletePhase", "subjectKind", "subjectId", "objectKey", "retentionVersion",
    "holdVersion", "quarantineVersion", "finalDeleteNotBefore",
  ], "retention final-delete payload");
  if (
    payload.kind !== "RETENTION_DELETE" || payload.deletePhase !== "FINAL_DELETE" ||
    payload.subjectKind !== "MEDIA"
  ) throw new TypeError("final delete accepts media only");
  const subjectId = string(payload.subjectId, UUID, "payload.subjectId");
  return {
    kind: "RETENTION_DELETE",
    deletePhase: "FINAL_DELETE",
    subjectKind: "MEDIA",
    subjectId,
    objectKey: canonicalMediaObjectKey(payload.objectKey, organizationId, subjectId),
    retentionVersion: integer(payload.retentionVersion, 1, "payload.retentionVersion"),
    holdVersion: integer(payload.holdVersion, 0, "payload.holdVersion"),
    quarantineVersion: integer(payload.quarantineVersion, 1, "payload.quarantineVersion"),
    finalDeleteNotBefore: timestamp(payload.finalDeleteNotBefore, "payload.finalDeleteNotBefore"),
  };
}

function parseAuditPayload(value: unknown, organizationId: string): AuditWorkPayloadV1 {
  const payload = exact(value, [
    "kind", "auditRootId", "rootDate", "firstSequence", "lastSequence", "eventCount",
    "previousRootHash", "merkleRootHash", "rootHash", "auditSigningKeyGeneration",
    "auditSigningPublicKeyHash", "anchorKey",
  ], "audit work payload");
  if (payload.kind !== "AUDIT_ANCHOR") throw new TypeError("audit work kind is invalid");
  const auditRootId = string(payload.auditRootId, UUID, "payload.auditRootId");
  const rootDate = date(payload.rootDate, "payload.rootDate");
  const anchorKey = string(payload.anchorKey, null, "payload.anchorKey");
  if (anchorKey !== `v1/org/${organizationId}/audit/${rootDate}/${auditRootId}.json`) {
    throw new TypeError("payload.anchorKey is not canonical");
  }
  const firstSequence = integer(payload.firstSequence, 1, "payload.firstSequence");
  const lastSequence = integer(payload.lastSequence, 1, "payload.lastSequence");
  const eventCount = integer(payload.eventCount, 1, "payload.eventCount");
  if (lastSequence < firstSequence || eventCount !== lastSequence - firstSequence + 1) {
    throw new TypeError("audit root sequence range is invalid");
  }
  const previousRootHash = payload.previousRootHash === null
    ? null
    : string(payload.previousRootHash, SHA256, "payload.previousRootHash");
  const merkleRootHash = string(payload.merkleRootHash, SHA256, "payload.merkleRootHash");
  const rootHash = string(payload.rootHash, SHA256, "payload.rootHash");
  assertAuditLineageRoot({
    organizationId,
    rootDate,
    firstSequence,
    lastSequence,
    eventCount,
    previousRootHash,
    merkleRootHash,
    rootHash,
  });
  return {
    kind: "AUDIT_ANCHOR",
    auditRootId,
    rootDate,
    firstSequence,
    lastSequence,
    eventCount,
    previousRootHash,
    merkleRootHash,
    rootHash,
    auditSigningKeyGeneration: integer(
      payload.auditSigningKeyGeneration,
      1,
      "payload.auditSigningKeyGeneration",
    ),
    auditSigningPublicKeyHash: string(
      payload.auditSigningPublicKeyHash,
      SHA256,
      "payload.auditSigningPublicKeyHash",
    ),
    anchorKey,
  };
}

function parseAuditRecoveryClaim(
  value: unknown,
  claimToken: string,
  now: Date,
  expectedOrganizationId?: string,
  expectedMaintenancePrincipalId?: string,
): AuditVerifyAuthorizedRecoveryV1 {
  const claim = exact(value, [
    "version", "recoveryKind", "workItemId", "organizationId", "maintenancePrincipalId",
    "credentialGeneration", "leaseGeneration", "fencingToken", "sourceKey", "claimToken",
    "recoveryGeneration", "recoveryLeaseExpiresAt", "frozenClaim", "payload",
    "verifyTicketId", "verifyTicketHash", "verifyTicket", "gatewayReceipt",
  ], "audit recovery claim");
  if (
    claim.version !== 1 || claim.recoveryKind !== "AUDIT_VERIFY_AUTHORIZED" ||
    claim.claimToken !== claimToken
  ) throw new TypeError("audit recovery claim binding is invalid");
  const organizationId = string(claim.organizationId, UUID, "claim.organizationId");
  const maintenancePrincipalId = string(
    claim.maintenancePrincipalId,
    UUID,
    "claim.maintenancePrincipalId",
  );
  if (
    (expectedOrganizationId !== undefined && organizationId !== expectedOrganizationId) ||
    (expectedMaintenancePrincipalId !== undefined &&
      maintenancePrincipalId !== expectedMaintenancePrincipalId)
  ) throw new TypeError("audit recovery claim principal mismatch");
  const recoveryLeaseExpiresAt = timestamp(
    claim.recoveryLeaseExpiresAt,
    "claim.recoveryLeaseExpiresAt",
  );
  if (Date.parse(recoveryLeaseExpiresAt) <= now.getTime()) {
    throw new TypeError("audit recovery lease is expired");
  }
  const frozen = exact(claim.frozenClaim, [
    "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
    "claimGeneration",
  ], "audit recovery frozen claim");
  const gatewayReceipt = claim.gatewayReceipt === null
    ? null
    : record(claim.gatewayReceipt, "audit recovery gateway receipt");
  return {
    version: 1,
    recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
    workItemId: string(claim.workItemId, UUID, "claim.workItemId"),
    organizationId,
    maintenancePrincipalId,
    credentialGeneration: integer(claim.credentialGeneration, 1, "claim.credentialGeneration"),
    leaseGeneration: integer(claim.leaseGeneration, 1, "claim.leaseGeneration"),
    fencingToken: integer(claim.fencingToken, 1, "claim.fencingToken"),
    sourceKey: string(claim.sourceKey, null, "claim.sourceKey"),
    claimToken,
    recoveryGeneration: integer(claim.recoveryGeneration, 1, "claim.recoveryGeneration"),
    recoveryLeaseExpiresAt,
    frozenClaim: {
      maintenancePrincipalId: string(
        frozen.maintenancePrincipalId,
        UUID,
        "frozenClaim.maintenancePrincipalId",
      ),
      credentialGeneration: integer(
        frozen.credentialGeneration,
        1,
        "frozenClaim.credentialGeneration",
      ),
      leaseGeneration: integer(frozen.leaseGeneration, 1, "frozenClaim.leaseGeneration"),
      fencingToken: integer(frozen.fencingToken, 1, "frozenClaim.fencingToken"),
      claimGeneration: integer(frozen.claimGeneration, 1, "frozenClaim.claimGeneration"),
    },
    payload: parseAuditPayload(claim.payload, organizationId),
    verifyTicketId: string(claim.verifyTicketId, JTI, "claim.verifyTicketId"),
    verifyTicketHash: string(claim.verifyTicketHash, SHA256, "claim.verifyTicketHash"),
    verifyTicket: record(claim.verifyTicket, "claim.verifyTicket"),
    gatewayReceipt: gatewayReceipt as AuditVerifyAuthorizedRecoveryV1["gatewayReceipt"],
  };
}

function parseRetentionRecoveryClaim(
  value: unknown,
  claimToken: string,
  now: Date,
  expectedOrganizationId?: string,
  expectedMaintenancePrincipalId?: string,
): RetentionDeleteAuthorizedRecoveryV1 {
  const claim = exact(value, [
    "version", "recoveryKind", "workItemId", "organizationId", "maintenancePrincipalId",
    "credentialGeneration", "leaseGeneration", "fencingToken", "sourceKey", "claimToken",
    "recoveryGeneration", "recoveryLeaseExpiresAt", "frozenClaim", "payload", "ticketId",
    "ticketHash", "ticket", "authorizationHash", "authorization", "authorizationExpiresAt",
    "gatewayReceipt",
  ], "retention recovery claim");
  if (
    claim.version !== 1 || claim.recoveryKind !== "RETENTION_DELETE_AUTHORIZED" ||
    claim.claimToken !== claimToken
  ) throw new TypeError("retention recovery claim binding is invalid");
  const organizationId = string(claim.organizationId, UUID, "claim.organizationId");
  const maintenancePrincipalId = string(
    claim.maintenancePrincipalId,
    UUID,
    "claim.maintenancePrincipalId",
  );
  if (
    (expectedOrganizationId !== undefined && organizationId !== expectedOrganizationId) ||
    (expectedMaintenancePrincipalId !== undefined &&
      maintenancePrincipalId !== expectedMaintenancePrincipalId)
  ) throw new TypeError("retention recovery claim principal mismatch");
  const recoveryLeaseExpiresAt = timestamp(
    claim.recoveryLeaseExpiresAt,
    "claim.recoveryLeaseExpiresAt",
  );
  if (Date.parse(recoveryLeaseExpiresAt) <= now.getTime()) {
    throw new TypeError("retention recovery lease is expired");
  }
  const authorizationExpiresAt = timestamp(
    claim.authorizationExpiresAt,
    "claim.authorizationExpiresAt",
  );
  const frozen = exact(claim.frozenClaim, [
    "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
    "claimGeneration",
  ], "retention recovery frozen claim");
  const gatewayReceipt = claim.gatewayReceipt === null
    ? null
    : record(claim.gatewayReceipt, "retention recovery gateway receipt");
  return {
    version: 1,
    recoveryKind: "RETENTION_DELETE_AUTHORIZED",
    workItemId: string(claim.workItemId, UUID, "claim.workItemId"),
    organizationId,
    maintenancePrincipalId,
    credentialGeneration: integer(claim.credentialGeneration, 1, "claim.credentialGeneration"),
    leaseGeneration: integer(claim.leaseGeneration, 1, "claim.leaseGeneration"),
    fencingToken: integer(claim.fencingToken, 1, "claim.fencingToken"),
    sourceKey: string(claim.sourceKey, null, "claim.sourceKey"),
    claimToken,
    recoveryGeneration: integer(claim.recoveryGeneration, 1, "claim.recoveryGeneration"),
    recoveryLeaseExpiresAt,
    frozenClaim: {
      maintenancePrincipalId: string(
        frozen.maintenancePrincipalId,
        UUID,
        "frozenClaim.maintenancePrincipalId",
      ),
      credentialGeneration: integer(
        frozen.credentialGeneration,
        1,
        "frozenClaim.credentialGeneration",
      ),
      leaseGeneration: integer(frozen.leaseGeneration, 1, "frozenClaim.leaseGeneration"),
      fencingToken: integer(frozen.fencingToken, 1, "frozenClaim.fencingToken"),
      claimGeneration: integer(frozen.claimGeneration, 1, "frozenClaim.claimGeneration"),
    },
    payload: parseFinalDeletePayload(claim.payload, organizationId),
    ticketId: string(claim.ticketId, UUID, "claim.ticketId"),
    ticketHash: string(claim.ticketHash, SHA256, "claim.ticketHash"),
    ticket: record(claim.ticket, "claim.ticket"),
    authorizationHash: string(
      claim.authorizationHash,
      SHA256,
      "claim.authorizationHash",
    ),
    authorization: record(claim.authorization, "claim.authorization"),
    authorizationExpiresAt,
    gatewayReceipt: gatewayReceipt as RetentionDeleteAuthorizedRecoveryV1["gatewayReceipt"],
  };
}

function parseMaintenanceClaim(
  value: unknown,
  claimToken: string,
  now: Date,
  expectedOrganizationId?: string,
  expectedMaintenancePrincipalId?: string,
): MaintenanceClaimItemV1 {
  const candidate = record(value, "maintenance work claim");
  if (candidate.recoveryKind === "RETENTION_DELETE_AUTHORIZED") {
    return parseRetentionRecoveryClaim(
      candidate,
      claimToken,
      now,
      expectedOrganizationId,
      expectedMaintenancePrincipalId,
    );
  }
  if (candidate.recoveryKind === "AUDIT_VERIFY_AUTHORIZED") {
    return parseAuditRecoveryClaim(
      candidate,
      claimToken,
      now,
      expectedOrganizationId,
      expectedMaintenancePrincipalId,
    );
  }
  const claim = exact(value, [
    "version", "workItemId", "organizationId", "maintenancePrincipalId",
    "credentialGeneration", "leaseGeneration", "sourceKey", "claimToken", "claimGeneration",
    "fencingToken", "leaseExpiresAt", "payload",
  ], "maintenance work claim");
  if (claim.version !== 1 || claim.claimToken !== claimToken) {
    throw new TypeError("maintenance work claim binding is invalid");
  }
  const workItemId = string(claim.workItemId, UUID, "claim.workItemId");
  const organizationId = string(claim.organizationId, UUID, "claim.organizationId");
  const maintenancePrincipalId = string(
    claim.maintenancePrincipalId,
    UUID,
    "claim.maintenancePrincipalId",
  );
  if (
    (expectedOrganizationId !== undefined && organizationId !== expectedOrganizationId) ||
    (expectedMaintenancePrincipalId !== undefined &&
      maintenancePrincipalId !== expectedMaintenancePrincipalId)
  ) throw new TypeError("maintenance work claim principal mismatch");
  const leaseExpiresAt = timestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= now.getTime()) {
    throw new TypeError("maintenance work claim lease is expired");
  }
  const payload = record(claim.payload, "claim.payload");
  let parsedPayload: MaintenanceWorkClaimV1["payload"];
  if (payload.kind === "AUDIT_ANCHOR") {
    parsedPayload = parseAuditPayload(payload, organizationId);
  } else if (payload.kind === "RETENTION_DELETE" && payload.deletePhase === "QUARANTINE") {
    exact(payload, [
      "kind", "deletePhase", "subjectKind", "subjectId", "retentionVersion", "holdVersion",
    ], "retention quarantine payload");
    const subjectKind = string(payload.subjectKind, null, "payload.subjectKind");
    if (![
      "MESSAGE", "AI_DRAFT", "MEDIA", "KNOWLEDGE", "HEALTH", "QR", "AUDIT", "POLICY",
      "CONTROL", "DELIVERY", "UNKNOWN", "SECURITY", "CONSENT", "RISK",
    ].includes(subjectKind)) throw new TypeError("retention subject kind is invalid");
    parsedPayload = {
      kind: "RETENTION_DELETE",
      deletePhase: "QUARANTINE",
      subjectKind: subjectKind as Extract<MaintenanceWorkClaimV1["payload"], {
        deletePhase: "QUARANTINE";
      }>["subjectKind"],
      subjectId: string(payload.subjectId, UUID, "payload.subjectId"),
      retentionVersion: integer(payload.retentionVersion, 1, "payload.retentionVersion"),
      holdVersion: integer(payload.holdVersion, 0, "payload.holdVersion"),
    };
  } else if (payload.kind === "RETENTION_DELETE" && payload.deletePhase === "FINAL_DELETE") {
    parsedPayload = parseFinalDeletePayload(payload, organizationId);
  } else {
    throw new TypeError("maintenance work kind is forbidden");
  }
  return {
    version: 1,
    workItemId,
    organizationId,
    maintenancePrincipalId,
    credentialGeneration: integer(
      claim.credentialGeneration,
      1,
      "claim.credentialGeneration",
    ),
    leaseGeneration: integer(claim.leaseGeneration, 1, "claim.leaseGeneration"),
    sourceKey: string(claim.sourceKey, null, "claim.sourceKey"),
    claimToken,
    claimGeneration: integer(claim.claimGeneration, 1, "claim.claimGeneration"),
    fencingToken: integer(claim.fencingToken, 1, "claim.fencingToken"),
    leaseExpiresAt,
    payload: parsedPayload,
  };
}

type MaintenanceWorkKind = "RETENTION_DELETE" | "AUDIT_ANCHOR";

type MaintenanceFailureClaim = Readonly<{
  version: 1;
  workItemId: string;
  organizationId: string;
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
  claimToken: string;
  payload: Readonly<{ kind: MaintenanceWorkKind }>;
} & (
  | Readonly<{ claimGeneration: number }>
  | Readonly<{
      recoveryKind: "RETENTION_DELETE_AUTHORIZED" | "AUDIT_VERIFY_AUTHORIZED";
      recoveryGeneration: number;
      frozenClaim: Readonly<{
        maintenancePrincipalId: string;
        credentialGeneration: number;
        leaseGeneration: number;
        fencingToken: number;
        claimGeneration: number;
      }>;
    }>
)>;

type ParsedMaintenanceClaim =
  | Readonly<{ state: "VALID"; item: MaintenanceClaimItemV1 }>
  | Readonly<{
      state: "INVALID";
      index: number;
      error: unknown;
      failureClaim: MaintenanceFailureClaim | null;
      workKind: MaintenanceWorkKind | null;
    }>;

function maybeMaintenanceWorkKind(value: unknown): MaintenanceWorkKind | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = (value as Record<string, unknown>).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const kind = (payload as Record<string, unknown>).kind;
  return kind === "RETENTION_DELETE" || kind === "AUDIT_ANCHOR" ? kind : null;
}

function authoritativeMaintenanceWorkKind(value: unknown): MaintenanceWorkKind | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const recoveryKind = (value as Record<string, unknown>).recoveryKind;
  if (recoveryKind === "RETENTION_DELETE_AUTHORIZED") return "RETENTION_DELETE";
  if (recoveryKind === "AUDIT_VERIFY_AUTHORIZED") return "AUDIT_ANCHOR";
  if (recoveryKind !== undefined) return null;
  return maybeMaintenanceWorkKind(value);
}

function parseFailureClaimCommon(
  claim: Record<string, unknown>,
  claimToken: string,
  expectedOrganizationId?: string,
  expectedMaintenancePrincipalId?: string,
): Omit<MaintenanceFailureClaim, "claimGeneration" | "recoveryKind" |
  "recoveryGeneration" | "frozenClaim"> {
  if (claim.version !== 1 || claim.claimToken !== claimToken) {
    throw new TypeError("maintenance work claim binding is invalid");
  }
  const organizationId = string(claim.organizationId, UUID, "claim.organizationId");
  const maintenancePrincipalId = string(
    claim.maintenancePrincipalId,
    UUID,
    "claim.maintenancePrincipalId",
  );
  if (
    (expectedOrganizationId !== undefined && organizationId !== expectedOrganizationId) ||
    (expectedMaintenancePrincipalId !== undefined &&
      maintenancePrincipalId !== expectedMaintenancePrincipalId)
  ) throw new TypeError("maintenance work claim principal mismatch");
  const workKind = maybeMaintenanceWorkKind(claim);
  if (workKind === null) throw new TypeError("maintenance work kind is forbidden");
  return {
    version: 1,
    workItemId: string(claim.workItemId, UUID, "claim.workItemId"),
    organizationId,
    maintenancePrincipalId,
    credentialGeneration: integer(claim.credentialGeneration, 1, "claim.credentialGeneration"),
    leaseGeneration: integer(claim.leaseGeneration, 1, "claim.leaseGeneration"),
    fencingToken: integer(claim.fencingToken, 1, "claim.fencingToken"),
    claimToken,
    payload: { kind: workKind },
  };
}

function parseMaintenanceFailureClaim(
  value: unknown,
  claimToken: string,
  now: Date,
  expectedOrganizationId?: string,
  expectedMaintenancePrincipalId?: string,
): MaintenanceFailureClaim {
  const candidate = record(value, "maintenance work claim");
  if (
    candidate.recoveryKind === "RETENTION_DELETE_AUTHORIZED" ||
    candidate.recoveryKind === "AUDIT_VERIFY_AUTHORIZED"
  ) {
    const recoveryKind = candidate.recoveryKind;
    const keys = recoveryKind === "RETENTION_DELETE_AUTHORIZED"
      ? [
          "version", "recoveryKind", "workItemId", "organizationId",
          "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
          "sourceKey", "claimToken", "recoveryGeneration", "recoveryLeaseExpiresAt",
          "frozenClaim", "payload", "ticketId", "ticketHash", "ticket", "authorizationHash",
          "authorization", "authorizationExpiresAt", "gatewayReceipt",
        ]
      : [
          "version", "recoveryKind", "workItemId", "organizationId",
          "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
          "sourceKey", "claimToken", "recoveryGeneration", "recoveryLeaseExpiresAt",
          "frozenClaim", "payload", "verifyTicketId", "verifyTicketHash", "verifyTicket",
          "gatewayReceipt",
        ];
    const claim = exact(candidate, keys, "maintenance recovery claim");
    string(claim.sourceKey, null, "claim.sourceKey");
    const recoveryLeaseExpiresAt = timestamp(
      claim.recoveryLeaseExpiresAt,
      "claim.recoveryLeaseExpiresAt",
    );
    if (Date.parse(recoveryLeaseExpiresAt) <= now.getTime()) {
      throw new TypeError("maintenance recovery lease is expired");
    }
    const common = parseFailureClaimCommon(
      claim,
      claimToken,
      expectedOrganizationId,
      expectedMaintenancePrincipalId,
    );
    if (
      (recoveryKind === "RETENTION_DELETE_AUTHORIZED" &&
        common.payload.kind !== "RETENTION_DELETE") ||
      (recoveryKind === "AUDIT_VERIFY_AUTHORIZED" && common.payload.kind !== "AUDIT_ANCHOR")
    ) throw new TypeError("maintenance recovery work kind is invalid");
    const frozen = exact(claim.frozenClaim, [
      "maintenancePrincipalId", "credentialGeneration", "leaseGeneration", "fencingToken",
      "claimGeneration",
    ], "maintenance recovery frozen claim");
    return {
      ...common,
      recoveryKind,
      recoveryGeneration: integer(
        claim.recoveryGeneration,
        1,
        "claim.recoveryGeneration",
      ),
      frozenClaim: {
        maintenancePrincipalId: string(
          frozen.maintenancePrincipalId,
          UUID,
          "frozenClaim.maintenancePrincipalId",
        ),
        credentialGeneration: integer(
          frozen.credentialGeneration,
          1,
          "frozenClaim.credentialGeneration",
        ),
        leaseGeneration: integer(frozen.leaseGeneration, 1, "frozenClaim.leaseGeneration"),
        fencingToken: integer(frozen.fencingToken, 1, "frozenClaim.fencingToken"),
        claimGeneration: integer(frozen.claimGeneration, 1, "frozenClaim.claimGeneration"),
      },
    };
  }
  const claim = exact(candidate, [
    "version", "workItemId", "organizationId", "maintenancePrincipalId",
    "credentialGeneration", "leaseGeneration", "sourceKey", "claimToken", "claimGeneration",
    "fencingToken", "leaseExpiresAt", "payload",
  ], "maintenance work claim");
  string(claim.sourceKey, null, "claim.sourceKey");
  const leaseExpiresAt = timestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= now.getTime()) {
    throw new TypeError("maintenance work claim lease is expired");
  }
  return {
    ...parseFailureClaimCommon(
      claim,
      claimToken,
      expectedOrganizationId,
      expectedMaintenancePrincipalId,
    ),
    claimGeneration: integer(claim.claimGeneration, 1, "claim.claimGeneration"),
  };
}

function parseClaimBatch(
  value: unknown,
  claimToken: string,
  limit: number,
  now: Date,
  expectedOrganizationId?: string,
  expectedMaintenancePrincipalId?: string,
): { items: ParsedMaintenanceClaim[]; unresolvedFailures: MaintenanceUnresolvedFailures } {
  const result = exact(
    value,
    ["version", "items", "unresolvedFailures"],
    "maintenance claim batch",
  );
  if (result.version !== 1 || !Array.isArray(result.items) || result.items.length > limit) {
    throw new TypeError("maintenance claim batch is invalid");
  }
  const unresolved = exact(result.unresolvedFailures, [
    "retentionDelete", "auditAnchor",
  ], "maintenance unresolved failures");
  const unresolvedFailures = {
    retentionDelete: integer(
      unresolved.retentionDelete,
      0,
      "maintenance unresolved failure retentionDelete",
    ),
    auditAnchor: integer(
      unresolved.auditAnchor,
      0,
      "maintenance unresolved failure auditAnchor",
    ),
  };
  const items = result.items.map((item, index): ParsedMaintenanceClaim => {
    try {
      return {
        state: "VALID",
        item: parseMaintenanceClaim(
          item,
          claimToken,
          now,
          expectedOrganizationId,
          expectedMaintenancePrincipalId,
        ),
      };
    } catch (error) {
      let failureClaim: MaintenanceFailureClaim | null = null;
      try {
        failureClaim = parseMaintenanceFailureClaim(
          item,
          claimToken,
          now,
          expectedOrganizationId,
          expectedMaintenancePrincipalId,
        );
      } catch {
        // An untrusted binding is never copied into a completion request.
      }
      return {
        state: "INVALID",
        index,
        error,
        failureClaim,
        workKind: failureClaim?.payload.kind ?? authoritativeMaintenanceWorkKind(item),
      };
    }
  });
  const workItemIds = items.flatMap((entry) => {
    if (entry.state === "VALID") return [entry.item.workItemId];
    return entry.failureClaim === null ? [] : [entry.failureClaim.workItemId];
  });
  if (new Set(workItemIds).size !== workItemIds.length) {
    throw new TypeError("maintenance claim batch contains duplicate work items");
  }
  return { items, unresolvedFailures };
}

type MaintenanceFailureOutcome = "RETRY" | "FAILED" | "DEAD_LETTER";

function failureStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isSafeInteger(status) ? status : null;
}

function classifyMaintenanceFailure(error: unknown): {
  outcome: MaintenanceFailureOutcome;
  reasonCode:
    | "MAINTENANCE_WORK_RETRY"
    | "MAINTENANCE_WORK_FAILED"
    | "MAINTENANCE_WORK_DEAD_LETTER";
  status: number | null;
} {
  const status = failureStatus(error);
  if (error instanceof MaintenanceRetryableWorkError) {
    return { outcome: "RETRY", reasonCode: "MAINTENANCE_WORK_RETRY", status };
  }
  if (error instanceof TypeError) {
    return {
      outcome: "DEAD_LETTER",
      reasonCode: "MAINTENANCE_WORK_DEAD_LETTER",
      status,
    };
  }
  if (
    status === null || status === 408 || status === 409 || status === 425 || status === 429 ||
    status >= 500
  ) return { outcome: "RETRY", reasonCode: "MAINTENANCE_WORK_RETRY", status };
  return { outcome: "FAILED", reasonCode: "MAINTENANCE_WORK_FAILED", status };
}

function failureRequest(
  item: MaintenanceFailureClaim,
  error: unknown,
): { body: Record<string, unknown>; outcome: MaintenanceFailureOutcome; evidenceHash: string } {
  const classified = classifyMaintenanceFailure(error);
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const evidence = Object.freeze({
    version: 1,
    evidenceKind: "WORK_FAILURE",
    reasonCode: classified.reasonCode,
    failureFingerprint: sha256Hex(
      "ihome-openclaw-maintenance-failure-fingerprint-v1\0" + canonicalJson({
        workKind: item.payload.kind,
        errorName,
        statusOrNull: classified.status,
        reasonCode: classified.reasonCode,
      }),
    ),
  });
  const evidenceHash = sha256Hex(
    "ihome-openclaw-maintenance-work-failure-v1\0" + canonicalJson(evidence),
  );
  const common = {
    version: 1,
    workItemId: item.workItemId,
    organizationId: item.organizationId,
    maintenancePrincipalId: item.maintenancePrincipalId,
    credentialGeneration: item.credentialGeneration,
    leaseGeneration: item.leaseGeneration,
    fencingToken: item.fencingToken,
    claimToken: item.claimToken,
  };
  const binding = "recoveryKind" in item
    ? {
        recoveryKind: item.recoveryKind,
        recoveryGeneration: item.recoveryGeneration,
        frozenClaim: item.frozenClaim,
      }
    : { claimGeneration: item.claimGeneration };
  return {
    body: Object.freeze({
      ...common,
      ...binding,
      outcome: classified.outcome,
      evidence,
      evidenceHash,
      retryAfterSeconds: classified.outcome === "RETRY" ? 5 : null,
    }),
    outcome: classified.outcome,
    evidenceHash,
  };
}

function parseFailureRecorded(
  value: unknown,
  item: MaintenanceFailureClaim,
  outcome: MaintenanceFailureOutcome,
  evidenceHash: string,
): void {
  const bindingKey = "recoveryKind" in item ? "recoveryGeneration" : "claimGeneration";
  const result = exact(value, [
    "version", "state", "workItemId", bindingKey, "outcome", "canonicalEvidenceHash",
    "completedAt", "retryNotBefore",
  ], "maintenance failure result");
  const expectedOutcome = outcome === "RETRY" ? "SAFE_RETRY" : outcome;
  const expectedBinding = "recoveryKind" in item ? item.recoveryGeneration : item.claimGeneration;
  if (
    result.version !== 1 || result.state !== "FAILURE_RECORDED" ||
    result.workItemId !== item.workItemId || result[bindingKey] !== expectedBinding ||
    result.outcome !== expectedOutcome || result.canonicalEvidenceHash !== evidenceHash
  ) throw new TypeError("maintenance failure result binding is invalid");
  if (outcome === "RETRY") {
    if (result.completedAt !== null) {
      throw new TypeError("maintenance retry result completion is invalid");
    }
    timestamp(result.retryNotBefore, "maintenance failure retryNotBefore");
  } else {
    timestamp(result.completedAt, "maintenance failure completedAt");
    if (result.retryNotBefore !== null) {
      throw new TypeError("maintenance terminal failure retry is invalid");
    }
  }
}

export async function processMaintenanceBatch({
  runtime,
  claimTokenFactory = () => randomBytes(32).toString("base64url"),
  limit = 8,
  leaseSeconds = MINIMUM_MAINTENANCE_LEASE_SECONDS,
  concurrency = 4,
  runRetention,
  runAudit,
  health,
  now = () => new Date(),
  organizationId,
  maintenancePrincipalId,
  signal,
  failureReportTimeoutMs = FAILURE_REPORT_BUDGET_SECONDS * 1_000,
  log = () => {},
}: {
  runtime: MaintenanceRuntimePort;
  claimTokenFactory?: () => string;
  limit?: number;
  leaseSeconds?: number;
  concurrency?: number;
  runRetention: (
    claim: MaintenanceWorkClaimV1 | RetentionDeleteAuthorizedRecoveryV1,
  ) => Promise<unknown>;
  runAudit: (
    claim: MaintenanceWorkClaimV1 | AuditVerifyAuthorizedRecoveryV1,
  ) => Promise<unknown>;
  health: MaintenanceHealthState;
  now?: () => Date;
  organizationId?: string;
  maintenancePrincipalId?: string;
  signal?: AbortSignal;
  failureReportTimeoutMs?: number;
  log?: (line: string) => void;
}): Promise<{ version: 1; claimed: number; completed: number; failed: number }> {
  integer(limit, 1, "claim limit");
  integer(leaseSeconds, MINIMUM_MAINTENANCE_LEASE_SECONDS, "lease seconds");
  integer(concurrency, 1, "worker concurrency");
  integer(failureReportTimeoutMs, 10, "failure report timeout");
  if (
    limit > 25 || leaseSeconds > 60 || concurrency > 8 ||
    failureReportTimeoutMs > FAILURE_REPORT_BUDGET_SECONDS * 1_000
  ) {
    throw new TypeError("maintenance worker bounds are invalid");
  }
  const claimToken = string(claimTokenFactory(), null, "claim token");
  if (claimToken.length < 32 || claimToken.length > 512) {
    throw new TypeError("claim token length is invalid");
  }
  const runnableLimit = Math.min(limit, concurrency);
  const claimedAt = now();
  let response: unknown;
  try {
    response = await runtime.post("/v1/maintenance/work/claim", {
      version: 1,
      claimToken,
      limit: runnableLimit,
      leaseSeconds,
      requestedKinds: ["RETENTION_DELETE", "AUDIT_ANCHOR"],
    });
  } catch (error) {
    health.markRuntimeFailure();
    log(JSON.stringify({
      event: "maintenance_claim_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    throw error;
  }
  let items: ParsedMaintenanceClaim[];
  try {
    const parsed = parseClaimBatch(
      response,
      claimToken,
      runnableLimit,
      claimedAt,
      organizationId,
      maintenancePrincipalId,
    );
    items = parsed.items;
    health.hydrateUnresolvedFailures(parsed.unresolvedFailures);
  } catch (error) {
    health.markRuntimeFailure();
    log(JSON.stringify({
      event: "maintenance_claim_invalid",
      errorName: error instanceof Error ? error.name : "UnknownError",
    }));
    throw error;
  }
  health.markRuntimeHealthy(claimedAt);
  let cursor = 0;
  let completed = 0;
  let failed = 0;
  const reportFailure = async (item: MaintenanceFailureClaim, error: unknown) => {
    const report = failureRequest(item, error);
    try {
      const result = await runtime.post(
        "/v1/maintenance/work/complete",
        report.body,
        { signal: requestSignal(failureReportTimeoutMs, signal) },
      );
      parseFailureRecorded(result, item, report.outcome, report.evidenceHash);
      health.markWorkFailureReported(item.payload.kind, item.workItemId);
    } catch (reportError) {
      health.markRuntimeFailure();
      health.markWorkFailure(item.payload.kind, item.workItemId);
      log(JSON.stringify({
        event: "maintenance_failure_report_failed",
        workKind: item.payload.kind,
        workItemId: item.workItemId,
        errorName: reportError instanceof Error ? reportError.name : "UnknownError",
      }));
    }
  };
  const worker = async () => {
    while (cursor < items.length) {
      const entry = items[cursor++];
      if (!entry) break;
      if (entry.state === "INVALID") {
        failed += 1;
        log(JSON.stringify({
          event: "maintenance_claim_item_invalid",
          itemIndex: entry.index,
          workKind: entry.workKind,
          reportable: entry.failureClaim !== null,
          errorName: entry.error instanceof Error ? entry.error.name : "UnknownError",
        }));
        if (signal?.aborted) {
          log(JSON.stringify({
            event: "maintenance_work_aborted",
            workKind: entry.workKind,
            workItemId: entry.failureClaim?.workItemId ?? null,
          }));
          continue;
        }
        if (entry.failureClaim === null) {
          const localFailureId = `invalid-claim:${entry.index}`;
          if (entry.workKind === null) {
            health.markWorkFailure("RETENTION_DELETE", localFailureId);
            health.markWorkFailure("AUDIT_ANCHOR", localFailureId);
          } else {
            health.markWorkFailure(entry.workKind, localFailureId);
          }
          continue;
        }
        await reportFailure(entry.failureClaim, entry.error);
        continue;
      }
      const item = entry.item;
      try {
        if (
          ("recoveryKind" in item && item.recoveryKind === "RETENTION_DELETE_AUTHORIZED") ||
          (!("recoveryKind" in item) && item.payload.kind === "RETENTION_DELETE")
        ) {
          await runRetention(item);
        }
        else await runAudit(item);
        health.markWorkHealthy(item.payload.kind, item.workItemId);
        completed += 1;
      } catch (error) {
        if (signal?.aborted) {
          log(JSON.stringify({
            event: "maintenance_work_aborted",
            workKind: item.payload.kind,
            workItemId: item.workItemId,
          }));
          failed += 1;
          continue;
        }
        log(JSON.stringify({
          event: "maintenance_work_failed",
          workKind: item.payload.kind,
          workItemId: item.workItemId,
          errorName: error instanceof Error ? error.name : "UnknownError",
          status: error && typeof error === "object" &&
              typeof (error as { status?: unknown }).status === "number"
            ? (error as { status: number }).status
            : null,
        }));
        await reportFailure(item, error);
        failed += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return { version: 1, claimed: items.length, completed, failed };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function runMaintenanceLoop({
  signal,
  pollIntervalMs,
  runBatch,
  log = () => {},
}: {
  signal: AbortSignal;
  pollIntervalMs: number;
  runBatch: () => Promise<unknown>;
  log?: (line: string) => void;
}): Promise<void> {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 300_000) {
    throw new TypeError("poll interval is invalid");
  }
  while (!signal.aborted) {
    const batch = Promise.resolve().then(runBatch).then(
      () => ({ kind: "complete" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<{ kind: "aborted" }>((resolveAbort) => {
      if (signal.aborted) resolveAbort({ kind: "aborted" });
      else {
        abortListener = () => resolveAbort({ kind: "aborted" });
        signal.addEventListener("abort", abortListener, { once: true });
      }
    });
    const outcome = await Promise.race([batch, aborted]);
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "failed") {
      log(JSON.stringify({
        event: "maintenance_batch_failed",
        errorName: outcome.error instanceof Error ? outcome.error.name : "UnknownError",
      }));
    }
    if (!signal.aborted) await abortableDelay(pollIntervalMs, signal);
  }
}

export class MediaGatewayError extends Error {
  readonly status: number | null;
  readonly code: "TICKET_EXPIRED_NO_WORK" | null;

  constructor(
    status: number | null,
    message: string,
    code: "TICKET_EXPIRED_NO_WORK" | null = null,
  ) {
    super(message);
    this.name = "MediaGatewayError";
    this.status = status;
    this.code = code;
  }
}

function gatewayOrigin(value: string): URL {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/"
  ) throw new TypeError("media gateway baseUrl must be an exact HTTPS origin");
  return url;
}

async function readGatewayJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok) {
    let code: "TICKET_EXPIRED_NO_WORK" | null = null;
    if (contentType === "application/json") {
      try {
        const text = await readBoundedUtf8Response(response, MAX_GATEWAY_RESPONSE_BYTES, {
          invalidContentLength: () => new Error("invalid gateway error body"),
          invalidUtf8: () => new Error("invalid gateway error body"),
          tooLarge: () => new Error("invalid gateway error body"),
        });
        const envelope = JSON.parse(text) as unknown;
        if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
          const top = envelope as Record<string, unknown>;
          const error = top.error;
          if (
            Object.keys(top).length === 1 && error && typeof error === "object" &&
            !Array.isArray(error)
          ) {
            const detail = error as Record<string, unknown>;
            if (
              Object.keys(detail).length === 1 &&
              detail.code === "TICKET_EXPIRED_NO_WORK"
            ) code = "TICKET_EXPIRED_NO_WORK";
          }
        }
      } catch {
        // Error bodies are optional evidence; status remains authoritative.
      }
    }
    throw new MediaGatewayError(response.status, "media gateway request failed", code);
  }
  if (contentType !== "application/json") {
    throw new MediaGatewayError(response.status, "media gateway returned non-JSON");
  }
  let text: string;
  try {
    text = await readBoundedUtf8Response(response, MAX_GATEWAY_RESPONSE_BYTES, {
      invalidContentLength: () => new MediaGatewayError(
        response.status,
        "media gateway returned invalid content length",
      ),
      invalidUtf8: () => new MediaGatewayError(
        response.status,
        "media gateway returned invalid UTF-8",
      ),
      tooLarge: () => new MediaGatewayError(
        response.status,
        "media gateway response is too large",
      ),
    });
  } catch (error) {
    if (error instanceof MediaGatewayError) throw error;
    throw new MediaGatewayError(response.status, "media gateway response body failed");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MediaGatewayError(response.status, "media gateway returned invalid JSON");
  }
}

export function createMediaGatewayClient({
  baseUrl,
  fetch = globalThis.fetch,
  timeoutMs = 10_000,
  signal,
}: {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): RetentionGatewayPort & AuditGatewayPort {
  const origin = gatewayOrigin(baseUrl);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("media gateway timeout is invalid");
  }
  const call = async (
    path: string,
    init: RequestInit,
    callSignal?: AbortSignal,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, origin), {
        ...init,
        redirect: "error",
        signal: requestSignal(timeoutMs, signal, callSignal),
      });
    } catch {
      throw new MediaGatewayError(null, "media gateway transport failed");
    }
    return await readGatewayJson(response);
  };
  return Object.freeze({
    putObject: ({ ticketHeader, contentType, bytes }: {
      ticketHeader: string;
      contentType: "application/json";
      bytes: Uint8Array;
    }, callOptions?: Readonly<{ signal?: AbortSignal }>) => call("v1/object", {
      method: "PUT",
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": contentType,
        "x-openclaw-media-ticket": ticketHeader,
      },
      body: bytes,
    }, callOptions?.signal),
    verifyObject: ({ ticketHeader }: {
      ticketHeader: string;
    }, callOptions?: Readonly<{ signal?: AbortSignal }>) => call("v1/object/verify", {
      method: "POST",
      headers: { "x-openclaw-media-ticket": ticketHeader },
    }, callOptions?.signal),
    deleteObject: ({ ticketHeader, deleteAuthorizationHeader }: {
      ticketHeader: string;
      deleteAuthorizationHeader: string;
    }, callOptions?: Readonly<{ signal?: AbortSignal }>) => call("v1/object", {
      method: "DELETE",
      headers: {
        "x-openclaw-delete-authorization": deleteAuthorizationHeader,
        "x-openclaw-media-ticket": ticketHeader,
      },
    }, callOptions?.signal),
  });
}

export async function readSecretFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new TypeError("secret file path must be absolute");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new TypeError("secret path must be a regular non-symlink file");
  }
  // Windows maps chmod(0400) to a read-only 0444 facade. The production Linux
  // container still requires the literal owner-only 0400 mode.
  const exactReadOnlyMode = (mode: number) => process.platform === "win32"
    ? (mode & 0o777) === 0o444
    : (mode & 0o777) === 0o400;
  if (!exactReadOnlyMode(before.mode)) {
    throw new TypeError("secret file must use exact mode 0400");
  }
  if (before.size < 1 || before.size > 16_384) {
    throw new TypeError("secret file size is invalid");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino
    ) throw new TypeError("secret file changed before it was opened");
    if (!exactReadOnlyMode(opened.mode)) {
      throw new TypeError("secret file must use exact mode 0400");
    }
    if (opened.size < 1 || opened.size > 16_384) {
      throw new TypeError("secret file size is invalid");
    }
    const value = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size ||
      !exactReadOnlyMode(after.mode)
    ) throw new TypeError("secret file changed while being read");
    if (value !== value.trim() || /[\r\n\0]/u.test(value) || value.length < 1) {
      throw new TypeError("secret file must contain one trimmed line");
    }
    return value;
  } finally {
    await handle.close();
  }
}

interface MaintenanceProcessConfiguration {
  functionsBaseUrl: string;
  gatewayBaseUrl: string;
  organizationId: string;
  maintenancePrincipalId: string;
  credentialFile: string;
  auditPrivateKeyFile: string;
  auditPrivateKeyGeneration: number;
  host: string;
  port: number;
  pollIntervalMs: number;
  claimLimit: number;
  leaseSeconds: number;
  concurrency: number;
}

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function environmentInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/u.test(raw)) throw new TypeError(`${name} is invalid`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return result;
}

export function readMaintenanceProcessConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): MaintenanceProcessConfiguration {
  const organizationId = environmentValue(env, "OPENCLAW_MAINTENANCE_ORGANIZATION_ID");
  const maintenancePrincipalId = environmentValue(
    env,
    "OPENCLAW_MAINTENANCE_PRINCIPAL_ID",
  );
  string(organizationId, UUID, "OPENCLAW_MAINTENANCE_ORGANIZATION_ID");
  string(maintenancePrincipalId, UUID, "OPENCLAW_MAINTENANCE_PRINCIPAL_ID");
  const host = env.OPENCLAW_MAINTENANCE_HOST ?? "0.0.0.0";
  if (
    host.length === 0 || host.length > 253 ||
    [...host].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new TypeError("OPENCLAW_MAINTENANCE_HOST is invalid");
  }
  return {
    functionsBaseUrl: environmentValue(env, "OPENCLAW_FUNCTIONS_BASE_URL"),
    gatewayBaseUrl: environmentValue(env, "OPENCLAW_MEDIA_GATEWAY_URL"),
    organizationId,
    maintenancePrincipalId,
    credentialFile: environmentValue(env, "OPENCLAW_MAINTENANCE_CREDENTIAL_FILE"),
    auditPrivateKeyFile: environmentValue(env, "OPENCLAW_AUDIT_PRIVATE_KEY_FILE"),
    auditPrivateKeyGeneration: environmentInteger(
      env,
      "OPENCLAW_AUDIT_SIGNING_KEY_GENERATION",
      1,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    host,
    port: environmentInteger(env, "OPENCLAW_MAINTENANCE_PORT", 8080, 1, 65_535),
    pollIntervalMs: environmentInteger(
      env,
      "OPENCLAW_MAINTENANCE_POLL_INTERVAL_MS",
      2_000,
      100,
      300_000,
    ),
    claimLimit: environmentInteger(env, "OPENCLAW_MAINTENANCE_CLAIM_LIMIT", 8, 1, 25),
    leaseSeconds: environmentInteger(
      env,
      "OPENCLAW_MAINTENANCE_LEASE_SECONDS",
      60,
      MINIMUM_MAINTENANCE_LEASE_SECONDS,
      60,
    ),
    concurrency: environmentInteger(env, "OPENCLAW_MAINTENANCE_CONCURRENCY", 4, 1, 8),
  };
}

export async function startMaintenanceProcess({
  env = process.env,
  fetch,
  log = (line) => console.log(line),
}: {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
} = {}) {
  const config = readMaintenanceProcessConfiguration(env);
  const abortController = new AbortController();
  const [credential, auditPrivateKeyPkcs8B64] = await Promise.all([
    readSecretFile(config.credentialFile),
    readSecretFile(config.auditPrivateKeyFile),
  ]);
  await validateAuditSigningPrivateKey(auditPrivateKeyPkcs8B64);
  const runtime = createMaintenanceRuntimeClient({
    functionsBaseUrl: config.functionsBaseUrl,
    organizationId: config.organizationId,
    maintenancePrincipalId: config.maintenancePrincipalId,
    credential,
    fetch,
    signal: abortController.signal,
  });
  const gateway = createMediaGatewayClient({
    baseUrl: config.gatewayBaseUrl,
    fetch,
    signal: abortController.signal,
  });
  const health = createMaintenanceHealthState();
  const server = createMaintenanceHealthServer({ health });
  const batch = () => processMaintenanceBatch({
    runtime,
    limit: config.claimLimit,
    leaseSeconds: config.leaseSeconds,
    concurrency: config.concurrency,
    health,
    signal: abortController.signal,
    organizationId: config.organizationId,
    maintenancePrincipalId: config.maintenancePrincipalId,
    log,
    runRetention: (claim) => runRetentionWork({
      claim,
      runtime,
      gateway,
    }),
    runAudit: (claim) => runAuditAnchorWork({
      claim,
      runtime,
      gateway,
      auditPrivateKeyPkcs8B64,
      auditPrivateKeyGeneration: config.auditPrivateKeyGeneration,
    }),
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, config.host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  log(JSON.stringify({
    event: "maintenance_listening",
    address: address.address,
    port: address.port,
  }));
  const loop = runMaintenanceLoop({
    signal: abortController.signal,
    pollIntervalMs: config.pollIntervalMs,
    runBatch: batch,
    log,
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    abortController.abort();
    await loop;
    await closeMaintenanceHealthServer(server);
  };
  return { server, health, loop, stop, address };
}

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  void startMaintenanceProcess().then(({ stop }) => {
    const shutdown = () => void stop().then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; },
    );
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }, () => {
    console.error('{"event":"maintenance_start_failed"}');
    process.exitCode = 1;
  });
}

export { authorizeMaintenance, MAINTENANCE_WORK_KINDS } from "./runtime-client.js";
export { runRetentionWork } from "./retention-runner.js";
export { buildSignedAuditAnchor, runAuditAnchorWork } from "./audit-anchor-runner.js";
