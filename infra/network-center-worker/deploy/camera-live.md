# Camera live gateway

The gateway adds receive-only WebRTC video to the existing camera monitoring tab. It does not record video or change the recorder's encoding or recording settings. MediaMTX passes the recorder substream through without transcoding. H.265 decoding depends on the browser/device; unsupported codecs and failed ICE connections remain visible errors. The verified pilot is Chrome/Chromium on the operator's Windows device; other devices and restrictive mobile networks require separate verification.

## Boundaries

- HTTPS carries only authenticated capabilities, SDP offers/answers and lease operations. Video travels over encrypted WebRTC, directly between the media host and the viewer. Do not route video/HLS through the existing Cloudflare tunnel.
- The gateway binds `127.0.0.1:18751`; MediaMTX signaling binds `127.0.0.1:18889`. RTSP/RTMP/HLS/SRT/MoQ, playback, recording and the media control API are disabled. Random UDP candidates use STUN; a network that requires TURN will fail explicitly rather than silently use another relay.
- NVR access uses a private WireGuard route with exact source and destination restrictions. There is no new public NVR port.
- Each create/renew/delete checks Supabase Auth and calls `camera_building_snapshot_v1` with the same user JWT. The configured recorder ID, organization, building, enabled flag and channel capacity must match the authorized snapshot. No service-role key is used.
- Opaque sessions are bound to their owner. A session lasts at most 75 seconds without successful renewal (checked every second), and cannot outlive the JWT used to authorize it. Permission revocation takes effect on the next renewal or lease expiry. Closing the tab also closes the browser peer immediately; server leases handle lost cleanup requests.
- There are at most 16 sessions per user and 24 globally, including pending starts. The gateway accepts one receive-only video track and bounded SDP bodies. Credentials, recorder URLs and upstream error text never reach the browser or journal.
- An uncertain create or failed cleanup stops the entire gateway/media process group. This interrupts other viewers but prevents an untracked session from continuing.

## Reproducible installation

Build `cameraLiveMain.mjs` using `scripts/build-camera-live.mjs` with the repository lockfile. The host Node runtime must be exactly 22.23.2. Use MediaMTX **1.21.2**, official Linux amd64 release archive SHA-256:

`121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27`

Verify the archive before extracting only its regular `mediamtx` member. Record the executable hash and gateway artifact hash with the reviewed Git SHA. Keep release directories immutable under `/opt/ihome-camera-live/releases/<sha>/`; `current` selects one release. The service verifies the executable hash on every start.

Provision root-owned `secrets/live-config.json` (0600, parent 0700) through the vault. It contains `supabaseUrl`, `publishableKey`, explicit HTTPS `origins`, and a `recorders` array. Each recorder contains `id`, `organizationId`, `buildingId`, allowed numeric `channels`, private `rtspOrigin`, `username` and `password`, and optionally `vendor` (see Recorder vendors). Never put this file in Git. The public Supabase key is not an authorization grant.

Root-owned `config/runtime.env` contains `CAMERA_MEDIA_BINARY` (absolute executable path under the selected release) and `CAMERA_MEDIA_SHA256`. `camera-live.service` uses systemd credentials and a private runtime directory for the generated media configuration. `KillMode=control-group` makes a gateway stop terminate video too.

Keep `AF_NETLINK` in the service address-family allowlist: the WebRTC library enumerates local network interfaces even when interface-derived ICE candidates are disabled. The host's `/dev/null` must retain its standard character-device permissions (`0666`, device `1:3`) so the unprivileged service can suppress media logs.

Add only the exact `/camera-live/v1/` signaling path to the existing HTTPS tunnel hostname. Back up the tunnel configuration, validate it before restarting, preserve all other ingress rules, and compare them after the change. Do not add a catch-all media route.

## Recorder vendors

A recorder entry may carry `vendor`: `DAHUA`, `KBVISION` or `HIKVISION`. Without it the recorder is Dahua/KBVision, exactly as before the field existed. Any other value makes the gateway refuse the whole file at start. All vendor decisions live in `src/cameraLiveVendor.ts`.

| | Dahua / KBVision | Hikvision |
|---|---|---|
| Live | `/cam/realmonitor?channel=N&subtype=0\|1` | `/Streaming/Channels/<N×100+1>` main, `<N×100+2>` sub (channel 1 → 101/102, IP channel 9 → 901/902) |
| Playback | `/cam/playback?channel=N&subtype=0&starttime=YYYY_MM_DD_hh_mm_ss&endtime=…` | `/Streaming/tracks/<N×100+1>?starttime=YYYYMMDDTHHMMSSZ&endtime=…` |
| Seek / speed | `Range: npt=` + `Scale` on the running session | a new stream per seek or speed change: `starttime` is the position, `Scale` rides on its first PLAY |
| Clip export | `archiveEnabled` + `archiveOrigin` | not available |

Both formats carry the recorder's wall clock (UTC+7); the `Z` in the Hikvision format is literal, not UTC. SD is the sub stream, every other quality comes from the main stream, and playback always reads the main track.

Hikvision specifics:

- **No clip export.** `archiveEnabled: true` or any `archiveOrigin` on a `HIKVISION` recorder is refused at start. Recorded playback is switched on with `playbackEnabled: true` instead (refused on Dahua/KBVision, where `archiveEnabled` decides). It needs `CAMERA_FFMPEG_BINARY`/`CAMERA_FFMPEG_SHA256` but no state directory. The API reports `archive: false`, and archive requests get the same `ARCHIVE_NOT_CONFIGURED`/`CAMERA_NOT_CONFIGURED` answers as any recorder without export.
- **Stream encryption.** With Hik-Connect "stream encryption" on, the recorder answers RTSP normally but its live video cannot be decoded (recorded playback still can). When the FFmpeg binary is configured, the gateway decodes one sub-stream frame before opening Hikvision live and answers `LIVE_STREAM_UNDECODABLE` (HTTP 503) if video arrives but nothing decodes within 10 seconds. A decoded frame clears the whole recorder for 10 minutes; a refusal is kept per stream for 30 seconds, so switching encryption off needs no restart. Without the FFmpeg binary there is no check and the viewer only sees its own "no picture" timeout.
- **Seek and speed open a new stream.** Measured on 11/11/2026 on two firmware generations (V4.70, H.265 hybrid DVR; V3.4 from 2017, H.264 DVR): both acknowledge a PLAY with `Range: clock=` or `Range: npt=` on a running session and then ignore it; the position does not move. The gateway therefore never sends Range to a Hikvision recorder. The API reports `playbackControl: false`, `POST /sessions/:id/playback` answers 409 `PLAYBACK_CONTROL_UNAVAILABLE`, and the viewers open a new session whose window starts at the position, with the speed as `Scale` on its first PLAY. `clock` and `npt` remain in `hikvisionDefaults` (`src/cameraLiveVendor.ts`) only as switchable strategies.
- **No audio in re-encoded streams.** Measured on firmware V3.4: the recorder advertises an audio track on live and on playback but never sends an audio packet, and FFmpeg does not write its output header until every mapped stream has produced a frame, so a transcoder that maps that track never publishes. Every Hikvision transcoder (HD/Full HD live, SD/HD/Full HD playback) is therefore video-only (`-an`). V4.70 does send audio but is treated the same, for one predictable behaviour per vendor. Native streams (SD live and "original") still relay whatever the recorder sends.
- **Speeds 1×, 2×, 4×.** 2× is exact on both. V4.70 plays exactly 4×, 6× and 8×. V3.4 delivers about 3.6× when asked for 4× and no more when asked for 6× or 8×, so nothing above 4× is offered. A re-encoded SD stream opened directly at 4× was measured working on both (on V3.4 only without audio). The viewers estimate the position as elapsed time × the requested speed (nothing in the stream carries the recorder's clock), so on a recorder that plays slower than asked the time bar runs ahead of the picture and the viewer stops before the picture reaches the end of the window.
- **Start offset.** The first picture is near, not at, the requested time: about 2 seconds after it on V4.70, 5 to 11 seconds before it on V3.4 (the previous key frame). The time burned into the picture is the reference; a guest share can show that many seconds before its window.

## Second instance for device tests

All loopback ports are fixed for production. To try a recorder next to the running service, start another process with all four of `CAMERA_LIVE_PORT`, `CAMERA_MEDIA_WEBRTC_PORT`, `CAMERA_MEDIA_RTSP_PORT` and `CAMERA_MEDIA_API_PORT` set to free ports. A partial override, or one that reuses a production port, is refused at start. Give it its own `live-config.json`, runtime directory and unit name; reuse the released media and FFmpeg binaries read-only. Never add these variables to `runtime.env`.

## Verification and rollback

Before enabling the route, check exact host identity, free loopback ports, available memory, unit validation, source/artifact hashes, and a recoverable backup. Verify authorized access with a real CRM role, unauthenticated/foreign-origin denial, actual decoded frames, renewal, stop, session expiry and cleanup. Do not treat a TCP connection or successful SDP response as proof that video plays. Test the affected UI and console through the production release lane.

Rollback removes only the new exact tunnel rule, restores its verified prior config, stops/disables `ihome-camera-live.service`, and confirms its process group and loopback listeners are gone. Existing network workers and `ihome-camera-monitor.service` continue independently. Preserve release artifacts and receipts. Any NAT removal must target the exact recorded pilot tags, with post-removal readback; never flush firewall tables.
