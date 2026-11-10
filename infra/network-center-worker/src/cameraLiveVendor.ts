/**
 * Every recorder-vendor decision of the live/playback gateway, as pure functions: RTSP source paths, the
 * recorder's time format, what a seek or speed change sends upstream, and what a vendor cannot do.
 * The server asks a profile; it never branches on the vendor name. No credentials pass through here.
 */
export const liveVendors = ["DAHUA", "KBVISION", "HIKVISION"] as const;
export type LiveVendor = (typeof liveVendors)[number];
export type LiveStream = "main" | "sub";

/** Recorders keep the building's wall clock: UTC+7, no daylight saving. */
const DEVICE_UTC_OFFSET_MS = 7 * 3600_000;
/** `YYYY-MM-DDTHH:MM:SS` on the recorder's wall clock. */
const wallClock = (iso: string) => new Date(Date.parse(iso) + DEVICE_UTC_OFFSET_MS).toISOString().slice(0, 19);
const offsetSeconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
/** No Scale header at normal speed: Dahua firmware returns too few frames for an explicit `Scale: 1`. */
const scaleOf = (speed: number | undefined) => (speed && speed !== 1 ? String(speed) : "");

export interface VendorPlaybackRange { start: string; end: string; position?: string; speed?: number }
/** RTSP `Range` of a PLAY, in the MediaMTX path fields `rtspRangeType` / `rtspRangeStart`. */
export interface VendorRtspRange { type: "npt" | "clock"; start: string }
/** Opening a recording: source path with query (no credentials) and what the first PLAY carries. */
export interface VendorPlaybackOpen { path: string; range?: VendorRtspRange; scale?: string }
/** PAUSE + PLAY on the running RTSP session. An empty `scale` removes the Scale header. */
export interface VendorPlaybackSeek { range: VendorRtspRange; scale: string }
export interface LiveVendorCapabilities {
  /** Clip export (HTTP download of the recording). Without it `archiveEnabled`/`archiveOrigin` are rejected at load. */
  archiveExport: boolean;
  /** Seek and speed change on the running playback session. False: the viewer re-opens the stream at the new position. */
  playbackControl: boolean;
  /** The recorder can deliver live video nobody can decode (stream encryption); prove one frame decodes before offering it. */
  liveDecodeCheck: boolean;
  /** Re-encoded outputs (resized live, SD/HD/Full HD playback) carry the recorder's audio. Native streams relay whatever arrives either way. */
  transcodedAudio: boolean;
}
export interface LiveVendorProfile {
  readonly vendor: LiveVendor;
  readonly capabilities: Readonly<LiveVendorCapabilities>;
  /** Speeds offered to viewers for recorded playback. */
  readonly playbackSpeeds: readonly number[];
  /** A UTC instant in the format the recorder expects in its playback URL. */
  deviceTime(iso: string): string;
  /** RTSP path and query of a live stream. */
  liveSource(channel: number, stream: LiveStream): string;
  playbackOpen(channel: number, range: VendorPlaybackRange): VendorPlaybackOpen;
  /** `offset` is in seconds from `range.start`. Undefined: this vendor cannot move a running session. */
  playbackSeek(range: VendorPlaybackRange, offset: number, speed: number): VendorPlaybackSeek | undefined;
}

/** `sd` is the recorder's sub stream; every other quality is derived from the main stream. */
export const liveStream = (quality: string): LiveStream => (quality === "sd" ? "sub" : "main");

/** The only place recorder credentials are attached. The result goes to the loopback media API or its 0600 file; never log it. */
export function recorderSource(recorder: { rtspOrigin: string; username: string; password: string }, path: string): string {
  const source = new URL(path, recorder.rtspOrigin);
  source.username = recorder.username; source.password = recorder.password;
  return source.href;
}

const dahuaTime = (iso: string) => wallClock(iso).replace(/[-:T]/gu, "_");
function dahuaVendor(vendor: "DAHUA" | "KBVISION"): LiveVendorProfile {
  return {
    vendor,
    capabilities: { archiveExport: true, playbackControl: true, liveDecodeCheck: false, transcodedAudio: true },
    playbackSpeeds: [1, 2, 4, 6, 8],
    deviceTime: dahuaTime,
    liveSource: (channel, stream) => `/cam/realmonitor?channel=${channel}&subtype=${stream === "sub" ? 1 : 0}`,
    playbackOpen(channel, range) {
      const query = new URLSearchParams({ channel: String(channel), subtype: "0", starttime: dahuaTime(range.start), endtime: dahuaTime(range.end) });
      const scale = scaleOf(range.speed);
      return { path: `/cam/playback?${query.toString()}`, ...(range.position ? { range: { type: "npt" as const, start: `${offsetSeconds(range.start, range.position)}s` } } : {}), ...(scale ? { scale } : {}) };
    },
    playbackSeek: (_range, offset, speed) => ({ range: { type: "npt", start: `${offset}s` }, scale: scaleOf(speed) }),
  };
}

/**
 * How a Hikvision playback session moves to another position.
 * - `reopen`: no Range at all; the position is the `starttime` of a new source URL, so each seek or speed change is
 *   a new stream, opened with Scale on its first PLAY.
 * - `clock`: PAUSE + PLAY with `Range: clock=<recorder wall clock>Z-` on the running session.
 * - `npt`: the same with `Range: npt=<seconds from the window start>-`, exactly as for Dahua.
 */
export type HikvisionSeek = "reopen" | "clock" | "npt";
export interface HikvisionOptions { seek: HikvisionSeek; playbackSpeeds: readonly number[] }
/**
 * Measured on 10/11/2026 with FFmpeg and on 11/11/2026 through this gateway's MediaMTX, on two firmware
 * generations: a hybrid DVR on V4.70 (H.265) and a 16-input DVR on V3.4 from 2017 (H.264).
 * - Stream ids and the playback URL are as built below; `starttime` is the recorder's wall clock despite the `Z`.
 *   The first picture is near, not at, `starttime`: about 2 s after it on V4.70, 5 to 11 s before it on V3.4.
 * - Range on a running session is acknowledged and then IGNORED by both, as `clock=` and as `npt=`: the position
 *   does not move, and V3.4 also freezes the picture for about 3 s. `clock` and `npt` are kept only as switchable
 *   strategies for a recorder that honours them; neither measured recorder does.
 * - `reopen` works on both, including Scale on the first PLAY of the new source. A re-encoded SD stream opened
 *   directly at 4x was measured too: it works on V4.70 with audio mapped and on V3.4 only without audio (see
 *   `transcodedAudio` below).
 * - Scale: 2x is exact on both. V4.70 plays exactly 4x, 6x and 8x. V3.4 delivers about 3.6x when asked for 4x and
 *   no more than that when asked for 6x or 8x, so only speeds both generations can follow are offered.
 */
export const hikvisionDefaults: HikvisionOptions = { seek: "reopen", playbackSpeeds: [1, 2, 4] };

/** `20261110T120000Z`: recorder wall clock; Hikvision writes the `Z` but does not mean UTC. */
const hikvisionTime = (iso: string) => `${wallClock(iso).replace(/[-:]/gu, "")}Z`;
/** Stream id: channel 1 is 101 (main) / 102 (sub), IP channel 9 is 901 / 902. No zero padding. */
const hikvisionStreamId = (channel: number, stream: LiveStream) => channel * 100 + (stream === "sub" ? 2 : 1);
export function hikvisionVendor(options: HikvisionOptions = hikvisionDefaults): LiveVendorProfile {
  return {
    vendor: "HIKVISION",
    capabilities: {
      archiveExport: false, playbackControl: options.seek !== "reopen", liveDecodeCheck: true,
      // Measured on 11/11/2026 on firmware V3.4: the SDP advertises a pcm_mulaw track on live and on playback, yet not
      // one audio packet arrives. FFmpeg writes its output header only once every mapped stream has produced a frame,
      // so a transcoder that maps that track never publishes and the viewer gets the start timeout. V4.70 does send
      // audio but is treated the same, for one predictable behaviour per vendor.
      transcodedAudio: false,
    },
    playbackSpeeds: options.playbackSpeeds,
    deviceTime: hikvisionTime,
    liveSource: (channel, stream) => `/Streaming/Channels/${hikvisionStreamId(channel, stream)}`,
    playbackOpen(channel, range) {
      const position = range.position && range.position !== range.start ? range.position : undefined;
      // Recorded playback always reads the main track.
      const track = (from: string) => `/Streaming/tracks/${hikvisionStreamId(channel, "main")}?starttime=${hikvisionTime(from)}&endtime=${hikvisionTime(range.end)}`;
      const scale = scaleOf(range.speed);
      const first = !position || options.seek === "reopen" ? undefined
        : options.seek === "clock" ? { type: "clock" as const, start: hikvisionTime(position) }
          : { type: "npt" as const, start: `${offsetSeconds(range.start, position)}s` };
      // With Range the URL keeps the whole window, so a later seek may go back before the first position.
      return { path: track(options.seek === "reopen" && position ? position : range.start), ...(first ? { range: first } : {}), ...(scale ? { scale } : {}) };
    },
    playbackSeek(range, offset, speed) {
      if (options.seek === "reopen") return undefined;
      const target = new Date(Date.parse(range.start) + offset * 1000).toISOString();
      return { range: options.seek === "clock" ? { type: "clock", start: hikvisionTime(target) } : { type: "npt", start: `${offset}s` }, scale: scaleOf(speed) };
    },
  };
}

const profiles: Record<LiveVendor, LiveVendorProfile> = { DAHUA: dahuaVendor("DAHUA"), KBVISION: dahuaVendor("KBVISION"), HIKVISION: hikvisionVendor() };
/** No vendor in `live-config.json` means Dahua/KBVision: the only recorders the gateway served before the field existed. */
export function liveVendor(vendor?: LiveVendor): LiveVendorProfile { return profiles[vendor ?? "DAHUA"]; }
