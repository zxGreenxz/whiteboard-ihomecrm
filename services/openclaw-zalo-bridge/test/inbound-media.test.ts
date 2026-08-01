import { describe, expect, it } from "vitest";

import {
  allResolvedAddressesAllowed,
  evaluateResolvedAddress,
} from "../src/media/ip-policy.js";
import {
  evaluateRedirectChain,
  isAllowedMediaHost,
  MAX_REDIRECTS,
} from "../src/media/redirect-policy.js";

const ALLOWLIST = ["zalo.me", "zaloapp.com", "zdn.vn"];

describe("Inbound media IP policy", () => {
  it("allows an ordinary public address", () => {
    expect(evaluateResolvedAddress("203.0.113.10").reason).toBe("RESERVED");
    expect(evaluateResolvedAddress("1.1.1.1")).toEqual({ allowed: true });
    expect(evaluateResolvedAddress("2606:4700:4700::1111")).toEqual({ allowed: true });
  });

  it("denies loopback, private, link-local, and metadata addresses", () => {
    expect(evaluateResolvedAddress("127.0.0.1").reason).toBe("LOOPBACK");
    expect(evaluateResolvedAddress("10.1.2.3").reason).toBe("PRIVATE");
    expect(evaluateResolvedAddress("172.16.0.1").reason).toBe("PRIVATE");
    expect(evaluateResolvedAddress("172.32.0.1").allowed).toBe(true);
    expect(evaluateResolvedAddress("192.168.1.1").reason).toBe("PRIVATE");
    expect(evaluateResolvedAddress("169.254.1.1").reason).toBe("LINK_LOCAL");
    expect(evaluateResolvedAddress("169.254.169.254").reason).toBe("METADATA");
  });

  it("denies multicast, unspecified, carrier-grade NAT, and reserved space", () => {
    expect(evaluateResolvedAddress("224.0.0.1").reason).toBe("MULTICAST");
    expect(evaluateResolvedAddress("0.0.0.0").reason).toBe("UNSPECIFIED");
    expect(evaluateResolvedAddress("100.64.0.1").reason).toBe("RESERVED");
    expect(evaluateResolvedAddress("240.0.0.1").reason).toBe("RESERVED");
  });

  it("denies IPv6 loopback, link-local, unique-local, and multicast", () => {
    expect(evaluateResolvedAddress("::1").reason).toBe("LOOPBACK");
    expect(evaluateResolvedAddress("fe80::1").reason).toBe("LINK_LOCAL");
    expect(evaluateResolvedAddress("fd00::1").reason).toBe("UNIQUE_LOCAL");
    expect(evaluateResolvedAddress("fc00::1").reason).toBe("UNIQUE_LOCAL");
    expect(evaluateResolvedAddress("ff02::1").reason).toBe("MULTICAST");
    expect(evaluateResolvedAddress("::").reason).toBe("UNSPECIFIED");
  });

  it("judges IPv4-mapped IPv6 by the IPv4 rules so mapping cannot bypass policy", () => {
    expect(evaluateResolvedAddress("::ffff:127.0.0.1").reason).toBe("LOOPBACK");
    expect(evaluateResolvedAddress("::ffff:169.254.169.254").reason).toBe("METADATA");
    expect(evaluateResolvedAddress("::ffff:10.0.0.1").reason).toBe("PRIVATE");
  });

  it("rejects a garbage address rather than defaulting to allow", () => {
    expect(evaluateResolvedAddress("not-an-ip").reason).toBe("INVALID_ADDRESS");
    expect(evaluateResolvedAddress("").reason).toBe("INVALID_ADDRESS");
  });

  it("requires every resolved address to pass, not just the first", () => {
    expect(allResolvedAddressesAllowed(["1.1.1.1", "127.0.0.1"]).reason).toBe("LOOPBACK");
    expect(allResolvedAddressesAllowed(["1.1.1.1", "8.8.8.8"])).toEqual({ allowed: true });
    expect(allResolvedAddressesAllowed([]).reason).toBe("INVALID_ADDRESS");
  });
});

describe("Inbound media redirect policy", () => {
  it("allows an exact host or a subdomain of an allowlisted host", () => {
    expect(isAllowedMediaHost("zalo.me", ALLOWLIST)).toBe(true);
    expect(isAllowedMediaHost("cdn.zalo.me", ALLOWLIST)).toBe(true);
    expect(isAllowedMediaHost("evil.com", ALLOWLIST)).toBe(false);
    expect(isAllowedMediaHost("notzalo.me", ALLOWLIST)).toBe(false);
  });

  it("caps the redirect chain at three hops", () => {
    const chain = (count: number) =>
      Array.from({ length: count + 1 }, (_unused, index) => `https://cdn.zalo.me/${index}`);
    expect(evaluateRedirectChain(chain(MAX_REDIRECTS), ALLOWLIST).allowed).toBe(true);
    expect(evaluateRedirectChain(chain(MAX_REDIRECTS + 1), ALLOWLIST).reason)
      .toBe("TOO_MANY_REDIRECTS");
  });

  it("revalidates the scheme at every hop", () => {
    expect(
      evaluateRedirectChain(
        ["https://cdn.zalo.me/a", "http://cdn.zalo.me/b"],
        ALLOWLIST,
      ).reason,
    ).toBe("SCHEME_DOWNGRADE");
  });

  it("revalidates the host at every hop, not just the first", () => {
    expect(
      evaluateRedirectChain(
        ["https://cdn.zalo.me/a", "https://evil.example/b"],
        ALLOWLIST,
      ).reason,
    ).toBe("HOST_NOT_ALLOWED");
  });

  it("rejects credentials embedded in a redirect target", () => {
    expect(
      evaluateRedirectChain(["https://user:pass@cdn.zalo.me/a"], ALLOWLIST).reason,
    ).toBe("INVALID_URL");
  });
});