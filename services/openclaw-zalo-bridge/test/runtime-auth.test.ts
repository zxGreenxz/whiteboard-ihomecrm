import { describe, expect, it } from "vitest";

import {
  CellWorkloadAuthenticator,
  signCellWorkloadRequest,
  type CellWorkloadBinding,
} from "../src/runtime-api/workload-auth.js";

const NOW = 1_785_062_400_000;
const secret = Buffer.from("cell-local-workload-secret-32-bytes-minimum", "utf8");
const binding: CellWorkloadBinding = {
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  cellId: "dddd2000-0000-4000-8000-000000000001",
  sessionGeneration: 5,
  fencingToken: 7,
};
const body = Buffer.from('{"version":1,"message":"hello"}', "utf8");

function headers(overrides: Partial<Parameters<typeof signCellWorkloadRequest>[0]> = {}) {
  return signCellWorkloadRequest({
    secret,
    binding,
    method: "POST",
    path: "/v1/inbound",
    body,
    timestampMs: NOW,
    nonce: "dddd7000-0000-4000-8000-000000000001",
    ...overrides,
  });
}

describe("cell-local workload authentication", () => {
  it("verifies an exact request and rejects replay", () => {
    const authenticator = new CellWorkloadAuthenticator({
      secret,
      binding,
      now: () => NOW,
    });

    expect(authenticator.verify({
      method: "POST",
      path: "/v1/inbound",
      body,
      headers: headers(),
    })).toEqual(binding);
    expect(() => authenticator.verify({
      method: "POST",
      path: "/v1/inbound",
      body,
      headers: headers(),
    })).toThrow(/replay/i);
  });

  it("binds bytes, route, session, fence, and clock without consuming bad nonces", () => {
    const authenticator = new CellWorkloadAuthenticator({
      secret,
      binding,
      now: () => NOW,
      maxClockSkewMs: 30_000,
    });
    const signed = headers();

    expect(() => authenticator.verify({
      method: "POST",
      path: "/v1/inbound",
      body: Buffer.from("tampered"),
      headers: signed,
    })).toThrow(/signature/i);
    expect(() => authenticator.verify({
      method: "POST",
      path: "/v1/other",
      body,
      headers: signed,
    })).toThrow(/signature/i);
    expect(() => authenticator.verify({
      method: "POST",
      path: "/v1/inbound",
      body,
      headers: headers({ timestampMs: NOW - 30_001 }),
    })).toThrow(/stale/i);
    expect(() => authenticator.verify({
      method: "POST",
      path: "/v1/inbound",
      body,
      headers: headers({ binding: { ...binding, fencingToken: 8 } }),
    })).toThrow(/fencing/i);

    expect(authenticator.verify({
      method: "POST",
      path: "/v1/inbound",
      body,
      headers: signed,
    })).toEqual(binding);
  });
});
