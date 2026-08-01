import type { JsonValue } from "./types";

export const REDACTED_TOKEN = "[REDACTED_OPENCLAW_SECRET]" as const;

export type IdempotencyResult = "NEW" | "REPLAY" | "CONFLICT";

export function classifyIdempotency(
  existingOperationKey: string,
  originalRequestHash: string | null,
  incomingRequestHash: string,
  incomingOperationKey = existingOperationKey,
): IdempotencyResult {
  if (originalRequestHash === null || existingOperationKey !== incomingOperationKey) return "NEW";
  return originalRequestHash === incomingRequestHash ? "REPLAY" : "CONFLICT";
}

export function makeClientOperationId(value?: string): string {
  return value ?? crypto.randomUUID();
}

export function redactOpenClawSecrets<T>(value: T): T {
  const redact = (current: unknown): JsonValue | unknown => {
    if (Array.isArray(current)) return current.map(item => redact(item));
    if (!current || typeof current !== "object") return current;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current)) {
      result[key] = key === "claimToken" || key === "markerNonce" ? REDACTED_TOKEN : redact(child);
    }
    return result;
  };
  return redact(value) as T;
}

export function assertOrganizationScope(request: { organizationId: string }, organizationId: string): void {
  if (request.organizationId !== organizationId) throw new Error("OpenClaw organization scope mismatch");
}

export function createScopedRequest<T extends Record<string, unknown>>(
  organizationId: string,
  request: T,
): T & { version: 1; organizationId: string } {
  if ("organizationId" in request && request.organizationId !== organizationId) {
    throw new Error("OpenClaw organization scope mismatch");
  }
  return { version: 1, organizationId, ...request } as T & { version: 1; organizationId: string };
}
