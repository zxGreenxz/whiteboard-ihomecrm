const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** The QR challenge lifetime is fixed by the design: exactly 120 seconds. */
export const OPENCLAW_QR_CHALLENGE_TTL_SECONDS = 120;

export const QR_OPERATION_RPCS = Object.freeze({
  BEGIN: "openclaw_begin_qr_login_v1",
  POLL: "openclaw_poll_qr_login_v1",
  CONSUME: "openclaw_service_consume_qr_challenge_v1",
} as const);

export type QrOperation = keyof typeof QR_OPERATION_RPCS;

export interface QrBeginRequest {
  version: 1;
  operation: "BEGIN";
  clientOperationId: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  browserNonceHash: string;
  authSessionHash: string;
  disclosureVersion: number;
}

export interface QrPollRequest {
  version: 1;
  operation: "POLL";
  organizationId: string;
  challengeId: string;
  browserNonceHash: string;
  authSessionHash: string;
}

export interface QrConsumeRequest {
  version: 1;
  operation: "CONSUME";
  clientOperationId: string;
  organizationId: string;
  accountId: string;
  challengeId: string;
  browserNonceHash: string;
  authSessionHash: string;
}

export type QrRequest = QrBeginRequest | QrPollRequest | QrConsumeRequest;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => key in value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

const BEGIN_KEYS = [
  "version",
  "operation",
  "clientOperationId",
  "organizationId",
  "accountId",
  "cellId",
  "browserNonceHash",
  "authSessionHash",
  "disclosureVersion",
] as const;

const POLL_KEYS = [
  "version",
  "operation",
  "organizationId",
  "challengeId",
  "browserNonceHash",
  "authSessionHash",
] as const;

const CONSUME_KEYS = [
  "version",
  "operation",
  "clientOperationId",
  "organizationId",
  "accountId",
  "challengeId",
  "browserNonceHash",
  "authSessionHash",
] as const;

export const qrRequestSchema = {
  safeParse(
    value: unknown,
  ): { success: true; data: QrRequest } | { success: false; error: string } {
    if (!isPlainObject(value)) return { success: false, error: "request must be an object" };
    if (value.version !== 1) return { success: false, error: "version must be 1" };

    if (value.operation === "BEGIN") {
      if (!hasExactKeys(value, BEGIN_KEYS)) {
        return { success: false, error: "begin request has unexpected keys" };
      }
      if (
        !isUuid(value.clientOperationId) ||
        !isUuid(value.organizationId) ||
        !isUuid(value.accountId) ||
        !isUuid(value.cellId) ||
        !isSha256(value.browserNonceHash) ||
        !isSha256(value.authSessionHash) ||
        !Number.isSafeInteger(value.disclosureVersion) ||
        Number(value.disclosureVersion) < 1
      ) {
        return { success: false, error: "begin request is invalid" };
      }
      return { success: true, data: value as unknown as QrBeginRequest };
    }

    if (value.operation === "POLL") {
      if (!hasExactKeys(value, POLL_KEYS)) {
        return { success: false, error: "poll request has unexpected keys" };
      }
      if (
        !isUuid(value.organizationId) ||
        !isUuid(value.challengeId) ||
        !isSha256(value.browserNonceHash) ||
        !isSha256(value.authSessionHash)
      ) {
        return { success: false, error: "poll request is invalid" };
      }
      return { success: true, data: value as unknown as QrPollRequest };
    }

    if (value.operation === "CONSUME") {
      if (!hasExactKeys(value, CONSUME_KEYS)) {
        return { success: false, error: "consume request has unexpected keys" };
      }
      if (
        !isUuid(value.clientOperationId) ||
        !isUuid(value.organizationId) ||
        !isUuid(value.accountId) ||
        !isUuid(value.challengeId) ||
        !isSha256(value.browserNonceHash) ||
        !isSha256(value.authSessionHash)
      ) {
        return { success: false, error: "consume request is invalid" };
      }
      return { success: true, data: value as unknown as QrConsumeRequest };
    }

    return { success: false, error: "operation is not allowed" };
  },
};
