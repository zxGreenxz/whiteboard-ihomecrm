import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { ArchiveJobs } from "./cameraArchive.js";
import { validateCameraOrigin } from "./cameraConfig.js";
import { playbackRange, playbackSources, playbackSpeeds, playbackSpeedSchema, playbackQualitySchema, type PlaybackRange } from "./cameraPlayback.js";

const uuid = z.string().uuid();
export const liveConfigSchema = z.object({
  supabaseUrl: z.literal("https://tryymsxyyckgbrmmvozx.supabase.co"),
  publishableKey: z.string().min(20).max(2048),
  origins: z.array(z.string().url()).min(1).max(4),
  recorders: z.array(z.object({
    id: uuid, organizationId: uuid, buildingId: uuid,
    channels: z.array(z.number().int().min(1).max(64)).min(1).max(64),
    rtspOrigin: z.string().regex(/^rtsp:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):\d{1,5}$/u),
    username: z.string().min(1).max(128), password: z.string().min(1).max(512),
    archiveEnabled: z.boolean().optional(),
    archiveOrigin: z.string().optional(),
  }).strict()).min(1).max(32),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.recorders.map((r) => r.id)).size !== config.recorders.length) ctx.addIssue({ code: "custom", message: "Duplicate recorder" });
  for (const recorder of config.recorders) {
    try {
      if (recorder.archiveEnabled || recorder.archiveOrigin !== undefined) validateCameraOrigin(recorder.archiveOrigin ?? "");
    } catch { ctx.addIssue({ code: "custom", message: "Private archive origin required" }); }
  }
  for (const origin of config.origins) {
    const u = new URL(origin);
    if (u.origin !== origin || u.protocol !== "https:") ctx.addIssue({ code: "custom", message: "HTTPS origins required" });
  }
});
export type LiveConfig = z.infer<typeof liveConfigSchema>;
export type LiveRecorder = LiveConfig["recorders"][number];
export const streamName = (recorder: LiveRecorder, channel: number, quality: "sd" | "hd" = "sd") => `camera-${recorder.id}-${channel}${quality === "hd" ? "-hd" : ""}`;
const mediaOrigin = "http://127.0.0.1:18889";
const LEASE_MS = 75_000;
const MAX_SESSIONS = 24;
const MAX_USER_SESSIONS = 16;
const BODY_MAX = 65_536;

export class LiveError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface LiveActor { id: string; expiresAt: number }
export interface LiveMediaSession { location: string; answer: string }
export interface LiveDependencies {
  playbackQualities?: ("sd" | "hd")[];
  authorize(token: string, recorder: LiveRecorder): Promise<LiveActor>;
  start(recorder: LiveRecorder, channel: number, offer: string, playback?: PlaybackRange, liveQuality?: "sd" | "hd"): Promise<LiveMediaSession>;
  stop(location: string): Promise<void>;
  /** Must terminate the media process as well as the gateway on uncertain cleanup. */
  fatal(): void;
  now?: () => number;
}

async function boundedText(response: Response, max = BODY_MAX): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > max) throw new LiveError(502, "UPSTREAM_INVALID");
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

export function createLiveDependencies(config: LiveConfig, fatal: () => void, request: typeof fetch = fetch, encoder?: string): LiveDependencies {
  const sources = playbackSources(request, fatal, encoder);
  const playbackPaths = new Map<string, string>();
  const startMedia = async (name: string, offer: string) => {
    const path = `/${name}/whep`;
    let response: Response;
    try { response = await request(mediaOrigin + path, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
    catch { fatal(); throw new LiveError(502, "MEDIA_START_UNCERTAIN"); }
    if (response.status !== 201) { await response.body?.cancel(); throw new LiveError(502, response.status === 400 ? "CODEC_UNSUPPORTED" : "CAMERA_UNAVAILABLE"); }
    try {
      const location = response.headers.get("location"); const parsed = location ? new URL(location, mediaOrigin) : undefined;
      if (!parsed || parsed.origin !== mediaOrigin || parsed.search || parsed.hash || !new RegExp(`^${path}/[a-f0-9-]{36}$`, "u").test(parsed.pathname)) throw new Error("Invalid media location");
      return { location: parsed.href, answer: await boundedText(response) };
    } catch { fatal(); throw new LiveError(502, "UPSTREAM_INVALID"); }
  };
  return {
    fatal,
    playbackQualities: encoder ? ["sd", "hd"] : [],
    async authorize(token, recorder) {
      const headers = { apikey: config.publishableKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const user = await request(`${config.supabaseUrl}/auth/v1/user`, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!user.ok) { await user.body?.cancel(); throw new LiveError(user.status === 401 || user.status === 403 ? 401 : 503, "AUTH_UNAVAILABLE"); }
      const actor = z.object({ id: uuid }).parse(JSON.parse(await boundedText(user)));
      // The signature and expiry were checked by Auth; never authorize from an unverified JWT payload.
      const claims = z.object({ exp: z.number().int().positive(), sub: uuid }).parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
      if (claims.sub !== actor.id || claims.exp * 1000 <= Date.now()) throw new LiveError(401, "SESSION_EXPIRED");
      const snapshot = await request(`${config.supabaseUrl}/rest/v1/rpc/camera_building_snapshot_v1`, {
        method: "POST", headers: { ...headers, "Content-Profile": "public", "Accept-Profile": "public" }, body: JSON.stringify({ p_building_id: recorder.buildingId }), redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (!snapshot.ok) { await snapshot.body?.cancel(); throw new LiveError(snapshot.status === 401 || snapshot.status === 403 ? 403 : 503, "CAMERA_ACCESS_DENIED"); }
      const data = z.object({ recorders: z.array(z.object({ id: uuid, organization_id: uuid, building_id: uuid, enabled: z.boolean(), channel_count: z.number().int() })) }).parse(JSON.parse(await boundedText(snapshot, 262144)));
      const found = data.recorders.find((r) => r.id === recorder.id && r.building_id === recorder.buildingId && r.organization_id === recorder.organizationId && r.enabled);
      if (!found || recorder.channels.some((c) => c > found.channel_count)) throw new LiveError(403, "CAMERA_ACCESS_DENIED");
      return { id: actor.id, expiresAt: claims.exp * 1000 };
    },
    async start(recorder, channel, offer, playback, liveQuality) {
      if (!playback) return startMedia(streamName(recorder, channel, liveQuality), offer);
      const name = await sources.add(recorder, channel, playback);
      try {
        const media = await startMedia(name, offer); playbackPaths.set(media.location, name); return media;
      } catch (error) { await sources.remove(name); throw error; }
    },
    async stop(location) {
      const response = await request(location, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (response.status !== 200 && response.status !== 204 && response.status !== 404) throw new LiveError(502, "MEDIA_CLEANUP_FAILED");
      const name = playbackPaths.get(location);
      if (name) { await sources.remove(name); playbackPaths.delete(location); }
    },
  };
}

export function validateOffer(offer: string) {
  const lines = offer.split(/\r?\n/u);
  const media = lines.filter((line) => line.startsWith("m="));
  const directions = lines.filter((line) => /^a=(?:sendrecv|sendonly|recvonly|inactive)$/u.test(line));
  if (Buffer.byteLength(offer) > BODY_MAX || !offer.startsWith("v=0\r\n") || media.length !== 1 || !/^m=video \d+ UDP\/TLS\/RTP\/SAVPF [\d ]+$/u.test(media[0] ?? "") || directions.length !== 1 || directions[0] !== "a=recvonly" || lines.some((line) => line.startsWith("a=ice-server"))) {
    throw new LiveError(400, "INVALID_VIDEO_OFFER");
  }
}

interface Session {
  id: string; actorId: string; recorder: LiveRecorder; expiresAt: number; location?: string; closed: boolean; playbackUntil?: number | undefined;
}
export class LiveSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  constructor(private readonly dependencies: LiveDependencies) { this.now = dependencies.now ?? Date.now; }
  get size() { return this.sessions.size; }
  async start(actor: LiveActor, recorder: LiveRecorder, channel: number, offer: string, range?: PlaybackRange, liveQuality?: "sd" | "hd") {
    validateOffer(offer);
    if (liveQuality !== undefined && !playbackQualitySchema.safeParse(liveQuality).success) throw new LiveError(400, "INVALID_VIDEO_QUALITY");
    const playback = range ? playbackRange(range, this.now()) : undefined;
    if (playback && !recorder.archiveEnabled) throw new LiveError(503, "ARCHIVE_NOT_CONFIGURED");
    if (!recorder.channels.includes(channel)) throw new LiveError(404, "CAMERA_NOT_CONFIGURED");
    if (actor.expiresAt <= this.now()) throw new LiveError(401, "SESSION_EXPIRED");
    if (this.sessions.size >= MAX_SESSIONS || [...this.sessions.values()].filter((s) => s.actorId === actor.id).length >= MAX_USER_SESSIONS) throw new LiveError(429, "CAMERA_LIMIT");
    if (playback && [...this.sessions.values()].filter((s) => s.playbackUntil).length >= 4) throw new LiveError(429, "PLAYBACK_BUSY");
    // Reserve before awaiting upstream: simultaneous requests cannot bypass the session limit.
    const playbackUntil = playback ? this.now() + (Date.parse(playback.end) - Date.parse(playback.start)) / (playback.speed ?? 1) + 30_000 : undefined;
    const session: Session = { id: randomUUID(), actorId: actor.id, recorder, expiresAt: Math.min(this.now() + LEASE_MS, actor.expiresAt, playbackUntil ?? Infinity), closed: false, playbackUntil };
    this.sessions.set(session.id, session);
    try {
      const media = liveQuality ? await this.dependencies.start(recorder, channel, offer, playback, liveQuality) : await this.dependencies.start(recorder, channel, offer, playback);
      session.location = media.location;
      if (session.closed || session.expiresAt <= this.now()) { await this.close(session); throw new LiveError(401, "SESSION_EXPIRED"); }
      return { id: session.id, answer: media.answer, expiresAt: session.expiresAt };
    } catch (error) { this.sessions.delete(session.id); throw error; }
  }
  find(id: string) { const session = this.sessions.get(id); if (!session) throw new LiveError(404, "SESSION_NOT_FOUND"); return session; }
  async renew(id: string, token: string) {
    const session = this.find(id);
    if (session.expiresAt <= this.now()) { await this.close(session); throw new LiveError(401, "SESSION_EXPIRED"); }
    const actor = await this.dependencies.authorize(token, session.recorder);
    if (session.actorId !== actor.id) throw new LiveError(403, "SESSION_OWNER_MISMATCH");
    if (session.closed || session.expiresAt <= this.now() || actor.expiresAt <= this.now()) { await this.close(session); throw new LiveError(401, "SESSION_EXPIRED"); }
    session.expiresAt = Math.min(this.now() + LEASE_MS, actor.expiresAt, session.playbackUntil ?? Infinity);
    return session.expiresAt;
  }
  async stop(id: string, token: string) {
    const session = this.find(id);
    const actor = await this.dependencies.authorize(token, session.recorder);
    if (session.actorId !== actor.id) throw new LiveError(403, "SESSION_OWNER_MISMATCH");
    await this.close(session);
  }
  async expire() { await Promise.all([...this.sessions.values()].filter((s) => s.expiresAt <= this.now()).map((s) => this.close(s))); }
  async closeAll() { await Promise.all([...this.sessions.values()].map((s) => this.close(s))); }
  private async close(session: Session) {
    session.closed = true; this.sessions.delete(session.id);
    const location = session.location; delete session.location;
    if (location) { try { await this.dependencies.stop(location); } catch { this.dependencies.fatal(); } }
  }
}

function tokenOf(request: IncomingMessage) {
  const value = request.headers.authorization;
  if (!value || !/^Bearer [A-Za-z0-9_.-]{20,8192}$/u.test(value)) throw new LiveError(401, "LOGIN_REQUIRED");
  return value.slice(7);
}
async function requestBody(request: IncomingMessage) {
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length; if (length > BODY_MAX) throw new LiveError(413, "OFFER_TOO_LARGE"); chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function reply(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(data));
}

export function createLiveServer(config: LiveConfig, dependencies: LiveDependencies, archive?: { jobs: ArchiveJobs; open(id: string): Readable }) {
  const sessions = new LiveSessions(dependencies);
  const downloads = new Set<string>();
  let pending = 0; let windowStart = Date.now(); let requests = 0;
  const server = createServer({ maxHeaderSize: 12288, requestTimeout: 20_000, headersTimeout: 10_000 }, async (request, response) => {
    if (Date.now() - windowStart >= 10_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 200 || pending >= 32) { reply(response, 429, { code: "CAMERA_BUSY" }); return; }
    pending++;
    try {
      const origin = request.headers.origin;
      if (!origin || !config.origins.includes(origin)) throw new LiveError(403, "ORIGIN_DENIED");
      response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
      const token = tokenOf(request);
      const path = request.url ?? "";
      const recorderRoute = /^\/camera-live\/v1\/recorders\/([a-f0-9-]{36})(?:\/channels\/(\d+)\/sessions(?:\?quality=(sd|hd))?)?$/u.exec(path);
      const sessionRoute = /^\/camera-live\/v1\/sessions\/([a-f0-9-]{36})(\/renew)?$/u.exec(path);
      const archiveCreate = /^\/camera-live\/v1\/recorders\/([a-f0-9-]{36})\/channels\/(\d+)\/archive$/u.exec(path);
      const archiveJob = /^\/camera-live\/v1\/archive\/([a-f0-9-]{36})(\/file)?$/u.exec(path);
      const playbackCreate = /^\/camera-live\/v1\/recorders\/([a-f0-9-]{36})\/channels\/(\d+)\/playback$/u.exec(path);
      if (playbackCreate && request.method === "POST") {
        if (request.headers["content-type"] !== "application/json") throw new LiveError(415, "JSON_REQUIRED");
        const recorder = config.recorders.find((r) => r.id === playbackCreate[1]);
        if (!recorder) throw new LiveError(404, "CAMERA_NOT_CONFIGURED");
        let input;
        try { input = z.object({ offer: z.string(), start: z.string(), end: z.string(), speed: playbackSpeedSchema.optional(), quality: playbackQualitySchema.optional() }).strict().parse(JSON.parse(await requestBody(request))); }
        catch { throw new LiveError(400, "INVALID_PLAYBACK_RANGE"); }
        const { offer, ...requestedRange } = input;
        const range = playbackRange(requestedRange); validateOffer(offer);
        const actor = await dependencies.authorize(token, recorder);
        const result = await sessions.start(actor, recorder, Number(playbackCreate[2]), input.offer, range);
        if (response.destroyed) { await sessions.stop(result.id, token); return; }
        reply(response, 201, result); return;
      }
      if (archiveCreate || archiveJob) {
        if (!archive) throw new LiveError(503, "ARCHIVE_NOT_CONFIGURED");
        if (archiveCreate && request.method === "POST") {
          if (request.headers["content-type"] !== "application/json") throw new LiveError(415, "JSON_REQUIRED");
          const recorder = config.recorders.find((r) => r.id === archiveCreate[1]);
          if (!recorder) throw new LiveError(404, "CAMERA_NOT_CONFIGURED");
          let value: unknown;
          try { value = JSON.parse(await requestBody(request)); } catch { throw new LiveError(400, "INVALID_ARCHIVE_RANGE"); }
          const actor = await dependencies.authorize(token, recorder);
          const job = await archive.jobs.create(actor, recorder, Number(archiveCreate[2]), value);
          if (response.destroyed) { await archive.jobs.stop(job.id, token); return; }
          reply(response, 202, job); return;
        }
        if (archiveJob) {
          const id = archiveJob[1]!;
          if (request.method === "GET" && !archiveJob[2]) { reply(response, 200, await archive.jobs.get(id, token)); return; }
          if (request.method === "DELETE" && !archiveJob[2]) { await archive.jobs.stop(id, token); reply(response, 200, { stopped: true }); return; }
          if (request.method === "GET" && archiveJob[2]) {
            if (downloads.size >= 2 || downloads.has(id)) throw new LiveError(429, "ARCHIVE_BUSY");
            downloads.add(id);
            const abort = new AbortController();
            const disconnected = () => abort.abort(); response.once("close", disconnected);
            let checking = false;
            const check = setInterval(() => {
              if (checking) return; checking = true;
              void archive.jobs.get(id, token).catch(() => abort.abort()).finally(() => { checking = false; });
            }, 25000);
            try {
              const job = await archive.jobs.file(id, token);
              response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": job.bytes!, "Content-Disposition": `attachment; filename="${job.filename}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
              await pipeline(archive.open(id), response, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]) });
            } finally { clearInterval(check); response.removeListener("close", disconnected); downloads.delete(id); }
            return;
          }
        }
        throw new LiveError(404, "NOT_FOUND");
      }
      if (recorderRoute) {
        const recorder = config.recorders.find((r) => r.id === recorderRoute[1]);
        if (!recorder) throw new LiveError(404, "CAMERA_NOT_CONFIGURED");
        const channel = recorderRoute[2];
        if (!channel && request.method === "GET") {
          await dependencies.authorize(token, recorder);
          reply(response, 200, { channels: recorder.channels, maxView: MAX_USER_SESSIONS, leaseSeconds: LEASE_MS / 1000, liveQualities: ["sd", "hd"], archive: Boolean(archive && recorder.archiveEnabled), playback: Boolean(recorder.archiveEnabled), playbackSpeeds: recorder.archiveEnabled ? playbackSpeeds : [], playbackQualities: recorder.archiveEnabled ? dependencies.playbackQualities ?? [] : [] }); return;
        }
        if (channel && request.method === "POST") {
          if (request.headers["content-type"] !== "application/sdp") throw new LiveError(415, "SDP_REQUIRED");
          const offer = await requestBody(request); validateOffer(offer);
          const actor = await dependencies.authorize(token, recorder);
          const quality = recorderRoute[3] ? playbackQualitySchema.parse(recorderRoute[3]) : undefined;
          const result = await sessions.start(actor, recorder, Number(channel), offer, undefined, quality);
          if (response.destroyed) { await sessions.stop(result.id, token); return; }
          reply(response, 201, result); return;
        }
      } else if (sessionRoute) {
        const id = sessionRoute[1]!;
        if (request.method === "POST" && sessionRoute[2]) { reply(response, 200, { expiresAt: await sessions.renew(id, token) }); return; }
        if (request.method === "DELETE" && !sessionRoute[2]) { await sessions.stop(id, token); reply(response, 200, { stopped: true }); return; }
      }
      throw new LiveError(404, "NOT_FOUND");
    } catch (error) {
      if (!response.headersSent && !response.destroyed) reply(response, error instanceof LiveError ? error.status : 503, { code: error instanceof LiveError ? error.code : "CAMERA_UNAVAILABLE" });
      else if (!response.destroyed) response.destroy();
    } finally { pending--; }
  });
  server.maxConnections = 96; server.keepAliveTimeout = 5000;
  const timer = setInterval(() => { void sessions.expire(); void archive?.jobs.expire(); }, 1000); timer.unref();
  server.on("close", () => { clearInterval(timer); void sessions.closeAll(); void archive?.jobs.closeAll(); });
  return { server, sessions };
}
