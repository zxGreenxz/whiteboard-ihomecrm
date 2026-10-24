import { describe, expect, it, vi } from "vitest";
import { ArchiveJobs, parseArchiveRange, type ArchiveDependencies } from "../src/cameraArchive.js";
import { liveConfigSchema, LiveError } from "../src/cameraLive.js";
import { archiveArguments, playbackUrl } from "../src/cameraArchiveMedia.js";

const recorder = liveConfigSchema.parse({
  supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "fixture-publishable-key", origins: ["https://crm.example.test"],
  recorders: [{ id: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1], rtspOrigin: "rtsp://10.0.0.1:554", username: "fixture", password: "fixture-secret", archiveEnabled: true }],
}).recorders[0]!;
const input = { start: "2026-10-20T08:00:00+07:00", end: "2026-10-20T08:01:00+07:00", purpose: "export" as const };
const actor = { id: "40000000-0000-4000-8000-000000000001", expiresAt: Date.parse("2026-10-24T12:00:00Z") };
function setup() {
  let now = Date.parse("2026-10-24T00:00:00Z");
  const dependencies: ArchiveDependencies = {
    authorize: vi.fn(async () => actor), now: () => now,
    encode: vi.fn(async () => ({ bytes: 4096, durationSeconds: 60, sha256: "a".repeat(64) })),
    remove: vi.fn(async () => {}), audit: vi.fn(), fatal: vi.fn(),
  };
  return { dependencies, jobs: new ArchiveJobs(dependencies), advance: (ms: number) => { now += ms; } };
}
describe("camera archive range and authorization", () => {
  it("requests the selected channel and recorder-local times without putting credentials in process arguments", () => {
    const range = parseArchiveRange(input, Date.parse("2026-10-24T00:00:00Z"));
    const url = new URL(playbackUrl(recorder, 1, range));
    expect(url.pathname).toBe("/cam/playback"); expect(url.searchParams.get("starttime")).toBe("2026_10_20_08_00_00");
    expect(url.searchParams.get("endtime")).toBe("2026_10_20_08_01_00"); expect(url.searchParams.get("channel")).toBe("1");
    const args = archiveArguments("/private/input.url", "/private/video.mp4", range);
    expect(args).toContain("concat"); expect(args).toContain("60"); expect(args.join(" ")).not.toContain("fixture-secret");
  });
  it("normalizes explicit offsets and rejects invalid, future, oversized or extra input", () => {
    expect(parseArchiveRange(input, Date.parse("2026-10-24T00:00:00Z"))).toMatchObject({ start: "2026-10-20T01:00:00.000Z", durationSeconds: 60 });
    for (const value of [{ ...input, end: input.start }, { ...input, start: "2026-02-30T00:00:00+07:00" }, { ...input, end: "2026-10-20T09:00:00+07:00" }, { ...input, end: "2027-01-01T00:00:00Z" }, { ...input, start: "2026-10-20T08:00:00" }, { ...input, url: "http://untrusted" }]) {
      expect(() => parseArchiveRange(value, Date.parse("2026-10-24T00:00:00Z"))).toThrow("INVALID_ARCHIVE_RANGE");
    }
  });
  it("denies unconfigured channels and reserves capacity before encoding", async () => {
    const { jobs, dependencies } = setup();
    await expect(jobs.create(actor, recorder, 2, input)).rejects.toMatchObject({ code: "CAMERA_NOT_CONFIGURED" });
    vi.mocked(dependencies.encode).mockImplementation(() => new Promise(() => {}));
    await jobs.create(actor, recorder, 1, input);
    await expect(jobs.create(actor, recorder, 1, input)).rejects.toMatchObject({ code: "ARCHIVE_BUSY" });
    expect(dependencies.encode).toHaveBeenCalledTimes(1);
  });
  it("rechecks actor and building for status and download, without exposing paths or credentials", async () => {
    const { jobs, dependencies } = setup(); const created = await jobs.create(actor, recorder, 1, input);
    await vi.waitFor(async () => expect((await jobs.get(created.id, "token")).state).toBe("ready"));
    const result = await jobs.get(created.id, "token"); expect(JSON.stringify(result)).not.toMatch(/fixture-secret|rtsp:|password|location/);
    vi.mocked(dependencies.authorize).mockResolvedValue({ ...actor, id: "other" });
    await expect(jobs.get(created.id, "other")).rejects.toMatchObject({ code: "SESSION_OWNER_MISMATCH" });
    await expect(jobs.file(created.id, "other")).rejects.toMatchObject({ code: "SESSION_OWNER_MISMATCH" });
    vi.mocked(dependencies.authorize).mockRejectedValue(new LiveError(403, "CAMERA_ACCESS_DENIED"));
    await expect(jobs.file(created.id, "revoked")).rejects.toMatchObject({ code: "CAMERA_ACCESS_DENIED" });
  });
  it("cancels abandoned work, removes late output and never serves it", async () => {
    const { jobs, dependencies, advance } = setup(); let finish!: (value: { bytes: number; durationSeconds: number; sha256: string }) => void;
    vi.mocked(dependencies.encode).mockImplementation(() => new Promise((done) => { finish = done; }));
    const created = await jobs.create(actor, recorder, 1, input);
    advance(75001); const expired = jobs.expire();
    expect(vi.mocked(dependencies.encode).mock.calls[0]?.[4].aborted).toBe(true);
    finish({ bytes: 4096, durationSeconds: 60, sha256: "a".repeat(64) });
    await expired;
    await vi.waitFor(() => expect(dependencies.remove).toHaveBeenCalledWith(created.id));
    await expect(jobs.get(created.id, "token")).rejects.toMatchObject({ code: "ARCHIVE_EXPIRED" });
  });
  it("does not serve a short recording as a complete requested interval", async () => {
    const { jobs, dependencies } = setup(); vi.mocked(dependencies.encode).mockResolvedValue({ bytes: 4096, durationSeconds: 12, sha256: "a".repeat(64) });
    const created = await jobs.create(actor, recorder, 1, input);
    await vi.waitFor(async () => expect((await jobs.get(created.id, "token")).state).toBe("failed"));
    expect((await jobs.get(created.id, "token")).code).toBe("ARCHIVE_INCOMPLETE");
    await expect(jobs.file(created.id, "token")).rejects.toMatchObject({ code: "ARCHIVE_NOT_READY" });
  });
  it("expires ready files and does not revive a job when authorization returns after expiry", async () => {
    const { jobs, dependencies, advance } = setup(); const created = await jobs.create(actor, recorder, 1, input);
    await vi.waitFor(async () => expect((await jobs.get(created.id, "token")).state).toBe("ready"));
    let authorize!: (value: typeof actor) => void;
    vi.mocked(dependencies.authorize).mockImplementation(() => new Promise((done) => { authorize = done; }));
    const pending = jobs.file(created.id, "token"); advance(15 * 60_000 + 1); await jobs.expire(); authorize(actor);
    await expect(pending).rejects.toMatchObject({ code: "ARCHIVE_EXPIRED" }); expect(dependencies.remove).toHaveBeenCalledWith(created.id);
  });
});
