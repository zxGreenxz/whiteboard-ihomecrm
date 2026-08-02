import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FilePortCycleEvidenceStore } from "../src/portCycleEvidence.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "network-center-evidence-"));
  directories.push(directory);
  return directory;
}

afterAll(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
});

const identity = {
  commandId: "50000000-0000-4000-8000-000000000001",
  managedResourceId: "60000000-0000-4000-8000-000000000001",
  immutableKey: "ether4",
};

/** Recorded against the real clock, so retention never masks a real failure. */
function fresh(overrides: Partial<typeof identity> = {}) {
  return { ...identity, ...overrides, observedAt: new Date().toISOString() };
}

describe("durable access-port cycle evidence", () => {
  it("survives the process that recorded it", async () => {
    const directory = await temporaryDirectory();
    const evidence = fresh();
    await new FilePortCycleEvidenceStore(directory).record(evidence);

    const reader = new FilePortCycleEvidenceStore(directory);
    expect(await reader.read(evidence.commandId)).toEqual(evidence);
  });

  it("returns nothing for a command that never cycled a port", async () => {
    const directory = await temporaryDirectory();
    const store = new FilePortCycleEvidenceStore(directory);
    await store.record(fresh());

    expect(await store.read("50000000-0000-4000-8000-0000000000ff")).toBeNull();
  });

  it("keeps a hostile command id inside its own directory", async () => {
    const directory = await temporaryDirectory();
    const store = new FilePortCycleEvidenceStore(directory);
    const commandId = "../../escaped";
    await store.record(fresh({ commandId }));

    const entries = await readdir(directory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[a-f0-9]{32}\.json$/);
    expect(await store.read(commandId)).toMatchObject({ commandId });
  });

  it("ignores evidence that has aged past its retention window", async () => {
    const directory = await temporaryDirectory();
    const store = new FilePortCycleEvidenceStore(directory, {
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      retentionMs: 60_000,
    });
    await store.record({ ...identity, observedAt: "2026-07-27T23:58:00.000Z" });

    expect(await store.read(identity.commandId)).toBeNull();
  });

  it("ignores evidence it cannot parse instead of trusting it", async () => {
    const directory = await temporaryDirectory();
    const store = new FilePortCycleEvidenceStore(directory);
    const evidence = fresh();
    await store.record(evidence);
    const [name] = await readdir(directory);
    expect(name).toMatch(/\.json$/);
    await writeFile(join(directory, name ?? "missing.json"), "{not json", "utf8");

    expect(await store.read(evidence.commandId)).toBeNull();
  });

  it("refuses evidence whose stored command id was swapped underneath it", async () => {
    const directory = await temporaryDirectory();
    const store = new FilePortCycleEvidenceStore(directory);
    const evidence = fresh();
    await store.record(evidence);
    const [name] = await readdir(directory);
    await writeFile(
      join(directory, name ?? "missing.json"),
      JSON.stringify({ ...evidence, commandId: "50000000-0000-4000-8000-0000000000aa" }),
      "utf8",
    );

    expect(await store.read(evidence.commandId)).toBeNull();
  });

  it("hands the managed identity back unauthenticated, for its reader to bind", async () => {
    // The store authenticates exactly one thing: the stored `commandId` against the
    // filename it was found under. The managed identity is *not* authenticated here —
    // it is returned as stored and cross-checked against the live port by
    // `CommandProcessor`, which is where the only trustworthy copy of it exists. This
    // test pins that division so no future reader assumes a guarantee it never had.
    const directory = await temporaryDirectory();
    const store = new FilePortCycleEvidenceStore(directory);
    const evidence = fresh();
    await store.record(evidence);
    const [name] = await readdir(directory);
    await writeFile(
      join(directory, name ?? "missing.json"),
      JSON.stringify({ ...evidence, managedResourceId: "swapped", immutableKey: "ether9" }),
      "utf8",
    );

    expect(await store.read(evidence.commandId)).toMatchObject({
      commandId: evidence.commandId,
      managedResourceId: "swapped",
      immutableKey: "ether9",
    });
  });

  it("prunes stale evidence files so the directory cannot grow without bound", async () => {
    const directory = await temporaryDirectory();
    let current = new Date("2026-07-28T00:00:00.000Z");
    const store = new FilePortCycleEvidenceStore(directory, {
      now: () => current,
      retentionMs: 60_000,
    });
    await store.record({ ...identity, observedAt: current.toISOString() });
    expect(await readdir(directory)).toHaveLength(1);

    current = new Date("2026-07-28T00:05:00.000Z");
    await store.record({
      ...identity,
      commandId: "50000000-0000-4000-8000-000000000002",
      observedAt: current.toISOString(),
    });

    const remaining = await readdir(directory);
    expect(remaining).toHaveLength(1);
    expect(await store.read("50000000-0000-4000-8000-000000000002")).not.toBeNull();
  });
});
