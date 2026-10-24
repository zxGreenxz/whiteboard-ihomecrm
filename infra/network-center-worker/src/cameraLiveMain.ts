import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLiveDependencies, createLiveServer, liveConfigSchema, streamName, type LiveConfig } from "./cameraLive.js";
import { ArchiveJobs } from "./cameraArchive.js";
import { createArchiveMedia, prepareArchiveDirectory } from "./cameraArchiveMedia.js";

export const MEDIA_VERSION = "1.21.2";
export const MEDIA_ARCHIVE_SHA256 = "121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27";

export function mediaConfiguration(config: LiveConfig) {
  const paths = Object.fromEntries(config.recorders.flatMap((recorder) => recorder.channels.map((channel) => {
    const source = new URL(`/cam/realmonitor?channel=${channel}&subtype=1`, recorder.rtspOrigin);
    source.username = recorder.username; source.password = recorder.password;
    return [streamName(recorder, channel), { source: source.href, sourceOnDemand: true, sourceOnDemandStartTimeout: "8s", sourceOnDemandCloseAfter: "5s", rtspTransport: "tcp", record: false, maxReaders: 24 }];
  })));
  return {
    logLevel: "error", logDestinations: ["stdout"], dumpPackets: false,
    rtsp: false, rtmp: false, hls: false, srt: false, moq: false, playback: false,
    api: true, apiAddress: "127.0.0.1:18897", apiAllowOrigins: [], metrics: false, pprof: false,
    webrtc: true, webrtcAddress: "127.0.0.1:18889", webrtcAllowOrigins: [],
    webrtcLocalUDPAddress: "", webrtcLocalTCPAddress: "", webrtcIPsFromInterfaces: false,
    webrtcICEServers2: [{ url: "stun:stun.l.google.com:19302" }],
    webrtcHandshakeTimeout: "15s", webrtcSTUNGatherTimeout: "5s",
    authInternalUsers: [{ user: "any", ips: ["127.0.0.1"], permissions: [{ action: "read" }, { action: "api" }] }],
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
  await writeFile(mediaConfig, JSON.stringify(mediaConfiguration(config)), { mode: 0o600 });
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
  const dependencies = createLiveDependencies(config, fatal);
  const archive = archiveMedia ? { jobs: new ArchiveJobs({ ...archiveMedia, authorize: dependencies.authorize, fatal, audit: (event, details) => console.log(JSON.stringify({ event, ...details })) }), open: archiveMedia.open } : undefined;
  const { server } = createLiveServer(config, dependencies, archive);
  media.once("error", fatal); media.once("exit", fatal); server.on("error", fatal);
  process.once("SIGTERM", fatal); process.once("SIGINT", fatal);
  server.listen(18751, "127.0.0.1", () => console.log("CAMERA_LIVE_READY"));
}

if (process.env.NODE_ENV !== "test") void main().catch(() => { console.error("CAMERA_LIVE_START_FAILED"); process.exit(1); });
