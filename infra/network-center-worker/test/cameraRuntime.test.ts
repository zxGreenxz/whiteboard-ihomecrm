import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkCenterApiClient } from "../src/apiClient.js";
import { DahuaClient } from "../src/camera/dahuaClient.js";
import type { CameraClientErrorCode } from "../src/camera/errors.js";
import { HikvisionClient } from "../src/camera/hikvisionClient.js";
import type { CameraSnapshot } from "../src/camera/types.js";
import { CameraOutbox } from "../src/cameraOutbox.js";
import { boundCameraCredential, cameraCollector, cameraPayload, cameraBatchQuarantineReason, CameraRuntime } from "../src/cameraRuntime.js";
import { loadCameraConfig, validateCameraOrigin, type CameraCredential } from "../src/cameraConfig.js";
import { cameraConnectionSchema, type CameraConnection, type CameraIngest } from "../src/cameraApiTypes.js";

const connection: CameraConnection = {
  recorderId: "dddd7000-0000-4000-8000-000000000001", connectionId: "dddd7000-0000-4000-8000-000000000002",
  organizationId: "dddd0000-0000-4000-8000-000000000001", buildingId: "dddd1000-0000-4000-8000-000000000001",
  displayName: "DEMO NVR", endpoint: "http://10.25.0.1:18080", credentialRef: "demo/nvr",
  channelCount: 1, pollIntervalSeconds: 30, connectTimeoutMs: 5000,
};
const snapshot = { observedAt: "2026-01-01T00:00:00.000Z", status: "ONLINE" as const,
  channels: [{ channel: 1, state: "CONNECTED" as const }], storage: [],
  eventCoverage: "STATE_POLLING_ONLY" as const, issues: [] };
const batch = (): CameraIngest => cameraPayload(connection, snapshot, true, [{
  eventKey: "fixed-event", code: "VideoLoss", action: "Start", channel: 1, observedAt: "2026-01-01T00:00:15.000Z",
}]);

describe("camera runtime evidence", () => {
  it("does not renew poll freshness when an event arrives", () => {
    const payload = batch();
    expect(payload.observedAt).toBe(snapshot.observedAt);
    expect(payload.events[0]?.observedAt).not.toBe(payload.observedAt);
    expect(payload.eventCoverage).toBe("EVENT_STREAM");
    expect(cameraPayload(connection, snapshot, false).issues).toContain("EVENT_STREAM_UNAVAILABLE");
  });
  it("pins credential delivery to the mounted private origin", () => {
    const credential = { origin: connection.endpoint, username: "test", password: "test-only" };
    const credentials = new Map([[connection.credentialRef, credential]]);
    expect(boundCameraCredential(connection, credentials)).toEqual(credential);
    expect(() => boundCameraCredential({ ...connection, endpoint: "http://10.25.0.2:18080" }, credentials)).toThrow();
    for (const url of ["http://example.com", "http://1.1.1.1", "http://127.0.0.1", "http://test:pass@10.0.0.1", "http://10.0.0.1/redirect"]) {
      expect(() => validateCameraOrigin(url)).toThrow();
    }
  });
  it("quarantines expired snapshots or event batches but keeps recent evidence", () => {
    expect(cameraBatchQuarantineReason(connection.connectionId, batch(), Date.parse("2026-01-30T00:00:00Z"))).toBeNull();
    expect(cameraBatchQuarantineReason(connection.connectionId, batch(), Date.parse("2026-02-01T00:00:00Z"))).toBe("EXPIRED");
    expect(cameraBatchQuarantineReason(connection.connectionId, { ...batch(), observedAt: "2026-02-01T00:00:00Z" }, Date.parse("2026-02-01T00:00:00Z"))).toBe("EXPIRED");
  });
});

describe("durable camera outbox", () => {
  const folders: string[] = [];
  afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
  const folder = async () => { const path = await mkdtemp(join(tmpdir(), "camera-outbox-test-")); folders.push(path); return path; };

  it("replays the identical event after an ambiguous acknowledgement and process restart", async () => {
    const path = await folder();
    await new CameraOutbox(path).enqueue(batch());
    const received: CameraIngest[] = [];
    await expect(new CameraOutbox(path).drain(async (payload) => { received.push(payload); throw new Error("lost response"); })).rejects.toThrow();
    expect(await new CameraOutbox(path).drain(async (payload) => { received.push(payload); })).toBe(1);
    expect(received).toEqual([batch(), batch()]);
    expect(await readdir(path)).toEqual([]);
  });
  it("retains old evidence when the capacity limit is reached", async () => {
    const path = await folder();
    const queue = new CameraOutbox(path, Buffer.byteLength(JSON.stringify(batch())) + 1);
    await queue.enqueue(batch());
    await expect(queue.enqueue(batch())).rejects.toThrow("CAMERA_OUTBOX_FULL");
    const received: CameraIngest[] = [];
    await queue.drain(async (payload) => { received.push(payload); });
    expect(received).toEqual([batch()]);
  });
  it("keeps poll transitions in insertion order", async () => {
    const queue = new CameraOutbox(await folder());
    await Promise.all([queue.enqueue(batch()), queue.enqueue({ ...batch(), status: "OFFLINE" }), queue.enqueue(batch())]);
    const states: string[] = [];
    await queue.drain(async (payload) => { states.push(payload.status); });
    expect(states).toEqual(["ONLINE", "OFFLINE", "ONLINE"]);
  });

  it("preserves obsolete binding evidence and continues delivering the current binding", async () => {
    const path = await folder();
    const queue = new CameraOutbox(path);
    await queue.enqueue({ ...batch(), connectionId: "retired-connection" });
    await queue.enqueue(batch());
    const received: CameraIngest[] = [];
    const reasons: string[] = [];
    await queue.drain(async (payload) => { received.push(payload); }, 20, {
      reason: (payload) => payload.connectionId !== connection.connectionId ? "BINDING_CHANGED" : null,
      recorded: (reason) => { reasons.push(reason); },
    });
    expect(received).toEqual([batch()]);
    expect(reasons).toEqual(["BINDING_CHANGED"]);
    expect(await readdir(join(path, "quarantine", "BINDING_CHANGED"))).toHaveLength(1);
    expect(await new CameraOutbox(path).drain(async () => { throw new Error("Must not resend quarantine"); })).toBe(0);
  });
});

// Obviously synthetic pin: no certificate hashes to this value.
const PIN = "ab".repeat(32);
const hikvision: CameraConnection = {
  ...connection, recorderId: "dddd7000-0000-4000-8000-000000000011", displayName: "DEMO ISAPI",
  endpoint: "https://10.25.0.2", credentialRef: "demo/isapi", channelCount: 4, vendor: "HIKVISION",
  // Not 30 s, so a poll wait cannot be mistaken for the 30 s assignment refresh.
  pollIntervalSeconds: 45,
};
const dahuaCredential: CameraCredential = { origin: connection.endpoint, username: "test", password: "test-only" };
const hikvisionCredential: CameraCredential = { origin: hikvision.endpoint, username: "test", password: "test-only", tlsFingerprint256: PIN };
const credentials = new Map([[connection.credentialRef, dahuaCredential], [hikvision.credentialRef, hikvisionCredential]]);

describe("camera vendor selection", () => {
  it("keeps the vendor the database sends and tolerates a database that sends none", () => {
    expect(cameraConnectionSchema.parse({ ...connection, vendor: "HIKVISION", laterKey: 1 })).toEqual({ ...connection, vendor: "HIKVISION" });
    expect(cameraConnectionSchema.parse(connection)).toEqual(connection);
    expect(cameraConnectionSchema.safeParse({ ...connection, vendor: "" }).success).toBe(false);
  });

  it("receives the vendor through the Edge envelope, one recorder at a time", async () => {
    const api = new NetworkCenterApiClient({
      baseUrl: new URL("https://edge.example.invalid/functions/v1/network-center-worker"), secret: "s".repeat(48), timeoutMs: 1_000,
      fetch: async () => Response.json({ ok: true, data: { items: [hikvision, connection, { ...connection, vendor: "UNIVIEW" }] } }),
    });
    // An unknown vendor does not reject the list; it is refused later, for that recorder alone.
    expect((await api.listCameraConnections()).map((item) => item.vendor)).toEqual(["HIKVISION", undefined, "UNIVIEW"]);
  });

  it("uses the ISAPI client for HIKVISION: polling only, half an hour after a refused login", () => {
    const collector = cameraCollector(hikvision, hikvisionCredential);
    expect(collector.client).toBeInstanceOf(HikvisionClient);
    expect(collector.openEventStream).toBeUndefined();
    expect(collector.authDeniedDelayMs).toBe(1_800_000);
    expect(collector.holdAuthDeniedAcrossRebuild).toBe(true);
  });

  it.each(["KBVISION", "DAHUA", undefined])("keeps the Dahua client, its event stream and its 300 s wait for vendor %s", (vendor) => {
    const collector = cameraCollector(vendor === undefined ? connection : { ...connection, vendor }, dahuaCredential);
    expect(collector.client).toBeInstanceOf(DahuaClient);
    expect(collector.openEventStream).toBeTypeOf("function");
    expect(collector.authDeniedDelayMs).toBe(300_000);
    expect(collector.holdAuthDeniedAcrossRebuild).toBe(false);
  });

  it.each(["UNIVIEW", "hikvision", "HIKVISION ", "Dahua"])("refuses vendor %j instead of guessing a protocol", (vendor) => {
    expect(() => cameraCollector({ ...connection, vendor }, dahuaCredential)).toThrow("CAMERA_VENDOR_UNSUPPORTED");
  });

  it("refuses an https Hikvision recorder without a pin, and a pin the Dahua client cannot honour", () => {
    const { tlsFingerprint256: _pin, ...unpinned } = hikvisionCredential;
    expect(() => cameraCollector(hikvision, unpinned)).toThrow("CAMERA_TLS_PIN_REQUIRED");
    expect(() => cameraCollector({ ...hikvision, vendor: "DAHUA" }, hikvisionCredential)).toThrow("CAMERA_TLS_PIN_UNSUPPORTED");
    const { vendor: _vendor, ...legacy } = hikvision;
    expect(() => cameraCollector(legacy, hikvisionCredential)).toThrow("CAMERA_TLS_PIN_UNSUPPORTED");
    expect(() => cameraCollector({ ...hikvision, endpoint: "http://10.25.0.2" }, { ...hikvisionCredential, origin: "http://10.25.0.2" })).toThrow("CAMERA_TLS_PIN_REQUIRES_HTTPS");
  });

  it("reports no stream issue for a recorder that has no event stream", () => {
    expect(cameraPayload(hikvision, snapshot, false, [], false)).toMatchObject({ eventCoverage: "STATE_POLLING_ONLY", issues: [], events: [] });
    expect(cameraPayload(hikvision, { ...snapshot, issues: ["STORAGE_STATUS_UNAVAILABLE"] }, false, [], false).issues).toEqual(["STORAGE_STATUS_UNAVAILABLE"]);
    expect(cameraPayload(connection, snapshot, false).issues).toEqual(["EVENT_STREAM_UNAVAILABLE"]);
  });
});

describe("camera credential file", () => {
  const folders: string[] = [];
  afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
  const load = async (entries: unknown) => {
    const folder = await mkdtemp(join(tmpdir(), "camera-config-test-"));
    folders.push(folder);
    await writeFile(join(folder, "worker-secret"), "s".repeat(40), { mode: 0o600 });
    await writeFile(join(folder, "camera-credentials.json"), JSON.stringify(entries), { mode: 0o600 });
    return loadCameraConfig({
      NETWORK_CENTER_EDGE_URL: "https://edge.example.invalid/functions/v1/network-center-worker",
      CAMERA_WORKER_SECRET_FILE: join(folder, "worker-secret"), CAMERA_CREDENTIALS_FILE: join(folder, "camera-credentials.json"),
      CAMERA_STATE_DIRECTORY: folder,
    }).credentials;
  };
  const entry = { origin: "https://10.25.0.2", username: "test", password: "test-only" };

  it("accepts a pin in either case, with or without colons, and stores one normal form", async () => {
    const loaded = await load({
      "demo/colons": { ...entry, tlsFingerprint256: Array.from({ length: 32 }, () => "AB").join(":") },
      "demo/bare": { ...entry, tlsFingerprint256: "aB".repeat(32) },
      "demo/plain": { ...dahuaCredential },
    });
    expect(loaded.get("demo/colons")).toEqual({ ...entry, tlsFingerprint256: PIN });
    expect(loaded.get("demo/bare")).toEqual({ ...entry, tlsFingerprint256: PIN });
    expect(loaded.get("demo/plain")).toEqual(dahuaCredential);
  });

  it("refuses a pin beside a plain-HTTP origin", async () => {
    await expect(load({ "demo/http": { ...entry, origin: "http://10.25.0.2", tlsFingerprint256: PIN } })).rejects.toThrow("CAMERA_TLS_PIN_REQUIRES_HTTPS");
  });

  it.each([
    "ab".repeat(31), "ab".repeat(33), "ab".repeat(20), `sha256:${PIN}`, `${"ab:".repeat(31)}a`, `${"ab".repeat(16)}:${"ab".repeat(16)}`, "zz".repeat(32), "",
  ])("keeps the entry schema strict: malformed pin %j", async (tlsFingerprint256) => {
    await expect(load({ "demo/bad": { ...entry, tlsFingerprint256 } })).rejects.toThrow("CAMERA_CREDENTIALS_INVALID");
  });

  it("still rejects a key it does not know", async () => {
    await expect(load({ "demo/extra": { ...entry, tlsFingerprint256: PIN, insecure: true } })).rejects.toThrow("CAMERA_CREDENTIALS_INVALID");
  });
});

describe("camera runtime per vendor", { timeout: 30_000 }, () => {
  const folders: string[] = [];
  const stops: Array<() => Promise<void>> = [];
  // The loops write to the real disk between waits; allow for a loaded machine.
  const eventually = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 5000, interval: 20 });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const live = (overrides: Partial<CameraSnapshot> = {}): CameraSnapshot => ({
    observedAt: new Date().toISOString(), status: "ONLINE", channels: [{ channel: 1, state: "CONNECTED" }], storage: [],
    eventCoverage: "STATE_POLLING_ONLY", issues: [], ...overrides,
  });
  const denied = () => live({ status: "AUTH_DENIED", channels: [], issues: ["AUTHENTICATION_FAILED"] });

  /** Time moves only when a test says so; every wait a loop asks for is recorded. */
  function manualClock() {
    let now = 1_000_000_000;
    const waiting: Array<{ at: number; wake: () => void }> = [];
    const requested: number[] = [];
    return {
      requested,
      now: () => now,
      sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
        requested.push(ms);
        if (signal.aborted) { resolve(); return; }
        waiting.push({ at: now + ms, wake: resolve });
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
      async advance(ms: number) {
        now += ms;
        for (const waiter of waiting.filter((item) => item.at <= now)) {
          waiting.splice(waiting.indexOf(waiter), 1);
          waiter.wake();
        }
        // Let the woken loops reach their next wait (they touch the real disk on the way).
        await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
      },
    };
  }

  async function start(input: {
    list: () => Promise<CameraConnection[]>;
    snapshot?: () => CameraSnapshot;
    lastFailure?: () => CameraClientErrorCode | null;
    productionCollector?: boolean;
  }) {
    const clock = manualClock();
    const polls: string[] = [];
    const ingested: CameraIngest[] = [];
    const errors: Array<{ message: string; context: unknown }> = [];
    const stateDirectory = await mkdtemp(join(tmpdir(), "camera-runtime-test-"));
    folders.push(stateDirectory);
    const controller = new AbortController();
    const runtime = new CameraRuntime({
      api: { listCameraConnections: input.list, ingestCamera: async (payload) => { ingested.push(payload); return { accepted: true }; } },
      credentials, stateDirectory, sleep: clock.sleep, now: clock.now,
      logger: { info: () => undefined, warn: () => undefined, error: (message, context) => { errors.push({ message, context }); } },
      ...(input.productionCollector ? {} : { collector: (target: CameraConnection, credential: CameraCredential) => {
        // The real selection still decides stream, waits and refusals; only the network is replaced.
        const selected = cameraCollector(target, credential);
        const client = { poll: async () => { polls.push(target.recorderId); return (input.snapshot ?? live)(); } };
        const lastFailure = input.lastFailure ? { lastFailure: input.lastFailure } : {};
        if (!selected.openEventStream) return { ...selected, client, ...lastFailure };
        // A stream that stays silent until shutdown: connected in name, never healthy.
        const openEventStream = async function* (signal: AbortSignal) {
          await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
        };
        return { ...selected, client, openEventStream, ...lastFailure };
      } }),
    });
    const done = runtime.run(controller.signal);
    stops.push(async () => { controller.abort(); await done; });
    const saved = async (recorderId: string) => (await readdir(join(stateDirectory, recorderId)).catch(() => [])).filter((name) => name.endsWith(".json"));
    return { clock, polls, ingested, errors, stateDirectory, saved };
  }

  it("does not collect a recorder with an unknown vendor and opens no socket for it", async () => {
    const connect = vi.spyOn(Socket.prototype, "connect");
    const run = await start({ list: async () => [{ ...connection, vendor: "UNIVIEW" }], productionCollector: true });
    const refusal = { message: "Camera vendor unsupported; recorder not collected", context: { recorderId: connection.recorderId } };
    await eventually(() => expect(run.errors).toEqual([refusal]));
    await eventually(() => expect(run.clock.requested).toEqual([30_000]));
    await run.clock.advance(30_000);
    await eventually(() => expect(run.errors).toEqual([refusal, refusal]));
    expect(connect).not.toHaveBeenCalled();
    expect(run.ingested).toEqual([]);
    expect(await readdir(run.stateDirectory)).toEqual([]);
  });

  it("collects a Hikvision recorder without a stream loop, a coverage gap or a stream issue", async () => {
    const run = await start({ list: async () => [hikvision] });
    const pollWaits = () => run.clock.requested.filter((ms) => ms === hikvision.pollIntervalSeconds * 1000).length;
    await eventually(() => expect(pollWaits()).toBe(1));
    await run.clock.advance(hikvision.pollIntervalSeconds * 1000);
    await eventually(() => expect(pollWaits()).toBe(2));
    // The first snapshot after a start and one after a later poll, both delivered.
    await eventually(async () => { await run.clock.advance(2000); expect(run.ingested.length).toBeGreaterThanOrEqual(2); });
    for (const payload of run.ingested) expect([payload.eventCoverage, payload.issues, payload.events]).toEqual(["STATE_POLLING_ONLY", [], []]);
    // 5000 ms is the stream loop's wait; a polling-only recorder must never ask for it.
    expect(run.clock.requested).not.toContain(5000);
    expect(run.errors).toEqual([]);
  });

  it("still reports the gap and the stream issue for a Dahua recorder whose stream is silent", async () => {
    const run = await start({ list: async () => [connection] });
    await eventually(async () => expect(await run.saved(connection.recorderId)).toHaveLength(1));
    await eventually(async () => { await run.clock.advance(2000); expect(run.ingested.length).toBeGreaterThanOrEqual(1); });
    expect(run.ingested[0]).toMatchObject({ eventCoverage: "STATE_POLLING_ONLY", issues: ["EVENT_STREAM_UNAVAILABLE"], events: [{ code: "COVERAGE_GAP" }] });
  });

  it("waits 1800 s after a refused Hikvision login before the next attempt", async () => {
    const run = await start({ list: async () => [hikvision], snapshot: denied });
    await eventually(() => expect(run.clock.requested).toContain(1_800_000));
    expect(run.polls).toHaveLength(1);
    await run.clock.advance(1_799_999);
    expect(run.polls).toHaveLength(1);
    await run.clock.advance(1);
    await eventually(() => expect(run.polls).toHaveLength(2));
    expect(run.clock.requested).not.toContain(300_000);
  });

  it("keeps 300 s after a refused Dahua login", async () => {
    const run = await start({ list: async () => [connection], snapshot: denied });
    await eventually(() => expect(run.clock.requested).toContain(300_000));
    expect(run.polls).toHaveLength(1);
    await run.clock.advance(299_999);
    expect(run.polls).toHaveLength(1);
    await run.clock.advance(1);
    await eventually(() => expect(run.polls).toHaveLength(2));
    expect(run.clock.requested).not.toContain(1_800_000);
  });

  it("holds the Hikvision wait when the collector is rebuilt after an assignment outage", async () => {
    let outage = false;
    const run = await start({ list: async () => { if (outage) throw new Error("edge unavailable"); return [hikvision]; }, snapshot: denied });
    await eventually(() => expect(run.clock.requested).toContain(1_800_000));
    const refreshes = () => run.clock.requested.filter((ms) => ms === 30_000).length;
    await eventually(() => expect(refreshes()).toBe(1));
    outage = true;
    await run.clock.advance(30_000);
    await eventually(() => expect(run.errors.map((entry) => entry.message)).toContain("Camera assignments unavailable; collection suspended"));
    await eventually(() => expect(refreshes()).toBe(2));
    outage = false;
    await run.clock.advance(30_000);
    // Rebuilt 60 s after the refusal: the new loop owes the remaining 1740 s before it may log in again.
    await eventually(() => expect(run.clock.requested).toContain(1_740_000));
    expect(run.polls).toHaveLength(1);
    await run.clock.advance(1_739_999);
    expect(run.polls).toHaveLength(1);
    await run.clock.advance(1);
    await eventually(() => expect(run.polls).toHaveLength(2));
  });

  it("names a client failure once per change, by fixed code", async () => {
    let failure: CameraClientErrorCode | null = "TLS_PIN_MISMATCH";
    const run = await start({ list: async () => [hikvision], snapshot: () => live({ status: "UNKNOWN", channels: [], issues: ["DEVICE_RESPONSE_INVALID"] }), lastFailure: () => failure });
    const named = { message: "Camera poll failed", context: { recorderId: hikvision.recorderId, code: "TLS_PIN_MISMATCH" } };
    const waits = () => run.clock.requested.filter((ms) => ms === hikvision.pollIntervalSeconds * 1000).length;
    await eventually(() => expect(waits()).toBe(1));
    await run.clock.advance(hikvision.pollIntervalSeconds * 1000);
    await eventually(() => expect(waits()).toBe(2));
    expect(run.polls).toHaveLength(2);
    expect(run.errors).toEqual([named]);
    failure = null;
    await run.clock.advance(hikvision.pollIntervalSeconds * 1000);
    await eventually(() => expect(waits()).toBe(3));
    failure = "TLS_PIN_MISMATCH";
    await run.clock.advance(hikvision.pollIntervalSeconds * 1000);
    await eventually(() => expect(run.errors).toEqual([named, named]));
  });
});
