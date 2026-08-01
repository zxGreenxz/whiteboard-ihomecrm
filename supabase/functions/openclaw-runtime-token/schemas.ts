const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Tokens live at most five minutes; the design fixes this, not the caller. */
export const OPENCLAW_RUNTIME_TOKEN_MAX_TTL_SECONDS = 300;

export interface ChannelExchangeRequest {
  version: 1;
  principalKind: "CHANNEL";
  organizationId: string;
  accountId: string;
  cellId: string;
  runtimeMethod: "POST";
  runtimePath: string;
  runtimeTimestamp: number;
  runtimeNonce: string;
  runtimeBodySha256: string;
  exchangeNonce: string;
}

export interface MaintenanceExchangeRequest {
  version: 1;
  principalKind: "MAINTENANCE";
  organizationId: string;
  maintenancePrincipalId: string;
  runtimeMethod: "POST";
  runtimePath: string;
  runtimeTimestamp: number;
  runtimeNonce: string;
  runtimeBodySha256: string;
  exchangeNonce: string;
}

export type RuntimeTokenExchangeRequest =
  | ChannelExchangeRequest
  | MaintenanceExchangeRequest;

const CHANNEL_KEYS = [
  "version",
  "principalKind",
  "organizationId",
  "accountId",
  "cellId",
  "runtimeMethod",
  "runtimePath",
  "runtimeTimestamp",
  "runtimeNonce",
  "runtimeBodySha256",
  "exchangeNonce",
] as const;

const MAINTENANCE_KEYS = [
  "version",
  "principalKind",
  "organizationId",
  "maintenancePrincipalId",
  "runtimeMethod",
  "runtimePath",
  "runtimeTimestamp",
  "runtimeNonce",
  "runtimeBodySha256",
  "exchangeNonce",
] as const;

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

function commonFieldsValid(value: Record<string, unknown>): boolean {
  return (
    value.runtimeMethod === "POST" &&
    typeof value.runtimePath === "string" &&
    value.runtimePath.startsWith("/v1/") &&
    !/[?#]/.test(value.runtimePath) &&
    typeof value.runtimeTimestamp === "number" &&
    Number.isInteger(value.runtimeTimestamp) &&
    value.runtimeTimestamp >= 0 &&
    value.runtimeTimestamp <= Number.MAX_SAFE_INTEGER &&
    isUuid(value.runtimeNonce) &&
    typeof value.runtimeBodySha256 === "string" &&
    SHA256_PATTERN.test(value.runtimeBodySha256) &&
    isUuid(value.exchangeNonce) &&
    // Reusing one nonce for both namespaces would let one exchange burn the
    // runtime call it is supposed to authorize.
    value.exchangeNonce !== value.runtimeNonce
  );
}

export const runtimeTokenRequestSchema = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: RuntimeTokenExchangeRequest }
    | { success: false; error: string } {
    if (!isPlainObject(value)) return { success: false, error: "request must be an object" };
    if (value.version !== 1) return { success: false, error: "version must be 1" };

    if (value.principalKind === "CHANNEL") {
      if (!hasExactKeys(value, CHANNEL_KEYS)) {
        return { success: false, error: "channel request has unexpected keys" };
      }
      if (
        !isUuid(value.organizationId) ||
        !isUuid(value.accountId) ||
        !isUuid(value.cellId) ||
        !commonFieldsValid(value)
      ) {
        return { success: false, error: "channel request is invalid" };
      }
      return { success: true, data: value as unknown as ChannelExchangeRequest };
    }

    if (value.principalKind === "MAINTENANCE") {
      if (!hasExactKeys(value, MAINTENANCE_KEYS)) {
        return { success: false, error: "maintenance request has unexpected keys" };
      }
      if (
        !isUuid(value.organizationId) ||
        !isUuid(value.maintenancePrincipalId) ||
        !commonFieldsValid(value)
      ) {
        return { success: false, error: "maintenance request is invalid" };
      }
      return { success: true, data: value as unknown as MaintenanceExchangeRequest };
    }

    return { success: false, error: "principalKind is not allowed" };
  },
};

export function principalSelectorFor(
  request: RuntimeTokenExchangeRequest,
): Record<string, string> {
  return request.principalKind === "CHANNEL"
    ? {
      organizationId: request.organizationId,
      accountId: request.accountId,
      cellId: request.cellId,
    }
    : {
      organizationId: request.organizationId,
      maintenancePrincipalId: request.maintenancePrincipalId,
    };
}