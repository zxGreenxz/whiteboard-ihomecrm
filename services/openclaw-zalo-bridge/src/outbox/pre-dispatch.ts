/**
 * Outbound policy preflight.
 *
 * Precedence is fixed and is evaluated in this order, because a later rule must
 * never be able to re-enable something an earlier rule forbade:
 *
 *   GLOBAL_STOP -> channel pause -> takeover -> campaign cancellation ->
 *   consent/suppression -> group allowlist+freshness -> quiet hours ->
 *   warm-up -> rate ceilings
 */

export const PLATFORM_LIMITS = Object.freeze({
  minIntervalMs: 3_000,
  burst: 2,
  perHour: 30,
  perDay: 200,
  autoRepliesPerPeerPerHour: 10,
  recipientsPerApprovedBatch: 100,
  proactivePerPeerPerDay: 1,
  proactivePerPeerPerMonth: 4,
  quietHoursStartHour: 20,
  quietHoursEndHour: 8,
  warmUpHours: 72,
  warmUpFraction: 1 / 3,
  autoReplyDelayMinMs: 3_000,
  autoReplyDelayMaxMs: 8_000,
  maxTextCodePointsPerChunk: 2_000,
});

export type PolicyDenialReason =
  | "GLOBAL_STOP"
  | "CHANNEL_PAUSED"
  | "HUMAN_TAKEOVER"
  | "CAMPAIGN_CANCELLED"
  | "NO_CONSENT"
  | "SUPPRESSED"
  | "GROUP_NOT_ALLOWLISTED"
  | "GROUP_DIRECTORY_STALE"
  | "QUIET_HOURS"
  | "RATE_MIN_INTERVAL"
  | "RATE_BURST"
  | "RATE_HOURLY"
  | "RATE_DAILY"
  | "RATE_AUTO_REPLY_PEER_HOURLY"
  | "RATE_PROACTIVE_PEER_DAILY"
  | "RATE_PROACTIVE_PEER_MONTHLY"
  | "BATCH_TOO_LARGE"
  | "WARM_UP_LIMIT";

export type SendClass = "MANUAL" | "AUTO_REPLY" | "PROACTIVE" | "CAMPAIGN";

export interface PolicyInput {
  sendClass: SendClass;
  globalStop: boolean;
  channelPaused: boolean;
  humanTakeoverActive: boolean;
  campaignCancelled: boolean;
  hasConsent: boolean;
  suppressed: boolean;
  isGroupTarget: boolean;
  groupAllowlisted: boolean;
  groupDirectoryFreshMs: number;
  batchRecipientCount: number;
  /** Local wall-clock hour (0-23) in the organization's timezone. */
  localHour: number;
  msSinceLastSend: number;
  sendsInLastBurstWindow: number;
  sendsInLastHour: number;
  sendsInLastDay: number;
  autoRepliesToPeerInLastHour: number;
  proactiveToPeerToday: number;
  proactiveToPeerThisMonth: number;
  accountAgeHours: number;
}

export interface PolicyVerdict {
  allowed: boolean;
  reason?: PolicyDenialReason;
}

export const GROUP_DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function deny(reason: PolicyDenialReason): PolicyVerdict {
  return { allowed: false, reason };
}

export function isQuietHour(localHour: number): boolean {
  // 20:00 through 07:59 inclusive.
  return localHour >= PLATFORM_LIMITS.quietHoursStartHour ||
    localHour < PLATFORM_LIMITS.quietHoursEndHour;
}

/**
 * During the first 72 hours an account may use only one third of each ceiling,
 * rounded down, so a brand-new account cannot immediately look like a spammer.
 */
export function warmUpCeiling(limit: number, accountAgeHours: number): number {
  if (accountAgeHours >= PLATFORM_LIMITS.warmUpHours) return limit;
  return Math.floor(limit * PLATFORM_LIMITS.warmUpFraction);
}

export function evaluateSendPolicy(input: PolicyInput): PolicyVerdict {
  // Organization-scoped stop precedes every other decision.
  if (input.globalStop) return deny("GLOBAL_STOP");
  if (input.channelPaused) return deny("CHANNEL_PAUSED");
  if (input.humanTakeoverActive && input.sendClass !== "MANUAL") {
    return deny("HUMAN_TAKEOVER");
  }
  if (input.campaignCancelled) return deny("CAMPAIGN_CANCELLED");

  if (input.sendClass !== "MANUAL") {
    if (!input.hasConsent) return deny("NO_CONSENT");
    if (input.suppressed) return deny("SUPPRESSED");
  }

  if (input.isGroupTarget) {
    if (!input.groupAllowlisted) return deny("GROUP_NOT_ALLOWLISTED");
    if (input.groupDirectoryFreshMs > GROUP_DIRECTORY_MAX_AGE_MS) {
      return deny("GROUP_DIRECTORY_STALE");
    }
  }

  if (input.batchRecipientCount > PLATFORM_LIMITS.recipientsPerApprovedBatch) {
    return deny("BATCH_TOO_LARGE");
  }

  // Quiet hours never block a human typing in the inbox.
  if (input.sendClass !== "MANUAL" && isQuietHour(input.localHour)) {
    return deny("QUIET_HOURS");
  }

  if (input.msSinceLastSend < PLATFORM_LIMITS.minIntervalMs) {
    return deny("RATE_MIN_INTERVAL");
  }
  if (input.sendsInLastBurstWindow >= PLATFORM_LIMITS.burst) return deny("RATE_BURST");

  const hourly = warmUpCeiling(PLATFORM_LIMITS.perHour, input.accountAgeHours);
  const daily = warmUpCeiling(PLATFORM_LIMITS.perDay, input.accountAgeHours);
  if (input.sendsInLastHour >= hourly) {
    return deny(input.accountAgeHours < PLATFORM_LIMITS.warmUpHours ? "WARM_UP_LIMIT" : "RATE_HOURLY");
  }
  if (input.sendsInLastDay >= daily) {
    return deny(input.accountAgeHours < PLATFORM_LIMITS.warmUpHours ? "WARM_UP_LIMIT" : "RATE_DAILY");
  }

  if (
    input.sendClass === "AUTO_REPLY" &&
    input.autoRepliesToPeerInLastHour >= PLATFORM_LIMITS.autoRepliesPerPeerPerHour
  ) {
    return deny("RATE_AUTO_REPLY_PEER_HOURLY");
  }

  if (input.sendClass === "PROACTIVE") {
    if (input.proactiveToPeerToday >= PLATFORM_LIMITS.proactivePerPeerPerDay) {
      return deny("RATE_PROACTIVE_PEER_DAILY");
    }
    if (input.proactiveToPeerThisMonth >= PLATFORM_LIMITS.proactivePerPeerPerMonth) {
      return deny("RATE_PROACTIVE_PEER_MONTHLY");
    }
  }

  return { allowed: true };
}

/**
 * Splits text on Unicode code-point boundaries, never UTF-16 units, so astral
 * emoji and combining sequences are not cut in half. JavaScript, SQL, and the
 * vendored fork must agree on this exact boundary.
 */
export function chunkByCodePoints(
  text: string,
  maxCodePoints = PLATFORM_LIMITS.maxTextCodePointsPerChunk,
): string[] {
  if (maxCodePoints < 1) throw new RangeError("maxCodePoints must be positive");
  const codePoints = Array.from(text);
  if (codePoints.length === 0) return [];
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += maxCodePoints) {
    chunks.push(codePoints.slice(index, index + maxCodePoints).join(""));
  }
  return chunks;
}

export function countCodePoints(text: string): number {
  return Array.from(text).length;
}