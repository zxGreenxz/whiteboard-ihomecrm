export type ReconciliationEvidence = Record<string, unknown>;

export type CommandIntentAction =
  | "FLUSH_DNS_CACHE"
  | "RENEW_DHCP_LEASE"
  | "CYCLE_ACCESS_PORT"
  | "REBOOT_ROUTER"
  | "CAPTURE_SNAPSHOT";

export interface CommandIntent {
  actionType: CommandIntentAction;
  deviceId: string;
  managedTarget: Record<string, unknown>;
  expectedPostcondition: Record<string, unknown>;
  observationDeadline: string;
}

export interface ActionObservation {
  observedAt: string;
  reachable: boolean;
  dns?: { commandAck?: boolean };
  dhcp?: {
    notApplicable?: boolean;
    leaseKey?: string;
    status?: string;
    expiresInSeconds?: number;
  };
  accessInterface?: {
    managedResourceId?: string;
    immutableKey?: string;
    enabled?: boolean;
    disabledObserved?: boolean;
    enabledObserved?: boolean;
  };
  boot?: { bootId?: string; uptimeSeconds?: number };
  snapshot?: {
    redactedContentHash?: string;
    encryptedArtifactHash?: string;
  };
  details?: Record<string, unknown>;
}

export type ReconciliationDecision =
  | { outcome: "SUCCEEDED"; evidence: ReconciliationEvidence }
  | { outcome: "FAILED"; code: string; evidence: ReconciliationEvidence }
  | {
    outcome: "UNCERTAIN";
    retryAfterSeconds: number;
    evidence: ReconciliationEvidence;
  };

const SHA256 = /^[a-f0-9]{64}$/;

function uncertain(
  intent: CommandIntent,
  before: ActionObservation,
  after: ActionObservation,
): ReconciliationDecision {
  return {
    outcome: "UNCERTAIN",
    retryAfterSeconds: intent.actionType === "REBOOT_ROUTER" ? 30 : 10,
    evidence: { actionType: intent.actionType, before, after },
  };
}

function observedBeforeDeadline(intent: CommandIntent, after: ActionObservation): boolean {
  const deadline = Date.parse(intent.observationDeadline);
  const observed = Date.parse(after.observedAt);
  return Number.isFinite(deadline) && Number.isFinite(observed) && observed <= deadline;
}

function sameText(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string"
    && left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function reconcileAction(
  intent: CommandIntent,
  before: ActionObservation,
  after: ActionObservation,
): ReconciliationDecision {
  if (!observedBeforeDeadline(intent, after)) return uncertain(intent, before, after);

  if (intent.actionType === "FLUSH_DNS_CACHE") {
    return after.dns?.commandAck === true
      ? {
        outcome: "SUCCEEDED",
        evidence: { actionType: intent.actionType, dnsAck: true, observedAt: after.observedAt },
      }
      : uncertain(intent, before, after);
  }

  if (intent.actionType === "RENEW_DHCP_LEASE") {
    if (before.dhcp?.notApplicable === true || after.dhcp?.notApplicable === true) {
      return {
        outcome: "FAILED",
        code: "DHCP_RENEW_NOT_APPLICABLE",
        evidence: { actionType: intent.actionType, notApplicable: true },
      };
    }
    const beforeExpiry = before.dhcp?.expiresInSeconds;
    const afterExpiry = after.dhcp?.expiresInSeconds;
    const renewed = before.dhcp?.status?.toLowerCase() === "bound"
      && after.dhcp?.status?.toLowerCase() === "bound"
      && sameText(before.dhcp?.leaseKey, after.dhcp?.leaseKey)
      && typeof beforeExpiry === "number"
      && typeof afterExpiry === "number"
      && afterExpiry > beforeExpiry;
    return renewed
      ? {
        outcome: "SUCCEEDED",
        evidence: {
          actionType: intent.actionType,
          leaseKey: after.dhcp?.leaseKey ?? "",
          previousExpirySeconds: beforeExpiry ?? 0,
          leaseExpiresInSeconds: afterExpiry ?? 0,
        },
      }
      : uncertain(intent, before, after);
  }

  if (intent.actionType === "CYCLE_ACCESS_PORT") {
    const target = intent.managedTarget;
    const port = after.accessInterface;
    const transitioned = Boolean(port)
      && sameText(port?.managedResourceId, target.managedResourceId)
      && sameText(port?.immutableKey, target.immutableKey)
      && port?.disabledObserved === true
      && port.enabledObserved === true
      && port.enabled === true;
    return transitioned
      ? {
        outcome: "SUCCEEDED",
        evidence: {
          actionType: intent.actionType,
          managedResourceId: port?.managedResourceId ?? "",
          immutableKey: port?.immutableKey ?? "",
          disabledObserved: true,
          enabledObserved: true,
          enabled: true,
        },
      }
      : uncertain(intent, before, after);
  }

  if (intent.actionType === "REBOOT_ROUTER") {
    const beforeUptime = before.boot?.uptimeSeconds;
    const afterUptime = after.boot?.uptimeSeconds;
    const rebooted = typeof before.boot?.bootId === "string"
      && typeof after.boot?.bootId === "string"
      && !sameText(before.boot.bootId, after.boot.bootId)
      && typeof beforeUptime === "number"
      && typeof afterUptime === "number"
      && afterUptime >= 0
      && afterUptime < beforeUptime;
    return rebooted
      ? {
        outcome: "SUCCEEDED",
        evidence: {
          actionType: intent.actionType,
          previousBootId: before.boot?.bootId ?? "",
          bootId: after.boot?.bootId ?? "",
          previousUptimeSeconds: beforeUptime ?? 0,
          uptimeSeconds: afterUptime ?? 0,
        },
      }
      : uncertain(intent, before, after);
  }

  const redactedContentHash = after.snapshot?.redactedContentHash ?? "";
  const encryptedArtifactHash = after.snapshot?.encryptedArtifactHash ?? "";
  return SHA256.test(redactedContentHash) && SHA256.test(encryptedArtifactHash)
    ? {
      outcome: "SUCCEEDED",
      evidence: {
        actionType: intent.actionType,
        redactedContentHash,
        encryptedArtifactHash,
      },
    }
    : uncertain(intent, before, after);
}
