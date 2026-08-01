import { describe, expect, it } from "vitest";

import {
  evaluateAddress,
  pinnedAddressIsStillValid,
  resolveAndPin,
  type LocalTopology,
} from "../src/dns-policy.js";
import { redactConnectTarget, redactHeaders, redactLogLine } from "../src/redaction.js";

const topology: LocalTopology = {
  hostGatewayAddresses: ["172.17.0.1"],
  containerNetworkCidrs: ["172.20.0.0/16"],
};

describe("Private and reserved range denial", () => {
  it("allows a genuinely public address", () => {
    expect(evaluateAddress("1.1.1.1")).toEqual({ allowed: true });
    expect(evaluateAddress("2606:4700:4700::1111")).toEqual({ allowed: true });
  });

  it("denies loopback, private, link-local, CGNAT, and metadata", () => {
    expect(evaluateAddress("127.0.0.1").denial).toBe("LOOPBACK");
    expect(evaluateAddress("10.0.0.5").denial).toBe("PRIVATE");
    expect(evaluateAddress("192.168.5.5").denial).toBe("PRIVATE");
    expect(evaluateAddress("169.254.1.1").denial).toBe("LINK_LOCAL");
    expect(evaluateAddress("169.254.169.254").denial).toBe("METADATA");
    expect(evaluateAddress("100.64.1.1").denial).toBe("CGNAT");
  });

  it("denies multicast, unspecified, documentation, and reserved space", () => {
    expect(evaluateAddress("224.0.0.1").denial).toBe("MULTICAST");
    expect(evaluateAddress("0.0.0.0").denial).toBe("UNSPECIFIED");
    expect(evaluateAddress("203.0.113.5").denial).toBe("DOCUMENTATION");
    expect(evaluateAddress("198.51.100.5").denial).toBe("DOCUMENTATION");
    expect(evaluateAddress("240.0.0.1").denial).toBe("RESERVED");
  });

  it("denies IPv6 loopback, link-local, unique-local, and documentation", () => {
    expect(evaluateAddress("::1").denial).toBe("LOOPBACK");
    expect(evaluateAddress("fe80::1").denial).toBe("LINK_LOCAL");
    expect(evaluateAddress("fd00::1").denial).toBe("UNIQUE_LOCAL");
    expect(evaluateAddress("2001:db8::1").denial).toBe("DOCUMENTATION");
  });

  it("denies an IPv4-mapped IPv6 that hides a private address", () => {
    expect(evaluateAddress("::ffff:10.0.0.1").denial).toBe("PRIVATE");
    expect(evaluateAddress("::ffff:169.254.169.254").denial).toBe("METADATA");
  });

  it("denies the host gateway and lateral container addresses", () => {
    expect(evaluateAddress("172.17.0.1", topology).denial).toBe("HOST_GATEWAY");
    expect(evaluateAddress("172.20.3.4", topology).denial).toBe("LATERAL_CONTAINER");
    // Outside the container CIDR the ordinary private rule still applies.
    expect(evaluateAddress("172.21.3.4", topology).denial).toBe("PRIVATE");
  });
});

describe("Resolve and pin", () => {
  it("pins the first address when every answer is acceptable", () => {
    const result = resolveAndPin("ai.chillhome.io.vn", ["1.1.1.1", "8.8.8.8"]);
    expect(result.ok).toBe(true);
    expect(result.resolution?.pinnedAddress).toBe("1.1.1.1");
  });

  it("rejects the whole resolution when any answer is private", () => {
    const result = resolveAndPin("evil.example", ["1.1.1.1", "127.0.0.1"]);
    expect(result.ok).toBe(false);
    expect(result.denial).toBe("LOOPBACK");
  });

  it("rejects an empty resolution rather than defaulting to allow", () => {
    expect(resolveAndPin("nowhere.example", []).denial).toBe("NO_ADDRESSES");
  });

  it("invalidates a pin when a retry resolves to a different address", () => {
    const result = resolveAndPin("ai.chillhome.io.vn", ["1.1.1.1"]);
    const pinned = result.resolution!;

    // Classic rebinding: the second answer drops the public address entirely.
    expect(pinnedAddressIsStillValid(pinned, "ai.chillhome.io.vn", ["10.0.0.5"])).toBe(false);
    expect(pinnedAddressIsStillValid(pinned, "ai.chillhome.io.vn", ["1.1.1.1"])).toBe(true);
  });

  it("invalidates a pin when a fresh answer also contains a forbidden address", () => {
    const pinned = resolveAndPin("ai.chillhome.io.vn", ["1.1.1.1"]).resolution!;
    expect(
      pinnedAddressIsStillValid(pinned, "ai.chillhome.io.vn", ["1.1.1.1", "10.0.0.5"]),
    ).toBe(false);
  });

  it("invalidates a pin reused for a different host after a redirect", () => {
    const pinned = resolveAndPin("ai.chillhome.io.vn", ["1.1.1.1"]).resolution!;
    expect(pinnedAddressIsStillValid(pinned, "other.example", ["1.1.1.1"])).toBe(false);
  });
});

describe("Broker log redaction", () => {
  it("redacts proxy and authorization headers", () => {
    expect(
      redactHeaders({
        "proxy-authorization": "Basic abc",
        authorization: "Bearer xyz",
        "x-openclaw-credential": "root-secret",
        host: "ai.chillhome.io.vn",
      }),
    ).toEqual({
      "proxy-authorization": "[REDACTED]",
      authorization: "[REDACTED]",
      "x-openclaw-credential": "[REDACTED]",
      host: "ai.chillhome.io.vn",
    });
  });

  it("strips credentials from a CONNECT target and a log line", () => {
    expect(redactConnectTarget("https://user:pass@ai.chillhome.io.vn:443"))
      .toBe("https://[REDACTED]@ai.chillhome.io.vn:443");
    expect(redactLogLine("proxy-authorization: Basic abc")).toContain("[REDACTED]");
    expect(redactLogLine("token eyJhbGciOiJI.eyJzdWIiOiJ4.signature")).toContain("[REDACTED_JWT]");
  });

  it("does not retain any proxy credential value in a redacted log line", () => {
    const redacted = redactLogLine(
      "Proxy-Authorization: Basic cHJveHktdXNlcjpzdXBlci1zZWNyZXQ=",
    );
    expect(redacted).toBe("Proxy-Authorization: [REDACTED]");
    expect(redacted).not.toContain("cHJveHktdXNlcjpzdXBlci1zZWNyZXQ=");
    expect(redactConnectTarget("proxy-user:proxy-pass@ai.chillhome.io.vn:443"))
      .toBe("[REDACTED]@ai.chillhome.io.vn:443");
  });
});
