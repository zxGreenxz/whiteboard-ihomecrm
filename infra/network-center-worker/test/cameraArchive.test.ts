import { describe, expect, it, vi } from "vitest";
import { ArchiveJobs, parseArchiveRange, type ArchiveDependencies } from "../src/cameraArchive.js";
import { liveConfigSchema, LiveError } from "../src/cameraLive.js";
import { archiveArguments, recorderTime, recordingStart, recordingEnd, ArchiveFrameCoverage, saveRecording } from "../src/cameraArchiveMedia.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const recorder = liveConfigSchema.parse({
  supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "fixture-publishable-key", origins: ["https://crm.example.test"],
  recorders: [{ id: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1], rtspOrigin: "rtsp://10.0.0.1:554", archiveOrigin: "http://10.0.0.1:80", username: "fixture", password: "fixture-secret", archiveEnabled: true }],
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
  it("requires an explicit private HTTP origin before enabling archive access", () => {
    for (const archiveOrigin of [undefined,"http://example.com","http://127.0.0.1","http://10.0.0.1@public.example","http://10.0.0.1/other"]) {
      expect(liveConfigSchema.safeParse({supabaseUrl:"https://tryymsxyyckgbrmmvozx.supabase.co",publishableKey:"fixture-publishable-key",origins:["https://crm.example.test"],recorders:[{...recorder,archiveOrigin}]}).success).toBe(false);
    }
  });
  it("trims absolute native timestamps without resetting a missing prefix or leaking credentials", () => {
    const range = parseArchiveRange(input, Date.parse("2026-10-24T00:00:00Z"));
    expect(recorderTime(range.start)).toBe("2026-10-20 08:00:00");
    expect(recordingStart(range)).toBe("2026-10-20 07:59:55");
    expect(recordingEnd(range)).toBe("2026-10-20 08:01:05");
    expect(recordingEnd({ ...range, end: "2026-10-20T16:59:58.000Z" })).toBe("2026-10-21 00:00:03");
    const args = archiveArguments("/private/source.dav", "/private/video.mp4", range);
    expect(args).toContain("dhav"); expect(args).toContain("-copyts"); expect(args).toContain("60");
    expect(args[args.indexOf("-vf")+1]).toContain(`setpts=PTS-${Date.parse("2026-10-20T08:00:00Z")/1000}/TB`);
    expect(args.join(" ")).not.toMatch(/STARTPTS|fixture-secret|rtsp:|http:/u);
  });
  it("defaults to HD, bounds both dimensions without upscaling and only accepts known resolutions", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    const filter = (resolution?: string, purpose = "export") => {
      const range = parseArchiveRange({ ...input, purpose, ...(resolution ? { resolution } : {}) }, now);
      const args = archiveArguments("/private/source.dav", "/private/video.mp4", range);
      return { range, filter: args[args.indexOf("-vf") + 1]! };
    };
    expect(filter().range.resolution).toBe("720p");
    expect(filter().filter).toContain("scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2");
    expect(filter("1080p").filter).toContain("min(1920,iw)':h='min(1080,ih)");
    expect(filter("original").filter).not.toContain("scale=");
    expect(filter("original", "preview").range.resolution).toBe("720p");
    expect(() => filter("720p,untrusted-filter")).toThrow("INVALID_ARCHIVE_RANGE");
  });
  it("rejects decoded missing prefixes, trailing video and internal timeline gaps", () => {
    const make = (times: number[]) => {
      const coverage = new ArchiveFrameCoverage();
      coverage.accept("[Parsed_showinfo_2 @ fixed] config in time_base: 1/1000, frame_rate: 25/1");
      times.forEach((time,index) => coverage.accept(`[Parsed_showinfo_2 @ fixed] n: ${index} pts: ${Math.round(time*1000)} pts_time:${time} duration: 1`));
      return coverage;
    };
    const complete = Array.from({length:125},(_,index)=>index/25);
    expect(make(complete).assertComplete(5)).toBe(5);
    expect(()=>make(complete.slice(25)).assertComplete(5)).toThrow("ARCHIVE_INCOMPLETE");
    expect(()=>make(complete.slice(0,100)).assertComplete(5)).toThrow("ARCHIVE_INCOMPLETE");
    expect(()=>make(complete.filter(t=>t<2||t>=3)).assertComplete(5)).toThrow("ARCHIVE_INCOMPLETE");
    expect(()=>make([1792835405,1792835406]).assertComplete(5)).toThrow("ARCHIVE_INCOMPLETE");
  });
  it("bounds native recording bytes even without a Content-Length and closes the file on abort", async () => {
    const directory=await mkdtemp(join(tmpdir(),"camera-native-"));
    try {
      const controller=new AbortController();
      const bytes=new Uint8Array(48).fill(7);
      await saveRecording(new Response(bytes),join(directory,"ok.dav"),controller.signal,64);
      expect(await readFile(join(directory,"ok.dav"))).toEqual(Buffer.from(bytes));
      await expect(saveRecording(new Response(new Uint8Array(65)),join(directory,"large.dav"),controller.signal,64)).rejects.toMatchObject({code:"ARCHIVE_TOO_LARGE"});
      controller.abort();
      await expect(saveRecording(new Response(bytes),join(directory,"abort.dav"),controller.signal,64)).rejects.toThrow();
    } finally { await rm(directory,{recursive:true,force:true}); }
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
