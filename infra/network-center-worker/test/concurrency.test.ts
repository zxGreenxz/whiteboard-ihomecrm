import { describe, expect, it } from "vitest";

import { AsyncSemaphore } from "../src/concurrency.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached");
}

describe("AsyncSemaphore", () => {
  it("reserves a released permit for the oldest waiter before admitting a newcomer", async () => {
    const semaphore = new AsyncSemaphore(1);
    const firstRelease = deferred();
    const contendersRelease = deferred();
    const order: string[] = [];
    let activeContenders = 0;
    let maximumActiveContenders = 0;

    const enterContender = async (name: string) => {
      order.push(name);
      activeContenders += 1;
      maximumActiveContenders = Math.max(maximumActiveContenders, activeContenders);
      await contendersRelease.promise;
      activeContenders -= 1;
    };

    const first = semaphore.use(() => {
      order.push("first");
      return firstRelease.promise;
    });
    await waitUntil(() => order.length === 1);
    const oldestWaiter = semaphore.use(() => enterContender("oldest"));

    let newcomer!: Promise<void>;
    firstRelease.resolve();
    queueMicrotask(() => {
      newcomer = semaphore.use(() => enterContender("newcomer"));
    });

    await waitUntil(() => order.length >= 2);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(maximumActiveContenders).toBe(1);
    expect(order.slice(0, 2)).toEqual(["first", "oldest"]);

    contendersRelease.resolve();
    await Promise.all([first, oldestWaiter, newcomer]);
  });

  it("hands the permit to the next waiter when an operation throws", async () => {
    const semaphore = new AsyncSemaphore(1);
    const releaseFailure = deferred();
    const expectedError = new Error("operation failed");
    let followerEntered = false;

    const failing = semaphore.use(async () => {
      await releaseFailure.promise;
      throw expectedError;
    });
    const failureAssertion = expect(failing).rejects.toBe(expectedError);
    const follower = semaphore.use(async () => {
      followerEntered = true;
      return 42;
    });

    await Promise.resolve();
    expect(followerEntered).toBe(false);

    releaseFailure.resolve();
    await failureAssertion;
    await expect(follower).resolves.toBe(42);
  });
});
