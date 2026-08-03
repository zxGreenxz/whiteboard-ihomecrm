import type { OpenClawUnknownResolutionOutcome } from "./types";

/**
 * The exact phrase an operator must type to stop every send in the organization.
 *
 * Unaccented on purpose: the operator may be on a keyboard without Vietnamese input,
 * and a confirmation nobody can type is a confirmation that gets worked around. The
 * comparison is exact - no trimming of interior spaces, no case folding - because
 * the point of the phrase is deliberateness, not convenience.
 */
export const GLOBAL_STOP_CONFIRMATION = "DUNG TOAN BO GUI CUA CONG TY";

/**
 * Whether the typed text authorises the stop.
 *
 * Leading and trailing whitespace is forgiven because it comes from paste and from
 * mobile keyboards, and forgiving it changes nothing about intent. Anything else -
 * different case, missing word, extra word - does not.
 */
export function globalStopConfirmationMatches(typed: string) {
  return typed.trim() === GLOBAL_STOP_CONFIRMATION;
}

export type GlobalStopBlockedBy = "PERMISSION" | "CONFIRMATION" | "ALREADY_STOPPED";

export interface GlobalStopGateInput {
  canManageOperations: boolean;
  typedConfirmation: string;
  alreadyStopped: boolean;
}

export function globalStopGate(input: GlobalStopGateInput): {
  canStop: boolean;
  blockedBy: GlobalStopBlockedBy | null;
} {
  const blockedBy: GlobalStopBlockedBy | null = !input.canManageOperations
    ? "PERMISSION"
    : input.alreadyStopped
      ? "ALREADY_STOPPED"
      : globalStopConfirmationMatches(input.typedConfirmation)
        ? null
        : "CONFIRMATION";
  return { canStop: blockedBy === null, blockedBy };
}

/**
 * The three outcomes an UNKNOWN may be resolved to, and what each one asserts.
 *
 * `fabricatesProviderSuccess` is false for every one of them, and the test pins that:
 * the operator is recording what they OBSERVED, not instructing the system to claim
 * a delivery. CONFIRMED_SENT means "I checked the phone and the customer has it",
 * not "mark it sent".
 */
export const UNKNOWN_OUTCOMES = [
  {
    outcome: "CONFIRMED_SENT",
    reasonCode: "OPERATOR_CONFIRMED_SENT",
    label: "Đã xác nhận khách nhận được",
    detail: "Bạn đã tự kiểm tra trên điện thoại và thấy tin đã tới khách.",
    createsNewSend: false,
  },
  {
    outcome: "CONFIRMED_FAILED",
    reasonCode: "OPERATOR_CONFIRMED_FAILED",
    label: "Đã xác nhận không tới khách",
    detail: "Bạn đã tự kiểm tra và thấy tin KHÔNG tới khách. Việc này không tự gửi lại.",
    createsNewSend: false,
  },
  {
    outcome: "NEW_INTENT_CREATED",
    reasonCode: "OPERATOR_CREATED_NEW_INTENT",
    label: "Tạo lần gửi mới",
    detail: "Dùng khi đã xác nhận tin cũ không tới. Sẽ tạo một lần gửi mới, có kiểm chính sách lại.",
    createsNewSend: true,
  },
] as const satisfies readonly {
  outcome: OpenClawUnknownResolutionOutcome;
  reasonCode: string;
  label: string;
  detail: string;
  createsNewSend: boolean;
}[];

/**
 * An UNKNOWN keeps its historical badge forever; resolving it adds a SECOND badge.
 *
 * The row is evidence of what the system observed at the time, and a resolution is
 * evidence of what an operator later established. Replacing the first with the
 * second would erase the fact that the outcome was ever in doubt - which is exactly
 * the fact an audit needs.
 */
export function unknownBadges(input: {
  resolutionOutcome: OpenClawUnknownResolutionOutcome | null;
}): readonly string[] {
  const badges = ["UNKNOWN"];
  if (input.resolutionOutcome !== null) badges.push(input.resolutionOutcome);
  return badges;
}

export type ResolutionFailure = "ALREADY_RESOLVED" | "PERMISSION_DENIED" | "STALE_EVIDENCE" | "UNKNOWN";

/**
 * What a failed resolution means.
 *
 * 40001 is the interesting one: the resolution is one-time, so it means somebody
 * else resolved it first. The correct response is to show THEIR outcome, not to
 * retry - which is why the hook reloads the winner rather than surfacing an error.
 */
export function classifyResolutionFailure(error: unknown): ResolutionFailure {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === "40001") return "ALREADY_RESOLVED";
    if (code === "42501") return "PERMISSION_DENIED";
    if (code === "22023" || code === "55000") return "STALE_EVIDENCE";
  }
  return "UNKNOWN";
}
