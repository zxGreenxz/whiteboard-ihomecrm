import { describe, expect, it } from "vitest";

import { TicketStateStore, type TicketStateStorage } from "../src/ticket-state";

function memoryStorage(): TicketStateStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(map.delete(key)),
  };
}

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const JTI = "dddd7000-0000-4000-8000-000000000001";
const WORK_CLAIM_ID = "dddd8000-0000-4000-8000-000000000001";

describe("TicketState one-use tickets", () => {
  it("consumes a jti exactly once", async () => {
    const store = new TicketStateStore(memoryStorage());
    expect(await store.consumeJti(JTI, 1_785_062_460)).toBe(true);
    expect(await store.consumeJti(JTI, 1_785_062_460)).toBe(false);
    expect(await store.consumeJti(JTI, 1_785_062_460)).toBe(false);
  });

  it("consumes a revocation nonce exactly once", async () => {
    const store = new TicketStateStore(memoryStorage());
    expect(await store.consumeRevocationNonce("nonce-1", 1)).toBe(true);
    expect(await store.consumeRevocationNonce("nonce-1", 1)).toBe(false);
  });
});

describe("TicketState generation floor", () => {
  const key = { organizationId: ORGANIZATION_ID, accountId: ACCOUNT_ID };

  it("starts at zero and only ever moves forward", async () => {
    const store = new TicketStateStore(memoryStorage());
    expect(await store.minimumGeneration(key)).toBe(0);

    expect(await store.raiseMinimumGeneration(key, 5)).toBe(5);
    expect(await store.raiseMinimumGeneration(key, 3)).toBe(5);
    expect(await store.raiseMinimumGeneration(key, 5)).toBe(5);
    expect(await store.raiseMinimumGeneration(key, 6)).toBe(6);
    expect(await store.minimumGeneration(key)).toBe(6);
  });

  it("denies every older ticket immediately after a disconnect raises the floor", async () => {
    const store = new TicketStateStore(memoryStorage());
    expect(await store.isGenerationCurrent(key, 4)).toBe(true);

    await store.raiseMinimumGeneration(key, 5);

    expect(await store.isGenerationCurrent(key, 4)).toBe(false);
    expect(await store.isGenerationCurrent(key, 5)).toBe(true);
    expect(await store.isGenerationCurrent(key, 6)).toBe(true);
  });

  it("keeps separate floors per organization and account", async () => {
    const store = new TicketStateStore(memoryStorage());
    const other = { organizationId: ORGANIZATION_ID, accountId: "dddd1000-0000-4000-8000-000000000002" };
    const maintenance = { organizationId: ORGANIZATION_ID, accountId: null };

    await store.raiseMinimumGeneration(key, 9);

    expect(await store.minimumGeneration(other)).toBe(0);
    expect(await store.minimumGeneration(maintenance)).toBe(0);
  });

  it("refuses a nonsensical generation value", async () => {
    const store = new TicketStateStore(memoryStorage());
    await expect(store.raiseMinimumGeneration(key, -1)).rejects.toThrow();
    await expect(store.raiseMinimumGeneration(key, 1.5)).rejects.toThrow();
  });
});

describe("TicketState retention state machine", () => {
  const receipt = {
    canonicalJson: '{"version":1,"outcome":"DELETED"}',
    signature: "s".repeat(86),
    sha256: "a".repeat(64),
  };

  it("advances AUTHORIZED -> DELETE_IN_PROGRESS -> RECEIPT_STORED", async () => {
    const store = new TicketStateStore(memoryStorage());
    await store.markAuthorized(WORK_CLAIM_ID);
    expect((await store.workState(WORK_CLAIM_ID))?.phase).toBe("AUTHORIZED");

    await store.markDeleteInProgress(WORK_CLAIM_ID);
    expect((await store.workState(WORK_CLAIM_ID))?.phase).toBe("DELETE_IN_PROGRESS");

    await store.storeReceipt(WORK_CLAIM_ID, receipt);
    const stored = await store.workState(WORK_CLAIM_ID);
    expect(stored?.phase).toBe("RECEIPT_STORED");
    expect(stored?.receipt).toEqual(receipt);
  });

  it("returns identical receipt bytes after a lost response", async () => {
    const store = new TicketStateStore(memoryStorage());
    await store.markAuthorized(WORK_CLAIM_ID);
    await store.markDeleteInProgress(WORK_CLAIM_ID);
    const first = await store.storeReceipt(WORK_CLAIM_ID, receipt);

    const replacement = {
      canonicalJson: '{"version":1,"outcome":"NOT_FOUND"}',
      signature: "z".repeat(86),
      sha256: "b".repeat(64),
    };
    const second = await store.storeReceipt(WORK_CLAIM_ID, replacement);

    expect(second).toEqual(first);
    expect(second.signature).toBe(receipt.signature);
  });

  it("never regresses out of RECEIPT_STORED after a crash and retry", async () => {
    const store = new TicketStateStore(memoryStorage());
    await store.markAuthorized(WORK_CLAIM_ID);
    await store.markDeleteInProgress(WORK_CLAIM_ID);
    await store.storeReceipt(WORK_CLAIM_ID, receipt);

    await store.markDeleteInProgress(WORK_CLAIM_ID);
    await store.markAuthorized(WORK_CLAIM_ID);

    const state = await store.workState(WORK_CLAIM_ID);
    expect(state?.phase).toBe("RECEIPT_STORED");
    expect(state?.receipt).toEqual(receipt);
  });

  it("keeps work claims isolated from each other", async () => {
    const store = new TicketStateStore(memoryStorage());
    await store.markAuthorized(WORK_CLAIM_ID);
    expect(await store.workState("dddd8000-0000-4000-8000-000000000002")).toBeUndefined();
  });
});