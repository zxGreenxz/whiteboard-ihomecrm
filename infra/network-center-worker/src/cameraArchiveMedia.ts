import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARCHIVE_MAX_BYTES, type ArchiveDependencies, type ArchiveRange } from "./cameraArchive.js";
import { LiveError, type LiveRecorder } from "./cameraLive.js";

export function playbackUrl(recorder: LiveRecorder, channel: number, range: ArchiveRange) {
  // Dahua/KBVISION playback expects recorder wall-clock time, not UTC or host time.
  const local = (value: string) => new Date(Date.parse(value) + 7 * 3600_000).toISOString().slice(0, 19).replace(/[-T:]/gu, "_");
  const url = new URL("/cam/playback", recorder.rtspOrigin);
  url.username = recorder.username; url.password = recorder.password;
  url.search = new URLSearchParams({ channel: String(channel), starttime: local(range.start), endtime: local(range.end) }).toString();
  return url.href;
}
export function archiveArguments(inputFile: string, outputFile: string, range: ArchiveRange) {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1",
    // A single-source manifest keeps the credential-bearing URL out of argv.
    "-f", "concat", "-safe", "0", "-protocol_whitelist", "file,rtsp,tcp,udp,rtp", "-i", inputFile, "-t", String(range.durationSeconds), "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-threads", "1", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(range.purpose === "preview" ? ["-vf", "scale=w='min(1280,iw)':h=-2"] : []),
    "-fps_mode", "vfr", "-c:a", "aac", "-b:a", "96k", "-map_metadata", "-1",
    "-movflags", "+faststart", "-fs", String(ARCHIVE_MAX_BYTES), "-progress", "pipe:1", "-nostats", outputFile];
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
      const folder = jobDirectory(id); await mkdir(folder, { mode: 0o700 });
      const input = join(folder, "input.url"); const output = join(folder, "video.mp4");
      const source = playbackUrl(recorder, channel, range).replace(/'/gu, "'\\''");
      await writeFile(input, `ffconcat version 1.0\nfile '${source}'\noption rtsp_transport tcp\noption timeout 15000000\n`, { mode: 0o600, flag: "wx" });
      if (signal.aborted) throw new LiveError(410, "ARCHIVE_EXPIRED");
      let seconds = 0; let frames = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          // Never forward stderr: FFmpeg errors may include recorder credentials.
          const child = spawn(binary, archiveArguments(input, output, range), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: { PATH: "/usr/bin:/bin" } });
          let killTimer: ReturnType<typeof setTimeout> | undefined; let failed = false; let buffer = "";
          const abort = () => { failed = true; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); };
          const deadline = setTimeout(abort, (range.durationSeconds * 2 + 90) * 1000);
          signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.length > 16384) { abort(); return; }
            const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
            for (const line of lines) {
              const time = /^out_time_us=(\d+)\r?$/u.exec(line); const frame = /^frame=(\d+)\r?$/u.exec(line);
              if (time) { seconds = Number(time[1]) / 1_000_000; progress(seconds); }
              if (frame) frames = Number(frame[1]);
            }
          });
          const cleanup = () => { clearTimeout(deadline); clearTimeout(killTimer); signal.removeEventListener("abort", abort); };
          child.once("error", () => { cleanup(); reject(new LiveError(502, "ARCHIVE_ENCODER_FAILED")); });
          child.once("close", (code) => { cleanup(); if (!failed && code === 0 && frames > 0) resolve(); else reject(new LiveError(502, "RECORDING_UNAVAILABLE")); });
        });
        const info = await stat(output); const hash = createHash("sha256");
        for await (const chunk of createReadStream(output)) hash.update(chunk);
        return { bytes: info.size, durationSeconds: seconds, sha256: hash.digest("hex") };
      } finally { await rm(input, { force: true }); }
    },
  };
}
