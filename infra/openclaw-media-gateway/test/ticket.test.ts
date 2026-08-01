import { describe, expect, it } from "vitest";

import { TicketStateStore, type TicketStateStorage } from "../src/ticket-state";
import { TicketStateDurableObject } from "../src/ticket-state-do";

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
    list: async <T>({ prefix, end, limit }: { prefix: string; end?: string; limit?: number }) =>
      new Map([...map.entries()]
        .filter(([key]) => key.startsWith(prefix) && (end === undefined || key < end))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, limit)
        .map(([key, value]) => [key, value as T])),
  };
}

function adversarialDurableState(): {
  state: DurableObjectState;
  armReadBarrier: (key: string, readers: number) => void;
} {
  const values = new Map<string, unknown>();
  let barrierKey: string | null = null;
  let barrierReaders = 0;
  let arrived = 0;
  let release: (() => void) | null = null;
  let transactionTail = Promise.resolve();

  const get = async <T>(key: string): Promise<T | undefined> => {
    const value = values.get(key) as T | undefined;
    if (key === barrierKey && barrierReaders > 0) {
      arrived += 1;
      if (arrived === barrierReaders) release?.();
      await new Promise<void>((resolve) => {
        if (arrived >= barrierReaders) resolve();
        else release = resolve;
      });
    }
    return value;
  };
  const storage = {
    get,
    put: async <T>(key: string, value: T) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
  };
  const transactionStorage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: storage.put,
    delete: storage.delete,
  };
  const state = {
    storage: {
      ...storage,
      transaction: async <T>(closure: (transaction: typeof storage) => Promise<T>) => {
        const previous = transactionTail;
        let unlock!: () => void;
        transactionTail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        try {
          return await closure(transactionStorage);
        } finally {
          unlock();
        }
      },
    },
  } as unknown as DurableObjectState;
  return {
    state,
    armReadBarrier: (key, readers) => {
      barrierKey = key;
      barrierReaders = readers;
      arrived = 0;
      release = null;
    },
  };
}

function crashInjectingDurableState(): {
  state: DurableObjectState;
  recover: () => void;
} {
  const values = new Map<string, unknown>();
  let injectCrash = true;
  const state = {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key),
      transaction: async <T>(closure: (transaction: TicketStateStorage) => Promise<T>) => {
        const staged = new Map(values);
        const transaction: TicketStateStorage = {
          get: async <V>(key: string) => staged.get(key) as V | undefined,
          put: async <V>(key: string, value: V) => {
            if (injectCrash && key.startsWith("work:")) throw new Error("simulated crash");
            staged.set(key, value);
          },
          delete: async (key: string) => staged.delete(key),
        };
        const result = await closure(transaction);
        values.clear();
        for (const [key, value] of staged) values.set(key, value);
        return result;
      },
    },
  } as unknown as DurableObjectState;
  return { state, recover: () => { injectCrash = false; } };
}

function stateRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://ticket-state.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const JTI = "dddd7000-0000-4000-8000-000000000001";
const WORK_CLAIM_ID = "dddd8000-0000-4000-8000-000000000001";
const ADMISSION = {
  principal: {
    organizationId: ORGANIZATION_ID,
    principalKind: "CHANNEL" as const,
    accountId: ACCOUNT_ID,
    cellId: "dddd2000-0000-4000-8000-000000000001",
    maintenancePrincipalId: null,
  },
  generations: {
    sessionGeneration: 5,
    credentialGeneration: 5,
    leaseGeneration: 5,
    fencingToken: 5,
  },
};

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

  it("atomically consumes a jti across concurrent durable-object requests", async () => {
    const fixture = adversarialDurableState();
    const durable = new TicketStateDurableObject(fixture.state);
    fixture.armReadBarrier(`jti:${JTI}`, 2);

    const responses = await Promise.all([
      durable.fetch(stateRequest("/consume-jti", { jti: JTI, expiresAtEpochSeconds: 10 })),
      durable.fetch(stateRequest("/consume-jti", { jti: JTI, expiresAtEpochSeconds: 10 })),
    ]);
    const consumed = await Promise.all(responses.map(async (response) =>
      (await response.json<{ consumed: boolean }>()).consumed
    ));

    expect(consumed.sort()).toEqual([false, true]);
  });

  it("garbage-collects expired JTI, nonce, and workflow records in bounded batches", async () => {
    const storage = memoryStorage();
    const store = new TicketStateStore(storage);
    await store.consumeJti(JTI, 10);
    await store.applyRevocation({
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL",
      accountId: ACCOUNT_ID,
      cellId: "dddd2000-0000-4000-8000-000000000001",
      maintenancePrincipalId: null,
      dimension: "SESSION",
    }, "dddd7000-0000-4000-8000-000000000009", 10, 5, "b".repeat(64), {
      acknowledgementHash: "c".repeat(64),
    });
    await store.beginWorkflow(
      WORK_CLAIM_ID,
      "a".repeat(64),
      "UPLOAD",
      [{ jti: "dddd7000-0000-4000-8000-000000000002", expiresAtEpochSeconds: 10 }],
    );

    expect(await store.pruneExpired(700_000, 2)).toBe(2);
    expect([...storage.map.keys()].filter((key) => key.startsWith("expiry:"))).toHaveLength(1);
    expect(await store.pruneExpired(700_000, 2)).toBe(1);
    expect([...storage.map.keys()].some((key) =>
      key.startsWith("jti:") || key.startsWith("nonce:") || key.startsWith("work:") ||
      key.startsWith("expiry:")
    )).toBe(false);
  });
});

describe("TicketState generation floor", () => {
  const channel = {
    organizationId: ORGANIZATION_ID,
    principalKind: "CHANNEL" as const,
    accountId: ACCOUNT_ID,
    cellId: "dddd2000-0000-4000-8000-000000000001",
    maintenancePrincipalId: null,
  };
  const key = { ...channel, dimension: "SESSION" as const };

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

  it("keeps floors isolated by principal and generation dimension", async () => {
    const store = new TicketStateStore(memoryStorage());
    const otherAccount = {
      ...key,
      accountId: "dddd1000-0000-4000-8000-000000000002",
    };
    const credential = { ...channel, dimension: "CREDENTIAL" as const };
    const maintenance = {
      organizationId: ORGANIZATION_ID,
      principalKind: "MAINTENANCE" as const,
      accountId: null,
      cellId: null,
      maintenancePrincipalId: "dddd3000-0000-4000-8000-000000000001",
      dimension: "CREDENTIAL" as const,
    };

    await store.raiseMinimumGeneration(key, 9);

    expect(await store.minimumGeneration(otherAccount)).toBe(0);
    expect(await store.minimumGeneration(credential)).toBe(0);
    expect(await store.minimumGeneration(maintenance)).toBe(0);
  });

  it("shares only the session floor across cells in one channel account", async () => {
    const store = new TicketStateStore(memoryStorage());
    await store.raiseMinimumGeneration(key, 9);
    await store.raiseMinimumGeneration({ ...channel, dimension: "CREDENTIAL" }, 7);

    const otherCell = { ...channel, cellId: "dddd2000-0000-4000-8000-000000000002" };
    const floors = await store.generationFloors(otherCell);

    expect(floors.sessionGeneration).toBe(9);
    expect(floors.credentialGeneration).toBe(0);
  });

  it("applies only the account SESSION floor to browser principals", async () => {
    const store = new TicketStateStore(memoryStorage());
    await store.raiseMinimumGeneration(key, 9);
    await store.raiseMinimumGeneration({ ...channel, dimension: "CREDENTIAL" }, 7);

    const floors = await store.generationFloors({ ...channel, cellId: null });

    expect(floors).toEqual({
      sessionGeneration: 9,
      credentialGeneration: 0,
      leaseGeneration: 0,
      fencingToken: 0,
    });
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

  it("refuses to tombstone after the object mutation lease deadline", async () => {
    const store = new TicketStateStore(memoryStorage());
    await expect(store.acquireObjectMutation("DELETE", "old-delete", 1_000, 100))
      .resolves.toMatchObject({ acquired: true });

    await expect(store.markObjectFinalDeleted("old-delete", 1_100))
      .rejects.toThrow("object mutation lease mismatch");
    await expect(store.acquireObjectMutation("DELETE", "new-delete", 1_100, 100))
      .resolves.toMatchObject({ acquired: true });
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

  it("binds a work id to one authenticated claim hash", async () => {
    const store = new TicketStateStore(memoryStorage());

    const bindings = [{ jti: JTI, expiresAtEpochSeconds: 10 }];
    const first = await store.beginWorkflow(
      WORK_CLAIM_ID, "a".repeat(64), "DELETE", bindings,
    );
    const retry = await store.beginWorkflow(
      WORK_CLAIM_ID, "a".repeat(64), "DELETE", bindings,
    );

    expect(first).toEqual(retry);
    await expect(
      store.beginWorkflow(WORK_CLAIM_ID, "b".repeat(64), "DELETE", bindings),
    ).rejects.toThrow("work claim mismatch");
  });

  it("checks generation floors for existing work and permits only stored-receipt replay", async () => {
    const store = new TicketStateStore(memoryStorage());
    const principal = {
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL" as const,
      accountId: ACCOUNT_ID,
      cellId: "dddd2000-0000-4000-8000-000000000001",
      maintenancePrincipalId: null,
    };
    const admission = {
      principal,
      generations: {
        sessionGeneration: 5,
        credentialGeneration: 5,
        leaseGeneration: 5,
        fencingToken: 5,
      },
    };
    const claimHash = "a".repeat(64);
    const bindings = [{ jti: JTI, expiresAtEpochSeconds: 1_785_062_460 }];

    await store.beginWorkflow(WORK_CLAIM_ID, claimHash, "UPLOAD", bindings, admission);
    await store.raiseMinimumGeneration({ ...principal, dimension: "CREDENTIAL" }, 6);

    await expect(store.beginWorkflow(
      WORK_CLAIM_ID, claimHash, "UPLOAD", bindings, admission,
    )).rejects.toThrow("ticket generation revoked");
    await store.storeWorkReceipt(WORK_CLAIM_ID, claimHash, receipt);
    await expect(store.beginWorkflow(
      WORK_CLAIM_ID, claimHash, "UPLOAD", bindings, admission,
    )).resolves.toMatchObject({ phase: "RECEIPT_STORED", claimHash });
    await expect(store.beginWorkflow(
      WORK_CLAIM_ID,
      "b".repeat(64),
      "UPLOAD",
      [{ jti: "dddd7000-0000-4000-8000-000000000003", expiresAtEpochSeconds: 1_785_062_460 }],
      admission,
      false,
      claimHash,
    )).rejects.toThrow("work claim mismatch");
    await expect(store.beginWorkflow(
      `${WORK_CLAIM_ID}-new`, claimHash, "UPLOAD",
      [{ jti: "dddd7000-0000-4000-8000-000000000002", expiresAtEpochSeconds: 1_785_062_460 }],
      admission,
    )).rejects.toThrow("ticket generation revoked");
  });

  it("permits stale admission only for an exact DELETE_IN_PROGRESS workflow", async () => {
    const store = new TicketStateStore(memoryStorage());
    const claimHash = "a".repeat(64);
    const bindings = [{ jti: JTI, expiresAtEpochSeconds: 1_785_062_460 }];
    await store.beginWorkflow(
      WORK_CLAIM_ID,
      claimHash,
      "DELETE",
      bindings,
      ADMISSION,
      false,
      claimHash,
    );
    await store.raiseMinimumGeneration({ ...ADMISSION.principal, dimension: "LEASE" }, 6);

    await expect(store.beginWorkflow(
      WORK_CLAIM_ID,
      claimHash,
      "DELETE",
      bindings,
      ADMISSION,
      true,
      claimHash,
    )).rejects.toThrow("ticket generation revoked");

    await store.markWorkInProgress(WORK_CLAIM_ID, claimHash, {});
    await expect(store.beginWorkflow(
      WORK_CLAIM_ID,
      claimHash,
      "DELETE",
      bindings,
      ADMISSION,
      true,
      claimHash,
    )).resolves.toMatchObject({ phase: "DELETE_IN_PROGRESS" });
  });

  it("can atomically create DELETE work in progress after external preconditions pass", async () => {
    const store = new TicketStateStore(memoryStorage());
    const claimHash = "a".repeat(64);

    const work = await store.beginWorkflow(
      WORK_CLAIM_ID,
      claimHash,
      "DELETE",
      [{ jti: JTI, expiresAtEpochSeconds: 10 }],
      { ...ADMISSION, nowEpochSeconds: 1 },
      false,
      claimHash,
      "NONE",
      [],
      "DELETE_IN_PROGRESS",
    );

    expect(work).toMatchObject({ phase: "DELETE_IN_PROGRESS", claimHash });
  });

  it("never recreates authorization from an expired workflow during GC", async () => {
    const store = new TicketStateStore(memoryStorage());
    const claimHash = "a".repeat(64);
    const admission = {
      ...ADMISSION,
      nowEpochSeconds: 1,
    };
    const bindings = [{ jti: JTI, expiresAtEpochSeconds: 10 }];
    await store.beginWorkflow(WORK_CLAIM_ID, claimHash, "UPLOAD", bindings, admission);

    await expect(store.beginWorkflow(
      WORK_CLAIM_ID,
      claimHash,
      "UPLOAD",
      bindings,
      { ...admission, nowEpochSeconds: 10 + 7 * 24 * 60 * 60 },
    )).rejects.toThrow("workflow expired");
  });

  it("allows only an explicit recovery claim to replace an expired workflow", async () => {
    const store = new TicketStateStore(memoryStorage());
    const originalHash = "a".repeat(64);
    const recoveryHash = "b".repeat(64);
    const originalAdmission = { ...ADMISSION, nowEpochSeconds: 1 };
    await store.beginWorkflow(
      WORK_CLAIM_ID,
      originalHash,
      "VERIFY",
      [{ jti: JTI, expiresAtEpochSeconds: 10 }],
      originalAdmission,
      false,
      originalHash,
    );
    const recoveryAdmission = { ...ADMISSION, nowEpochSeconds: 10 + 7 * 24 * 60 * 60 };
    const recoveryBinding = [{
      jti: "dddd7000-0000-4000-8000-000000000004",
      expiresAtEpochSeconds: recoveryAdmission.nowEpochSeconds + 60,
    }];

    await expect(store.beginWorkflow(
      WORK_CLAIM_ID,
      recoveryHash,
      "VERIFY",
      recoveryBinding,
      recoveryAdmission,
      false,
      recoveryHash,
    )).rejects.toThrow("workflow expired");
    await expect(store.beginWorkflow(
      WORK_CLAIM_ID,
      recoveryHash,
      "VERIFY",
      recoveryBinding,
      recoveryAdmission,
      false,
      recoveryHash,
      "AUTHORIZED_OR_EXPIRED",
      [JTI],
    )).resolves.toMatchObject({
      phase: "AUTHORIZED",
      claimHash: recoveryHash,
      replayHash: recoveryHash,
    });
  });

  it("lets recovery replace safe AUTHORIZED work but never in-progress evidence", async () => {
    const originalHash = "a".repeat(64);
    const recoveryHash = "b".repeat(64);
    const replacementBinding = [{
      jti: "dddd7000-0000-4000-8000-000000000005",
      expiresAtEpochSeconds: 1_785_062_520,
    }];
    const authorized = new TicketStateStore(memoryStorage());
    await authorized.beginWorkflow(
      WORK_CLAIM_ID,
      originalHash,
      "DELETE",
      [{ jti: JTI, expiresAtEpochSeconds: 1_785_062_460 }],
      ADMISSION,
    );
    await expect(authorized.beginWorkflow(
      WORK_CLAIM_ID,
      recoveryHash,
      "DELETE",
      replacementBinding,
      ADMISSION,
      false,
      recoveryHash,
      "AUTHORIZED_OR_EXPIRED",
      ["dddd7000-0000-4000-8000-000000000099"],
      "DELETE_IN_PROGRESS",
    )).rejects.toThrow("workflow replacement mismatch");
    await expect(authorized.beginWorkflow(
      WORK_CLAIM_ID,
      recoveryHash,
      "DELETE",
      replacementBinding,
      ADMISSION,
      false,
      recoveryHash,
      "AUTHORIZED_OR_EXPIRED",
      [JTI],
      "DELETE_IN_PROGRESS",
    )).resolves.toMatchObject({
      phase: "DELETE_IN_PROGRESS",
      claimHash: recoveryHash,
    });

    const inProgress = new TicketStateStore(memoryStorage());
    await inProgress.beginWorkflow(
      WORK_CLAIM_ID,
      originalHash,
      "DELETE",
      [{ jti: JTI, expiresAtEpochSeconds: 1_785_062_460 }],
      ADMISSION,
    );
    await inProgress.markWorkInProgress(WORK_CLAIM_ID, originalHash, {
      objectExisted: true,
      versionOrEtag: "version-1",
    });
    await expect(inProgress.beginWorkflow(
      WORK_CLAIM_ID,
      recoveryHash,
      "DELETE",
      replacementBinding,
      ADMISSION,
      false,
      recoveryHash,
      "AUTHORIZED_OR_EXPIRED",
      [JTI],
      "DELETE_IN_PROGRESS",
    )).rejects.toThrow("work claim mismatch");
  });

  it("serializes revocation acknowledgement before stale workflow admission", async () => {
    const fixture = adversarialDurableState();
    const durable = new TicketStateDurableObject(fixture.state);
    const principal = {
      organizationId: ORGANIZATION_ID,
      principalKind: "CHANNEL",
      accountId: ACCOUNT_ID,
      cellId: "dddd2000-0000-4000-8000-000000000001",
      maintenancePrincipalId: null,
    };
    const revoke = await durable.fetch(stateRequest("/apply-revocation", {
      ...principal,
      dimension: "CREDENTIAL",
      nonce: "dddd7000-0000-4000-8000-000000000009",
      seenAtEpochSeconds: 1_785_062_400,
      minimumValidGeneration: 6,
      revocationHash: "b".repeat(64),
      acknowledgement: { version: 1, acknowledgementHash: "c".repeat(64) },
    }));
    expect(revoke.status).toBe(200);

    const stale = await durable.fetch(stateRequest("/begin-workflow", {
      workClaimId: WORK_CLAIM_ID,
      claimHash: "a".repeat(64),
      kind: "UPLOAD",
      bindings: [{ jti: JTI, expiresAtEpochSeconds: 1_785_062_460 }],
      admission: {
        principal,
        generations: {
          sessionGeneration: 5,
          credentialGeneration: 5,
          leaseGeneration: 5,
          fencingToken: 5,
        },
      },
    }));

    expect(stale.status).toBe(409);
  });

  it("atomically binds every workflow JTI while creating AUTHORIZED work", async () => {
    const fixture = adversarialDurableState();
    const durable = new TicketStateDurableObject(fixture.state);
    const claimHash = "a".repeat(64);
    const secondJti = "dddd7000-0000-4000-8000-000000000002";

    const response = await durable.fetch(stateRequest("/begin-workflow", {
      workClaimId: WORK_CLAIM_ID,
      claimHash,
      kind: "DELETE",
      bindings: [
        { jti: JTI, expiresAtEpochSeconds: 10 },
        { jti: secondJti, expiresAtEpochSeconds: 11 },
      ],
      admission: ADMISSION,
    }));

    expect(response.status).toBe(200);
    expect((await response.json<{ work: { phase: string } }>()).work.phase).toBe("AUTHORIZED");
    await expect((await durable.fetch(stateRequest("/consume-jti", {
      jti: JTI,
      expiresAtEpochSeconds: 10,
    }))).json()).resolves.toEqual({ consumed: false });
    await expect((await durable.fetch(stateRequest("/consume-jti", {
      jti: secondJti,
      expiresAtEpochSeconds: 11,
    }))).json()).resolves.toEqual({ consumed: false });
  });

  it("recovers after a crash between staged JTI and work writes without orphaning the JTI", async () => {
    const fixture = crashInjectingDurableState();
    const durable = new TicketStateDurableObject(fixture.state);
    const body = {
      workClaimId: WORK_CLAIM_ID,
      claimHash: "a".repeat(64),
      kind: "UPLOAD",
      bindings: [{ jti: JTI, expiresAtEpochSeconds: 10 }],
      admission: ADMISSION,
    };

    expect((await durable.fetch(stateRequest("/begin-workflow", body))).status).toBe(409);
    fixture.recover();
    const recovered = await durable.fetch(stateRequest("/begin-workflow", body));

    expect(recovered.status).toBe(200);
    expect((await recovered.json<{ work: { phase: string } }>()).work.phase).toBe("AUTHORIZED");
  });

  it("persists recovery evidence once and rejects cross-claim receipt storage", async () => {
    const store = new TicketStateStore(memoryStorage());
    const claimHash = "a".repeat(64);
    await store.beginWorkflow(
      WORK_CLAIM_ID,
      claimHash,
      "DELETE",
      [{ jti: JTI, expiresAtEpochSeconds: 10 }],
    );

    await store.markWorkInProgress(WORK_CLAIM_ID, claimHash, {
      objectExisted: true,
      versionOrEtag: "r2-version-1",
    });
    await store.markWorkInProgress(WORK_CLAIM_ID, claimHash, {
      objectExisted: false,
      versionOrEtag: null,
    });

    const state = await store.workState(WORK_CLAIM_ID);
    expect(state?.progress).toEqual({
      objectExisted: true,
      versionOrEtag: "r2-version-1",
    });
    await expect(
      store.storeWorkReceipt(WORK_CLAIM_ID, "b".repeat(64), receipt),
    ).rejects.toThrow("work claim mismatch");
  });

  it("atomically binds a work id when concurrent durable-object claims disagree", async () => {
    const fixture = adversarialDurableState();
    const durable = new TicketStateDurableObject(fixture.state);
    fixture.armReadBarrier(`work:${WORK_CLAIM_ID}`, 2);

    const responses = await Promise.all([
      durable.fetch(stateRequest("/begin-workflow", {
        workClaimId: WORK_CLAIM_ID,
        claimHash: "a".repeat(64),
        kind: "DELETE",
        bindings: [{ jti: JTI, expiresAtEpochSeconds: 10 }],
        admission: ADMISSION,
      })),
      durable.fetch(stateRequest("/begin-workflow", {
        workClaimId: WORK_CLAIM_ID,
        claimHash: "b".repeat(64),
        kind: "DELETE",
        bindings: [{ jti: JTI, expiresAtEpochSeconds: 10 }],
        admission: ADMISSION,
      })),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it("atomically stores one receipt across concurrent durable-object requests", async () => {
    const fixture = adversarialDurableState();
    const durable = new TicketStateDurableObject(fixture.state);
    const claimHash = "a".repeat(64);
    await durable.fetch(stateRequest("/begin-workflow", {
      workClaimId: WORK_CLAIM_ID,
      claimHash,
      kind: "DELETE",
      bindings: [{ jti: JTI, expiresAtEpochSeconds: 10 }],
      admission: ADMISSION,
    }));
    await durable.fetch(stateRequest("/mark-work-in-progress", {
      workClaimId: WORK_CLAIM_ID,
      claimHash,
      progress: { objectExisted: true, versionOrEtag: "version-1" },
    }));
    fixture.armReadBarrier(`work:${WORK_CLAIM_ID}`, 2);
    const alternate = {
      canonicalJson: '{"version":1,"outcome":"NOT_FOUND"}',
      signature: "z".repeat(86),
      sha256: "b".repeat(64),
    };

    const responses = await Promise.all([
      durable.fetch(stateRequest("/store-work-receipt", {
        workClaimId: WORK_CLAIM_ID,
        claimHash,
        receipt,
      })),
      durable.fetch(stateRequest("/store-work-receipt", {
        workClaimId: WORK_CLAIM_ID,
        claimHash,
        receipt: alternate,
      })),
    ]);
    const stored = await Promise.all(responses.map(async (response) =>
      (await response.json<{ receipt: typeof receipt }>()).receipt
    ));

    expect(stored[1]).toEqual(stored[0]);
  });
});
