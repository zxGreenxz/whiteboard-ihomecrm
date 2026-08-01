import { describe, expect, it } from "vitest";

import { evaluateAddress, type LocalTopology } from "../src/dns-policy.js";

describe("Globally routable address policy", () => {
  it("rejects the full IPv6 link-local range", () => {
    expect(evaluateAddress("fe80::1").denial).toBe("LINK_LOCAL");
    expect(evaluateAddress("fe9f::1").denial).toBe("LINK_LOCAL");
    expect(evaluateAddress("febf::1").denial).toBe("LINK_LOCAL");
  });

  it("rejects special-purpose IPv4 and IPv6 ranges", () => {
    expect(evaluateAddress("192.88.99.1").denial).toBe("RESERVED");
    expect(evaluateAddress("100::1").denial).toBe("RESERVED");
    expect(evaluateAddress("2002:c000:0201::1").denial).toBe("RESERVED");
  });

  it("rejects private IPv4 hidden in either mapped IPv6 spelling", () => {
    expect(evaluateAddress("::ffff:10.0.0.1").denial).toBe("PRIVATE");
    expect(evaluateAddress("::ffff:a00:1").denial).toBe("PRIVATE");
  });

  it("rejects IPv6 lateral-container destinations from configured CIDRs", () => {
    const topology: LocalTopology = {
      hostGatewayAddresses: [],
      containerNetworkCidrs: ["2001:4860:abcd::/64"],
    };
    expect(evaluateAddress("2001:4860:abcd::25", topology).denial)
      .toBe("LATERAL_CONTAINER");
  });

  it("allows ordinary public IPv4 and IPv6 addresses", () => {
    expect(evaluateAddress("8.8.8.8")).toEqual({ allowed: true });
    expect(evaluateAddress("2001:4860:4860::8888")).toEqual({ allowed: true });
  });
});
