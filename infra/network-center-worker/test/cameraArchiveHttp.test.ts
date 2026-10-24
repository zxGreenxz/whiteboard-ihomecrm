import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ArchiveJobs, type ArchiveDependencies } from "../src/cameraArchive.js";
import { createLiveServer, LiveError, liveConfigSchema, type LiveDependencies } from "../src/cameraLive.js";

const config = liveConfigSchema.parse({
  supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "fixture-publishable-key", origins: ["https://crm.example.test"],
  recorders: [{ id: "10000000-0000-4000-8000-000000000001", organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001", channels: [1], rtspOrigin: "rtsp://10.0.0.1:554", username: "fixture", password: "fixture-secret", archiveEnabled: true }],
});
const actor = { id: "40000000-0000-4000-8000-000000000001", expiresAt: Date.now() + 3600_000 };
const input = { start: "2026-10-20T08:00:00+07:00", end: "2026-10-20T08:01:00+07:00", purpose: "export" };
describe("camera archive HTTP workflow", () => {
  it("creates, polls, downloads and deletes with scoped authentication on every operation", async () => {
    const authorize = vi.fn(async () => actor);
    const live: LiveDependencies = { authorize, start: vi.fn(), stop: vi.fn(), fatal: vi.fn() };
    const archive: ArchiveDependencies = { authorize, encode: vi.fn(async () => ({ bytes: 2048, durationSeconds: 60, sha256: "a".repeat(64) })), remove: vi.fn(), audit: vi.fn(), fatal: vi.fn() };
    const jobs = new ArchiveJobs(archive); const open = vi.fn(() => Readable.from([Buffer.alloc(2048)]));
    const { server } = createLiveServer(config, live, { jobs, open });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const origin = `http://127.0.0.1:${address.port}/camera-live/v1`;
    const headers = { Origin: config.origins[0]!, Authorization: "Bearer fixture-token-long-enough", "Content-Type": "application/json" };
    try {
      const path = `/recorders/${config.recorders[0]!.id}/channels/1/archive`;
      expect((await fetch(origin + path, { method: "POST", headers: { Origin: headers.Origin }, body: JSON.stringify(input) })).status).toBe(401);
      expect(archive.encode).not.toHaveBeenCalled();
      const created = await fetch(origin + path, { method: "POST", headers, body: JSON.stringify(input) }); expect(created.status).toBe(202);
      const job = await created.json() as { id: string };
      const status = await fetch(`${origin}/archive/${job.id}`, { headers }); expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ state: "ready", channel: 1, start: "2026-10-20T01:00:00.000Z" });
      const file = await fetch(`${origin}/archive/${job.id}/file`, { headers }); expect(file.headers.get("content-type")).toBe("video/mp4"); expect(file.headers.get("cache-control")).toBe("no-store");
      expect((await file.arrayBuffer()).byteLength).toBe(2048);
      authorize.mockRejectedValueOnce(new LiveError(403, "CAMERA_ACCESS_DENIED"));
      expect((await fetch(`${origin}/archive/${job.id}/file`, { headers })).status).toBe(403); expect(open).toHaveBeenCalledTimes(1);
      authorize.mockResolvedValueOnce({ ...actor, id: "other" });
      expect((await fetch(`${origin}/archive/${job.id}`, { method: "DELETE", headers })).status).toBe(403);
      expect((await fetch(`${origin}/archive/${job.id}`, { method: "DELETE", headers })).status).toBe(200);
      expect((await fetch(`${origin}/archive/${job.id}/file`, { headers })).status).toBe(410);
      expect(authorize).toHaveBeenCalledTimes(6); expect(archive.remove).toHaveBeenCalledWith(job.id);
    } finally { await new Promise<void>((done) => server.close(() => done())); await jobs.closeAll(); }
  });
});
