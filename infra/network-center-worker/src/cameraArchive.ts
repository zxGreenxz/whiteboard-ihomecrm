import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LiveError, type LiveActor, type LiveRecorder } from "./cameraLive.js";

const rangeSchema = z.object({
  start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }),
  purpose: z.enum(["preview", "export"]),
  resolution: z.enum(["720p", "1080p", "original"]).default("720p"),
}).strict();
export const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_LEASE_MS = 75_000;
const RETAIN_MS = 15 * 60_000;
export interface ArchiveRange { start: string; end: string; purpose: "preview" | "export"; resolution: "720p" | "1080p" | "original"; durationSeconds: number }
export function parseArchiveRange(value: unknown, now = Date.now()): ArchiveRange {
  const parsed = rangeSchema.safeParse(value);
  if (!parsed.success) throw new LiveError(400, "INVALID_ARCHIVE_RANGE");
  const { start, end, purpose, resolution } = parsed.data;
  const from = Date.parse(start); const to = Date.parse(end); const durationSeconds = (to - from) / 1000;
  if (!Number.isInteger(durationSeconds) || from % 1000 !== 0 || to % 1000 !== 0 || durationSeconds < 1 || durationSeconds > (purpose === "preview" ? 600 : 1800) || to > now || from < Date.UTC(2000, 0, 1)) throw new LiveError(400, "INVALID_ARCHIVE_RANGE");
  return { start: new Date(from).toISOString(), end: new Date(to).toISOString(), purpose, resolution: purpose === "preview" ? "720p" : resolution, durationSeconds };
}
export interface ArchiveResult { bytes: number; durationSeconds: number; sha256: string }
export interface ArchiveDependencies {
  authorize(token: string, recorder: LiveRecorder): Promise<LiveActor>;
  encode(id: string, recorder: LiveRecorder, channel: number, range: ArchiveRange, signal: AbortSignal, progress: (seconds: number) => void): Promise<ArchiveResult>;
  remove(id: string): Promise<void>;
  audit(event: string, details: Record<string, string | number>): void;
  fatal(): void;
  now?: () => number;
}
interface ArchiveJob {
  id: string; actorId: string; recorder: LiveRecorder; channel: number; range: ArchiveRange;
  state: "processing" | "ready" | "failed"; progress: number; expiresAt: number; createdAt: number;
  abort: AbortController; task?: Promise<void>; closed: boolean; result?: ArchiveResult; code?: string;
}
export class ArchiveJobs {
  private readonly jobs = new Map<string, ArchiveJob>();
  private readonly now: () => number;
  constructor(private readonly dependencies: ArchiveDependencies) { this.now = dependencies.now ?? Date.now; }
  async create(actor: LiveActor, recorder: LiveRecorder, channel: number, value: unknown) {
    const range = parseArchiveRange(value, this.now());
    if (!recorder.archiveEnabled) throw new LiveError(503, "ARCHIVE_NOT_CONFIGURED");
    if (!recorder.channels.includes(channel)) throw new LiveError(404, "CAMERA_NOT_CONFIGURED");
    if (actor.expiresAt <= this.now()) throw new LiveError(401, "SESSION_EXPIRED");
    // One encoder for the whole gateway; reserve synchronously before any await.
    if (this.jobs.size >= 4 || [...this.jobs.values()].some((job) => job.state === "processing") || [...this.jobs.values()].filter((job) => job.actorId === actor.id).length >= 2) throw new LiveError(429, "ARCHIVE_BUSY");
    const job: ArchiveJob = { id: randomUUID(), actorId: actor.id, recorder, channel, range, state: "processing", progress: 0, expiresAt: Math.min(this.now() + ARCHIVE_LEASE_MS, actor.expiresAt), createdAt: this.now(), abort: new AbortController(), closed: false };
    this.jobs.set(job.id, job);
    this.dependencies.audit("archive.created", { jobId: job.id, actorId: actor.id, recorderId: recorder.id, channel, start: range.start, end: range.end, purpose: range.purpose });
    job.task = this.run(job);
    return this.publicJob(job);
  }
  private publicJob(job: ArchiveJob) {
    return { id: job.id, recorderId: job.recorder.id, channel: job.channel, start: job.range.start, end: job.range.end, purpose: job.range.purpose, resolution: job.range.resolution, state: job.state, progress: job.progress, expiresAt: job.expiresAt, ...(job.code ? { code: job.code } : {}), ...(job.result ? { ...job.result, filename: `camera-${job.recorder.id}-ch${job.channel}-${job.range.start.replace(/[:.]/gu, "-")}-${job.range.resolution}.mp4` } : {}) };
  }
  private async run(job: ArchiveJob) {
    try {
      const result = await this.dependencies.encode(job.id, job.recorder, job.channel, job.range, job.abort.signal, (seconds) => {
        if (!job.closed) job.progress = Math.min(99, Math.max(0, Math.floor(seconds / job.range.durationSeconds * 100)));
      });
      if (job.closed || job.expiresAt <= this.now()) return;
      if (result.bytes < 1024 || result.bytes >= ARCHIVE_MAX_BYTES || !/^[a-f0-9]{64}$/u.test(result.sha256)) throw new LiveError(502, "ARCHIVE_TOO_LARGE");
      const tolerance = Math.min(2, job.range.durationSeconds * 0.05 + 0.2);
      if (!Number.isFinite(result.durationSeconds) || Math.abs(result.durationSeconds - job.range.durationSeconds) > tolerance) throw new LiveError(502, "ARCHIVE_INCOMPLETE");
      job.result = result; job.state = "ready"; job.progress = 100; job.expiresAt = this.now() + RETAIN_MS;
      this.dependencies.audit("archive.ready", { jobId: job.id, sha256: result.sha256, bytes: result.bytes, durationSeconds: result.durationSeconds });
    } catch (error) {
      job.state = "failed"; job.code = error instanceof LiveError ? error.code : "RECORDING_UNAVAILABLE";
      this.dependencies.audit("archive.failed", { jobId: job.id, code: job.code });
    } finally {
      if (job.state !== "ready" || job.closed) await this.remove(job.id);
    }
  }
  private async authorized(id: string, token: string) {
    const job = this.jobs.get(id);
    if (!job || job.closed || job.expiresAt <= this.now()) throw new LiveError(410, "ARCHIVE_EXPIRED");
    const actor = await this.dependencies.authorize(token, job.recorder);
    if (actor.id !== job.actorId) throw new LiveError(403, "SESSION_OWNER_MISMATCH");
    if (job.closed || job.expiresAt <= this.now() || actor.expiresAt <= this.now()) throw new LiveError(410, "ARCHIVE_EXPIRED");
    if (job.state === "processing") job.expiresAt = Math.min(this.now() + ARCHIVE_LEASE_MS, actor.expiresAt, job.createdAt + (job.range.durationSeconds * 2 + 120) * 1000);
    return job;
  }
  async get(id: string, token: string) { return this.publicJob(await this.authorized(id, token)); }
  async file(id: string, token: string) {
    const job = await this.authorized(id, token);
    if (job.state !== "ready" || !job.result) throw new LiveError(409, "ARCHIVE_NOT_READY");
    this.dependencies.audit("archive.download", { jobId: id, actorId: job.actorId, sha256: job.result.sha256 });
    return this.publicJob(job);
  }
  async stop(id: string, token: string) { await this.close(await this.authorized(id, token)); }
  async expire() { await Promise.all([...this.jobs.values()].filter((job) => job.expiresAt <= this.now()).map((job) => this.close(job))); }
  async closeAll() { await Promise.all([...this.jobs.values()].map((job) => this.close(job))); }
  private async remove(id: string) { try { await this.dependencies.remove(id); } catch { this.dependencies.fatal(); } }
  private async close(job: ArchiveJob) {
    if (job.closed) return;
    job.closed = true; job.abort.abort();
    await job.task; await this.remove(job.id); this.jobs.delete(job.id);
  }
}
