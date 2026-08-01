import { describe, expect, it } from "vitest";

import {
  evaluateDestination,
  parseAllowlist,
  parseAllowlistDocument,
  type AllowlistEntry,
} from "../src/allowlist.js";

const ALLOWLIST: AllowlistEntry[] = parseAllowlist([
  { host: "tryymsxyyckgbrmmvozx.supabase.co", port: 443, purpose: "supabase" },
  { host: "openclaw-media.chillhome.io.vn", port: 443, purpose: "media gateway" },
  { host: "ai.chillhome.io.vn", port: 443, purpose: "model provider" },
  { host: "chat.zalo.me", port: 443, purpose: "zalo" },
]);

describe("Allowlist parsing", () => {
  it("accepts exact reviewed FQDN and port entries", () => {
    expect(ALLOWLIST).toHaveLength(4);
    expect(ALLOWLIST[0]?.host).toBe("tryymsxyyckgbrmmvozx.supabase.co");
  });

  it("refuses a wildcard host at parse time", () => {
    expect(() => parseAllowlist([{ host: "*.zalo.me", port: 443, purpose: "x" }]))
      .toThrow(/wildcard/i);
  });

  it("refuses an IP literal in the allowlist", () => {
    expect(() => parseAllowlist([{ host: "1.2.3.4", port: 443, purpose: "x" }])).toThrow();
    expect(() => parseAllowlist([{ host: "::1", port: 443, purpose: "x" }])).toThrow();
  });

  it("refuses an invalid port or a missing purpose", () => {
    expect(() => parseAllowlist([{ host: "a.example", port: 0, purpose: "x" }])).toThrow();
    expect(() => parseAllowlist([{ host: "a.example", port: 70_000, purpose: "x" }])).toThrow();
    expect(() => parseAllowlist([{ host: "a.example", port: 443, purpose: "" }])).toThrow();
  });

  it("requires canonical multi-label FQDNs", () => {
    expect(() => parseAllowlist([{ host: "localhost", port: 443, purpose: "x" }])).toThrow();
    expect(() => parseAllowlist([{ host: "bad-.example", port: 443, purpose: "x" }])).toThrow();
    expect(() => parseAllowlist([{ host: "bad.example.", port: 443, purpose: "x" }])).toThrow();
  });

  it("refuses duplicate FQDN and port entries", () => {
    expect(() => parseAllowlist([
      { host: "api.example.com", port: 443, purpose: "first" },
      { host: "API.EXAMPLE.COM", port: 443, purpose: "duplicate" },
    ])).toThrow(/duplicate/i);
  });

  it("parses only the closed versioned allowlist document", () => {
    expect(parseAllowlistDocument({
      version: 1,
      destinations: [{ host: "api.example.com", port: 443, purpose: "api" }],
    })).toEqual([{ host: "api.example.com", port: 443, purpose: "api" }]);
    expect(() => parseAllowlistDocument({ version: 2, destinations: [] })).toThrow(/version/i);
    expect(() => parseAllowlistDocument({ version: 1, destinations: [], wildcard: true }))
      .toThrow(/unknown/i);
  });

  it("rejects coerced values and unknown entry fields", () => {
    expect(() => parseAllowlist([
      { host: "api.example.com", port: "443", purpose: "api" },
    ])).toThrow(/port/i);
    expect(() => parseAllowlist([
      { host: "api.example.com", port: 443, purpose: 7 },
    ])).toThrow(/purpose/i);
    expect(() => parseAllowlist([
      { host: "api.example.com", port: 443, purpose: "api", wildcard: false },
    ])).toThrow(/unknown/i);
  });
});

describe("Destination evaluation", () => {
  it("allows an exact allowlisted host and port", () => {
    const verdict = evaluateDestination("ai.chillhome.io.vn", 443, ALLOWLIST);
    expect(verdict.allowed).toBe(true);
    expect(verdict.entry?.purpose).toBe("model provider");
  });

  it("does not imply subdomains of an allowlisted host", () => {
    expect(evaluateDestination("evil.ai.chillhome.io.vn", 443, ALLOWLIST).denial)
      .toBe("HOST_NOT_ALLOWED");
  });

  it("refuses an allowlisted host on a different port", () => {
    expect(evaluateDestination("ai.chillhome.io.vn", 80, ALLOWLIST).denial)
      .toBe("PORT_NOT_ALLOWED");
  });

  it("refuses an IP literal destination outright", () => {
    expect(evaluateDestination("1.1.1.1", 443, ALLOWLIST).denial).toBe("IP_LITERAL_FORBIDDEN");
    expect(evaluateDestination("[::1]", 443, ALLOWLIST).denial).toBe("IP_LITERAL_FORBIDDEN");
  });

  it("refuses a wildcard or malformed destination", () => {
    expect(evaluateDestination("*.zalo.me", 443, ALLOWLIST).denial).toBe("WILDCARD_FORBIDDEN");
    expect(evaluateDestination("", 443, ALLOWLIST).denial).toBe("MALFORMED_HOST");
    expect(evaluateDestination("bad_host!", 443, ALLOWLIST).denial).toBe("MALFORMED_HOST");
  });

  it("refuses anything not in the reviewed list, including a plausible lookalike", () => {
    expect(evaluateDestination("supabase.co", 443, ALLOWLIST).denial).toBe("HOST_NOT_ALLOWED");
    expect(evaluateDestination("ai.chillhome.io.vn.evil.example", 443, ALLOWLIST).denial)
      .toBe("HOST_NOT_ALLOWED");
  });
});
