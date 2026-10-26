import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLiveDependencies, createLiveServer, liveConfigSchema, streamName, type LiveConfig } from "./cameraLive.js";
import { ArchiveJobs } from "./cameraArchive.js";
import { createArchiveMedia, prepareArchiveDirectory } from "./cameraArchiveMedia.js";

// Build from the pinned upstream revision plus media/playback-control.patch.
// Runtime verifies the release's binary digest before executing it.
export const MEDIA_VERSION = "1.21.2-ihome-playback2";

export function mediaConfiguration(config: LiveConfig, encoder?: string) {
  if (encoder && !/^\/opt\/ihome-camera-live\/releases\/[a-f0-9]{40}\/ffmpeg$/u.test(encoder)) throw new Error("LIVE_ENCODER_INVALID");
  const paths = Object.fromEntries(config.recorders.flatMap((recorder) => recorder.channels.flatMap((channel) => (["sd", "hd"] as const).map((quality) => {
    const source = new URL(`/cam/realmonitor?channel=${channel}&subtype=${quality === "sd" ? 1 : 0}`, recorder.rtspOrigin);
    source.username = recorder.username; source.password = recorder.password;
    return [streamName(recorder, channel, quality), { source: source.href, sourceOnDemand: true, sourceOnDemandStartTimeout: "8s", sourceOnDemandCloseAfter: "5s", rtspTransport: "tcp", record: false, maxReaders: 24 }];
  }))));
  if (encoder) {
    for (const recorder of config.recorders) for (const channel of recorder.channels) {
      const main = streamName(recorder, channel, "hd");
      const mainInput = streamName(recorder, channel, "original");
      // Native SD/main video and G.711 audio pass straight through MediaMTX.
      // Only resized profiles need an encoder before the first picture.
      paths[mainInput] = paths[main]!;
      for (const quality of ["hd", "fullhd"] as const) {
        const output = streamName(recorder, channel, quality); const input = mainInput;
        const size = quality === "hd" ? [1280, 720] : [1920, 1080];
        const video = ["-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "25", "-maxrate", quality === "hd" ? "2500k" : "4500k", "-bufsize", "9000k", "-pix_fmt", "yuv420p", "-g", "25", "-vf", `scale=w='min(${size[0]},iw)':h='min(${size[1]},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`];
        const command = [encoder, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-rtsp_transport", "tcp", "-timeout", "10000000", "-probesize", "32768", "-analyzeduration", "1", "-i", `rtsp://127.0.0.1:18895/${input}`, "-map", "0:v:0", "-map", "0:a:0?", ...video, "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-b:a", "32k", "-f", "rtsp", "-rtsp_transport", "tcp", "-muxdelay", "0.05", `rtsp://127.0.0.1:18895/${output}`].map((arg) => `'${arg.replace(/'/gu, `'\\''`)}'`).join(" ");
        // Shared on-demand outputs: one encoder per camera/quality, not per viewer.
        Object.assign(paths, { [output]: { source: "publisher", runOnDemand: command, runOnDemandRestart: false, runOnDemandStartTimeout: "10s", runOnDemandCloseAfter: "1s", record: false, maxReaders: 24 } });
      }
    }
  }
  return {
    logLevel: "error", logDestinations: ["stdout"], dumpPackets: false,
    rtsp: true, rtspAddress: "127.0.0.1:18895", rtspTransports: ["tcp"], rtmp: false, hls: false, srt: false, moq: false, playback: false,
    api: true, apiAddress: "127.0.0.1:18897", apiAllowOrigins: [], metrics: false, pprof: false,
    webrtc: true, webrtcAddress: "127.0.0.1:18889", webrtcAllowOrigins: [],
    webrtcLocalUDPAddress: "", webrtcLocalTCPAddress: "", webrtcIPsFromInterfaces: false,
    webrtcICEServers2: [{ url: "stun:stun.l.google.com:19302" }],
    webrtcHandshakeTimeout: "15s", webrtcSTUNGatherTimeout: "5s",
    authInternalUsers: [{ user: "any", ips: ["127.0.0.1"], permissions: [{ action: "read" }, { action: "api" }, { action: "publish", path: encoder ? "~^(playback-[a-f0-9-]{36}|camera-[a-f0-9-]{36}-[0-9]{1,2}(-hd|-fullhd|-original)?)$" : "~^playback-[a-f0-9-]{36}$" }] }],
    paths,
  };
}

async function main() {
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
  const runtimeDirectory = process.env.RUNTIME_DIRECTORY;
  const binary = process.env.CAMERA_MEDIA_BINARY;
  const expectedDigest = process.env.CAMERA_MEDIA_SHA256;
  if (!credentialDirectory || !runtimeDirectory || !binary?.startsWith("/opt/ihome-camera-live/releases/") || !expectedDigest?.match(/^[a-f0-9]{64}$/u)) throw new Error("LIVE_RUNTIME_INVALID");
  if (createHash("sha256").update(await readFile(binary)).digest("hex") !== expectedDigest) throw new Error("LIVE_BINARY_DIGEST_MISMATCH");
  const config = liveConfigSchema.parse(JSON.parse(await readFile(join(credentialDirectory, "live-config.json"), "utf8")));
  const archiveBinary = process.env.CAMERA_FFMPEG_BINARY;
  const archiveDigest = process.env.CAMERA_FFMPEG_SHA256;
  const stateDirectory = process.env.STATE_DIRECTORY;
  let archiveMedia: ReturnType<typeof createArchiveMedia> | undefined;
  if (config.recorders.some((recorder) => recorder.archiveEnabled)) {
    if (!archiveBinary?.startsWith("/opt/ihome-camera-live/releases/") || !archiveDigest?.match(/^[a-f0-9]{64}$/u) || stateDirectory !== "/var/lib/ihome-camera-live") throw new Error("ARCHIVE_RUNTIME_INVALID");
    if (createHash("sha256").update(await readFile(archiveBinary)).digest("hex") !== archiveDigest) throw new Error("ARCHIVE_BINARY_DIGEST_MISMATCH");
    const directory = join(stateDirectory, "archive"); await prepareArchiveDirectory(directory);
    archiveMedia = createArchiveMedia(archiveBinary, directory);
  }
  const mediaConfig = join(runtimeDirectory, "mediamtx.json");
  await writeFile(mediaConfig, JSON.stringify(mediaConfiguration(config, archiveMedia ? archiveBinary : undefined)), { mode: 0o600 });
  // Media logs can contain recorder URLs. Never forward them to the application journal.
  const media = spawn(binary, [mediaConfig], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  let stopping = false;
  const fatal = () => {
    if (stopping) return;
    stopping = true; process.exitCode = 1; media.kill("SIGTERM");
    setTimeout(() => { media.kill("SIGKILL"); process.exit(1); }, 1000).unref();
    console.error("CAMERA_LIVE_STOPPED");
    server.close(); server.closeAllConnections();
  };
  const dependencies = createLiveDependencies(config, fatal, fetch, archiveMedia ? archiveBinary : undefined);
  const archive = archiveMedia ? { jobs: new ArchiveJobs({ ...archiveMedia, authorize: dependencies.authorize, fatal, audit: (event, details) => console.log(JSON.stringify({ event, ...details })) }), open: archiveMedia.open } : undefined;
  const { server } = createLiveServer(config, dependencies, archive);
  media.once("error", fatal); media.once("exit", fatal); server.on("error", fatal);
  process.once("SIGTERM", fatal); process.once("SIGINT", fatal);
  server.listen(18751, "127.0.0.1", () => console.log("CAMERA_LIVE_READY"));
}

if (process.env.NODE_ENV !== "test") void main().catch(() => { console.error("CAMERA_LIVE_START_FAILED"); process.exit(1); });
