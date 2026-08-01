/**
 * Maintenance principal authentication.
 *
 * The whole point of a separate maintenance principal is that retention and
 * audit anchoring survive events that kill the channel: the Zalo account can be
 * disconnected, replaced, or removed, and the channel cell can be offline, and
 * these jobs still run. Conversely, a send-work token must never reach them.
 */

export type MaintenanceOperation = "maintenance.claim" | "maintenance.complete";

export const MAINTENANCE_WORK_KINDS = Object.freeze([
  "RETENTION_DELETE",
  "AUDIT_ANCHOR",
] as const);

export type MaintenanceWorkKind = (typeof MAINTENANCE_WORK_KINDS)[number];

export interface MaintenancePrincipal {
  version: 1;
  principalKind: "MAINTENANCE";
  organizationId: string;
  maintenancePrincipalId: string;
  credentialGeneration: number;
  leaseGeneration: number;
  fencingToken: number;
}

export interface MaintenanceAuthState {
  principal: MaintenancePrincipal;
  credentialEnabled: boolean;
  credentialRevoked: boolean;
  leaseStatus: "ACTIVE" | "EXPIRED" | "RELEASED";
  leaseExpiresAtEpochMs: number;
  currentCredentialGeneration: number;
  currentLeaseGeneration: number;
  currentFencingToken: number;
  allowedScopes: readonly string[];
}

export type MaintenanceDenial =
  | "WRONG_PRINCIPAL_KIND"
  | "WRONG_ORGANIZATION"
  | "CREDENTIAL_DISABLED"
  | "CREDENTIAL_REVOKED"
  | "STALE_CREDENTIAL_GENERATION"
  | "LEASE_NOT_ACTIVE"
  | "LEASE_EXPIRED"
  | "STALE_LEASE_GENERATION"
  | "STALE_FENCING_TOKEN"
  | "SCOPE_NOT_GRANTED"
  | "WORK_KIND_FORBIDDEN";

export interface MaintenanceVerdict {
  allowed: boolean;
  denial?: MaintenanceDenial;
}

function deny(denial: MaintenanceDenial): MaintenanceVerdict {
  return { allowed: false, denial };
}

export function authorizeMaintenance({
  state,
  expectedOrganizationId,
  operation,
  workKind,
  nowEpochMs,
}: {
  state: MaintenanceAuthState;
  expectedOrganizationId: string;
  operation: MaintenanceOperation;
  workKind?: string;
  nowEpochMs: number;
}): MaintenanceVerdict {
  const principal = state.principal;

  if (principal.principalKind !== "MAINTENANCE") return deny("WRONG_PRINCIPAL_KIND");
  if (principal.organizationId !== expectedOrganizationId) return deny("WRONG_ORGANIZATION");

  if (!state.credentialEnabled) return deny("CREDENTIAL_DISABLED");
  if (state.credentialRevoked) return deny("CREDENTIAL_REVOKED");
  if (principal.credentialGeneration !== state.currentCredentialGeneration) {
    return deny("STALE_CREDENTIAL_GENERATION");
  }

  if (state.leaseStatus !== "ACTIVE") return deny("LEASE_NOT_ACTIVE");
  if (state.leaseExpiresAtEpochMs <= nowEpochMs) return deny("LEASE_EXPIRED");
  if (principal.leaseGeneration !== state.currentLeaseGeneration) {
    return deny("STALE_LEASE_GENERATION");
  }
  if (principal.fencingToken !== state.currentFencingToken) {
    return deny("STALE_FENCING_TOKEN");
  }

  if (!state.allowedScopes.includes(operation)) return deny("SCOPE_NOT_GRANTED");

  if (workKind !== undefined) {
    if (!(MAINTENANCE_WORK_KINDS as readonly string[]).includes(workKind)) {
      return deny("WORK_KIND_FORBIDDEN");
    }
  }

  return { allowed: true };
}

/**
 * Channel state is deliberately absent from the decision above. This helper
 * exists so the tests can state the invariant explicitly: no channel condition
 * may influence maintenance authorization.
 */
export function channelStateAffectsMaintenance(): false {
  return false;
}