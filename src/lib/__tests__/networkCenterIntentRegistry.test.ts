import { describe, expect, it, vi } from "vitest";

import {
  createIntentRegistry,
  type IntentStorage,
  type NetworkActionIntentTarget,
} from "@/lib/network-center/intentRegistry";

function sharedStorage(): IntentStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const targetAction: NetworkActionIntentTarget = {
  actorId: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  buildingId: "30000000-0000-4000-8000-000000000001",
  deviceId: "40000000-0000-4000-8000-000000000001",
  actionType: "cycle_access_port",
  interfaceId: "50000000-0000-4000-8000-000000000001",
  parameters: { durationSeconds: 5 },
  reason: "Cycle access port for validation",
  confirmation: "router-demo",
};

describe("Network Center stable intent registry", () => {
  it("keeps one idempotency key across close and reopen until terminal", () => {
    const ids = [
      "60000000-0000-4000-8000-000000000001",
      "60000000-0000-4000-8000-000000000002",
    ];
    const registry = createIntentRegistry(() => ids.shift()!, {
      storage: sharedStorage(),
    });

    const first = registry.begin(targetAction);
    registry.closeDialog(targetAction);
    expect(registry.begin(targetAction)).toEqual(first);

    registry.observe(first.id, "UNCERTAIN");
    expect(registry.begin(targetAction)).toMatchObject({
      id: first.id,
      status: "UNCERTAIN",
    });

    registry.observe(first.id, "SUCCEEDED");
    expect(registry.begin(targetAction).id).not.toBe(first.id);
  });

  it("restores active intent and exact command identity after reload", () => {
    const storage = sharedStorage();
    const firstTab = createIntentRegistry(
      () => "60000000-0000-4000-8000-000000000001",
      { storage },
    );
    const intent = firstTab.begin(targetAction);
    firstTab.attachCommand(intent.id, "70000000-0000-4000-8000-000000000001", "RUNNING");

    const reloaded = createIntentRegistry(vi.fn(), { storage });
    expect(reloaded.lookup(targetAction)).toMatchObject({
      id: intent.id,
      commandId: "70000000-0000-4000-8000-000000000001",
      status: "RUNNING",
    });
    expect(reloaded.begin(targetAction).id).toBe(intent.id);
  });

  it("clears an attached intent when the UI observes lowercase terminal success", () => {
    const registry = createIntentRegistry(
      () => "60000000-0000-4000-8000-000000000001",
      { storage: sharedStorage() },
    );
    const intent = registry.begin(targetAction);
    registry.attachCommand(intent.id, "70000000-0000-4000-8000-000000000001", "running");

    registry.observeCommand("70000000-0000-4000-8000-000000000001", "success");

    expect(registry.lookup(targetAction)).toBeNull();
  });

  it("converges two tabs on one semantic target despite parameter key order", () => {
    const storage = sharedStorage();
    const firstTab = createIntentRegistry(
      () => "60000000-0000-4000-8000-000000000001",
      { storage },
    );
    const secondUuid = vi.fn(() => "60000000-0000-4000-8000-000000000002");
    const secondTab = createIntentRegistry(secondUuid, { storage });

    const first = firstTab.begin({
      ...targetAction,
      parameters: { z: true, durationSeconds: 5 },
    });
    const second = secondTab.begin({
      ...targetAction,
      parameters: { durationSeconds: 5, z: true },
    });

    expect(second.id).toBe(first.id);
    expect(secondUuid).not.toHaveBeenCalled();
  });

  it("uses a new exact-request token when the reason changes", () => {
    const storage = sharedStorage();
    let sequence = 0;
    const registry = createIntentRegistry(
      () => `60000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      { storage },
    );

    const first = registry.begin(targetAction);
    const changedReason = registry.begin({
      ...targetAction,
      reason: "Cycle access port for a different incident",
    });

    expect(changedReason.id).not.toBe(first.id);
  });

  it("isolates actors and organizations, prunes stale principals, and never resets active intent", () => {
    const storage = sharedStorage();
    let sequence = 0;
    const registry = createIntentRegistry(
      () => `60000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      { storage },
    );

    const first = registry.begin(targetAction);
    const otherActor = registry.begin({
      ...targetAction,
      actorId: "10000000-0000-4000-8000-000000000002",
    });
    const otherOrg = registry.begin({
      ...targetAction,
      organizationId: "20000000-0000-4000-8000-000000000002",
    });

    expect(new Set([first.id, otherActor.id, otherOrg.id]).size).toBe(3);
    expect(registry.reset(targetAction)).toBe(true); // PENDING and never submitted is safe.

    const active = registry.begin(targetAction);
    registry.attachCommand(active.id, "70000000-0000-4000-8000-000000000001", "RUNNING");
    expect(registry.reset(targetAction)).toBe(false);
    registry.observe(active.id, "UNCERTAIN");
    expect(registry.reset(targetAction)).toBe(false);

    expect(registry.prune({
      actorId: targetAction.actorId,
      organizationIds: [targetAction.organizationId],
    })).toBe(2);
    expect(registry.list()).toHaveLength(1);
    expect(registry.lookup(targetAction)).toMatchObject({ id: active.id, status: "UNCERTAIN" });
  });

  it("does not publish duplicate authoritative state and trigger a render loop", () => {
    const registry = createIntentRegistry(
      () => "60000000-0000-4000-8000-000000000001",
      { storage: sharedStorage() },
    );
    const intent = registry.begin(targetAction);
    registry.attachCommand(
      intent.id,
      "70000000-0000-4000-8000-000000000001",
      "RUNNING",
    );
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.attachCommand(
      intent.id,
      "70000000-0000-4000-8000-000000000001",
      "running",
    );
    registry.observeCommand(
      "70000000-0000-4000-8000-000000000001",
      "running",
    );

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
