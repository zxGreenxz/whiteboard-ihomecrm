import {
  hashCanonicalSendPayload as hashPayload,
  snapshotCanonicalSendPayload,
  type CanonicalSendPayloadV1,
  type OutboxAuthorizeSendRequestV1,
  type ZaloUserBridgeSendPartV1,
} from "../runtime-api/schemas.js";
import { evaluateMarker, type MarkerFields } from "../outbox/state-machine.js";

export const PRIVATE_SEND_RPC = "zalouser.bridge.send";

export const ALLOWED_CONTROL_RPCS = Object.freeze([
  "web.login.start",
  "web.login.wait",
  "channels.status",
  "channels.start",
  "channels.stop",
  "channels.logout",
  "agent",
] as const);

export type ControlRpc = (typeof ALLOWED_CONTROL_RPCS)[number];
export type SendPart = ZaloUserBridgeSendPartV1;
export type { CanonicalSendPayloadV1 };

export type SendDenial =
  | "UNSUPPORTED_PART_KIND"
  | "EMPTY_BATCH"
  | "TOO_MANY_PARTS"
  | "PART_INDEX_INVALID"
  | "TEXT_TOO_LONG"
  | "MEDIA_UNVERIFIED"
  | "MARKER_INVALID"
  | "GENERIC_SEND_FORBIDDEN"
  | "CONTROL_RPC_FORBIDDEN"
  | "PAYLOAD_HASH_MISMATCH";

export interface SendAttemptResult {
  authorized: boolean;
  denial?: SendDenial;
  providerFramesEmitted: number;
  providerMessageIds: string[];
  outcome?: "SENT" | "UNKNOWN" | "FAILED";
}

export function hashCanonicalSendPayload(payload: CanonicalSendPayloadV1): string {
  return hashPayload(payload);
}

export function materializeBatch(
  payload: CanonicalSendPayloadV1,
): { ok: boolean; denial?: SendDenial; parts: SendPart[] } {
  if (!Array.isArray(payload.parts) || payload.parts.length === 0) {
    return { ok: false, denial: "EMPTY_BATCH", parts: [] };
  }
  if (payload.parts.length > 20) return { ok: false, denial: "TOO_MANY_PARTS", parts: [] };
  for (const [index, part] of payload.parts.entries()) {
    if (!part || typeof part !== "object" || (part.kind !== "TEXT" && part.kind !== "MEDIA")) {
      return { ok: false, denial: "UNSUPPORTED_PART_KIND", parts: [] };
    }
    if (part.version !== 1 || part.partIndex !== index) {
      return { ok: false, denial: "PART_INDEX_INVALID", parts: [] };
    }
    if (part.kind === "TEXT") {
      if (typeof part.text !== "string" || part.text.length === 0) {
        return { ok: false, denial: "UNSUPPORTED_PART_KIND", parts: [] };
      }
      if (Array.from(part.text).length > 2_000) {
        return { ok: false, denial: "TEXT_TOO_LONG", parts: [] };
      }
    } else if (
      typeof part.objectKey !== "string" || part.objectKey.trim().length === 0 ||
      typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(part.sha256) ||
      typeof part.mime !== "string" ||
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(part.mime) ||
      !Number.isSafeInteger(part.bytes) || part.bytes <= 0
    ) {
      return { ok: false, denial: "MEDIA_UNVERIFIED", parts: [] };
    }
  }
  try {
    return { ok: true, parts: [...snapshotCanonicalSendPayload(payload).parts] };
  } catch {
    return { ok: false, denial: "UNSUPPORTED_PART_KIND", parts: [] };
  }
}

export interface SendDependencies {
  authorizeSend: (input: {
    payloadHash: string;
    marker: MarkerFields;
  }) => Promise<{ authorized: boolean }>;
  emitProviderFrame: (part: SendPart, index: number) => Promise<string>;
  nowEpochMs: () => number;
  leaseExpiresAtEpochMs: number;
  currentFencingToken: number;
  currentSessionGeneration: number;
  currentControlVersion: number;
  currentTakeoverVersion: number;
  nonceAlreadyConsumed: boolean;
}

/**
 * Unit-level model of the fork's last-moment authorization seam. Production
 * workers call the private RPC adapter below; the reviewed fork owns provider
 * materialization and I/O.
 */
export async function zalouserBridgeSend(
  payload: CanonicalSendPayloadV1,
  marker: MarkerFields,
  dependencies: SendDependencies,
): Promise<SendAttemptResult> {
  const batch = materializeBatch(payload);
  if (!batch.ok) {
    return {
      authorized: false,
      denial: batch.denial,
      providerFramesEmitted: 0,
      providerMessageIds: [],
    };
  }
  const payloadHash = hashCanonicalSendPayload(payload);
  const markerVerdict = evaluateMarker({
    marker,
    nowEpochMs: dependencies.nowEpochMs(),
    leaseExpiresAtEpochMs: dependencies.leaseExpiresAtEpochMs,
    expectedPayloadSha256: payloadHash,
    currentFencingToken: dependencies.currentFencingToken,
    currentSessionGeneration: dependencies.currentSessionGeneration,
    currentControlVersion: dependencies.currentControlVersion,
    currentTakeoverVersion: dependencies.currentTakeoverVersion,
    nonceAlreadyConsumed: dependencies.nonceAlreadyConsumed,
  });
  if (!markerVerdict.ok) {
    return {
      authorized: false,
      denial: marker.payloadHash !== payloadHash ? "PAYLOAD_HASH_MISMATCH" : "MARKER_INVALID",
      providerFramesEmitted: 0,
      providerMessageIds: [],
    };
  }
  try {
    const authorization = await dependencies.authorizeSend({ payloadHash, marker });
    if (!authorization.authorized) {
      return {
        authorized: false,
        denial: "MARKER_INVALID",
        providerFramesEmitted: 0,
        providerMessageIds: [],
      };
    }
  } catch {
    return {
      authorized: false,
      denial: "MARKER_INVALID",
      providerFramesEmitted: 0,
      providerMessageIds: [],
    };
  }

  const handoffBarrierNow = dependencies.nowEpochMs();
  const markerExpiresAt = Date.parse(marker.expiresAt);
  if (markerExpiresAt <= handoffBarrierNow) {
    throw Object.assign(new Error("authorization expired before provider handoff"), {
      code: "AUTHORIZATION_EXPIRED",
      authorizedHandoffRecorded: false as const,
    });
  }
  if (dependencies.leaseExpiresAtEpochMs <= handoffBarrierNow) {
    throw Object.assign(new Error("lease expired before provider handoff"), {
      code: "LEASE_EXPIRED",
      authorizedHandoffRecorded: false as const,
    });
  }

  const providerMessageIds: string[] = [];
  let providerFramesEmitted = 0;
  for (const [index, part] of batch.parts.entries()) {
    try {
      providerFramesEmitted += 1;
      providerMessageIds.push(await dependencies.emitProviderFrame(part, index));
    } catch {
      return {
        authorized: true,
        providerFramesEmitted,
        providerMessageIds,
        outcome: "UNKNOWN",
      };
    }
  }
  return {
    authorized: true,
    providerFramesEmitted,
    providerMessageIds,
    outcome: "SENT",
  };
}

export interface CellRpcTransport {
  invoke(method: string, params: unknown): Promise<unknown>;
}

/** The only production business-delivery call the bridge can make. */
export function createZaloUserBridgeRpcAdapter(transport: CellRpcTransport) {
  if (!transport || typeof transport.invoke !== "function") {
    throw new TypeError("cell RPC transport is required");
  }
  return Object.freeze({
    send: async (payload: CanonicalSendPayloadV1, authorization: OutboxAuthorizeSendRequestV1) =>
      await transport.invoke(PRIVATE_SEND_RPC, {
        version: 1,
        payload: snapshotCanonicalSendPayload(payload),
        authorization,
      }),
    control: async (method: ControlRpc, params: unknown) => {
      if (!isAllowedControlRpc(method)) throw new Error("CONTROL_RPC_FORBIDDEN");
      return await transport.invoke(method, params);
    },
  });
}

export function genericSend(): SendAttemptResult {
  return {
    authorized: false,
    denial: "GENERIC_SEND_FORBIDDEN",
    providerFramesEmitted: 0,
    providerMessageIds: [],
  };
}

export function isAllowedControlRpc(name: string): name is ControlRpc {
  return (ALLOWED_CONTROL_RPCS as readonly string[]).includes(name);
}

export const CONTROL_TRAFFIC_KINDS = Object.freeze([
  "typing",
  "seen",
  "delivery-receipt",
] as const);

export function validateControlTraffic(
  kind: string,
  body: Record<string, unknown>,
): { ok: boolean; reason?: string } {
  if (!(CONTROL_TRAFFIC_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: "CONTROL_KIND_FORBIDDEN" };
  }
  for (const forbidden of ["text", "media", "parts", "marker", "authorization"]) {
    if (forbidden in body) return { ok: false, reason: "CONTROL_CARRIES_CONTENT" };
  }
  return { ok: true };
}
