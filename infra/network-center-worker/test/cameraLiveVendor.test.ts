import { afterEach, describe, expect, it, vi } from "vitest";
import { liveConfigSchema } from "../src/cameraLive.js";
import { mediaConfiguration } from "../src/cameraLiveMain.js";
import { playbackSources } from "../src/cameraPlayback.js";
import { hikvisionDefaults, hikvisionVendor, liveStream, liveVendor, liveVendors, recorderSource } from "../src/cameraLiveVendor.js";

const ids = { organizationId: "20000000-0000-4000-8000-000000000001", buildingId: "30000000-0000-4000-8000-000000000001" };
const dahuaRecorder = { id: "10000000-0000-4000-8000-000000000001", ...ids, channels: [1, 9], rtspOrigin: "rtsp://10.0.0.1:18554", username: "fixture", password: "fixture-p@ss/word" };
const hikvisionRecorder = { id: "10000000-0000-4000-8000-000000000002", ...ids, vendor: "HIKVISION", channels: [1, 9], rtspOrigin: "rtsp://192.168.1.10:554", username: "viewer", password: "fixture-p@ss/word", playbackEnabled: true };
const config = liveConfigSchema.parse({ supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co", publishableKey: "test-publishable-key-placeholder", origins: ["https://crm.example.test"], recorders: [dahuaRecorder, hikvisionRecorder] });
const [dahua, hikvision] = config.recorders as [typeof config.recorders[number], typeof config.recorders[number]];
const encoder = `/opt/ihome-camera-live/releases/${"a".repeat(40)}/ffmpeg`;
const uuids = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
/** Records what the gateway sends to the media API, with generated ids replaced by `UUID`. */
function mediaApi() {
  let revision = "";
  const calls: { url: string; method: string; body: string }[] = [];
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === "PATCH") revision = JSON.parse(String(init.body)).rtspPlaybackRevision;
    calls.push({ url: String(url).replace(uuids, "UUID"), method: init?.method ?? "GET", body: init?.body ? String(init.body).replace(uuids, "UUID") : "" });
    return init?.method ? Response.json({}) : Response.json({ typeSpecific: { playbackRevision: revision } });
  });
  return { request, calls, bodies: (method: string) => calls.filter((call) => call.method === method).map((call) => call.body) };
}
/** The argument list MediaMTX runs for a `runOnDemand` string (every argument is single-quoted by the gateway). */
const shellArguments = (command: string) => command.slice(1, -1).split("' '").map((argument) => argument.replaceAll("'\\''", "'"));
/** No audio is mapped, encoded or filtered: `-an` and nothing else about audio. */
function expectVideoOnly(args: string[]) {
  expect(args.filter((argument) => argument === "-an")).toHaveLength(1);
  for (const flag of ["-c:a", "-af", "-ar", "-ac", "-b:a", "libopus"]) expect(args).not.toContain(flag);
  expect(args.some((argument) => /0:a|asetpts|aresample/u.test(argument))).toBe(false);
  expect(args.filter((argument) => argument === "-map")).toHaveLength(1);
}
// 23:59:59 on the last day of October in Vietnam: the window crosses midnight and the month.
const acrossMonth = { start: "2026-10-31T16:59:59.000Z", end: "2026-10-31T17:30:00.000Z" };
const acrossYear = { start: "2026-12-31T16:00:00.000Z", end: "2026-12-31T18:00:00.000Z" };

describe("recorder vendor profiles", () => {
  it("treats a missing vendor and KBVISION as Dahua, and knows no other vendor", () => {
    expect(liveVendors).toEqual(["DAHUA", "KBVISION", "HIKVISION"]);
    expect(liveVendor().vendor).toBe("DAHUA"); expect(liveVendor(undefined)).toBe(liveVendor("DAHUA"));
    const { vendor: _dahua, ...dahuaRest } = liveVendor("DAHUA"); const { vendor: _kbvision, ...kbvisionRest } = liveVendor("KBVISION");
    expect(JSON.stringify(kbvisionRest)).toBe(JSON.stringify(dahuaRest));
    expect(liveVendor("KBVISION").playbackOpen(3, { ...acrossMonth, position: "2026-10-31T17:00:01.000Z", speed: 8 })).toEqual(liveVendor("DAHUA").playbackOpen(3, { ...acrossMonth, position: "2026-10-31T17:00:01.000Z", speed: 8 }));
  });
  it("declares what each vendor can do", () => {
    for (const vendor of ["DAHUA", "KBVISION"] as const) {
      expect(liveVendor(vendor).capabilities).toEqual({ archiveExport: true, playbackControl: true, liveDecodeCheck: false, transcodedAudio: true });
      expect(liveVendor(vendor).playbackSpeeds).toEqual([1, 2, 4, 6, 8]);
    }
    // Measured 11/11/2026: both recorders ignore Range on a running session, and the older one tops out near 4x.
    expect(hikvisionDefaults).toEqual({ seek: "reopen", playbackSpeeds: [1, 2, 4] });
    // Measured 11/11/2026: the older recorder advertises an audio track and never sends a packet on it, so no re-encoded output carries audio.
    expect(liveVendor("HIKVISION").capabilities).toEqual({ archiveExport: false, playbackControl: false, liveDecodeCheck: true, transcodedAudio: false });
    expect(liveVendor("HIKVISION").playbackSpeeds).toEqual([1, 2, 4]);
    for (const seek of ["clock", "npt"] as const) expect(hikvisionVendor({ ...hikvisionDefaults, seek }).capabilities).toEqual({ archiveExport: false, playbackControl: true, liveDecodeCheck: true, transcodedAudio: false });
    expect(hikvisionVendor({ seek: "reopen", playbackSpeeds: [1] }).playbackSpeeds).toEqual([1]);
  });
  it("maps only sd to the sub stream", () => {
    expect(liveStream("sd")).toBe("sub");
    for (const quality of ["hd", "fullhd", "original"]) expect(liveStream(quality)).toBe("main");
  });
  it("formats the recorder's wall clock (UTC+7) across midnight, month, year and leap-day boundaries", () => {
    const cases: [string, string, string][] = [
      ["2026-10-20T01:00:00.000Z", "2026_10_20_08_00_00", "20261020T080000Z"],
      ["2026-10-31T16:59:59.000Z", "2026_10_31_23_59_59", "20261031T235959Z"],
      ["2026-10-31T17:00:00.000Z", "2026_11_01_00_00_00", "20261101T000000Z"],
      ["2026-12-31T18:00:00.000Z", "2027_01_01_01_00_00", "20270101T010000Z"],
      ["2028-02-28T17:00:00.000Z", "2028_02_29_00_00_00", "20280229T000000Z"],
      ["2026-03-01T06:59:59+07:00", "2026_03_01_06_59_59", "20260301T065959Z"],
    ];
    for (const [iso, dahuaTime, hikvisionTime] of cases) {
      expect(liveVendor("DAHUA").deviceTime(iso)).toBe(dahuaTime);
      expect(liveVendor("HIKVISION").deviceTime(iso)).toBe(hikvisionTime);
    }
  });
  it("builds Dahua live and playback sources", () => {
    const profile = liveVendor("DAHUA");
    expect(profile.liveSource(1, "sub")).toBe("/cam/realmonitor?channel=1&subtype=1");
    expect(profile.liveSource(9, "main")).toBe("/cam/realmonitor?channel=9&subtype=0");
    expect(profile.playbackOpen(9, acrossMonth)).toEqual({ path: "/cam/playback?channel=9&subtype=0&starttime=2026_10_31_23_59_59&endtime=2026_11_01_00_30_00" });
    expect(profile.playbackOpen(9, { ...acrossMonth, position: "2026-10-31T17:00:01.000Z", speed: 8 })).toEqual({ path: "/cam/playback?channel=9&subtype=0&starttime=2026_10_31_23_59_59&endtime=2026_11_01_00_30_00", range: { type: "npt", start: "2s" }, scale: "8" });
    expect(profile.playbackOpen(2, { ...acrossYear, position: acrossYear.start, speed: 1 })).toEqual({ path: "/cam/playback?channel=2&subtype=0&starttime=2026_12_31_23_00_00&endtime=2027_01_01_01_00_00", range: { type: "npt", start: "0s" } });
    expect(profile.playbackSeek(acrossMonth, 120, 1)).toEqual({ range: { type: "npt", start: "120s" }, scale: "" });
    expect(profile.playbackSeek(acrossMonth, 0.5, 8)).toEqual({ range: { type: "npt", start: "0.5s" }, scale: "8" });
  });
  it("builds Hikvision live sources from channel * 100 + stream, without zero padding", () => {
    const profile = liveVendor("HIKVISION");
    expect(profile.liveSource(1, "main")).toBe("/Streaming/Channels/101"); expect(profile.liveSource(1, "sub")).toBe("/Streaming/Channels/102");
    expect(profile.liveSource(9, "main")).toBe("/Streaming/Channels/901"); expect(profile.liveSource(9, "sub")).toBe("/Streaming/Channels/902");
    expect(profile.liveSource(16, "sub")).toBe("/Streaming/Channels/1602"); expect(profile.liveSource(33, "main")).toBe("/Streaming/Channels/3301");
  });
  it("opens Hikvision playback on the main track with the recorder's wall clock and a literal Z", () => {
    const profile = liveVendor("HIKVISION");
    expect(profile.playbackOpen(1, acrossMonth)).toEqual({ path: "/Streaming/tracks/101?starttime=20261031T235959Z&endtime=20261101T003000Z" });
    expect(profile.playbackOpen(9, acrossYear)).toEqual({ path: "/Streaming/tracks/901?starttime=20261231T230000Z&endtime=20270101T010000Z" });
    expect(profile.playbackOpen(9, { ...acrossYear, speed: 4 })).toEqual({ path: "/Streaming/tracks/901?starttime=20261231T230000Z&endtime=20270101T010000Z", scale: "4" });
    // A position equal to the window start changes nothing.
    expect(profile.playbackOpen(9, { ...acrossYear, position: acrossYear.start, speed: 1 })).toEqual({ path: "/Streaming/tracks/901?starttime=20261231T230000Z&endtime=20270101T010000Z" });
  });
  it("by default re-opens a Hikvision source at the position: no Range, Scale on the first PLAY, nothing for a running session", () => {
    const profile = hikvisionVendor();
    expect(profile.playbackOpen(9, { ...acrossYear, position: "2026-12-31T17:00:01.000Z", speed: 4 })).toEqual({ path: "/Streaming/tracks/901?starttime=20270101T000001Z&endtime=20270101T010000Z", scale: "4" });
    expect(profile.playbackOpen(9, { ...acrossYear, position: "2026-12-31T17:59:59.000Z" })).toEqual({ path: "/Streaming/tracks/901?starttime=20270101T005959Z&endtime=20270101T010000Z" });
    expect(profile.playbackOpen(1, { ...acrossMonth, speed: 2 })).toEqual({ path: "/Streaming/tracks/101?starttime=20261031T235959Z&endtime=20261101T003000Z", scale: "2" });
    for (const speed of [1, 2, 4]) expect(profile.playbackSeek(acrossYear, 3600, speed)).toBeUndefined();
  });
  it("keeps clock and npt Range as switchable strategies, with the whole window in the URL", () => {
    const clock = hikvisionVendor({ ...hikvisionDefaults, seek: "clock" });
    expect(clock.playbackOpen(9, { ...acrossYear, position: "2026-12-31T17:00:01.000Z", speed: 4 })).toEqual({ path: "/Streaming/tracks/901?starttime=20261231T230000Z&endtime=20270101T010000Z", range: { type: "clock", start: "20270101T000001Z" }, scale: "4" });
    expect(clock.playbackSeek(acrossYear, 3600, 1)).toEqual({ range: { type: "clock", start: "20270101T000000Z" }, scale: "" });
    expect(clock.playbackSeek(acrossYear, 3599, 4)).toEqual({ range: { type: "clock", start: "20261231T235959Z" }, scale: "4" });
    expect(clock.playbackSeek(acrossYear, 0, 2)).toEqual({ range: { type: "clock", start: "20261231T230000Z" }, scale: "2" });
    const npt = hikvisionVendor({ ...hikvisionDefaults, seek: "npt" });
    expect(npt.playbackOpen(9, { ...acrossYear, position: "2026-12-31T17:00:01.000Z" })).toEqual({ path: "/Streaming/tracks/901?starttime=20261231T230000Z&endtime=20270101T010000Z", range: { type: "npt", start: "3601s" } });
    expect(npt.playbackSeek(acrossYear, 3600, 4)).toEqual({ range: { type: "npt", start: "3600s" }, scale: "4" });
  });
  it("attaches credentials in one place, percent-encoded, and only to the recorder origin", () => {
    expect(recorderSource(dahua, "/cam/realmonitor?channel=1&subtype=1")).toBe("rtsp://fixture:fixture-p%40ss%2Fword@10.0.0.1:18554/cam/realmonitor?channel=1&subtype=1");
    expect(recorderSource(hikvision, liveVendor("HIKVISION").liveSource(9, "sub"))).toBe("rtsp://viewer:fixture-p%40ss%2Fword@192.168.1.10:554/Streaming/Channels/902");
    for (const profile of [liveVendor("DAHUA"), liveVendor("HIKVISION")]) expect(JSON.stringify([profile.liveSource(1, "main"), profile.playbackOpen(1, acrossMonth)])).not.toMatch(/fixture|viewer|10\.0\.0\.1|192\.168/u);
  });
});

describe("Dahua output is unchanged by the vendor field", () => {
  const live = (channel: number, quality: "sd" | "hd") => ({ source: `rtsp://fixture:fixture-p%40ss%2Fword@10.0.0.1:18554/cam/realmonitor?channel=${channel}&subtype=${quality === "sd" ? 1 : 0}`, sourceOnDemand: true, sourceOnDemandStartTimeout: "8s", sourceOnDemandCloseAfter: "5s", rtspTransport: "tcp", record: false, maxReaders: 24 });
  it("keeps the exact live sources and encoder commands", () => {
    const paths = mediaConfiguration(config).paths as Record<string, unknown>;
    expect(JSON.stringify(paths[`camera-${dahua.id}-1`])).toBe(JSON.stringify(live(1, "sd")));
    expect(JSON.stringify(paths[`camera-${dahua.id}-9-hd`])).toBe(JSON.stringify(live(9, "hd")));
    const encoded = mediaConfiguration(config, encoder).paths as Record<string, unknown>;
    expect(JSON.stringify(encoded[`camera-${dahua.id}-9-original`])).toBe(JSON.stringify(live(9, "hd")));
    expect(JSON.stringify(encoded[`camera-${dahua.id}-1-hd`])).toBe(`{"source":"publisher","runOnDemand":"'${encoder}' '-hide_banner' '-loglevel' 'error' '-nostdin' '-threads' '1' '-filter_threads' '1' '-rtsp_transport' 'tcp' '-timeout' '10000000' '-probesize' '32768' '-analyzeduration' '1' '-i' 'rtsp://127.0.0.1:18895/camera-${dahua.id}-1-original' '-map' '0:v:0' '-map' '0:a:0?' '-c:v' 'libx264' '-threads' '1' '-preset' 'ultrafast' '-tune' 'zerolatency' '-crf' '25' '-maxrate' '2500k' '-bufsize' '9000k' '-pix_fmt' 'yuv420p' '-g' '15' '-vf' 'fps=15,scale=w='\\\\''min(1280,iw)'\\\\'':h='\\\\''min(720,ih)'\\\\'':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear' '-c:a' 'libopus' '-ar' '48000' '-ac' '1' '-b:a' '32k' '-f' 'rtsp' '-rtsp_transport' 'tcp' '-muxdelay' '0.05' 'rtsp://127.0.0.1:18895/camera-${dahua.id}-1-hd'","runOnDemandRestart":false,"runOnDemandStartTimeout":"10s","runOnDemandCloseAfter":"1s","record":false,"maxReaders":24}`);
    expect(JSON.stringify(encoded[`camera-${dahua.id}-9-fullhd`])).toBe(`{"source":"publisher","runOnDemand":"'${encoder}' '-hide_banner' '-loglevel' 'error' '-nostdin' '-threads' '1' '-filter_threads' '1' '-rtsp_transport' 'tcp' '-timeout' '10000000' '-probesize' '32768' '-analyzeduration' '1' '-i' 'rtsp://127.0.0.1:18895/camera-${dahua.id}-9-original' '-map' '0:v:0' '-map' '0:a:0?' '-c:v' 'libx264' '-threads' '2' '-preset' 'ultrafast' '-tune' 'zerolatency' '-crf' '25' '-maxrate' '4500k' '-bufsize' '9000k' '-pix_fmt' 'yuv420p' '-g' '10' '-vf' 'fps=10,scale=w='\\\\''min(1920,iw)'\\\\'':h='\\\\''min(1080,ih)'\\\\'':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear' '-c:a' 'libopus' '-ar' '48000' '-ac' '1' '-b:a' '32k' '-f' 'rtsp' '-rtsp_transport' 'tcp' '-muxdelay' '0.05' 'rtsp://127.0.0.1:18895/camera-${dahua.id}-9-fullhd'","runOnDemandRestart":false,"runOnDemandStartTimeout":"10s","runOnDemandCloseAfter":"1s","record":false,"maxReaders":24}`);
  });
  it("keeps the exact playback source, encoder command, seek and speed requests", async () => {
    const api = mediaApi(); const sources = playbackSources(api.request, vi.fn(), encoder);
    const direct = await sources.add(dahua, 9, { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T02:00:00.000Z" });
    const original = await sources.add(dahua, 9, { ...acrossMonth, position: "2026-10-31T17:00:01.000Z", speed: 8, quality: "original" });
    const sd = await sources.add(dahua, 9, { ...acrossYear, quality: "sd", speed: 1 });
    await sources.control(sd, 120, 1, new AbortController().signal); await sources.control(sd, 0.5, 8, new AbortController().signal);
    const thumbnail = await sources.add(dahua, 1, { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T01:00:20.000Z" }, true);
    for (const name of [direct, original, sd, thumbnail]) await sources.remove(name);
    const playback = "rtsp://fixture:fixture-p%40ss%2Fword@10.0.0.1:18554/cam/playback";
    expect(api.bodies("POST")).toEqual([
      `{"source":"${playback}?channel=9&subtype=0&starttime=2026_10_20_08_00_00&endtime=2026_10_20_09_00_00","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","record":false,"maxReaders":1}`,
      `{"source":"${playback}?channel=9&subtype=0&starttime=2026_10_31_23_59_59&endtime=2026_11_01_00_30_00","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","rtspPlaybackRevision":"UUID","rtspRangeType":"npt","rtspRangeStart":"2s","rtspScale":"8","record":false,"maxReaders":1}`,
      `{"source":"rtsp://127.0.0.1:18895/playback-source-UUID","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","record":false,"maxReaders":1}`,
      `{"source":"${playback}?channel=9&subtype=0&starttime=2026_12_31_23_00_00&endtime=2027_01_01_01_00_00","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","rtspPlaybackRevision":"UUID","record":false,"maxReaders":1}`,
      `{"source":"publisher","runOnDemand":"'${encoder}' '-hide_banner' '-loglevel' 'error' '-nostdin' '-threads' '1' '-filter_threads' '1' '-rtsp_transport' 'tcp' '-timeout' '10000000' '-probesize' '32768' '-analyzeduration' '1' '-i' 'rtsp://127.0.0.1:18895/playback-source-UUID' '-map' '0:v:0' '-map' '0:a:0?' '-c:a' 'libopus' '-ar' '48000' '-ac' '1' '-b:a' '32k' '-af' 'asetpts=(RTCTIME-RTCSTART)/(TB*1000000),aresample=async=1:first_pts=0' '-c:v' 'libx264' '-threads' '1' '-preset' 'ultrafast' '-tune' 'zerolatency' '-crf' '28' '-maxrate' '1800k' '-bufsize' '3600k' '-pix_fmt' 'yuv420p' '-g' '25' '-force_key_frames' 'expr:gte(t,n_forced*0.5)' '-vf' 'setpts=(RTCTIME-RTCSTART)/(TB*1000000),scale=w='\\\\''min(854,iw)'\\\\'':h='\\\\''min(480,ih)'\\\\'':force_original_aspect_ratio=decrease:force_divisible_by=2' '-fps_mode' 'passthrough' '-enc_time_base' '1:90000' '-f' 'rtsp' '-rtsp_transport' 'tcp' '-max_interleave_delta' '100000' '-muxdelay' '0.05' 'rtsp://127.0.0.1:18895/playback-UUID'","runOnDemandRestart":false,"runOnDemandStartTimeout":"10s","runOnDemandCloseAfter":"1s","record":false,"maxReaders":1}`,
      `{"source":"${playback}?channel=1&subtype=0&starttime=2026_10_20_08_00_00&endtime=2026_10_20_08_00_20","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","rtspPlaybackRevision":"UUID","record":false,"maxReaders":1}`,
    ]);
    expect(api.bodies("PATCH")).toEqual([
      `{"rtspRangeType":"npt","rtspRangeStart":"120s","rtspScale":"","rtspPlaybackRevision":"UUID"}`,
      `{"rtspRangeType":"npt","rtspRangeStart":"0.5s","rtspScale":"8","rtspPlaybackRevision":"UUID"}`,
    ]);
    expect(api.calls.filter((call) => call.method === "PATCH" || call.method === "GET").map((call) => call.url)).toEqual([
      "http://127.0.0.1:18897/v3/config/paths/patch/playback-source-UUID", "http://127.0.0.1:18897/v3/paths/static-sources/get/playback-source-UUID",
      "http://127.0.0.1:18897/v3/config/paths/patch/playback-source-UUID", "http://127.0.0.1:18897/v3/paths/static-sources/get/playback-source-UUID",
    ]);
  });
});

describe("Hikvision through the same media plumbing", () => {
  it("pulls live from /Streaming/Channels and feeds the same encoder commands a credential-free loopback URL", () => {
    const encoded = mediaConfiguration(config, encoder).paths as Record<string, { source: string; runOnDemand?: string }>;
    const source = "rtsp://viewer:fixture-p%40ss%2Fword@192.168.1.10:554/Streaming/Channels";
    expect(encoded[`camera-${hikvision.id}-1`]).toEqual({ source: `${source}/102`, sourceOnDemand: true, sourceOnDemandStartTimeout: "8s", sourceOnDemandCloseAfter: "5s", rtspTransport: "tcp", record: false, maxReaders: 24 });
    expect(encoded[`camera-${hikvision.id}-1-original`]!.source).toBe(`${source}/101`);
    expect(encoded[`camera-${hikvision.id}-9`]!.source).toBe(`${source}/902`); expect(encoded[`camera-${hikvision.id}-9-original`]!.source).toBe(`${source}/901`);
    expect(mediaConfiguration(config).paths[`camera-${hikvision.id}-9-hd`]!.source).toBe(`${source}/901`);
    for (const quality of ["hd", "fullhd"]) expect(encoded[`camera-${hikvision.id}-9-${quality}`]!.runOnDemand).not.toMatch(/viewer|fixture-p|192\.168/u);
  });
  it("re-encodes Hikvision live HD without any audio argument, while the Dahua encoder keeps its audio", () => {
    const encoded = mediaConfiguration(config, encoder).paths as Record<string, { runOnDemand?: string }>;
    const { runOnDemand, ...path } = encoded[`camera-${hikvision.id}-1-hd`]!;
    expect(path).toEqual({ source: "publisher", runOnDemandRestart: false, runOnDemandStartTimeout: "10s", runOnDemandCloseAfter: "1s", record: false, maxReaders: 24 });
    const live = (recorderId: string, audio: boolean) => [
      encoder, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-rtsp_transport", "tcp", "-timeout", "10000000", "-probesize", "32768", "-analyzeduration", "1",
      "-i", `rtsp://127.0.0.1:18895/camera-${recorderId}-1-original`, "-map", "0:v:0", ...(audio ? ["-map", "0:a:0?"] : ["-an"]),
      "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "25", "-maxrate", "2500k", "-bufsize", "9000k", "-pix_fmt", "yuv420p", "-g", "15",
      "-vf", "fps=15,scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear",
      ...(audio ? ["-c:a", "libopus", "-ar", "48000", "-ac", "1", "-b:a", "32k"] : []), "-f", "rtsp", "-rtsp_transport", "tcp", "-muxdelay", "0.05", `rtsp://127.0.0.1:18895/camera-${recorderId}-1-hd`,
    ];
    expect(shellArguments(runOnDemand!)).toEqual(live(hikvision.id, false));
    expectVideoOnly(shellArguments(runOnDemand!));
    expectVideoOnly(shellArguments(encoded[`camera-${hikvision.id}-9-fullhd`]!.runOnDemand!));
    expect(shellArguments(encoded[`camera-${dahua.id}-1-hd`]!.runOnDemand!)).toEqual(live(dahua.id, true));
  });
  it("opens playback on /Streaming/tracks at the requested position with Scale on the first PLAY, and sends nothing to a running session", async () => {
    const api = mediaApi(); const sources = playbackSources(api.request, vi.fn(), encoder);
    const direct = await sources.add(hikvision, 1, acrossMonth);
    const sd = await sources.add(hikvision, 9, { ...acrossYear, quality: "sd", position: "2026-12-31T17:00:01.000Z", speed: 4 });
    const thumbnail = await sources.add(hikvision, 9, { start: "2026-10-20T01:00:00.000Z", end: "2026-10-20T01:00:20.000Z" }, true);
    const dahuaSd = await sources.add(dahua, 9, { ...acrossYear, quality: "sd" });
    const tracks = "rtsp://viewer:fixture-p%40ss%2Fword@192.168.1.10:554/Streaming/tracks";
    const posts = api.bodies("POST");
    expect(posts[0]).toBe(`{"source":"${tracks}/101?starttime=20261031T235959Z&endtime=20261101T003000Z","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","record":false,"maxReaders":1}`);
    expect(posts[1]).toBe(`{"source":"${tracks}/901?starttime=20270101T000001Z&endtime=20270101T010000Z","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","rtspPlaybackRevision":"UUID","rtspScale":"4","record":false,"maxReaders":1}`);
    // The transcoder only ever reads the loopback source, and for Hikvision it is video-only (playback SD here).
    const { runOnDemand, ...transcoder } = JSON.parse(posts[2]!) as { runOnDemand: string };
    expect(transcoder).toEqual({ source: "publisher", runOnDemandRestart: false, runOnDemandStartTimeout: "10s", runOnDemandCloseAfter: "1s", record: false, maxReaders: 1 });
    const sdAudio = ["-map", "0:a:0?", "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-b:a", "32k", "-af", "asetpts=(RTCTIME-RTCSTART)/(TB*1000000),aresample=async=1:first_pts=0"];
    const playbackSd = (audio: boolean) => [
      encoder, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-rtsp_transport", "tcp", "-timeout", "10000000", "-probesize", "32768", "-analyzeduration", "1",
      "-i", "rtsp://127.0.0.1:18895/playback-source-UUID", "-map", "0:v:0", ...(audio ? sdAudio : ["-an"]),
      "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "28", "-maxrate", "1800k", "-bufsize", "3600k", "-pix_fmt", "yuv420p", "-g", "25", "-force_key_frames", "expr:gte(t,n_forced*0.5)",
      "-vf", "setpts=(RTCTIME-RTCSTART)/(TB*1000000),scale=w='min(854,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-fps_mode", "passthrough", "-enc_time_base", "1:90000", "-f", "rtsp", "-rtsp_transport", "tcp", "-max_interleave_delta", "100000", "-muxdelay", "0.05", "rtsp://127.0.0.1:18895/playback-UUID",
    ];
    expect(shellArguments(runOnDemand)).toEqual(playbackSd(false)); expectVideoOnly(shellArguments(runOnDemand));
    expect(posts[2]).not.toMatch(/viewer|fixture-p|192\.168/u);
    expect(shellArguments((JSON.parse(posts[5]!) as { runOnDemand: string }).runOnDemand)).toEqual(playbackSd(true));
    expect(posts[3]).toBe(`{"source":"${tracks}/901?starttime=20261020T080000Z&endtime=20261020T080020Z","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","rtspPlaybackRevision":"UUID","record":false,"maxReaders":1}`);
    // Both measured recorders ignore Range on a running session, so none is ever sent: the viewer opens a new session.
    for (const [offset, speed] of [[3600, 4], [60, 1]] as const) await expect(sources.control(sd, offset, speed, new AbortController().signal)).rejects.toMatchObject({ status: 409, code: "PLAYBACK_CONTROL_UNAVAILABLE" });
    expect(api.bodies("PATCH")).toEqual([]); expect(api.calls.some((call) => call.url.includes("static-sources"))).toBe(false);
    for (const name of [direct, sd, thumbnail, dahuaSd]) await sources.remove(name);
    const removed = (suffix: string) => `http://127.0.0.1:18897/v3/config/paths/delete/playback-${suffix}UUID`;
    expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([removed(""), removed(""), removed("source-"), removed(""), removed(""), removed("source-")]);
  });
});

describe("Hikvision with seek switched back to clock", () => {
  afterEach(() => { vi.doUnmock("../src/cameraLiveVendor.js"); vi.resetModules(); });
  it("offers playback control again and sends seek and speed as clock Range and Scale on the running session", async () => {
    vi.resetModules();
    vi.doMock("../src/cameraLiveVendor.js", async (original) => {
      const actual = await original<typeof import("../src/cameraLiveVendor.js")>();
      const clock = actual.hikvisionVendor({ ...actual.hikvisionDefaults, seek: "clock" });
      return { ...actual, liveVendor: (vendor?: Parameters<typeof actual.liveVendor>[0]) => (vendor === "HIKVISION" ? clock : actual.liveVendor(vendor)) };
    });
    const { createLiveServer } = await import("../src/cameraLive.js");
    const { playbackSources: rangeSources } = await import("../src/cameraPlayback.js");
    const api = mediaApi(); const sources = rangeSources(api.request, vi.fn(), encoder);
    const name = await sources.add(hikvision, 9, { ...acrossYear, quality: "sd", position: "2026-12-31T17:00:01.000Z" });
    expect(api.bodies("POST")[0]).toBe(`{"source":"rtsp://viewer:fixture-p%40ss%2Fword@192.168.1.10:554/Streaming/tracks/901?starttime=20261231T230000Z&endtime=20270101T010000Z","sourceOnDemand":true,"sourceOnDemandStartTimeout":"8s","sourceOnDemandCloseAfter":"1s","rtspTransport":"tcp","rtspPlaybackRevision":"UUID","rtspRangeType":"clock","rtspRangeStart":"20270101T000001Z","record":false,"maxReaders":1}`);
    await sources.control(name, 3600, 4, new AbortController().signal); await sources.control(name, 60, 1, new AbortController().signal);
    expect(api.bodies("PATCH")).toEqual([
      `{"rtspRangeType":"clock","rtspRangeStart":"20270101T000000Z","rtspScale":"4","rtspPlaybackRevision":"UUID"}`,
      `{"rtspRangeType":"clock","rtspRangeStart":"20261231T230100Z","rtspScale":"","rtspPlaybackRevision":"UUID"}`,
    ]);
    const { server } = createLiveServer(config, { authorize: async () => ({ id: "40000000-0000-4000-8000-000000000001", expiresAt: Date.now() + 60_000 }), start: vi.fn(), stop: vi.fn(), fatal: vi.fn(), control: vi.fn(), playbackQualities: ["sd", "hd"] });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/camera-live/v1/recorders/${hikvision.id}`, { headers: { Origin: config.origins[0]!, Authorization: "Bearer a-token-long-enough-for-validation" } });
      expect(await response.json()).toMatchObject({ archive: false, playback: true, playbackControl: true, playbackSpeeds: [1, 2, 4], playbackQualities: ["sd", "hd"] });
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
});
