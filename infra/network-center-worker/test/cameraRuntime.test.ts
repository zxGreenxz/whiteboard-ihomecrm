import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CameraOutbox } from "../src/cameraOutbox.js";
import { boundCameraCredential, cameraPayload, cameraBatchQuarantineReason } from "../src/cameraRuntime.js";
import { validateCameraOrigin } from "../src/cameraConfig.js";
import type { CameraConnection, CameraIngest } from "../src/cameraApiTypes.js";

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
