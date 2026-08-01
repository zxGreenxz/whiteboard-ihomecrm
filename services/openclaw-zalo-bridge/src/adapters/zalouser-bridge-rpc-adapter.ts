import { createHash } from "node:crypto";

import { canonicalJson } from "../spool/checksum.js";
import {
  evaluateMarker,
  type MarkerFields,
} from "../outbox/state-machine.js";

/**
 * The private ZaloUser bridge RPC adapter.
 *
 * Business delivery uses exactly one private request, `zalouser.bridge.send`,
 * carrying the complete canonical payload plus a short-lived authorization
 * marker. The stock generic `send` is never used for business traffic: it is
 * denied outside the authorized fork context, which is what makes every other
 * bypass path (message tool, pairing notification, direct adapter call) unable
 * to move customer content.
 */

export const PRIVATE_SEND_RPC = "zalouser.bridge.send";

/** Ordinary cell control RPCs the adapter is allowed to call. */
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

export type SendPartKind = "TEXT" | "MEDIA";

export interface SendPart {
  kind: SendPartKind;
  /** TEXT parts carry text; MEDIA parts carry a verified object reference. */
  text?: string;
  mediaId?: string;
  sha256?: string;
  mime?: string;
  byteLength?: number;
}

export interface CanonicalSendPayloadV1 {
  version: 1;
  outboxId: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  targetStableId: string;
  accountProfile: string;
  idempotencyKey: string;
  parts: SendPart[];
}

export type SendDenial =
  | "UNSUPPORTED_PART_KIND"
  | "EMPTY_BATCH"
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

/**
 * RFC8785-style canonical hash of the send payload. JavaScript, SQL, and the
 * vendored fork must all agree on this value; disagreement is what a stale or
 * tampered marker looks like.
 */
export function hashCanonicalSendPayload(payload: CanonicalSendPayloadV1): string {
  return createHash("sha256")
    .update("ihome-openclaw-send-payload-v1", "utf8")
    .update(Buffer.from([0]))
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

/**
 * Materializes the exact ordered provider batch. Only TEXT and MEDIA are
 * representable; a link or reaction request is a bypass attempt and fails here,
 * before authorization and before any provider I/O.
 */
export function materializeBatch(
  payload: CanonicalSendPayloadV1,
): { ok: boolean; denial?: SendDenial; parts: SendPart[] } {
  if (payload.parts.length === 0) return { ok: false, denial: "EMPTY_BATCH", parts: [] };
  for (const part of payload.parts) {
    if (part.kind !== "TEXT" && part.kind !== "MEDIA") {
      return { ok: false, denial: "UNSUPPORTED_PART_KIND", parts: [] };
    }
    if (part.kind === "MEDIA") {
      // Every media byte sequence must already be verified: digest, MIME, and
      // length are all required before the batch may be authorized.
      if (
        typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(part.sha256) ||
        typeof part.mime !== "string" || part.mime.length === 0 ||
        typeof part.byteLength !== "number" || !Number.isInteger(part.byteLength) ||
        part.byteLength <= 0
      ) {
        return { ok: false, denial: "MEDIA_UNVERIFIED", parts: [] };
      }
    }
    if (part.kind === "TEXT" && (typeof part.text !== "string" || part.text.length === 0)) {
      return { ok: false, denial: "UNSUPPORTED_PART_KIND", parts: [] };
    }
  }
  return { ok: true, parts: [...payload.parts] };
}

export interface SendDependencies {
  /**
   * Calls `/v1/outbox/authorize-send`. This is the final awaited operation
   * before the first provider I/O.
   */
  authorizeSend: (input: {
    payloadSha256: string;
    marker: MarkerFields;
  }) => Promise<{ authorized: boolean }>;
  /** Emits one provider frame; the adapter counts every call. */
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
 * The single authorized business-send entry point.
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

  const payloadSha256 = hashCanonicalSendPayload(payload);
  const markerVerdict = evaluateMarker({
    marker,
    nowEpochMs: dependencies.nowEpochMs(),
    leaseExpiresAtEpochMs: dependencies.leaseExpiresAtEpochMs,
    expectedPayloadSha256: payloadSha256,
    currentFencingToken: dependencies.currentFencingToken,
    currentSessionGeneration: dependencies.currentSessionGeneration,
    currentControlVersion: dependencies.currentControlVersion,
    currentTakeoverVersion: dependencies.currentTakeoverVersion,
    nonceAlreadyConsumed: dependencies.nonceAlreadyConsumed,
  });
  if (!markerVerdict.ok) {
    return {
      authorized: false,
      denial: marker.payloadSha256 !== payloadSha256
        ? "PAYLOAD_HASH_MISMATCH"
        : "MARKER_INVALID",
      providerFramesEmitted: 0,
      providerMessageIds: [],
    };
  }

  let authorization: { authorized: boolean };
  try {
    authorization = await dependencies.authorizeSend({ payloadSha256, marker });
  } catch {
    // An Edge error, timeout, or bridge failure yields zero provider frames.
    return {
      authorized: false,
      denial: "MARKER_INVALID",
      providerFramesEmitted: 0,
      providerMessageIds: [],
    };
  }
  if (!authorization.authorized) {
    return {
      authorized: false,
      denial: "MARKER_INVALID",
      providerFramesEmitted: 0,
      providerMessageIds: [],
    };
  }

  const providerMessageIds: string[] = [];
  let framesEmitted = 0;
  for (const [index, part] of batch.parts.entries()) {
    try {
      framesEmitted += 1;
      providerMessageIds.push(await dependencies.emitProviderFrame(part, index));
    } catch {
      // Any failure after the first possible handoff makes the whole outbox
      // UNKNOWN, even when later parts are known to be unsent.
      return {
        authorized: true,
        providerFramesEmitted: framesEmitted,
        providerMessageIds,
        outcome: "UNKNOWN",
      };
    }
  }

  return {
    authorized: true,
    providerFramesEmitted: framesEmitted,
    providerMessageIds,
    outcome: "SENT",
  };
}

/**
 * The stock generic `send` path. It exists only to be refused: business content
 * must travel through `zalouserBridgeSend`.
 */
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

/** Typing, seen, and delivery receipts are content-free and mint nothing. */
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