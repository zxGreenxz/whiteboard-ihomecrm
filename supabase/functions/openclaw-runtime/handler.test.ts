import { describe, expect, it, vi } from "vitest";

import { base64UrlEncode, canonicalJson } from "../_shared/openclaw/crypto";
import { handleRuntimeRequest, type RuntimeDependencies } from "./handler";
import {
  CHANNEL_WORK_KINDS,
  findRuntimeRoute,
  MAINTENANCE_WORK_KINDS,
  RUNTIME_ROUTES,
  validateInboundBatch,
  workKindIsAllowed,
} from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const MAINTENANCE_ID = "dddd3000-0000-4000-8000-000000000001";
const OUTBOX_ID = "dddd8000-0000-4000-8000-000000000001";
const INBOUND_REQUEST_ID = "dddd7000-0000-4000-8000-000000000010";
const CLAIM_TOKEN = "c".repeat(32);
const RETENTION_TICKET_ID = "dddd7000-0000-4000-8000-000000000020";

function base64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}

async function signedRetentionReceipt(overrides: Record<string, unknown> = {}) {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const unsigned = {
    version: 1,
    receiptKind: "RETENTION_FINAL_DELETE",
    receiptId: "dddd7000-0000-4000-8000-000000000021",
    organizationId: ORGANIZATION_ID,
    maintenancePrincipalId: MAINTENANCE_ID,
    workItemId: "dddd7000-0000-4000-8000-000000000022",
    claimGeneration: 2,
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    objectKey: `v1/org/${ORGANIZATION_ID}/media/object-1`,
    deletePhase: "FINAL_DELETE",
    holdVersion: 0,
    quarantineVersion: 1,
    deleteTicketJti: "dddd7000-0000-4000-8000-000000000023",
    deleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000024",
    proofJti: "dddd7000-0000-4000-8000-000000000024",
    objectStatus: "DELETED",
    r2VersionOrEtag: "etag-1",
    completedAt: "2026-08-01T00:00:00.000Z",
    gatewaySigningKeyGeneration: 1,
    ...overrides,
  };
  const signature = base64UrlEncode(new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(
      `ihome-openclaw-retention-receipt-v1\0${canonicalJson(unsigned)}`,
    ),
  )));
  return {
    receipt: { ...unsigned, signature },
    publicKey: base64(await crypto.subtle.exportKey("spki", keys.publicKey)),
  };
}

async function signedMediaUploadReceipt(overrides: Record<string, unknown> = {}) {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const unsigned = {
    version: 1,
    receiptKind: "MEDIA_UPLOAD",
    receiptId: "dddd7000-0000-4000-8000-000000000051",
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    mediaId: "dddd7000-0000-4000-8000-000000000052",
    objectKey: `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}` +
      "/conversation/dddd7000-0000-4000-8000-000000000054" +
      "/message/dddd7000-0000-4000-8000-000000000055" +
      "/media/dddd7000-0000-4000-8000-000000000052/original",
    sha256: "a".repeat(64),
    contentType: "image/png",
    contentLength: 64,
    uploadTicketJti: "dddd7000-0000-4000-8000-000000000053",
    credentialGeneration: 1,
    leaseGeneration: 1,
    fencingToken: 1,
    sessionGeneration: 1,
    objectVersionOrEtag: "etag-1",
    storedAt: "2026-08-01T00:00:00.000Z",
    gatewaySigningKeyGeneration: 1,
    ...overrides,
  };
  const signature = base64UrlEncode(new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(
      `ihome-openclaw-media-upload-receipt-v1\0${canonicalJson(unsigned)}`,
    ),
  )));
  return {
    receipt: { ...unsigned, signature },
    publicKey: base64(await crypto.subtle.exportKey("spki", keys.publicKey)),
  };
}

const authorizationMarker = {
  version: 1,
  outboxId: OUTBOX_ID,
  claimGeneration: 2,
  payloadHash: "d".repeat(64),
  fencingToken: 1,
  sessionGeneration: 1,
  controlVersion: 1,
  takeoverVersion: 0,
  markerNonce: "dddd7000-0000-4000-8000-000000000009",
  expiresAt: "2026-08-01T00:00:15.000Z",
};
const authorization = { version: 1, claimToken: CLAIM_TOKEN, authorizationMarker };
const deliveryEvidence = {
  version: 1,
  evidenceKind: "OUTBOX_DELIVERY",
  outboxId: OUTBOX_ID,
  claimGeneration: 2,
  payloadHash: "d".repeat(64),
  authorizationMarker,
  totalPartCount: 1,
  knownProviderMessageIds: ["provider-message-1"],
  possibleHandoffPrefixLength: 1,
  outcome: "SENT",
  reasonCode: "ALL_PARTS_ACKNOWLEDGED",
};
const outboxCompletion = {
  version: 1,
  authorization,
  deliveryEvidence,
  deliveryEvidenceHash: "e".repeat(64),
  outcome: "SENT",
  reasonCode: "ALL_PARTS_ACKNOWLEDGED",
};

const channelPrincipal = {
  version: 1 as const,
  principalKind: "CHANNEL" as const,
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  cellId: CELL_ID,
  credentialGeneration: 1,
  leaseGeneration: 1,
  fencingToken: 1,
  sessionGeneration: 1,
  localSessionGeneration: 1,
  authMode: "NORMAL" as const,
};

const heartbeatRequest = {
  version: 1,
  commandClaimToken: CLAIM_TOKEN,
  commandLeaseSeconds: 60,
  commandStarts: [],
  commandResults: [],
};

const maintenancePrincipal = {
  version: 1 as const,
  principalKind: "MAINTENANCE" as const,
  organizationId: ORGANIZATION_ID,
  maintenancePrincipalId: MAINTENANCE_ID,
  credentialGeneration: 1,
  leaseGeneration: 1,
  fencingToken: 1,
};

function unsignedDeleteTicketResult() {
  return {
    version: 1,
    ticketId: RETENTION_TICKET_ID,
    ticket: {
      version: 1,
      aud: "openclaw-media-gateway",
      operation: "DELETE",
      subject: "MAINTENANCE",
      jti: "dddd7000-0000-4000-8000-000000000023",
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey: `v1/org/${ORGANIZATION_ID}/media/object-1`,
      sha256: "b".repeat(64),
      contentType: "image/png",
      contentLength: 64,
      sessionGeneration: 0,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 1,
      iat: 1_785_062_400,
      exp: 1_785_062_430,
      maintenancePrincipalId: MAINTENANCE_ID,
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      deletePhase: "FINAL_DELETE",
      quarantineVersion: 1,
      finalDeleteNotBefore: 1_784_000_000,
      holdVersion: 0,
    },
    ticketHash: "a".repeat(64),
    expiresAt: "2026-08-01T00:00:30.000Z",
    state: "TICKET_ISSUED",
  };
}

function unsignedDeleteAuthorizationResult() {
  return {
    version: 1,
    ticketId: RETENTION_TICKET_ID,
    ticketHash: "a".repeat(64),
    deleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000024",
    expiresAt: "2026-08-01T00:00:05.000Z",
    state: "DELETE_AUTHORIZED",
    authorization: {
      version: 1,
      authorizationKind: "RETENTION_FINAL_DELETE",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      objectKey: `v1/org/${ORGANIZATION_ID}/media/object-1`,
      deletePhase: "FINAL_DELETE",
      holdVersion: 0,
      quarantineVersion: 1,
      deleteTicketJti: "dddd7000-0000-4000-8000-000000000023",
      authorizationJti: "dddd7000-0000-4000-8000-000000000024",
      iat: "2026-08-01T00:00:00.000Z",
      exp: "2026-08-01T00:00:05.000Z",
      gatewaySigningKeyGeneration: 1,
    },
  };
}

function runtimeRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://edge.invalid/openclaw-runtime${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer runtime.token.value",
      "x-openclaw-timestamp": "1785062400",
      "x-openclaw-nonce": "dddd7000-0000-4000-8000-000000000001",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function canonicalInboundBatch(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    sessionGeneration: 1,
    events: [{
      version: 1,
      eventKind: "MESSAGE",
      providerEventId: "provider-event-handler-1",
      providerMessageId: "provider-message-handler-1",
      providerConversationId: "provider-conversation-handler-1",
      providerSenderId: "provider-sender-handler-1",
      providerTarget: { kind: "PEER", providerId: "peer-handler-1" },
      providerEventType: "MESSAGE",
      sourceTimestamp: "2026-08-01T00:00:00.000Z",
      callbackReceivedAt: "2026-08-01T00:00:01.000Z",
      rawEnvelope: { event: "message" },
      rawEnvelopeSha256: "a".repeat(64),
      normalized: { text: "hello", replyToProviderMessageId: null, mediaManifest: [] },
      normalizedSha256: "b".repeat(64),
    }],
    ...overrides,
  };
}

function inboundWorkClaim() {
  return {
    version: 1,
    workItemId: "dddd9000-0000-4000-8000-000000000001",
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    credentialGeneration: 1,
    leaseGeneration: 1,
    sourceKey: "inbound:event:message:target",
    claimToken: CLAIM_TOKEN,
    claimGeneration: 2,
    fencingToken: 1,
    leaseExpiresAt: "2026-08-01T00:00:30.000Z",
    payload: {
      kind: "INBOUND_AUTOMATION",
      inboundEventId: "dddd9100-0000-4000-8000-000000000001",
      messageId: "dddd9200-0000-4000-8000-000000000001",
      conversationId: "dddd9300-0000-4000-8000-000000000001",
      targetId: "dddd9400-0000-4000-8000-000000000001",
      targetVersion: 1,
      targetDirectoryRefreshedAt: "2026-08-01T00:00:00.000Z",
      automationVersionId: "dddd9500-0000-4000-8000-000000000001",
      templateVersionId: "dddd9600-0000-4000-8000-000000000001",
      knowledgeVersionIds: ["dddd9700-0000-4000-8000-000000000001"],
      eligibilityDecisionHash: "a".repeat(64),
    },
  };
}

function inboundWorkContextResult() {
  const claim = inboundWorkClaim();
  return {
    version: 1,
    workItemId: claim.workItemId,
    claimGeneration: claim.claimGeneration,
    kind: "INBOUND_AUTOMATION",
    currentState: { allowed: true },
    frozenContext: {
      customerText: "hello",
      knowledgeChunks: [{
        chunkId: "dddd9800-0000-4000-8000-000000000001",
        versionId: claim.payload.knowledgeVersionIds[0],
        sensitivity: "CUSTOMER_SAFE",
        text: "Open from 8 to 20.",
      }],
      canonicalPayload: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        target: { kind: "PEER", providerId: "peer-handler-1" },
        channel: "zalouser",
        accountProfile: "default",
        idempotencyKey: `work:${claim.workItemId}:${claim.claimGeneration}`,
        parts: [{ version: 1, partIndex: 0, kind: "TEXT", text: "[PENDING_RENDER]" }],
        replyToProviderMessageId: null,
        policyVersionId: "dddd9900-0000-4000-8000-000000000001",
        automationVersionId: claim.payload.automationVersionId,
        templateVersionId: claim.payload.templateVersionId,
        frozenInputs: {
          campaignVersionId: null,
          scheduleVersion: null,
          subscriptionVersion: null,
          subscriptionId: null,
          occurrenceId: null,
          sourceTable: null,
          sourceId: null,
          sourceVersion: null,
          knowledgeVersionIds: claim.payload.knowledgeVersionIds,
          sourceSnapshotHash: claim.payload.eligibilityDecisionHash,
          targetVersion: claim.payload.targetVersion,
          targetDirectoryRefreshedAt: claim.payload.targetDirectoryRefreshedAt,
          fieldMappingHash: null,
        },
      },
      sourceSnapshotHash: claim.payload.eligibilityDecisionHash,
    },
  };
}

/**
 * Khoác hình dạng PostgrestFilterBuilder lên một kết quả rpc giả lập.
 *
 * Chỉ dựng đúng phần hợp đồng mà handler dùng: `.abortSignal()` trả về chính nó
 * để còn `await` được. KHÔNG dựng cả builder — một bản giả càng đầy đủ càng dễ
 * lệch khỏi supabase-js thật mà không ai biết, và phần thừa đó không được test
 * nào chạm tới.
 *
 * Tín hiệu huỷ được GIỮ LẠI để test có thể khẳng định hạn giờ thật sự được gắn,
 * thay vì chỉ chứng minh lời gọi không nổ.
 */
function nhuBuilder(ketQua: unknown) {
  const thenable = Promise.resolve(ketQua) as Promise<unknown> & {
    abortSignal: (signal: AbortSignal) => typeof thenable;
    signalDaNhan?: AbortSignal;
  };
  thenable.abortSignal = (signal: AbortSignal) => {
    thenable.signalDaNhan = signal;
    tinHieuHuyGanNhat = signal;
    return thenable;
  };
  return thenable;
}

/** Tín hiệu huỷ của lời gọi facade gần nhất — dùng cho khẳng định hạn giờ. */
let tinHieuHuyGanNhat: AbortSignal | undefined;

function dependencies(options: {
  rpc?: ReturnType<typeof vi.fn>;
  verify?: ReturnType<typeof vi.fn>;
  principal?: unknown;
  logger?: { error: ReturnType<typeof vi.fn> };
  gatewayReceiptPublicKey?: string;
  signGatewayPayload?: ReturnType<typeof vi.fn>;
  ticketKeyGeneration?: number;
  historicalTicketSigningKeys?: RuntimeDependencies["historicalTicketSigningKeys"];
} = {}) {
  const principal = options.principal ?? channelPrincipal;
  const rpc = options.rpc ?? vi.fn((name: string) => Promise.resolve({
    data: name.includes("claim_outbox") || name.includes("claim_work_item")
      ? principal && typeof principal === "object" &&
          (principal as { principalKind?: unknown }).principalKind === "MAINTENANCE"
        ? { version: 1, items: [], unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 } }
        : { version: 1, items: [] }
      : name.includes("ingest_inbound_batch")
      ? {
        version: 1,
        requestId: INBOUND_REQUEST_ID,
        accepted: 1,
        deduplicated: 0,
        quarantined: 0,
        results: [{
          index: 0,
          status: "ACCEPTED",
          inboundEventId: "dddd7000-0000-4000-8000-000000000041",
          messageId: "dddd7000-0000-4000-8000-000000000042",
          decisionId: "dddd7000-0000-4000-8000-000000000043",
          decisionKind: "NO_SEND",
          noSendReason: "TARGET_INELIGIBLE",
          workItemId: null,
          media: [],
        }],
      }
      : { version: 1 },
    error: null,
  }));
  const verify = options.verify ??
    vi.fn(() => Promise.resolve({
      principal,
      nonce: "n",
      operation: "op",
      bodySha256: "0".repeat(64),
      issuedAtEpochSeconds: 1_785_062_400,
      expiresAtEpochSeconds: 1_785_062_700,
    }));
  return {
    environment: {
      supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co",
      supabaseAnonKey: "anon",
      supabaseServiceRoleKey: "service",
      runtimeTokenSigningKey: "x".repeat(48),
      browserOrigins: ["https://ptcrm.vercel.app"],
      gatewayReceiptKeyRegistry: options.gatewayReceiptPublicKey
        ? {
          "1": {
            generation: 1,
            publicKeySpkiBase64: options.gatewayReceiptPublicKey,
            activatesAt: "2026-07-01T00:00:00.000Z",
            retiresAt: "2026-09-01T00:00:00.000Z",
            revokedAt: null,
          },
        }
        : {},
    },
    // `rpc()` thật của supabase-js trả về PostgrestFilterBuilder — một thenable
    // có thêm các phương thức chuỗi, trong đó có `.abortSignal()`. Bộ giả lập ở
    // đây trả về Promise trần, nên từ khi fc12840f gắn hạn giờ cho lời gọi facade
    // (`.abortSignal(AbortSignal.timeout(...))`) thì MỌI đường có chạm SQL đều
    // ném `client.rpc(...).abortSignal is not a function` và rơi vào catch → 500.
    // Đó là toàn bộ 18 test đỏ, và cả 18 đều báo "expected 500 to be 200", một
    // thông báo không hề nhắc tới abortSignal.
    //
    // Bọc tại ĐÚNG MỘT chỗ này thay vì sửa từng bộ giả lập: mỗi test vẫn truyền
    // `rpc` riêng của nó và mọi khẳng định `toHaveBeenCalledWith` vẫn nguyên, vì
    // spy không bị thay — chỉ giá trị TRẢ VỀ được khoác thêm hình dạng builder.
    createServiceClient: () => ({
      rpc: (...args: unknown[]) => nhuBuilder((rpc as (...a: unknown[]) => unknown)(...args)),
    }),
    verifyRuntimeRequest: verify,
    logger: options.logger ?? { error: vi.fn() },
    requestIdFactory: () => "dddd9000-0000-4000-8000-000000000001",
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    signGatewayPayload: options.signGatewayPayload ?? vi.fn(() => Promise.resolve("A".repeat(86))),
    ticketKeyGeneration: options.ticketKeyGeneration ?? 1,
    historicalTicketSigningKeys: options.historicalTicketSigningKeys,
    rpc,
    verify,
  };
}

describe("OpenClaw runtime route allowlist", () => {
  it("exposes exactly the twenty-one approved runtime routes", () => {
    expect(RUNTIME_ROUTES.map((route) => route.path)).toEqual([
      "/v1/heartbeat",
      "/v1/qr/publish",
      "/v1/qr/result",
      "/v1/inbound/batch",
      "/v1/outbox/claim",
      "/v1/outbox/preflight",
      "/v1/outbox/authorize-send",
      "/v1/outbox/requeue",
      "/v1/outbox/complete",
      "/v1/work/claim",
      "/v1/work/context",
      "/v1/work/complete",
      "/v1/work/create-outbox",
      "/v1/media/upload-ticket",
      "/v1/media/upload-complete",
      "/v1/maintenance/work/claim",
      "/v1/maintenance/work/complete",
      "/v1/maintenance/media/upload-ticket",
      "/v1/maintenance/media/verify-ticket",
      "/v1/maintenance/retention/delete-ticket",
      "/v1/maintenance/retention/authorize-delete",
    ]);
  });

  it("binds every route to one public service facade and one principal audience", () => {
    for (const route of RUNTIME_ROUTES) {
      expect(route.facade, route.path).toMatch(/^openclaw_service_[a-z0-9_]+_v1$/);
      expect(["CHANNEL", "MAINTENANCE"], route.path).toContain(route.principalKind);
      expect(route.path.startsWith("/v1/maintenance/"), route.path).toBe(
        route.principalKind === "MAINTENANCE",
      );
      expect(typeof (route as { validateRequest?: unknown }).validateRequest, route.path)
        .toBe("function");
      expect(typeof (route as { validateResponse?: unknown }).validateResponse, route.path)
        .toBe("function");
    }
  });

  it("accepts only exact discriminated channel work completion evidence", () => {
    const route = findRuntimeRoute("POST", "/v1/work/complete");
    expect(route).toBeDefined();
    const base = {
      version: 1,
      workItemId: "dddd7000-0000-4000-8000-000000000030",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      credentialGeneration: 1,
      leaseGeneration: 1,
      claimToken: CLAIM_TOKEN,
      claimGeneration: 1,
      fencingToken: 1,
      outcome: "COMPLETE",
      retryAfterSeconds: null,
      evidenceHash: "a".repeat(64),
    };
    const noSend = {
      version: 1,
      evidenceKind: "NO_SEND",
      reasonCode: "TAKEOVER_ACTIVE",
    };
    const humanDraft = {
      version: 1,
      evidenceKind: "HUMAN_DRAFT",
      reasonCode: "DLP_BLOCKED",
      classification: "TENANT_SUPPORT",
      confidenceBasisPoints: 7500,
      findings: ["EMAIL", "PHONE_NUMBER"],
      draftText: "Lien he [REDACTED_EMAIL].",
      draftHash: "b".repeat(64),
    };

    expect(route?.validateRequest({ ...base, evidence: noSend })).toBe(true);
    expect(route?.validateRequest({ ...base, evidence: humanDraft })).toBe(true);
    expect(route?.validateRequest({
      ...base,
      evidence: { disposition: "NO_SEND", reasonCode: "TAKEOVER_ACTIVE" },
    })).toBe(false);
    expect(route?.validateRequest({
      ...base,
      evidence: { ...humanDraft, prompt: "secret prompt" },
    })).toBe(false);
    expect(route?.validateRequest({
      ...base,
      evidence: { ...humanDraft, findings: ["EMAIL", "EMAIL"] },
    })).toBe(false);
  });

  it("routes QR publication and connection finalization through distinct facades", () => {
    const publish = findRuntimeRoute("POST", "/v1/qr/publish");
    const finalize = findRuntimeRoute("POST", "/v1/qr/result");

    expect(publish).toMatchObject({
      facade: "openclaw_service_submit_qr_result_v1",
      serviceOperation: "openclaw_submit_qr_result_v1",
    });
    expect(finalize).toMatchObject({
      facade: "openclaw_service_finalize_account_connection_v1",
      serviceOperation: "openclaw_finalize_account_connection_v1",
    });
    expect(finalize?.facade).not.toBe(publish?.facade);
  });

  it("delivers only bounded QR_LOGIN and DISCONNECT command claims through heartbeat", () => {
    const route = findRuntimeRoute("POST", "/v1/heartbeat")!;
    const request = {
      version: 1,
      commandClaimToken: CLAIM_TOKEN,
      commandLeaseSeconds: 60,
      commandStarts: [{
        version: 1,
        runtimeCommandId: "dddd7000-0000-4000-8000-000000000071",
        commandKind: "DISCONNECT",
        claimGeneration: 2,
        claimToken: CLAIM_TOKEN,
        payloadHash: "d".repeat(64),
      }],
      commandResults: [{
        version: 1,
        runtimeCommandId: "dddd7000-0000-4000-8000-000000000071",
        commandKind: "DISCONNECT",
        claimGeneration: 2,
        claimToken: CLAIM_TOKEN,
        outcome: "PROVIDER_LOGGED_OUT",
        result: {
          version: 1,
          revocationId: "dddd7000-0000-4000-8000-000000000072",
          revokedSessionGeneration: 2,
          minimumSessionGeneration: 3,
          channel: "zalouser",
          accountId: ACCOUNT_ID,
          credentialsCleared: false,
          loggedOut: true,
          status: "PROVIDER_LOGGED_OUT",
        },
      }],
    };
    const response = {
      version: 1,
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      observedAt: "2026-08-01T00:00:00.000Z",
      accepted: true,
      authMode: "NORMAL",
      currentSessionGeneration: 3,
      currentConnectionGeneration: 3,
      commandResultAcks: [{
        version: 1,
        runtimeCommandId: "dddd7000-0000-4000-8000-000000000071",
        commandKind: "DISCONNECT",
        claimGeneration: 2,
        outcome: "PROVIDER_LOGGED_OUT",
        resultHash: "e".repeat(64),
        adoptSessionGeneration: 3,
        status: "ACCEPTED",
      }],
      commands: [{
        version: 1,
        runtimeCommandId: "dddd7000-0000-4000-8000-000000000073",
        commandKind: "QR_LOGIN",
        commandVersion: 1,
        claimGeneration: 1,
        claimToken: CLAIM_TOKEN,
        leaseExpiresAt: "2026-08-01T00:00:30.000Z",
        sourceSessionGeneration: 3,
        targetSessionGeneration: 3,
        sourceConnectionGeneration: 2,
        targetConnectionGeneration: 2,
        expectedFencingToken: 1,
        executionState: "LEASED",
        effectDeadlineAt: null,
        payload: {
          version: 1,
          challengeId: "dddd7000-0000-4000-8000-000000000074",
          browserNonceHash: "b".repeat(64),
        },
        payloadHash: "c".repeat(64),
      }],
    };

    expect(route.validateRequest(request)).toBe(true);
    const failedBeforeStartRequest = {
      ...request,
      commandStarts: [],
      commandResults: [{
        version: 1,
        runtimeCommandId: "dddd7000-0000-4000-8000-000000000075",
        commandKind: "QR_LOGIN",
        claimGeneration: 1,
        claimToken: CLAIM_TOKEN,
        outcome: "FAILED",
        result: {
          version: 1,
          reasonCode: "PROVIDER_UNAVAILABLE",
          failureFingerprint: "f".repeat(64),
          status: "FAILED_BEFORE_START",
        },
      }],
    };
    expect(route.validateRequest(failedBeforeStartRequest)).toBe(true);
    expect(route.validateRequest({ version: 1 })).toBe(false);
    expect(route.validateRequest({ ...request, commandResults: Array(9).fill(request.commandResults[0]) }))
      .toBe(false);
    expect(route.validateResponse(response)).toBe(true);
    // Capacity controls ride back to the cell in this exact response. The contract is
    // exact-keyed, so an unlisted key would 502 EVERY heartbeat for EVERY organization
    // and silently brick the runtime the moment the migration lands.
    expect(route.validateResponse({
      ...response,
      capacityControls: [{
        control: "PAUSE_ALL_OUTBOUND_MEDIA",
        appliedAt: "2026-08-01T00:00:00.000Z",
        reasonFingerprint: "quota:transfer:100",
        requiresManualResume: true,
      }],
    })).toBe(true);
    // Optional in BOTH directions: the Edge and the migration deploy separately, so
    // each side must tolerate the other being ahead.
    expect(route.validateResponse({ ...response, capacityControls: [] })).toBe(true);
    expect(route.validateResponse(response)).toBe(true);
    // Still exact: a malformed control or an unknown key is rejected.
    expect(route.validateResponse({
      ...response,
      capacityControls: [{ control: "NOT_A_CONTROL", appliedAt: "2026-08-01T00:00:00.000Z", reasonFingerprint: "x", requiresManualResume: true }],
    })).toBe(false);
    expect(route.validateResponse({ ...response, unexpectedKey: 1 })).toBe(false);
    expect(route.validateResponse({
      ...response,
      commandResultAcks: [{
        version: 1,
        runtimeCommandId: "dddd7000-0000-4000-8000-000000000075",
        commandKind: "QR_LOGIN",
        claimGeneration: 1,
        outcome: "FAILED",
        resultHash: "f".repeat(64),
        adoptSessionGeneration: null,
        status: "ACCEPTED",
      }],
    })).toBe(true);
    expect(route.validateResponse({
      ...response,
      commands: [{ ...response.commands[0], commandKind: "CELL_REBIND" }],
    })).toBe(false);
  });

  it("routes maintenance completion only through the specialized dispatcher facade", () => {
    expect(findRuntimeRoute("POST", "/v1/maintenance/work/complete")).toMatchObject({
      facade: "openclaw_service_complete_maintenance_work_v1",
      serviceOperation: "openclaw_complete_maintenance_work_v1",
      principalKind: "MAINTENANCE",
    });
  });

  it("loads frozen work context through one claim-bound facade", () => {
    const route = findRuntimeRoute("POST", "/v1/work/context");
    const claim = inboundWorkClaim();
    expect(route).toMatchObject({
      facade: "openclaw_service_get_work_context_v1",
      serviceOperation: "openclaw_get_work_context_v1",
      principalKind: "CHANNEL",
    });
    expect(route?.validateRequest({ version: 1, claim })).toBe(true);
    expect(route?.validateRequest({ version: 1, claim, organizationId: ORGANIZATION_ID }))
      .toBe(false);
    expect(route?.validateResponse(inboundWorkContextResult())).toBe(true);
    expect(route?.validateResponse({
      ...inboundWorkContextResult(),
      frozenContext: {
        ...inboundWorkContextResult().frozenContext,
        sourceSnapshotHash: "b".repeat(64),
      },
    })).toBe(false);
  });

  it("requires stable media mappings on accepted and duplicate inbound results", () => {
    const route = findRuntimeRoute("POST", "/v1/inbound/batch")!;
    const mediaId = "dddd7000-0000-4000-8000-000000000030";
    const valid = {
      version: 1,
      requestId: INBOUND_REQUEST_ID,
      accepted: 1,
      deduplicated: 1,
      quarantined: 0,
      results: [
        {
          index: 0,
          status: "ACCEPTED",
          inboundEventId: "dddd7000-0000-4000-8000-000000000031",
          messageId: "dddd7000-0000-4000-8000-000000000032",
          decisionId: "dddd7000-0000-4000-8000-000000000033",
          decisionKind: "WORK_ELIGIBLE",
          noSendReason: null,
          workItemId: "dddd7000-0000-4000-8000-000000000034",
          media: [{ manifestIndex: 0, mediaId }],
        },
        {
          index: 1,
          status: "DUPLICATE",
          inboundEventId: "dddd7000-0000-4000-8000-000000000031",
          media: [{ manifestIndex: 0, mediaId }],
        },
      ],
    };
    expect(route.validateResponse(valid)).toBe(true);
    expect(route.validateResponse({
      ...valid,
      results: [{ ...valid.results[0], media: [{ manifestIndex: 1, mediaId }] }, valid.results[1]],
    })).toBe(false);
    expect(route.validateResponse({
      ...valid,
      results: [Object.fromEntries(
        Object.entries(valid.results[0]).filter(([key]) => key !== "media"),
      ), valid.results[1]],
    })).toBe(false);
  });

  it("issues upload tickets only from bridge-verified canonical bytes", () => {
    const route = findRuntimeRoute("POST", "/v1/media/upload-ticket");
    const request = {
      version: 1,
      mediaId: "dddd7000-0000-4000-8000-000000000052",
      operation: "PUT",
      verifiedSha256: "a".repeat(64),
      contentType: "image/png",
      contentLength: 64,
    };

    expect(route?.validateRequest(request)).toBe(true);
    expect(route?.validateRequest({ version: 1, mediaId: request.mediaId, operation: "PUT" }))
      .toBe(false);
    expect(route?.validateRequest({ ...request, verifiedSha256: "A".repeat(64) })).toBe(false);
  });

  it("routes retention ticket issuance and delete authorization through distinct facades", () => {
    const issue = findRuntimeRoute("POST", "/v1/maintenance/retention/delete-ticket");
    const authorize = findRuntimeRoute("POST", "/v1/maintenance/retention/authorize-delete");

    expect(issue).toMatchObject({
      facade: "openclaw_service_issue_retention_delete_ticket_v1",
      serviceOperation: "openclaw_issue_retention_delete_ticket_v1",
      principalKind: "MAINTENANCE",
    });
    expect(authorize).toMatchObject({
      facade: "openclaw_service_authorize_retention_delete_v1",
      serviceOperation: "openclaw_authorize_retention_delete_v1",
      principalKind: "MAINTENANCE",
    });
    expect(issue?.facade).not.toBe(authorize?.facade);
    const signedDeleteTicketResult = {
      version: 1,
      ticketId: RETENTION_TICKET_ID,
      ticket: {
        version: 1,
        aud: "openclaw-media-gateway",
        operation: "DELETE",
        subject: "MAINTENANCE",
        jti: "dddd7000-0000-4000-8000-000000000023",
        organizationId: ORGANIZATION_ID,
        accountId: null,
        objectKey: `v1/org/${ORGANIZATION_ID}/media/object-1`,
        sha256: "b".repeat(64),
        contentType: "image/png",
        contentLength: 64,
        sessionGeneration: 0,
        gatewayKeyGeneration: 1,
        receiptSigningKeyGeneration: 1,
        iat: 1_785_062_400,
        exp: 1_785_062_430,
        maintenancePrincipalId: MAINTENANCE_ID,
        workItemId: "dddd7000-0000-4000-8000-000000000022",
        claimGeneration: 2,
        credentialGeneration: 1,
        leaseGeneration: 1,
        fencingToken: 1,
        deletePhase: "FINAL_DELETE",
        quarantineVersion: 1,
        finalDeleteNotBefore: 1_784_000_000,
        holdVersion: 0,
        signature: "A".repeat(86),
      },
      ticketHash: "a".repeat(64),
      expiresAt: "2026-08-01T00:00:30.000Z",
      state: "TICKET_ISSUED",
    };
    expect(issue?.validateResponse(signedDeleteTicketResult)).toBe(true);
    expect(issue?.validateResponse({
      ...signedDeleteTicketResult,
      ticket: Object.fromEntries(
        Object.entries(signedDeleteTicketResult.ticket).filter(([key]) => key !== "signature"),
      ),
    })).toBe(false);

    const canonicalAuthorizationRequest = {
      version: 1,
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      claimToken: CLAIM_TOKEN,
    };
    expect(authorize?.validateRequest(canonicalAuthorizationRequest)).toBe(true);
    expect(authorize?.validateRequest({
      ...canonicalAuthorizationRequest,
      tombstoneId: "dddd7000-0000-4000-8000-000000000025",
      holdVersion: 0,
      deleteTicketJti: "dddd7000-0000-4000-8000-000000000023",
      deleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000024",
      gatewaySigningKeyGeneration: 1,
    })).toBe(false);

    expect(authorize?.validateResponse({
      version: 1,
      ticketId: RETENTION_TICKET_ID,
      ticketHash: "a".repeat(64),
      deleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000024",
      expiresAt: "2026-08-01T00:00:05.000Z",
      state: "DELETE_AUTHORIZED",
      authorization: {
        version: 1,
        authorizationKind: "RETENTION_FINAL_DELETE",
        organizationId: ORGANIZATION_ID,
        maintenancePrincipalId: MAINTENANCE_ID,
        workItemId: "dddd7000-0000-4000-8000-000000000022",
        claimGeneration: 2,
        credentialGeneration: 1,
        leaseGeneration: 1,
        fencingToken: 1,
        objectKey: `v1/org/${ORGANIZATION_ID}/media/object-1`,
        deletePhase: "FINAL_DELETE",
        holdVersion: 0,
        quarantineVersion: 1,
        deleteTicketJti: "dddd7000-0000-4000-8000-000000000023",
        authorizationJti: "dddd7000-0000-4000-8000-000000000024",
        iat: "2026-08-01T00:00:00.000Z",
        exp: "2026-08-01T00:00:05.000Z",
        gatewaySigningKeyGeneration: 1,
        signature: "B".repeat(86),
      },
    })).toBe(true);
  });

  it("accepts only the frozen audit and retention recovery refresh contracts", () => {
    const audit = findRuntimeRoute("POST", "/v1/maintenance/media/verify-ticket");
    const retention = findRuntimeRoute("POST", "/v1/maintenance/retention/authorize-delete");
    const auditRequest = {
      version: 1,
      operation: "ANCHOR_VERIFY",
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      recoveryGeneration: 2,
      claimToken: CLAIM_TOKEN,
      expiredVerifyTicketJti: "dddd7000-0000-4000-8000-000000000023",
      gatewayDenial: { status: 410, code: "TICKET_EXPIRED_NO_WORK" },
      auditRootId: "dddd7000-0000-4000-8000-000000000026",
      rootHash: "a".repeat(64),
      anchorKey: `v1/org/${ORGANIZATION_ID}/audit/root.json`,
      signatureHash: "b".repeat(64),
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: "c".repeat(64),
      documentSha256: "d".repeat(64),
      documentByteLength: 512,
    };
    const auditTicket = {
      version: 1,
      aud: "openclaw-media-gateway",
      operation: "ANCHOR_VERIFY",
      subject: "MAINTENANCE",
      jti: "dddd7000-0000-4000-8000-000000000027",
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey: auditRequest.anchorKey,
      sha256: auditRequest.documentSha256,
      contentType: "application/json",
      contentLength: auditRequest.documentByteLength,
      sessionGeneration: 0,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 1,
      iat: 1_785_062_400,
      exp: 1_785_062_430,
      maintenancePrincipalId: MAINTENANCE_ID,
      workItemId: auditRequest.workItemId,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      recoveryGeneration: 2,
      replacesVerifyTicketJti: auditRequest.expiredVerifyTicketJti,
      frozenClaim: {
        maintenancePrincipalId: MAINTENANCE_ID,
        credentialGeneration: 1,
        leaseGeneration: 1,
        fencingToken: 1,
        claimGeneration: 2,
      },
      auditRootId: auditRequest.auditRootId,
      rootHash: auditRequest.rootHash,
      signatureHash: auditRequest.signatureHash,
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: auditRequest.auditSigningPublicKeyHash,
      signature: "A".repeat(86),
    };
    const auditResult = {
      version: 1,
      ticketId: auditTicket.jti,
      ticketHash: "e".repeat(64),
      expiresAt: "2026-08-01T00:00:30.000Z",
      state: "RECOVERY_REFRESHED",
      replacesVerifyTicketJti: auditRequest.expiredVerifyTicketJti,
      ticket: auditTicket,
    };
    const retentionRequest = {
      version: 1,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      workItemId: auditRequest.workItemId,
      recoveryGeneration: 2,
      claimToken: CLAIM_TOKEN,
      ticketId: RETENTION_TICKET_ID,
      expiredTicketJti: "dddd7000-0000-4000-8000-000000000023",
      expiredDeleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000024",
      gatewayDenial: { status: 410, code: "TICKET_EXPIRED_NO_WORK" },
    };
    const normalDelete = unsignedDeleteTicketResult();
    const { claimGeneration: _ticketClaimGeneration, ...deleteTicketAdmission } = normalDelete.ticket;
    const refreshedDelete = {
      ...normalDelete,
      ticket: {
        ...deleteTicketAdmission,
        jti: "dddd7000-0000-4000-8000-000000000028",
        recoveryKind: "RETENTION_DELETE_AUTHORIZED",
        recoveryGeneration: 2,
        replacesTicketJti: retentionRequest.expiredTicketJti,
        replacesDeleteAuthorizationJti: retentionRequest.expiredDeleteAuthorizationJti,
        frozenClaim: {
          maintenancePrincipalId: MAINTENANCE_ID,
          credentialGeneration: 1,
          leaseGeneration: 1,
          fencingToken: 1,
          claimGeneration: 2,
        },
      },
    };
    const normalAuthorization = unsignedDeleteAuthorizationResult();
    const { claimGeneration: _authorizationClaimGeneration, ...authorizationAdmission } =
      normalAuthorization.authorization;
    const refreshedAuthorization = {
      ...normalAuthorization,
      deleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000029",
      authorization: {
        ...authorizationAdmission,
        deleteTicketJti: refreshedDelete.ticket.jti,
        authorizationJti: "dddd7000-0000-4000-8000-000000000029",
        recoveryKind: "RETENTION_DELETE_AUTHORIZED",
        recoveryGeneration: 2,
        replacesTicketJti: retentionRequest.expiredTicketJti,
        replacesDeleteAuthorizationJti: retentionRequest.expiredDeleteAuthorizationJti,
        frozenClaim: refreshedDelete.ticket.frozenClaim,
      },
    };
    const retentionResult = {
      ...refreshedAuthorization,
      ticketHash: refreshedDelete.ticketHash,
      state: "RECOVERY_REFRESHED",
      replacesTicketJti: retentionRequest.expiredTicketJti,
      replacesDeleteAuthorizationJti: retentionRequest.expiredDeleteAuthorizationJti,
      ticket: { ...refreshedDelete.ticket, signature: "B".repeat(86) },
      authorization: { ...refreshedAuthorization.authorization, signature: "C".repeat(86) },
    };

    expect(audit?.validateRequest(auditRequest)).toBe(true);
    expect(audit?.validateResponse(auditResult)).toBe(true);
    expect(retention?.validateRequest(retentionRequest)).toBe(true);
    expect(retention?.validateResponse(retentionResult)).toBe(true);
    expect(retention?.validateResponse({
      ...retentionResult,
      authorization: {
        ...retentionResult.authorization,
        frozenClaim: {
          claimGeneration: retentionResult.authorization.frozenClaim.claimGeneration,
          fencingToken: retentionResult.authorization.frozenClaim.fencingToken,
          leaseGeneration: retentionResult.authorization.frozenClaim.leaseGeneration,
          credentialGeneration: retentionResult.authorization.frozenClaim.credentialGeneration,
          maintenancePrincipalId:
            retentionResult.authorization.frozenClaim.maintenancePrincipalId,
        },
      },
    })).toBe(true);
    expect(audit?.validateRequest({ ...auditRequest, gatewayDenial: { status: 410 } })).toBe(false);
    expect(audit?.validateRequest({ ...auditRequest, unexpected: true })).toBe(false);
    expect(retention?.validateRequest({
      ...retentionRequest,
      gatewayDenial: { status: 409, code: "TICKET_EXPIRED_NO_WORK" },
    })).toBe(false);
    expect(retention?.validateResponse({
      ...retentionResult,
      replacesTicketJti: retentionResult.ticket.jti,
    })).toBe(false);
  });

  it("requires durable maintenance failure readiness on claim and completion", () => {
    const claimRoute = findRuntimeRoute("POST", "/v1/maintenance/work/claim")!;
    const completionRoute = findRuntimeRoute("POST", "/v1/maintenance/work/complete")!;
    const evidence = {
      version: 1,
      evidenceKind: "WORK_FAILURE",
      reasonCode: "MAINTENANCE_WORK_RETRY",
      failureFingerprint: "a".repeat(64),
    };
    const normalFailure = {
      version: 1,
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      organizationId: ORGANIZATION_ID,
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      claimToken: CLAIM_TOKEN,
      claimGeneration: 2,
      outcome: "RETRY",
      evidence,
      evidenceHash: "b".repeat(64),
      retryAfterSeconds: 5,
    };
    const recoveryFailure = {
      ...normalFailure,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      recoveryGeneration: 3,
      frozenClaim: {
        maintenancePrincipalId: "dddd3000-0000-4000-8000-000000000002",
        credentialGeneration: 1,
        leaseGeneration: 1,
        fencingToken: 1,
        claimGeneration: 2,
      },
    };
    delete (recoveryFailure as { claimGeneration?: number }).claimGeneration;
    const normalResult = {
      version: 1,
      state: "FAILURE_RECORDED",
      workItemId: normalFailure.workItemId,
      claimGeneration: 2,
      outcome: "SAFE_RETRY",
      canonicalEvidenceHash: normalFailure.evidenceHash,
      completedAt: null,
      retryNotBefore: "2026-08-01T00:00:05+00:00",
    };
    const recoveryResult = {
      ...normalResult,
      recoveryGeneration: 3,
    };
    delete (recoveryResult as { claimGeneration?: number }).claimGeneration;

    expect(claimRoute.validateResponse({
      version: 1,
      items: [],
      unresolvedFailures: { retentionDelete: 1, auditAnchor: 0 },
    })).toBe(true);
    expect(claimRoute.validateResponse({ version: 1, items: [] })).toBe(false);
    expect(completionRoute.validateRequest(normalFailure)).toBe(true);
    expect(completionRoute.validateRequest(recoveryFailure)).toBe(true);
    expect(completionRoute.validateResponse(normalResult)).toBe(true);
    expect(completionRoute.validateResponse(recoveryResult)).toBe(true);
    expect(completionRoute.validateRequest({ ...normalFailure, retryAfterSeconds: null })).toBe(false);
    expect(completionRoute.validateRequest({
      ...recoveryFailure,
      frozenClaim: { ...recoveryFailure.frozenClaim, extra: true },
    })).toBe(false);
  });

  it("binds audit tickets to the exact signed document bytes", () => {
    const route = findRuntimeRoute("POST", "/v1/maintenance/media/upload-ticket")!;
    const request = {
      version: 1,
      operation: "ANCHOR",
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      claimToken: CLAIM_TOKEN,
      auditRootId: "dddd7000-0000-4000-8000-000000000026",
      rootHash: "a".repeat(64),
      anchorKey: `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/dddd7000-0000-4000-8000-000000000026.json`,
      signatureHash: "b".repeat(64),
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: "e".repeat(64),
      documentSha256: "c".repeat(64),
      documentByteLength: 512,
    };
    expect(route.validateRequest(request)).toBe(true);
    const { documentSha256: _sha, documentByteLength: _length, ...unbound } = request;
    expect(route.validateRequest(unbound)).toBe(false);
    expect(route.validateResponse({
      version: 1,
      ticketId: "dddd7000-0000-4000-8000-000000000027",
      ticketHash: "d".repeat(64),
      expiresAt: "2026-08-01T00:00:30.000Z",
      state: "ISSUED",
      ticket: {
        version: 1,
        aud: "openclaw-media-gateway",
        operation: "ANCHOR",
        subject: "MAINTENANCE",
        jti: "dddd7000-0000-4000-8000-000000000027",
        organizationId: ORGANIZATION_ID,
        accountId: null,
        objectKey: request.anchorKey,
        sha256: request.documentSha256,
        contentType: "application/json",
        contentLength: request.documentByteLength,
        sessionGeneration: 0,
        gatewayKeyGeneration: 1,
        receiptSigningKeyGeneration: 2,
        iat: 1_785_062_400,
        exp: 1_785_062_430,
        maintenancePrincipalId: MAINTENANCE_ID,
        workItemId: request.workItemId,
        claimGeneration: request.claimGeneration,
        credentialGeneration: 1,
        leaseGeneration: 1,
        fencingToken: 1,
        auditRootId: request.auditRootId,
        rootHash: request.rootHash,
        signatureHash: request.signatureHash,
        auditSigningKeyGeneration: request.auditSigningKeyGeneration,
        auditSigningPublicKeyHash: request.auditSigningPublicKeyHash,
        signature: "A".repeat(86),
      },
    })).toBe(true);
  });

  it("accepts exact authorized maintenance recovery claims with frozen Gateway lineage", () => {
    const route = findRuntimeRoute("POST", "/v1/maintenance/work/claim")!;
    const verifyTicket = {
      version: 1,
      aud: "openclaw-media-gateway",
      operation: "ANCHOR_VERIFY",
      subject: "MAINTENANCE",
      jti: "dddd7000-0000-4000-8000-000000000027",
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey: `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/dddd7000-0000-4000-8000-000000000026.json`,
      sha256: "c".repeat(64),
      contentType: "application/json",
      contentLength: 512,
      sessionGeneration: 0,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 2,
      iat: 1_785_062_400,
      exp: 1_785_062_430,
      maintenancePrincipalId: MAINTENANCE_ID,
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      auditRootId: "dddd7000-0000-4000-8000-000000000026",
      rootHash: "a".repeat(64),
      signatureHash: "b".repeat(64),
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: "e".repeat(64),
      signature: "A".repeat(86),
    };
    const response = {
      version: 1,
      unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 },
      items: [{
        version: 1,
        recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
        workItemId: verifyTicket.workItemId,
        organizationId: ORGANIZATION_ID,
        maintenancePrincipalId: MAINTENANCE_ID,
        credentialGeneration: 3,
        leaseGeneration: 4,
        fencingToken: 5,
        sourceKey: "audit:recovery:1",
        claimToken: CLAIM_TOKEN,
        recoveryGeneration: 2,
        recoveryLeaseExpiresAt: "2026-08-01T00:01:00.000Z",
        frozenClaim: {
          maintenancePrincipalId: MAINTENANCE_ID,
          credentialGeneration: 1,
          leaseGeneration: 1,
          fencingToken: 1,
          claimGeneration: 2,
        },
        payload: {
          kind: "AUDIT_ANCHOR",
          auditRootId: verifyTicket.auditRootId,
          rootDate: "2026-08-01",
          firstSequence: 1,
          lastSequence: 1,
          eventCount: 1,
          previousRootHash: null,
          merkleRootHash: verifyTicket.rootHash,
          rootHash: verifyTicket.rootHash,
          auditSigningKeyGeneration: 1,
          auditSigningPublicKeyHash: verifyTicket.auditSigningPublicKeyHash,
          anchorKey: verifyTicket.objectKey,
        },
        verifyTicketId: verifyTicket.jti,
        verifyTicketHash: "d".repeat(64),
        signatureHash: verifyTicket.signatureHash,
        verifyTicket,
        gatewayReceipt: null,
      }],
    };
    expect(route.validateResponse(response)).toBe(true);
    const { claimGeneration: _claimGeneration, ...verifyTicketBase } = verifyTicket;
    const refreshedVerifyTicket = {
      ...verifyTicketBase,
      jti: "dddd7000-0000-4000-8000-000000000028",
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      recoveryGeneration: response.items[0].recoveryGeneration,
      replacesVerifyTicketJti: verifyTicket.jti,
      frozenClaim: response.items[0].frozenClaim,
    };
    const refreshedResponse = {
      ...response,
      items: [{
        ...response.items[0],
        verifyTicketId: refreshedVerifyTicket.jti,
        verifyTicket: refreshedVerifyTicket,
      }],
    };
    expect(route.validateResponse(refreshedResponse)).toBe(true);
    for (const mutation of [
      { organizationId: "dddd0000-0000-4000-8000-000000000099" },
      { objectKey: `${verifyTicket.objectKey}-other` },
      { auditRootId: "dddd7000-0000-4000-8000-000000000099" },
      { rootHash: "9".repeat(64) },
      { signatureHash: "8".repeat(64) },
      { auditSigningKeyGeneration: 2 },
      { auditSigningPublicKeyHash: "7".repeat(64) },
    ]) {
      expect(route.validateResponse({
        ...refreshedResponse,
        items: [{
          ...refreshedResponse.items[0],
          verifyTicket: { ...refreshedVerifyTicket, ...mutation },
        }],
      })).toBe(false);
    }
    expect(route.validateResponse({
      ...response,
      items: [{ ...response.items[0], frozenClaim: { ...response.items[0].frozenClaim, claimGeneration: 3 } }],
    })).toBe(false);
  });

  it("resolves only POST and rejects unmapped paths and methods", () => {
    expect(findRuntimeRoute("POST", "/v1/heartbeat")?.operation).toBe("heartbeat");
    expect(findRuntimeRoute("GET", "/v1/heartbeat")).toBeNull();
    expect(findRuntimeRoute("POST", "/v1/heartbeat/")).toBeNull();
    expect(findRuntimeRoute("POST", "/v1/admin")).toBeNull();
    expect(findRuntimeRoute("POST", "/v1/../v1/heartbeat")).toBeNull();
  });

  it("keeps send-work and maintenance-work kinds disjoint", () => {
    for (const kind of CHANNEL_WORK_KINDS) {
      expect(MAINTENANCE_WORK_KINDS).not.toContain(kind);
    }
    const channelClaim = findRuntimeRoute("POST", "/v1/work/claim")!;
    const maintenanceClaim = findRuntimeRoute("POST", "/v1/maintenance/work/claim")!;

    expect(workKindIsAllowed(channelClaim, ["INBOUND_AUTOMATION"])).toBe(true);
    expect(workKindIsAllowed(channelClaim, ["RETENTION_DELETE"])).toBe(false);
    expect(workKindIsAllowed(maintenanceClaim, ["AUDIT_ANCHOR"])).toBe(true);
    expect(workKindIsAllowed(maintenanceClaim, ["CRM_EVENT"])).toBe(false);
    expect(workKindIsAllowed(channelClaim, [])).toBe(false);
  });
});

describe("OpenClaw inbound batch validation", () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    eventKind: "MESSAGE",
    providerEventId: "provider-event-1",
    providerMessageId: "provider-message-1",
    providerConversationId: "provider-conversation-1",
    providerSenderId: "provider-sender-1",
    providerTarget: { kind: "PEER", providerId: "peer-1" },
    providerEventType: "MESSAGE",
    sourceTimestamp: "2026-08-01T00:00:00.000Z",
    callbackReceivedAt: "2026-08-01T00:00:01.000Z",
    rawEnvelope: { event: "message" },
    rawEnvelopeSha256: "a".repeat(64),
    normalized: {
      text: "hello",
      replyToProviderMessageId: null,
      mediaManifest: [],
    },
    normalizedSha256: "b".repeat(64),
    ...overrides,
  });
  const batch = (events: unknown[]) => ({
    version: 1,
    organizationId: ORGANIZATION_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    sessionGeneration: 1,
    events,
  });

  it("accepts the exact fork-to-bridge canonical envelope", () => {
    expect(validateInboundBatch(batch([event()])).ok).toBe(true);
  });

  it("rejects a batch above one hundred events", () => {
    const events = Array.from({ length: 101 }, (_unused, index) =>
      event({ providerEventId: `provider-event-${index}` }));
    expect(validateInboundBatch(batch(events))).toEqual({
      ok: false,
      reason: "BATCH_TOO_LARGE",
    });
  });

  it("rejects the legacy per-event tenant/payload contract", () => {
    expect(validateInboundBatch(batch([event({
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      payloadSha256: "c".repeat(64),
    })]))).toEqual({ ok: false, reason: "BATCH_INVALID" });
    expect(validateInboundBatch(batch([{
      version: 1,
      eventKind: "MESSAGE",
      providerEventId: "provider-event-1",
      providerMessageId: "provider-message-1",
      targetKind: "PEER",
      targetProviderId: "peer-1",
      providerOccurredAt: "2026-08-01T00:00:00.000Z",
      payloadHash: "a".repeat(64),
      payload: {},
    }]))).toEqual({ ok: false, reason: "BATCH_INVALID" });
  });

  it("rejects a duplicate event id whose payload hash disagrees", () => {
    expect(
      validateInboundBatch(batch([
        event(),
        event({ normalizedSha256: "c".repeat(64) }),
      ])),
    ).toEqual({ ok: false, reason: "BATCH_DUPLICATE_CONFLICT" });
  });

  it("accepts an idempotent duplicate whose payload hash matches", () => {
    expect(validateInboundBatch(batch([event(), event()])).ok).toBe(true);
  });

  it("allows fallback identity only when both provider ids are null", () => {
    expect(validateInboundBatch(batch([event({
      providerEventId: null,
      providerMessageId: null,
    })])).ok).toBe(true);
  });
});

describe("OpenClaw runtime API handler", () => {
  it("signs a SQL-derived retention delete ticket over bare JCS", async () => {
    const unsigned = unsignedDeleteTicketResult();
    const rpc = vi.fn(() => Promise.resolve({ data: unsigned, error: null }));
    const signGatewayPayload = vi.fn(() => Promise.resolve("A".repeat(86)));
    const dependency = dependencies({
      principal: maintenancePrincipal,
      rpc,
      signGatewayPayload,
    });
    const requestBody = {
      version: 1,
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      claimToken: CLAIM_TOKEN,
    };

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/retention/delete-ticket", requestBody),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "openclaw_service_issue_retention_delete_ticket_v1",
      expect.objectContaining({ p_request: requestBody }),
    );
    expect(Buffer.from(signGatewayPayload.mock.calls[0][0]).toString("utf8"))
      .toBe(canonicalJson(unsigned.ticket));
    expect((await response.json()).result).toEqual({
      ...unsigned,
      ticket: { ...unsigned.ticket, signature: "A".repeat(86) },
    });
  });

  it("signs a trusted delete authorization with the retention domain", async () => {
    const unsigned = unsignedDeleteAuthorizationResult();
    const rpc = vi.fn(() => Promise.resolve({ data: unsigned, error: null }));
    const signGatewayPayload = vi.fn(() => Promise.resolve("B".repeat(86)));
    const dependency = dependencies({
      principal: maintenancePrincipal,
      rpc,
      signGatewayPayload,
    });
    const requestBody = {
      version: 1,
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      claimToken: CLAIM_TOKEN,
    };

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/retention/authorize-delete", requestBody),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(signGatewayPayload.mock.calls[0][0]).toString("utf8"))
      .toBe(
        `ihome-openclaw-retention-authorization-v1\0${canonicalJson(unsigned.authorization)}`,
      );
    expect((await response.json()).result).toEqual({
      ...unsigned,
      authorization: { ...unsigned.authorization, signature: "B".repeat(86) },
    });
  });

  it("signs both artifacts returned by retention recovery refresh", async () => {
    const normalTicket = unsignedDeleteTicketResult();
    const { claimGeneration: _ticketClaimGeneration, ...ticketAdmission } = normalTicket.ticket;
    const frozenClaim = {
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      claimGeneration: 2,
    };
    const ticket = {
      ...normalTicket,
      ticket: {
        ...ticketAdmission,
        jti: "dddd7000-0000-4000-8000-000000000028",
        recoveryKind: "RETENTION_DELETE_AUTHORIZED",
        recoveryGeneration: 2,
        replacesTicketJti: "dddd7000-0000-4000-8000-000000000023",
        replacesDeleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000024",
        frozenClaim,
      },
    };
    const normalAuthorization = unsignedDeleteAuthorizationResult();
    const { claimGeneration: _authorizationClaimGeneration, ...authorizationAdmission } =
      normalAuthorization.authorization;
    const authorization = {
      ...normalAuthorization,
      deleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000029",
      authorization: {
        ...authorizationAdmission,
        deleteTicketJti: ticket.ticket.jti,
        authorizationJti: "dddd7000-0000-4000-8000-000000000029",
        recoveryKind: "RETENTION_DELETE_AUTHORIZED",
        recoveryGeneration: 2,
        replacesTicketJti: ticket.ticket.replacesTicketJti,
        replacesDeleteAuthorizationJti: ticket.ticket.replacesDeleteAuthorizationJti,
        frozenClaim,
      },
    };
    const unsigned = {
      ...authorization,
      ticketHash: ticket.ticketHash,
      state: "RECOVERY_REFRESHED",
      replacesTicketJti: "dddd7000-0000-4000-8000-000000000023",
      replacesDeleteAuthorizationJti: "dddd7000-0000-4000-8000-000000000024",
      ticket: ticket.ticket,
    };
    const signGatewayPayload = vi.fn()
      .mockResolvedValueOnce("T".repeat(86))
      .mockResolvedValueOnce("A".repeat(86));
    const dependency = dependencies({
      principal: maintenancePrincipal,
      rpc: vi.fn(() => Promise.resolve({ data: unsigned, error: null })),
      signGatewayPayload,
    });
    const requestBody = {
      version: 1,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      recoveryGeneration: 2,
      claimToken: CLAIM_TOKEN,
      ticketId: RETENTION_TICKET_ID,
      expiredTicketJti: unsigned.replacesTicketJti,
      expiredDeleteAuthorizationJti: unsigned.replacesDeleteAuthorizationJti,
      gatewayDenial: { status: 410, code: "TICKET_EXPIRED_NO_WORK" },
    };

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/retention/authorize-delete", requestBody),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(signGatewayPayload).toHaveBeenCalledTimes(2);
    expect((await response.json()).result).toEqual({
      ...unsigned,
      ticket: { ...unsigned.ticket, signature: "T".repeat(86) },
      authorization: { ...unsigned.authorization, signature: "A".repeat(86) },
    });
  });

  it("signs a SQL-derived audit ticket over bare JCS", async () => {
    const requestBody = {
      version: 1,
      operation: "ANCHOR",
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      claimToken: CLAIM_TOKEN,
      auditRootId: "dddd7000-0000-4000-8000-000000000026",
      rootHash: "a".repeat(64),
      anchorKey: `v1/org/${ORGANIZATION_ID}/audit/2026-08-01/dddd7000-0000-4000-8000-000000000026.json`,
      signatureHash: "b".repeat(64),
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: "e".repeat(64),
      documentSha256: "c".repeat(64),
      documentByteLength: 512,
    };
    const ticket = {
      version: 1,
      aud: "openclaw-media-gateway",
      operation: "ANCHOR",
      subject: "MAINTENANCE",
      jti: "dddd7000-0000-4000-8000-000000000027",
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey: requestBody.anchorKey,
      sha256: requestBody.documentSha256,
      contentType: "application/json",
      contentLength: requestBody.documentByteLength,
      sessionGeneration: 0,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 1,
      iat: 1_785_062_400,
      exp: 1_785_062_430,
      maintenancePrincipalId: MAINTENANCE_ID,
      workItemId: requestBody.workItemId,
      claimGeneration: 2,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      auditRootId: requestBody.auditRootId,
      rootHash: requestBody.rootHash,
      signatureHash: requestBody.signatureHash,
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: requestBody.auditSigningPublicKeyHash,
    };
    const unsigned = {
      version: 1,
      ticketId: ticket.jti,
      ticketHash: "d".repeat(64),
      expiresAt: "2026-08-01T00:00:30.000Z",
      state: "ISSUED",
      ticket,
    };
    const rpc = vi.fn(() => Promise.resolve({ data: unsigned, error: null }));
    const signGatewayPayload = vi.fn(() => Promise.resolve("C".repeat(86)));
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/media/upload-ticket", requestBody),
      dependencies({ principal: maintenancePrincipal, rpc, signGatewayPayload }),
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(signGatewayPayload.mock.calls[0][0]).toString("utf8"))
      .toBe(canonicalJson(ticket));
    expect((await response.json()).result).toEqual({
      ...unsigned,
      ticket: { ...ticket, signature: "C".repeat(86) },
    });
  });

  it("refuses to sign SQL claims for a different ES256 key generation", async () => {
    const unsigned = unsignedDeleteTicketResult();
    unsigned.ticket.gatewayKeyGeneration = 2;
    const rpc = vi.fn(() => Promise.resolve({ data: unsigned, error: null }));
    const signGatewayPayload = vi.fn(() => Promise.resolve("A".repeat(86)));
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/retention/delete-ticket", {
        version: 1,
        workItemId: "dddd7000-0000-4000-8000-000000000022",
        claimGeneration: 2,
        claimToken: CLAIM_TOKEN,
      }),
      dependencies({ principal: maintenancePrincipal, rpc, signGatewayPayload, ticketKeyGeneration: 1 }),
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("TICKET_KEY_GENERATION_MISMATCH");
    expect(signGatewayPayload).not.toHaveBeenCalled();
  });

  it("uses a bounded historical key only for exact authorized recovery artifacts", async () => {
    const ticket = {
      version: 1,
      aud: "openclaw-media-gateway",
      operation: "ANCHOR_VERIFY",
      subject: "MAINTENANCE",
      jti: "dddd7000-0000-4000-8000-000000000027",
      organizationId: ORGANIZATION_ID,
      accountId: null,
      objectKey: `v1/org/${ORGANIZATION_ID}/audit/root.json`,
      sha256: "c".repeat(64),
      contentType: "application/json",
      contentLength: 512,
      sessionGeneration: 0,
      gatewayKeyGeneration: 2,
      receiptSigningKeyGeneration: 1,
      iat: 1_785_062_400,
      exp: 1_785_062_430,
      maintenancePrincipalId: MAINTENANCE_ID,
      workItemId: "dddd7000-0000-4000-8000-000000000022",
      claimGeneration: 2,
      credentialGeneration: 1,
      leaseGeneration: 1,
      fencingToken: 1,
      auditRootId: "dddd7000-0000-4000-8000-000000000026",
      rootHash: "a".repeat(64),
      signatureHash: "b".repeat(64),
      auditSigningKeyGeneration: 1,
      auditSigningPublicKeyHash: "e".repeat(64),
    };
    const data = {
      version: 1,
      unresolvedFailures: { retentionDelete: 0, auditAnchor: 0 },
      items: [{
        version: 1,
        recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
        workItemId: ticket.workItemId,
        organizationId: ORGANIZATION_ID,
        maintenancePrincipalId: MAINTENANCE_ID,
        credentialGeneration: 3,
        leaseGeneration: 4,
        fencingToken: 5,
        sourceKey: "audit:recovery:historical",
        claimToken: CLAIM_TOKEN,
        recoveryGeneration: 2,
        recoveryLeaseExpiresAt: "2026-08-01T00:01:00+00:00",
        frozenClaim: {
          maintenancePrincipalId: MAINTENANCE_ID,
          credentialGeneration: 1,
          leaseGeneration: 1,
          fencingToken: 1,
          claimGeneration: 2,
        },
        payload: {
          kind: "AUDIT_ANCHOR",
          auditRootId: ticket.auditRootId,
          rootDate: "2026-08-01",
          firstSequence: 1,
          lastSequence: 1,
          eventCount: 1,
          previousRootHash: null,
          merkleRootHash: ticket.rootHash,
          rootHash: ticket.rootHash,
          auditSigningKeyGeneration: 1,
          auditSigningPublicKeyHash: ticket.auditSigningPublicKeyHash,
          anchorKey: ticket.objectKey,
        },
        verifyTicketId: ticket.jti,
        verifyTicketHash: "d".repeat(64),
        signatureHash: ticket.signatureHash,
        verifyTicket: ticket,
        gatewayReceipt: null,
      }],
    };
    const historicalSign = vi.fn(() => Promise.resolve("H".repeat(86)));
    const activeSign = vi.fn(() => Promise.resolve("A".repeat(86)));
    const rpc = vi.fn(() => Promise.resolve({ data, error: null }));
    const historicalTicketSigningKeys = {
      2: {
        activatedAtEpochSeconds: 1_785_062_300,
        retiredAtEpochSeconds: 1_785_062_500,
        emergencyRevokedAtEpochSeconds: null,
        signGatewayPayload: historicalSign,
      },
    };
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/claim", {
        version: 1,
        claimToken: CLAIM_TOKEN,
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["AUDIT_ANCHOR"],
      }),
      dependencies({
        principal: maintenancePrincipal,
        rpc,
        signGatewayPayload: activeSign,
        ticketKeyGeneration: 3,
        historicalTicketSigningKeys,
      }),
    );

    expect(response.status).toBe(200);
    expect(historicalSign).toHaveBeenCalledOnce();
    expect(activeSign).not.toHaveBeenCalled();
    expect((await response.json()).result.items[0].verifyTicket.signature).toBe("H".repeat(86));

    const { claimGeneration: _claimGeneration, ...ticketWithoutClaim } = ticket;
    const refreshedTicket = {
      ...ticketWithoutClaim,
      jti: "dddd7000-0000-4000-8000-000000000028",
      maintenancePrincipalId: MAINTENANCE_ID,
      credentialGeneration: 3,
      leaseGeneration: 4,
      fencingToken: 5,
      recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
      recoveryGeneration: 2,
      replacesVerifyTicketJti: ticket.jti,
      frozenClaim: {
        maintenancePrincipalId: MAINTENANCE_ID,
        credentialGeneration: 1,
        leaseGeneration: 1,
        fencingToken: 1,
        claimGeneration: 2,
      },
    };
    const refreshRpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        ticketId: refreshedTicket.jti,
        ticketHash: "f".repeat(64),
        expiresAt: "2026-08-01T00:00:30.000Z",
        state: "RECOVERY_REFRESHED",
        replacesVerifyTicketJti: ticket.jti,
        ticket: refreshedTicket,
      },
      error: null,
    }));
    const refreshed = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/media/verify-ticket", {
        version: 1,
        operation: "ANCHOR_VERIFY",
        recoveryKind: "AUDIT_VERIFY_AUTHORIZED",
        workItemId: ticket.workItemId,
        recoveryGeneration: 2,
        claimToken: CLAIM_TOKEN,
        expiredVerifyTicketJti: ticket.jti,
        gatewayDenial: { status: 410, code: "TICKET_EXPIRED_NO_WORK" },
        auditRootId: ticket.auditRootId,
        rootHash: ticket.rootHash,
        anchorKey: ticket.objectKey,
        signatureHash: ticket.signatureHash,
        auditSigningKeyGeneration: 1,
        auditSigningPublicKeyHash: ticket.auditSigningPublicKeyHash,
        documentSha256: ticket.sha256,
        documentByteLength: ticket.contentLength,
      }),
      dependencies({
        principal: maintenancePrincipal,
        rpc: refreshRpc,
        signGatewayPayload: activeSign,
        ticketKeyGeneration: 3,
        historicalTicketSigningKeys,
      }),
    );
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).result.ticket.signature).toBe("H".repeat(86));

    const revoked = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/claim", {
        version: 1,
        claimToken: CLAIM_TOKEN,
        limit: 1,
        leaseSeconds: 30,
        requestedKinds: ["AUDIT_ANCHOR"],
      }),
      dependencies({
        principal: maintenancePrincipal,
        rpc,
        ticketKeyGeneration: 3,
        historicalTicketSigningKeys: {
          2: { ...historicalTicketSigningKeys[2], emergencyRevokedAtEpochSeconds: 1_785_062_450 },
        },
      }),
    );
    expect(revoked.status).toBe(502);
    expect((await revoked.json()).error.code).toBe("TICKET_KEY_GENERATION_MISMATCH");
  });

  it("rejects an unmapped route before any database access", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/admin/exec", { version: 1 }),
      dependency,
    );

    expect(response.status).toBe(404);
    expect(dependency.rpc).not.toHaveBeenCalled();
    expect(dependency.verify).not.toHaveBeenCalled();
  });

  it("rejects additional fields through the route-specific schema before authentication", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/heartbeat", { version: 1, arbitrary: true }),
      dependency,
    );

    expect(response.status).toBe(400);
    expect(dependency.verify).not.toHaveBeenCalled();
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("gắn hạn giờ vào lời gọi facade thay vì chờ vô hạn", async () => {
    // VÌ SAO CÓ TEST NÀY. fc12840f thêm `.abortSignal(AbortSignal.timeout(...))`
    // để một RPC treo không giữ mãi connection. Bộ giả lập `rpc` lúc đó trả về
    // Promise trần nên `.abortSignal` không tồn tại — 18 test rơi vào catch và
    // báo "expected 500 to be 200", một câu không hề nhắc tới abortSignal.
    //
    // Khi vá bộ giả lập, tôi kiểm bằng đột biến: GỠ hẳn `.abortSignal(...)` khỏi
    // handler thì 76/76 test vẫn XANH. Tức bản vá làm test chạy lại được nhưng
    // để chính thứ vừa gây ra sự cố nằm ngoài tầm đo — ai xoá hạn giờ sau này
    // cũng không ai biết. Test này bịt đúng chỗ đó.
    tinHieuHuyGanNhat = undefined;
    const deps = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/complete", outboxCompletion),
      deps,
    );
    expect(response.status).toBe(200);
    expect(tinHieuHuyGanNhat).toBeInstanceOf(AbortSignal);
    // Chưa hết hạn ngay: nếu ai đó đặt nhầm thành AbortSignal.abort() thì lời gọi
    // sẽ chết ngay lập tức thay vì có thời gian chạy.
    expect(tinHieuHuyGanNhat?.aborted).toBe(false);
  });

  it("accepts only the canonical nested outbox completion contract", async () => {
    const valid = dependencies();
    const validResponse = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/complete", outboxCompletion),
      valid,
    );
    expect(validResponse.status).toBe(200);
    expect(valid.rpc).toHaveBeenCalledWith(
      "openclaw_service_complete_outbox_v1",
      expect.objectContaining({ p_request: outboxCompletion }),
    );

    const invalid = dependencies();
    const invalidResponse = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/complete", { version: 1, outboxId: OUTBOX_ID }),
      invalid,
    );
    expect(invalidResponse.status).toBe(400);
    expect(invalid.verify).not.toHaveBeenCalled();
    expect(invalid.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when SQL returns a legacy outbox claim shape", async () => {
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        items: [{
          outboxId: OUTBOX_ID,
          claimGeneration: 1,
          canonicalPayload: { version: 1 },
          payloadHash: "d".repeat(64),
        }],
      },
      error: null,
    }));
    const dependency = dependencies({ rpc });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/claim", {
        version: 1,
        claimToken: CLAIM_TOKEN,
        limit: 5,
        leaseSeconds: 30,
      }),
      dependency,
    );

    expect(response.status).toBe(502);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("rejects any browser Origin header on a runtime route", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/heartbeat", { version: 1 }, { origin: "https://ptcrm.vercel.app" }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("calls the mapped facade with the verified principal envelope", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/claim", {
        version: 1,
        claimToken: CLAIM_TOKEN,
        limit: 5,
        leaseSeconds: 30,
      }),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(dependency.rpc).toHaveBeenCalledTimes(1);
    expect(dependency.rpc.mock.calls[0][0]).toBe("openclaw_service_claim_outbox_v1");
    const args = dependency.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_principal).toEqual({
      ...channelPrincipal,
      maintenancePrincipalId: null,
      allowedOperations: ["openclaw_claim_outbox_v1"],
    });
    expect(args.p_envelope).toMatchObject({
      version: 1,
      operation: "openclaw_claim_outbox_v1",
      nonce: "n",
      iat: "2026-07-26T10:40:00.000Z",
      exp: "2026-07-26T10:45:00.000Z",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(args.p_request).toEqual({
      version: 1,
      claimToken: CLAIM_TOKEN,
      limit: 5,
      leaseSeconds: 30,
    });
  });

  it("refuses a maintenance route when the token carries a channel principal", async () => {
    const dependency = dependencies({ principal: channelPrincipal });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/claim", {
        version: 1,
        claimToken: CLAIM_TOKEN,
        limit: 5,
        leaseSeconds: 30,
        requestedKinds: ["RETENTION_DELETE"],
      }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("refuses a channel route when the token carries a maintenance principal", async () => {
    const dependency = dependencies({ principal: maintenancePrincipal });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/claim", {
        version: 1,
        claimToken: CLAIM_TOKEN,
        limit: 5,
        leaseSeconds: 30,
      }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("lets maintenance work run while no channel account is usable", async () => {
    const dependency = dependencies({ principal: maintenancePrincipal });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/claim", {
        version: 1,
        claimToken: CLAIM_TOKEN,
        limit: 5,
        leaseSeconds: 30,
        requestedKinds: ["AUDIT_ANCHOR"],
      }),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(dependency.rpc.mock.calls[0][1].p_principal).toEqual({
      ...maintenancePrincipal,
      accountId: null,
      cellId: null,
      sessionGeneration: 0,
      localSessionGeneration: 0,
      authMode: "NORMAL",
      allowedOperations: ["openclaw_claim_work_item_v1"],
    });
  });

  it("verifies a retention receipt signature before calling SQL", async () => {
    const fixture = await signedRetentionReceipt();
    const receipt = { ...fixture.receipt, objectKey: `${fixture.receipt.objectKey}-forged` };
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        ticketId: RETENTION_TICKET_ID,
        gatewayOutcome: "DELETED",
        receiptHash: "f".repeat(64),
        finalized: true,
        idempotentReplay: false,
      },
      error: null,
    }));
    const dependency = dependencies({
      principal: maintenancePrincipal,
      rpc,
      gatewayReceiptPublicKey: fixture.publicKey,
    });

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/complete", {
        version: 1,
        ticketId: RETENTION_TICKET_ID,
        gatewayReceipt: receipt,
      }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("authorizes retention recovery with the current owner while preserving frozen receipt lineage", async () => {
    const fixture = await signedRetentionReceipt({
      maintenancePrincipalId: "dddd3000-0000-4000-8000-000000000099",
      credentialGeneration: 2,
      leaseGeneration: 3,
      fencingToken: 4,
    });
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        ticketId: RETENTION_TICKET_ID,
        gatewayOutcome: "DELETED",
        receiptHash: "f".repeat(64),
        finalized: true,
        idempotentReplay: false,
      },
      error: null,
    }));
    const dependency = dependencies({
      principal: maintenancePrincipal,
      rpc,
      gatewayReceiptPublicKey: fixture.publicKey,
    });
    const body = {
      version: 1,
      recoveryKind: "RETENTION_DELETE_AUTHORIZED",
      workItemId: fixture.receipt.workItemId,
      recoveryGeneration: 2,
      claimToken: CLAIM_TOKEN,
      ticketId: RETENTION_TICKET_ID,
      gatewayReceipt: fixture.receipt,
    };

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/complete", body),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "openclaw_service_complete_maintenance_work_v1",
      expect.objectContaining({ p_request: body }),
    );
  });

  it("rejects a recovery receipt from another frozen work lineage before SQL", async () => {
    const fixture = await signedRetentionReceipt();
    const dependency = dependencies({
      principal: maintenancePrincipal,
      rpc: vi.fn(),
      gatewayReceiptPublicKey: fixture.publicKey,
    });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/complete", {
        version: 1,
        recoveryKind: "RETENTION_DELETE_AUTHORIZED",
        workItemId: "dddd7000-0000-4000-8000-000000000099",
        recoveryGeneration: 2,
        claimToken: CLAIM_TOKEN,
        ticketId: RETENTION_TICKET_ID,
        gatewayReceipt: fixture.receipt,
      }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("verifies one exact signed channel upload receipt before finalizing its media row", async () => {
    const fixture = await signedMediaUploadReceipt();
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        mediaId: fixture.receipt.mediaId,
        byteState: "AVAILABLE",
        receiptHash: "b".repeat(64),
        idempotentReplay: false,
      },
      error: null,
    }));
    const dependency = dependencies({
      rpc,
      gatewayReceiptPublicKey: fixture.publicKey,
    });
    const request = {
      version: 1,
      mediaId: fixture.receipt.mediaId,
      gatewayReceipt: fixture.receipt,
    };

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/media/upload-complete", request),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "openclaw_service_finalize_media_upload_v1",
      expect.objectContaining({ p_request: request }),
    );
    expect((await response.json()).result).toEqual({
      version: 1,
      mediaId: fixture.receipt.mediaId,
      byteState: "AVAILABLE",
      receiptHash: "b".repeat(64),
      idempotentReplay: false,
    });
  });

  it("rejects a media upload receipt that reuses its upload ticket JTI as the receipt id", async () => {
    const reusedId = "dddd7000-0000-4000-8000-000000000053";
    const fixture = await signedMediaUploadReceipt({ receiptId: reusedId, uploadTicketJti: reusedId });
    const rpc = vi.fn();
    const dependency = dependencies({
      rpc,
      gatewayReceiptPublicKey: fixture.publicKey,
    });

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/media/upload-complete", {
        version: 1,
        mediaId: fixture.receipt.mediaId,
        gatewayReceipt: fixture.receipt,
      }),
      dependency,
    );

    expect(response.status).toBe(400);
    expect(dependency.verify).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a signed media upload receipt with a lineage-truncated object key", async () => {
    const fixture = await signedMediaUploadReceipt({
      objectKey: `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}` +
        "/media/dddd7000-0000-4000-8000-000000000052/original",
    });
    const rpc = vi.fn();
    const dependency = dependencies({
      rpc,
      gatewayReceiptPublicKey: fixture.publicKey,
    });

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/media/upload-complete", {
        version: 1,
        mediaId: fixture.receipt.mediaId,
        gatewayReceipt: fixture.receipt,
      }),
      dependency,
    );

    expect(response.status).toBe(400);
    expect(dependency.verify).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("allows a rotated channel principal to finalize an old authoritative upload receipt", async () => {
    const fixture = await signedMediaUploadReceipt({ cellId: "dddd2000-0000-4000-8000-000000000099" });
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        mediaId: fixture.receipt.mediaId,
        byteState: "AVAILABLE",
        receiptHash: "b".repeat(64),
        idempotentReplay: false,
      },
      error: null,
    }));
    const dependency = dependencies({
      rpc,
      gatewayReceiptPublicKey: fixture.publicKey,
    });

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/media/upload-complete", {
        version: 1,
        mediaId: fixture.receipt.mediaId,
        gatewayReceipt: fixture.receipt,
      }),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("rejects an old upload receipt from another account before SQL", async () => {
    const foreignAccountId = "dddd1000-0000-4000-8000-000000000099";
    const fixture = await signedMediaUploadReceipt({
      accountId: foreignAccountId,
      objectKey: `v1/org/${ORGANIZATION_ID}/account/${foreignAccountId}` +
        "/conversation/dddd7000-0000-4000-8000-000000000054" +
        "/message/dddd7000-0000-4000-8000-000000000055" +
        "/media/dddd7000-0000-4000-8000-000000000052/original",
    });
    const dependency = dependencies({
      rpc: vi.fn(),
      gatewayReceiptPublicKey: fixture.publicKey,
    });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/media/upload-complete", {
        version: 1,
        mediaId: fixture.receipt.mediaId,
        gatewayReceipt: fixture.receipt,
      }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("rejects a validly signed receipt whose principal claims do not match the runtime token", async () => {
    const fixture = await signedRetentionReceipt({
      organizationId: "aaaa0000-0000-4000-8000-000000000001",
    });
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        ticketId: RETENTION_TICKET_ID,
        gatewayOutcome: "DELETED",
        receiptHash: "f".repeat(64),
        finalized: true,
        idempotentReplay: false,
      },
      error: null,
    }));
    const dependency = dependencies({
      principal: maintenancePrincipal,
      rpc,
      gatewayReceiptPublicKey: fixture.publicKey,
    });

    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/maintenance/work/complete", {
        version: 1,
        ticketId: RETENTION_TICKET_ID,
        gatewayReceipt: fixture.receipt,
      }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a work kind outside the route class", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/work/claim", { version: 1, requestedKinds: ["RETENTION_DELETE"] }),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("binds an inbound batch tenant, cell, and session to the verified principal", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/inbound/batch", canonicalInboundBatch({
        organizationId: "aaaa0000-0000-4000-8000-000000000001",
      })),
      dependency,
    );

    expect(response.status).toBe(403);
    expect(dependency.verify).toHaveBeenCalledOnce();
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("forwards one canonical inbound batch unchanged to its sole facade", async () => {
    const dependency = dependencies();
    const body = canonicalInboundBatch();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/inbound/batch", body),
      dependency,
    );

    expect(response.status).toBe(200);
    expect(dependency.rpc).toHaveBeenCalledWith(
      "openclaw_service_ingest_inbound_batch_v1",
      expect.objectContaining({ p_request: body }),
    );
  });

  it("rejects an oversized or over-count inbound batch before the facade", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/inbound/batch", {
        version: 1,
        events: Array.from({ length: 101 }, (_unused, index) => ({
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          providerEventId: `event-${index}`,
          payloadSha256: "a".repeat(64),
        })),
      }),
      dependency,
    );

    expect(response.status).toBe(400);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("cancels a streamed request as soon as the global JSON cap is exceeded", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":1,"padding":"'));
        controller.enqueue(new Uint8Array(256 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const dependency = dependencies();
    const response = await handleRuntimeRequest(new Request(
      "https://edge.invalid/openclaw-runtime/v1/heartbeat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer runtime.token.value",
          "x-openclaw-timestamp": "1785062400",
          "x-openclaw-nonce": "dddd7000-0000-4000-8000-000000000001",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ), dependency);

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("BODY_TOO_LARGE");
    expect(cancelled).toBe(true);
    expect(dependency.verify).not.toHaveBeenCalled();
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when a streamed request aborts while being read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"version":1'));
        controller.error(new Error("client aborted"));
      },
    });
    const dependency = dependencies();
    const response = await handleRuntimeRequest(new Request(
      "https://edge.invalid/openclaw-runtime/v1/heartbeat",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer runtime.token.value",
          "x-openclaw-timestamp": "1785062400",
          "x-openclaw-nonce": "dddd7000-0000-4000-8000-000000000001",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ), dependency);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("BODY_READ_FAILED");
    expect(dependency.verify).not.toHaveBeenCalled();
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("rejects a missing runtime envelope before consuming the request stream", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const responsePromise = handleRuntimeRequest(new Request(
      "https://edge.invalid/openclaw-runtime/v1/heartbeat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ), dependencies());
    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("runtime consumed unauthenticated body")), 100)
      ),
    ]);

    expect(response.status).toBe(401);
  });

  it("rejects any secret-like field anywhere in a runtime body", async () => {
    const dependency = dependencies();
    let deeplyNested: Record<string, unknown> = { apiKey: "depth-bypass" };
    for (let depth = 0; depth < 40; depth += 1) deeplyNested = { nested: deeplyNested };
    for (const body of [
      { version: 1, credential: "root-secret" },
      { version: 1, nested: { deep: { apiKey: "abc" } } },
      { version: 1, list: [{ runtimeToken: "abc" }] },
      { version: 1, deeplyNested },
    ]) {
      const response = await handleRuntimeRequest(
        runtimeRequest("/v1/heartbeat", body),
        dependency,
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("SECRET_FIELD_FORBIDDEN");
    }
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("maps an invalid or replayed token to 401 without touching the database", async () => {
    const verify = vi.fn(() => Promise.reject(new Error("nonce replay")));
    const dependency = dependencies({ verify });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/heartbeat", heartbeatRequest),
      dependency,
    );

    expect(response.status).toBe(401);
    expect(dependency.rpc).not.toHaveBeenCalled();
  });

  it("maps a stale fencing or session denial to 403 and never leaks SQL text", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: null,
        error: {
          code: "42501",
          message: "fencing token mismatch for cell dddd2000-0000-4000-8000-000000000001",
        },
      })
    );
    const dependency = dependencies({ rpc });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/complete", outboxCompletion),
      dependency,
    );
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).not.toContain("fencing token mismatch");
  });

  it("maps a CAS conflict to 409 so the runtime retries instead of double sending", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { code: "40001", message: "CAS failed" } })
    );
    const dependency = dependencies({ rpc });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/outbox/authorize-send", authorization),
      dependency,
    );

    expect(response.status).toBe(409);
  });

  it("maps unknown SQL failures to a retryable 5xx instead of misclassifying them as client errors", async () => {
    const dependency = dependencies({
      rpc: vi.fn(() => Promise.resolve({
        data: null,
        error: { code: "XX000", message: "internal database failure" },
      })),
    });
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/heartbeat", heartbeatRequest),
      dependency,
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("RUNTIME_DEPENDENCY_FAILED");
  });

  it("answers with no-store headers and never sets CORS on runtime routes", async () => {
    const dependency = dependencies();
    const response = await handleRuntimeRequest(
      runtimeRequest("/v1/heartbeat", heartbeatRequest),
      dependency,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
