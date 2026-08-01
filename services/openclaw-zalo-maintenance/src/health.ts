/**
 * Maintenance health.
 *
 * Maintenance readiness deliberately ignores the Zalo channel: a paused or
 * disconnected channel must not stop retention or audit anchoring.
 */

export interface MaintenanceReadinessInput {
  credentialValid: boolean;
  leaseActive: boolean;
  fencingCurrent: boolean;
  /** Present only to prove it is not consulted. */
  channelPaused?: boolean;
  channelCellOffline?: boolean;
}

export interface MaintenanceReadiness {
  retentionReady: boolean;
  auditReady: boolean;
}

export function evaluateMaintenanceReadiness(
  input: MaintenanceReadinessInput,
): MaintenanceReadiness {
  const ready = input.credentialValid && input.leaseActive && input.fencingCurrent;
  return { retentionReady: ready, auditReady: ready };
}