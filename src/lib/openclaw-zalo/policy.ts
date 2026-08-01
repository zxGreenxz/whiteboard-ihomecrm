import type {
  OpenClawSendDecision,
  OpenClawSendPolicyInput,
  SendDecisionReason,
} from "./types";

export const POLICY_REASON_PRECEDENCE = [
  "GLOBAL_STOP",
  "MODE_PAUSED",
  "ACCOUNT_PAUSED",
  "CAMPAIGN_CANCELLED",
  "TAKEOVER_ACTIVE",
  "SUPPRESSED",
  "CONSENT_MISSING",
  "QUIET_HOURS",
  "RATE_LIMITED",
  "GROUP_NOT_ALLOWLISTED",
  "GROUP_DIRECTORY_STALE",
] as const satisfies readonly Exclude<SendDecisionReason, "ALLOWED">[];

export function evaluateSendPolicy(input: OpenClawSendPolicyInput): OpenClawSendDecision {
  const reason = POLICY_REASON_PRECEDENCE.find(candidate => input[candidate] === true) ?? "ALLOWED";
  return { allowed: reason === "ALLOWED", reason };
}
