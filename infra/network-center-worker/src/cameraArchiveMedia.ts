import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { ARCHIVE_MAX_BYTES, type ArchiveDependencies, type ArchiveRange } from "./cameraArchive.js";
import { LiveError } from "./cameraLive.js";
import { DahuaClient } from "./camera/dahuaClient.js";
import { validateCameraOrigin } from "./cameraConfig.js";
import { recordingFetch } from "./cameraRecordingFetch.js";

export const recorderTime = (value: string) => new Date(Date.parse(value) + 7 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
// Some recorders omit interframes at the download boundary. Fetch preroll, then
// trim using the preserved absolute clock; never shift the requested interval.
export const recordingStart = (range: ArchiveRange) => recorderTime(new Date(Date.parse(range.start) - 5000).toISOString());
// The recorder's HTTP end boundary can precede its last video PTS by a fraction
// of a second. Fetch a suffix too; trim and coverage checks still use the exact range.
export const recordingEnd = (range: ArchiveRange) => recorderTime(new Date(Date.parse(range.end) + 5000).toISOString());
export function archiveArguments(inputFile: string, outputFile: string, range: ArchiveRange) {
  // DHAV preserves recorder wall-clock dates as UTC-shaped PTS. Keep those PTS
  // until trimming; resetting to STARTPTS would hide a missing first second.
  const start = Date.parse(range.start) / 1000 + 7 * 3600; const end = start + range.durationSeconds;
  const resolution = range.purpose === "preview" ? "720p" : range.resolution;
  const bounds = resolution === "480p" ? [854, 480] : resolution === "1080p" ? [1920, 1080] : [1280, 720];
  const scale = resolution === "original" ? "" : `scale=w='min(${bounds[0]},iw)':h='min(${bounds[1]},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,`;
  return ["-hide_banner", "-loglevel", "info", "-nostdin", "-y", "-threads", "2", "-filter_threads", "1",
    "-copyts", "-f", "dhav", "-protocol_whitelist", "file", "-i", inputFile, "-t", String(range.durationSeconds), "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-vf", `trim=start=${start}:end=${end},setpts=PTS-${start}/TB,${scale}showinfo=checksum=0`,
    "-af", `atrim=start=${start}:end=${end},asetpts=PTS-${start}/TB`,
    "-fps_mode", "vfr", "-c:a", "aac", "-b:a", "96k", "-map_metadata", "-1",
    "-movflags", "+faststart", "-fs", String(ARCHIVE_MAX_BYTES), "-progress", "pipe:1", "-nostats", outputFile];
}

/** Inspect only numeric decoded-frame timing; never retain or forward raw media logs. */
export class ArchiveFrameCoverage {
  private fps = 0; private first = NaN; private last = NaN; private maxGap = 0; private invalid = false;
  accept(line: string) {
    if (!line.includes("Parsed_showinfo")) return;
    const rate = /config in .*frame_rate:\s*(\d+)\/(\d+)/u.exec(line);
    if (rate) this.fps = Number(rate[1]) / Number(rate[2]);
    const frame = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([-+\d.eE]+)/u.exec(line);
    if (!frame) return;
    const seconds = Number(frame[1]);
    if (!Number.isFinite(seconds) || (Number.isFinite(this.last) && seconds < this.last)) { this.invalid = true; return; }
    if (!Number.isFinite(this.first)) this.first = seconds;
    if (Number.isFinite(this.last)) this.maxGap = Math.max(this.maxGap, seconds - this.last);
    this.last = seconds;
  }
  assertComplete(duration: number) {
    const edge = 1 / this.fps + 0.08;
    if (this.invalid || !Number.isFinite(this.fps) || this.fps <= 0 || this.fps > 240 ||
        !Number.isFinite(this.first) || this.first < -0.05 || this.first > edge ||
        this.last < duration - edge || this.last >= duration + 0.08 || this.maxGap > Math.max(0.5, 2 / this.fps + 0.05)) {
      throw new LiveError(502, "ARCHIVE_INCOMPLETE");
    }
    // Encoder progress may report DTS (before delayed B-frames). Use the
    // decoded presentation end for video duration and handover metadata.
    return this.last + 1 / this.fps;
  }
}

export async function saveRecording(response: Response, path: string, signal: AbortSignal, maximumBytes = ARCHIVE_MAX_BYTES, onBytes?: (bytes: number, totalBytes?: number) => void) {
  const reader = response.body?.getReader();
  if (!reader) throw new LiveError(502, "RECORDING_UNAVAILABLE");
  let file: Awaited<ReturnType<typeof open>> | undefined; let bytes = 0;
  try {
    if (Number(response.headers.get("content-length")) >= maximumBytes) throw new LiveError(502, "ARCHIVE_TOO_LARGE");
    file = await open(path, "wx", 0o600);
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes >= maximumBytes) throw new LiveError(502, "ARCHIVE_TOO_LARGE");
      await file.writeFile(part.value);
      const total = Number(response.headers.get("content-length"));
      onBytes?.(bytes, Number.isSafeInteger(total) && total > 0 ? total : undefined);
    }
    if (bytes < 32) throw new LiveError(502, "RECORDING_UNAVAILABLE");
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); await file?.close(); }
  }
}

export async function prepareArchiveDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // This directory belongs only to archive jobs. Fail closed on unexpected entries.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(entry.name)) throw new Error("ARCHIVE_DIRECTORY_INVALID");
    await rm(join(directory, entry.name), { recursive: true });
  }
}
export function createArchiveMedia(binary: string, directory: string): Pick<ArchiveDependencies, "encode" | "remove"> & { open(id: string): ReturnType<typeof createReadStream> } {
  const jobDirectory = (id: string) => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id)) throw new Error("ARCHIVE_ID_INVALID");
    return join(directory, id);
  };
  return {
    open(id) { return createReadStream(join(jobDirectory(id), "video.mp4")); },
    async remove(id) { await rm(jobDirectory(id), { recursive: true, force: true }); },
    async encode(id, recorder, channel, range, signal, progress) {
      const disk = await statfs(directory);
      if (disk.bavail * disk.bsize < 2 * 1024 ** 3 + 2 * ARCHIVE_MAX_BYTES) throw new LiveError(507, "ARCHIVE_STORAGE_FULL");
      const folder = jobDirectory(id); await mkdir(folder, { mode: 0o700 });
      const input = join(folder, "source.dav"); const output = join(folder, "video.mp4");
      const timeout = new AbortController(); const deadline = setTimeout(() => timeout.abort(), (range.durationSeconds * 2 + 90) * 1000);
      const workSignal = AbortSignal.any([signal, timeout.signal]);
      let seconds = 0; let frames = 0;
      try {
        const baseUrl = validateCameraOrigin(recorder.archiveOrigin ?? "");
        const client = new DahuaClient({ baseUrl, username: recorder.username, password: recorder.password, fetch: recordingFetch(baseUrl) });
        const response = await client.recording(channel, recordingStart(range), recordingEnd(range), workSignal);
        await saveRecording(response, input, workSignal, ARCHIVE_MAX_BYTES, (bytes, totalBytes) => progress({ phase: "source", bytes, ...(totalBytes ? { totalBytes } : {}) }));
        if (workSignal.aborted) throw new LiveError(410, "ARCHIVE_EXPIRED");
        const coverage = new ArchiveFrameCoverage();
        progress({ phase: "encoding", seconds: 0 });
        await new Promise<void>((resolve, reject) => {
          // FFmpeg reads only a private local file; credentials never enter argv or its logs.
          const child = spawn(binary, archiveArguments(input, output, range), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { PATH: "/usr/bin:/bin" } });
          let killTimer: ReturnType<typeof setTimeout> | undefined; let failed = false; let buffer = ""; let timingBuffer = "";
          const abort = () => { failed = true; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); };
          workSignal.addEventListener("abort", abort, { once: true }); if (workSignal.aborted) abort();
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.length > 16384) { abort(); return; }
            const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
            for (const line of lines) {
              const time = /^out_time_us=(\d+)\r?$/u.exec(line); const frame = /^frame=(\d+)\r?$/u.exec(line);
              if (time) { seconds = Number(time[1]) / 1_000_000; progress({ phase: "encoding", seconds }); }
              if (frame) frames = Number(frame[1]);
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            timingBuffer += chunk.toString("utf8");
            const lines = timingBuffer.split("\n"); timingBuffer = lines.pop() ?? "";
            if (timingBuffer.length > 16384) { abort(); return; }
            for (const line of lines) coverage.accept(line);
          });
          const cleanup = () => { clearTimeout(killTimer); workSignal.removeEventListener("abort", abort); };
          child.once("error", () => { cleanup(); reject(new LiveError(502, "ARCHIVE_ENCODER_FAILED")); });
          child.once("close", (code) => { cleanup(); if (!failed && code === 0 && frames > 0) resolve(); else reject(new LiveError(502, "RECORDING_UNAVAILABLE")); });
        });
        const durationSeconds = coverage.assertComplete(range.durationSeconds);
        progress({ phase: "verifying" });
        const info = await stat(output); const hash = createHash("sha256");
        for await (const chunk of createReadStream(output)) hash.update(chunk);
        return { bytes: info.size, durationSeconds, sha256: hash.digest("hex") };
      } finally { clearTimeout(deadline); await rm(input, { force: true }); }
    },
  };
}
