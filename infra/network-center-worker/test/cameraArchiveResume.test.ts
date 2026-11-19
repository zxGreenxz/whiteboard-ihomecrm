import { describe, expect, it, vi } from "vitest";
import { ArchiveJobs, type ArchiveDependencies } from "../src/cameraArchive.js";
import type { LiveRecorder } from "../src/cameraLive.js";

const recorder: LiveRecorder = { id: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1, 2], rtspOrigin: "rtsp://10.0.0.1:554", username: "fixture", password: "fixture", archiveEnabled: true, archiveOrigin: "http://10.0.0.1" };
const requestId = "50000000-0000-4000-8000-000000000001";
const input = { requestId, start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T01:01:00.000Z", purpose: "export" as const, resolution: "480p" as const };
const actor = { id: "40000000-0000-4000-8000-000000000001", expiresAt: Date.parse("2026-10-24T12:00:00Z") };
function setup() {
  let now = Date.parse("2026-10-24T00:00:00Z");
  let complete!: (result: { bytes: number; durationSeconds: number; sha256: string }) => void;
  const dependencies: ArchiveDependencies = { now: () => now, authorize: vi.fn(async () => actor), encode: vi.fn<ArchiveDependencies["encode"]>((_id, _recorder, _channel, _range, signal) => new Promise((resolve, reject) => { complete = resolve; signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }); })), remove: vi.fn(async () => {}), audit: vi.fn(), fatal: vi.fn() };
  return { jobs: new ArchiveJobs(dependencies), dependencies, advance(ms: number) { now += ms; }, async ready() { complete({ bytes: 4096, durationSeconds: 60, sha256: "a".repeat(64) }); await Promise.resolve(); await Promise.resolve(); } };
}
describe("resumable camera exports", () => {
  it("holds the encoder and disk reservation until cancellation cleanup settles", async () => {
    const { jobs, dependencies } = setup();
    let finish!: () => void; let removed!: () => void;
    vi.mocked(dependencies.encode).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ bytes: 4096, durationSeconds: 60, sha256: "a".repeat(64) }); }));
    vi.mocked(dependencies.remove).mockImplementationOnce(() => new Promise((resolve) => { removed = resolve; }));
    await jobs.create(actor, recorder, 1, input);
    const stopped = jobs.cancelRequest(actor, recorder, requestId);
    const next = { ...input, requestId: "50000000-0000-4000-8000-000000000009" };
    await expect(jobs.create(actor, recorder, 1, next)).rejects.toMatchObject({ code: "ARCHIVE_BUSY" });
    finish(); await vi.waitFor(() => expect(dependencies.remove).toHaveBeenCalledOnce());
    await expect(jobs.create(actor, recorder, 1, next)).rejects.toMatchObject({ code: "ARCHIVE_BUSY" });
    expect(dependencies.encode).toHaveBeenCalledOnce(); removed(); await stopped;
    await jobs.create(actor, recorder, 1, next); expect(dependencies.encode).toHaveBeenCalledTimes(2); await jobs.closeAll();
  });
  it("reuses an atomic reservation after a lost POST response and rejects changed parameters", async () => {
    const { jobs, dependencies } = setup();
    const [first, retry] = await Promise.all([jobs.create(actor, recorder, 1, input), jobs.create(actor, recorder, 1, input)]);
    expect(retry.id).toBe(first.id); expect(dependencies.encode).toHaveBeenCalledTimes(1);
    await expect(jobs.create(actor, recorder, 2, input)).rejects.toMatchObject({ code: "ARCHIVE_REQUEST_CONFLICT" });
    await jobs.closeAll();
  });
  it("restores only the current owner's recorder and keeps processing alive across F5", async () => {
    const { jobs, advance } = setup(); const first = await jobs.create(actor, recorder, 1, input);
    advance(76_000); await jobs.expire();
    expect(await jobs.find(actor, recorder, requestId)).toMatchObject({ id: first.id, state: "processing" });
    expect(await jobs.find({ ...actor, id: "another-owner" }, recorder)).toBeNull();
    expect(await jobs.find(actor, { ...recorder, id: "another-recorder" })).toBeNull();
    advance(200_000); await jobs.expire();
    await expect(jobs.get(first.id, "token")).rejects.toMatchObject({ code: "ARCHIVE_EXPIRED" });
  });
  it("remembers cancellation before POST arrives without starting an encoder", async () => {
    const { jobs, dependencies } = setup(); await jobs.cancelRequest(actor, recorder, requestId);
    await expect(jobs.create(actor, recorder, 1, input)).rejects.toMatchObject({ code: "ARCHIVE_CANCELLED" });
    expect(dependencies.encode).not.toHaveBeenCalled();
  });
  it("deduplicates matching parameters and cancellation follows every request alias", async () => {
    const { jobs, dependencies } = setup(); const a = await jobs.create(actor, recorder, 1, input);
    const alias = "50000000-0000-4000-8000-000000000002";
    const b = await jobs.create(actor, recorder, 1, { ...input, requestId: alias }); expect(b.id).toBe(a.id);
    await jobs.cancelRequest(actor, recorder, alias);
    for (const id of [requestId, alias]) await expect(jobs.create(actor, recorder, 1, { ...input, requestId: id })).rejects.toMatchObject({ code: "ARCHIVE_CANCELLED" });
    expect(dependencies.encode).toHaveBeenCalledTimes(1);
  });
  it("does not reveal or cancel another owner's request and preserves global encoder capacity", async () => {
    const { jobs } = setup(); const first = await jobs.create(actor, recorder, 1, input); const other = { ...actor, id: "other" };
    await jobs.cancelRequest(other, recorder, requestId);
    expect(await jobs.get(first.id, "token")).toHaveProperty("state", "processing");
    await expect(jobs.create(other, recorder, 1, { ...input, requestId: "50000000-0000-4000-8000-000000000003" })).rejects.toMatchObject({ code: "ARCHIVE_BUSY" });
    await jobs.closeAll();
  });
  it("retains a ready file across reload and holds only a bounded in-flight download at expiry", async () => {
    const { jobs, ready, advance, dependencies } = setup(); const created = await jobs.create(actor, recorder, 1, input); await ready();
    expect(await jobs.find(actor, recorder)).toMatchObject({ id: created.id, state: "ready" });
    advance(15 * 60_000 - 1000); await jobs.file(created.id, "token"); advance(2000); await jobs.expire();
    expect(dependencies.remove).not.toHaveBeenCalled(); expect(await jobs.get(created.id, "token")).toHaveProperty("state", "ready");
    advance(120_000); await jobs.expire(); expect(dependencies.remove).toHaveBeenCalledWith(created.id);
  });
  it("clears the download hold on disconnect so expiry can remove files", async () => {
    const { jobs, ready, advance, dependencies } = setup(); const created = await jobs.create(actor, recorder, 1, input); await ready();
    advance(899_000); await jobs.file(created.id, "token"); jobs.finishDownload(created.id); advance(2000); await jobs.expire();
    expect(dependencies.remove).toHaveBeenCalledWith(created.id);
  });
  it("reports source bytes and encoding separately without inventing a source percentage", async () => {
    const { jobs, dependencies } = setup(); const created = await jobs.create(actor, recorder, 1, input);
    const progress = vi.mocked(dependencies.encode).mock.calls[0]![5];
    progress({ phase: "source", bytes: 2048 }); expect(await jobs.get(created.id, "token")).toMatchObject({ phase: "source", sourceBytes: 2048, progress: 0 });
    progress({ phase: "encoding", seconds: 30 }); expect(await jobs.get(created.id, "token")).toMatchObject({ phase: "encoding", progress: 50 });
    await jobs.closeAll();
  });
});
