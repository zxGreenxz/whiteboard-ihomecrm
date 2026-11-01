import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LiveError, type LiveActor, type LiveRecorder } from "./cameraLive.js";

const rangeSchema = z.object({
  start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }),
  purpose: z.enum(["preview", "export"]),
  resolution: z.enum(["480p", "720p", "1080p", "original"]).default("480p"),
  requestId: z.string().uuid().optional(),
}).strict();
export const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_LEASE_MS = 75_000;
const RETAIN_MS = 15 * 60_000;
const REQUEST_RETAIN_MS = 90 * 60_000;
const DOWNLOAD_MS = 120_000;
export interface ArchiveRange { start: string; end: string; purpose: "preview" | "export"; resolution: "480p" | "720p" | "1080p" | "original"; durationSeconds: number }
export function parseArchiveRange(value: unknown, now = Date.now()): ArchiveRange {
  const parsed = rangeSchema.safeParse(value);
  if (!parsed.success) throw new LiveError(400, "INVALID_ARCHIVE_RANGE");
  const { start, end, purpose, resolution } = parsed.data;
  const from = Date.parse(start); const to = Date.parse(end); const durationSeconds = (to - from) / 1000;
  if (!Number.isInteger(durationSeconds) || from % 1000 !== 0 || to % 1000 !== 0 || durationSeconds < 1 || durationSeconds > (purpose === "preview" ? 600 : 1800) || to > now || from < Date.UTC(2000, 0, 1)) throw new LiveError(400, "INVALID_ARCHIVE_RANGE");
  return { start: new Date(from).toISOString(), end: new Date(to).toISOString(), purpose, resolution: purpose === "preview" ? "720p" : resolution, durationSeconds };
}
export interface ArchiveResult { bytes: number; durationSeconds: number; sha256: string }
export type ArchiveProgress = { phase: "source"; bytes: number; totalBytes?: number } | { phase: "encoding"; seconds: number } | { phase: "verifying" };
export interface ArchiveDependencies {
  authorize(token: string, recorder: LiveRecorder): Promise<LiveActor>;
  encode(id: string, recorder: LiveRecorder, channel: number, range: ArchiveRange, signal: AbortSignal, progress: (update: number | ArchiveProgress) => void): Promise<ArchiveResult>;
  remove(id: string): Promise<void>;
  audit(event: string, details: Record<string, string | number>): void;
  fatal(): void;
  now?: () => number;
}
interface ArchiveJob {
  id: string; actorId: string; recorder: LiveRecorder; channel: number; range: ArchiveRange;
  state: "processing" | "ready" | "failed"; progress: number; expiresAt: number; createdAt: number;
  abort: AbortController; task?: Promise<void>; closed: boolean; working: boolean; result?: ArchiveResult; code?: string;
  requestId?: string; phase: "source" | "encoding" | "verifying" | "ready"; sourceBytes: number; sourceTotalBytes?: number; downloadUntil?: number;
}
interface ArchiveRequest { actorId: string; fingerprint?: string; jobId?: string; cancelled: boolean; expiresAt: number }
export class ArchiveJobs {
  private readonly jobs = new Map<string, ArchiveJob>();
  private readonly requests = new Map<string, ArchiveRequest>();
  private readonly now: () => number;
  constructor(private readonly dependencies: ArchiveDependencies) { this.now = dependencies.now ?? Date.now; }
  async create(actor: LiveActor, recorder: LiveRecorder, channel: number, value: unknown) {
    const range = parseArchiveRange(value, this.now());
    const { requestId } = rangeSchema.parse(value);
    if (!recorder.archiveEnabled) throw new LiveError(503, "ARCHIVE_NOT_CONFIGURED");
    if (!recorder.channels.includes(channel)) throw new LiveError(404, "CAMERA_NOT_CONFIGURED");
    if (actor.expiresAt <= this.now()) throw new LiveError(401, "SESSION_EXPIRED");
    this.pruneRequests();
    const key = requestId && this.requestKey(actor, recorder, requestId);
    const fingerprint = JSON.stringify([channel, range.start, range.end, range.purpose, range.resolution]);
    const previous = key ? this.requests.get(key) : undefined;
    if (previous?.cancelled) throw new LiveError(410, "ARCHIVE_CANCELLED");
    if (previous?.fingerprint && previous.fingerprint !== fingerprint) throw new LiveError(409, "ARCHIVE_REQUEST_CONFLICT");
    if (previous?.jobId) {
      const job = this.jobs.get(previous.jobId);
      if (!job || !this.alive(job)) throw new LiveError(410, "ARCHIVE_EXPIRED");
      return this.publicJob(job);
    }
    if (key) this.checkRequestCapacity(actor);
    const matching = requestId && [...this.jobs.values()].find((job) => this.alive(job) && job.state !== "failed" && job.actorId === actor.id && job.recorder.id === recorder.id && JSON.stringify([job.channel, job.range.start, job.range.end, job.range.purpose, job.range.resolution]) === fingerprint);
    if (key && matching) {
      this.requests.set(key, { actorId: actor.id, fingerprint, jobId: matching.id, cancelled: false, expiresAt: this.now() + REQUEST_RETAIN_MS });
      return this.publicJob(matching);
    }
    // Reserve synchronously before encoding; source + output also consume capacity.
    const occupied = [...this.jobs.values()].filter((job) => job.state !== "failed" || job.working || job.closed);
    if (occupied.length >= 4 || occupied.some((job) => job.working || job.closed) || occupied.filter((job) => job.actorId === actor.id).length >= 2 || occupied.reduce((bytes, job) => bytes + (job.result?.bytes ?? 2 * ARCHIVE_MAX_BYTES), 0) + 2 * ARCHIVE_MAX_BYTES > 4 * ARCHIVE_MAX_BYTES) throw new LiveError(429, "ARCHIVE_BUSY");
    const job: ArchiveJob = { id: randomUUID(), actorId: actor.id, recorder, channel, range, state: "processing", phase: "source", sourceBytes: 0, progress: 0, expiresAt: Math.min(this.now() + (requestId ? (range.durationSeconds * 2 + 120) * 1000 : ARCHIVE_LEASE_MS), actor.expiresAt), createdAt: this.now(), abort: new AbortController(), closed: false, working: true, ...(requestId ? { requestId } : {}) };
    this.jobs.set(job.id, job);
    if (key) this.requests.set(key, { actorId: actor.id, fingerprint, jobId: job.id, cancelled: false, expiresAt: this.now() + REQUEST_RETAIN_MS });
    this.dependencies.audit("archive.created", { jobId: job.id, actorId: actor.id, recorderId: recorder.id, channel, start: range.start, end: range.end, purpose: range.purpose });
    job.task = this.run(job);
    return this.publicJob(job);
  }
  private publicJob(job: ArchiveJob) {
    return { id: job.id, recorderId: job.recorder.id, channel: job.channel, start: job.range.start, end: job.range.end, purpose: job.range.purpose, resolution: job.range.resolution, state: job.state, phase: job.phase, sourceBytes: job.sourceBytes, ...(job.sourceTotalBytes ? { sourceTotalBytes: job.sourceTotalBytes } : {}), ...(job.requestId ? { requestId: job.requestId } : {}), progress: job.progress, expiresAt: job.expiresAt, ...(job.code ? { code: job.code } : {}), ...(job.result ? { ...job.result, filename: `camera-${job.recorder.id}-ch${job.channel}-${job.range.start.replace(/[:.]/gu, "-")}-${job.range.resolution}.mp4` } : {}) };
  }
  private requestKey(actor: LiveActor, recorder: LiveRecorder, id: string) { if (!z.string().uuid().safeParse(id).success) throw new LiveError(400, "INVALID_ARCHIVE_RANGE"); return `${actor.id}:${recorder.id}:${id}`; }
  private pruneRequests() { for (const [key, request] of this.requests) if (request.expiresAt <= this.now()) this.requests.delete(key); }
  private checkRequestCapacity(actor: LiveActor) { if (this.requests.size >= 256 || [...this.requests.values()].filter((request) => request.actorId === actor.id).length >= 32) throw new LiveError(429, "ARCHIVE_BUSY"); }
  private alive(job: ArchiveJob) { return !job.closed && (job.expiresAt > this.now() || (job.downloadUntil ?? 0) > this.now()); }
  async find(actor: LiveActor, recorder: LiveRecorder, requestId?: string) {
    if (actor.expiresAt <= this.now()) throw new LiveError(401, "SESSION_EXPIRED");
    if (requestId) {
      const request = this.requests.get(this.requestKey(actor, recorder, requestId));
      if (!request) return null;
      if (request.cancelled) throw new LiveError(410, "ARCHIVE_CANCELLED");
      const job = request.jobId ? this.jobs.get(request.jobId) : undefined;
      if (!job || !this.alive(job)) throw new LiveError(410, "ARCHIVE_EXPIRED");
      return this.publicJob(job);
    }
    const own = [...this.jobs.values()].filter((job) => job.actorId === actor.id && job.recorder.id === recorder.id && job.range.purpose === "export" && this.alive(job));
    own.sort((a, b) => Number(b.state === "processing") - Number(a.state === "processing") || b.createdAt - a.createdAt);
    return own[0] ? this.publicJob(own[0]) : null;
  }
  async cancelRequest(actor: LiveActor, recorder: LiveRecorder, requestId: string) {
    if (actor.expiresAt <= this.now()) throw new LiveError(401, "SESSION_EXPIRED");
    this.pruneRequests(); const key = this.requestKey(actor, recorder, requestId); const previous = this.requests.get(key);
    if (!previous) this.checkRequestCapacity(actor);
    this.requests.set(key, { ...previous, actorId: actor.id, cancelled: true, expiresAt: this.now() + REQUEST_RETAIN_MS });
    const job = previous?.jobId ? this.jobs.get(previous.jobId) : undefined;
    if (job) await this.close(job, true);
  }
  private async run(job: ArchiveJob) {
    try {
      const result = await this.dependencies.encode(job.id, job.recorder, job.channel, job.range, job.abort.signal, (update) => {
        if (job.closed) return;
        const value = typeof update === "number" ? { phase: "encoding" as const, seconds: update } : update;
        job.phase = value.phase;
        if (value.phase === "source") { job.sourceBytes = value.bytes; if (value.totalBytes === undefined) delete job.sourceTotalBytes; else job.sourceTotalBytes = value.totalBytes; }
        if (value.phase === "encoding") job.progress = Math.min(99, Math.max(0, Math.floor(value.seconds / job.range.durationSeconds * 100)));
      });
      if (job.closed || job.expiresAt <= this.now()) return;
      if (result.bytes < 1024 || result.bytes >= ARCHIVE_MAX_BYTES || !/^[a-f0-9]{64}$/u.test(result.sha256)) throw new LiveError(502, "ARCHIVE_TOO_LARGE");
      const tolerance = Math.min(2, job.range.durationSeconds * 0.05 + 0.2);
      if (!Number.isFinite(result.durationSeconds) || Math.abs(result.durationSeconds - job.range.durationSeconds) > tolerance) throw new LiveError(502, "ARCHIVE_INCOMPLETE");
      job.result = result; job.state = "ready"; job.phase = "ready"; job.progress = 100; job.expiresAt = this.now() + RETAIN_MS;
      this.dependencies.audit("archive.ready", { jobId: job.id, sha256: result.sha256, bytes: result.bytes, durationSeconds: result.durationSeconds });
    } catch (error) {
      job.state = "failed"; job.code = error instanceof LiveError ? error.code : "RECORDING_UNAVAILABLE";
      job.expiresAt = this.now() + 120_000;
      this.dependencies.audit("archive.failed", { jobId: job.id, code: job.code });
    } finally {
      if (job.state !== "ready" || job.closed) await this.remove(job.id);
      job.working = false;
    }
  }
  private async authorized(id: string, token: string) {
    const job = this.jobs.get(id);
    if (!job || !this.alive(job)) throw new LiveError(410, "ARCHIVE_EXPIRED");
    const actor = await this.dependencies.authorize(token, job.recorder);
    if (actor.id !== job.actorId) throw new LiveError(403, "SESSION_OWNER_MISMATCH");
    if (!this.alive(job) || actor.expiresAt <= this.now()) throw new LiveError(410, "ARCHIVE_EXPIRED");
    if (job.state === "processing") job.expiresAt = Math.min(job.requestId ? Infinity : this.now() + ARCHIVE_LEASE_MS, actor.expiresAt, job.createdAt + (job.range.durationSeconds * 2 + 120) * 1000);
    return job;
  }
  async get(id: string, token: string) { return this.publicJob(await this.authorized(id, token)); }
  async file(id: string, token: string) {
    const job = await this.authorized(id, token);
    if (job.state !== "ready" || !job.result) throw new LiveError(409, "ARCHIVE_NOT_READY");
    if (job.expiresAt <= this.now()) throw new LiveError(410, "ARCHIVE_EXPIRED");
    job.downloadUntil = this.now() + DOWNLOAD_MS;
    this.dependencies.audit("archive.download", { jobId: id, actorId: job.actorId, sha256: job.result.sha256 });
    return this.publicJob(job);
  }
  finishDownload(id: string) { const job = this.jobs.get(id); if (job) delete job.downloadUntil; }
  async stop(id: string, token: string) { await this.close(await this.authorized(id, token), true); }
  async expire() { this.pruneRequests(); await Promise.all([...this.jobs.values()].filter((job) => !this.alive(job)).map((job) => this.close(job))); }
  async closeAll() { await Promise.all([...this.jobs.values()].map((job) => this.close(job))); }
  private async remove(id: string) { try { await this.dependencies.remove(id); } catch { this.dependencies.fatal(); } }
  private async close(job: ArchiveJob, cancelled = false) {
    if (job.closed) return;
    job.closed = true; job.abort.abort();
    if (cancelled) for (const request of this.requests.values()) if (request.jobId === job.id) request.cancelled = true;
    await job.task; await this.remove(job.id); this.jobs.delete(job.id);
  }
}
