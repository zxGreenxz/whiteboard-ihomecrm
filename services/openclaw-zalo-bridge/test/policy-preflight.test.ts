import { describe, expect, it } from "vitest";

import {
  chunkByCodePoints,
  countCodePoints,
  evaluateSendPolicy,
  GROUP_DIRECTORY_MAX_AGE_MS,
  isQuietHour,
  PLATFORM_LIMITS,
  warmUpCeiling,
} from "../src/outbox/pre-dispatch.js";

function policy(overrides: Record<string, unknown> = {}) {
  return evaluateSendPolicy({
    sendClass: "AUTO_REPLY",
    globalStop: false,
    channelPaused: false,
    humanTakeoverActive: false,
    campaignCancelled: false,
    hasConsent: true,
    suppressed: false,
    isGroupTarget: false,
    groupAllowlisted: true,
    groupDirectoryFreshMs: 0,
    batchRecipientCount: 1,
    localHour: 10,
    msSinceLastSend: 60_000,
    sendsInLastBurstWindow: 0,
    sendsInLastHour: 0,
    sendsInLastDay: 0,
    autoRepliesToPeerInLastHour: 0,
    proactiveToPeerToday: 0,
    proactiveToPeerThisMonth: 0,
    accountAgeHours: 1_000,
    ...overrides,
  } as Parameters<typeof evaluateSendPolicy>[0]);
}

describe("Platform ceilings are frozen", () => {
  it("matches the exact approved limits", () => {
    expect(PLATFORM_LIMITS.minIntervalMs).toBe(3_000);
    expect(PLATFORM_LIMITS.burst).toBe(2);
    expect(PLATFORM_LIMITS.perHour).toBe(30);
    expect(PLATFORM_LIMITS.perDay).toBe(200);
    expect(PLATFORM_LIMITS.autoRepliesPerPeerPerHour).toBe(10);
    expect(PLATFORM_LIMITS.recipientsPerApprovedBatch).toBe(100);
    expect(PLATFORM_LIMITS.proactivePerPeerPerDay).toBe(1);
    expect(PLATFORM_LIMITS.proactivePerPeerPerMonth).toBe(4);
    expect(PLATFORM_LIMITS.quietHoursStartHour).toBe(20);
    expect(PLATFORM_LIMITS.quietHoursEndHour).toBe(8);
    expect(PLATFORM_LIMITS.warmUpHours).toBe(72);
    expect(PLATFORM_LIMITS.autoReplyDelayMinMs).toBe(3_000);
    expect(PLATFORM_LIMITS.autoReplyDelayMaxMs).toBe(8_000);
    expect(PLATFORM_LIMITS.maxTextCodePointsPerChunk).toBe(2_000);
  });
});

describe("Policy precedence", () => {
  it("allows an ordinary auto reply", () => {
    expect(policy()).toEqual({ allowed: true });
  });

  it("puts GLOBAL_STOP ahead of every other decision", () => {
    expect(
      policy({
        globalStop: true,
        channelPaused: true,
        humanTakeoverActive: true,
        hasConsent: false,
      }).reason,
    ).toBe("GLOBAL_STOP");
  });

  it("orders channel pause, takeover, and campaign cancellation next", () => {
    expect(policy({ channelPaused: true, humanTakeoverActive: true }).reason)
      .toBe("CHANNEL_PAUSED");
    expect(policy({ humanTakeoverActive: true, campaignCancelled: true }).reason)
      .toBe("HUMAN_TAKEOVER");
    expect(policy({ campaignCancelled: true, hasConsent: false }).reason)
      .toBe("CAMPAIGN_CANCELLED");
  });

  it("lets a human keep replying during takeover and quiet hours", () => {
    expect(policy({ sendClass: "MANUAL", humanTakeoverActive: true })).toEqual({ allowed: true });
    expect(policy({ sendClass: "MANUAL", localHour: 23 })).toEqual({ allowed: true });
  });

  it("requires consent and no suppression for automated classes", () => {
    expect(policy({ hasConsent: false }).reason).toBe("NO_CONSENT");
    expect(policy({ suppressed: true }).reason).toBe("SUPPRESSED");
    expect(policy({ sendClass: "MANUAL", hasConsent: false })).toEqual({ allowed: true });
  });

  it("requires an allowlisted and fresh group directory", () => {
    expect(policy({ isGroupTarget: true, groupAllowlisted: false }).reason)
      .toBe("GROUP_NOT_ALLOWLISTED");
    expect(
      policy({ isGroupTarget: true, groupDirectoryFreshMs: GROUP_DIRECTORY_MAX_AGE_MS + 1 }).reason,
    ).toBe("GROUP_DIRECTORY_STALE");
    expect(policy({ isGroupTarget: true, groupDirectoryFreshMs: GROUP_DIRECTORY_MAX_AGE_MS }))
      .toEqual({ allowed: true });
  });

  it("caps an approved batch at one hundred recipients", () => {
    expect(policy({ batchRecipientCount: 100 })).toEqual({ allowed: true });
    expect(policy({ batchRecipientCount: 101 }).reason).toBe("BATCH_TOO_LARGE");
  });
});

describe("Quiet hours", () => {
  it("covers 20:00 through 07:59", () => {
    for (const hour of [20, 21, 23, 0, 3, 7]) {
      expect(isQuietHour(hour), String(hour)).toBe(true);
    }
    for (const hour of [8, 9, 12, 19]) {
      expect(isQuietHour(hour), String(hour)).toBe(false);
    }
  });

  it("blocks automated sends inside quiet hours", () => {
    expect(policy({ localHour: 21 }).reason).toBe("QUIET_HOURS");
    expect(policy({ localHour: 8 })).toEqual({ allowed: true });
  });
});

describe("Rate ceilings", () => {
  it("enforces the minimum interval and burst", () => {
    expect(policy({ msSinceLastSend: 2_999 }).reason).toBe("RATE_MIN_INTERVAL");
    expect(policy({ msSinceLastSend: 3_000 })).toEqual({ allowed: true });
    expect(policy({ sendsInLastBurstWindow: 2 }).reason).toBe("RATE_BURST");
  });

  it("enforces hourly and daily ceilings", () => {
    expect(policy({ sendsInLastHour: 29 })).toEqual({ allowed: true });
    expect(policy({ sendsInLastHour: 30 }).reason).toBe("RATE_HOURLY");
    expect(policy({ sendsInLastDay: 200 }).reason).toBe("RATE_DAILY");
  });

  it("enforces the per-peer auto-reply ceiling", () => {
    expect(policy({ autoRepliesToPeerInLastHour: 9 })).toEqual({ allowed: true });
    expect(policy({ autoRepliesToPeerInLastHour: 10 }).reason)
      .toBe("RATE_AUTO_REPLY_PEER_HOURLY");
  });

  it("enforces proactive per-peer daily and monthly ceilings", () => {
    expect(policy({ sendClass: "PROACTIVE", localHour: 10, proactiveToPeerToday: 1 }).reason)
      .toBe("RATE_PROACTIVE_PEER_DAILY");
    expect(
      policy({ sendClass: "PROACTIVE", localHour: 10, proactiveToPeerThisMonth: 4 }).reason,
    ).toBe("RATE_PROACTIVE_PEER_MONTHLY");
    expect(policy({ sendClass: "PROACTIVE", localHour: 10 })).toEqual({ allowed: true });
  });
});

describe("Warm-up window", () => {
  it("caps a new account at one third of each ceiling", () => {
    expect(warmUpCeiling(30, 0)).toBe(10);
    expect(warmUpCeiling(200, 0)).toBe(66);
    expect(warmUpCeiling(30, 72)).toBe(30);
    expect(warmUpCeiling(200, 72)).toBe(200);
  });

  it("denies with WARM_UP_LIMIT inside the first seventy-two hours", () => {
    expect(policy({ accountAgeHours: 10, sendsInLastHour: 10 }).reason).toBe("WARM_UP_LIMIT");
    expect(policy({ accountAgeHours: 72, sendsInLastHour: 10 })).toEqual({ allowed: true });
  });
});

describe("Text chunking on code-point boundaries", () => {
  it("splits at exactly two thousand code points", () => {
    const text = "a".repeat(4_001);
    const chunks = chunkByCodePoints(text);
    expect(chunks).toHaveLength(3);
    expect(countCodePoints(chunks[0]!)).toBe(2_000);
    expect(countCodePoints(chunks[1]!)).toBe(2_000);
    expect(countCodePoints(chunks[2]!)).toBe(1);
  });

  it("never splits an astral emoji into surrogate halves", () => {
    const emoji = "\u{1F600}";
    const text = emoji.repeat(2_001);
    const chunks = chunkByCodePoints(text);

    expect(chunks).toHaveLength(2);
    expect(countCodePoints(chunks[0]!)).toBe(2_000);
    // If the split had used UTF-16 units the first chunk would end with a lone
    // high surrogate and this reassembly would not match.
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
  });

  it("counts code points, not UTF-16 units or UTF-8 bytes", () => {
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);
    expect(countCodePoints(emoji)).toBe(1);
    expect(new TextEncoder().encode(emoji).byteLength).toBe(4);
  });

  it("keeps a combining sequence together when it fits in a chunk", () => {
    const combining = "e\u0301";
    expect(countCodePoints(combining)).toBe(2);
    expect(chunkByCodePoints(combining, 2)).toEqual([combining]);
  });

  it("returns no chunks for empty text", () => {
    expect(chunkByCodePoints("")).toEqual([]);
  });
});