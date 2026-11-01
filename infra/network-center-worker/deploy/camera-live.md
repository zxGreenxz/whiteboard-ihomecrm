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

Provision root-owned `secrets/live-config.json` (0600, parent 0700) through the vault. It contains `supabaseUrl`, `publishableKey`, explicit HTTPS `origins`, and a `recorders` array. Each recorder contains `id`, `organizationId`, `buildingId`, allowed numeric `channels`, private `rtspOrigin`, `username` and `password`. Never put this file in Git. The public Supabase key is not an authorization grant.

Root-owned `config/runtime.env` contains `CAMERA_MEDIA_BINARY` (absolute executable path under the selected release) and `CAMERA_MEDIA_SHA256`. `camera-live.service` uses systemd credentials and a private runtime directory for the generated media configuration. `KillMode=control-group` makes a gateway stop terminate video too.

Keep `AF_NETLINK` in the service address-family allowlist: the WebRTC library enumerates local network interfaces even when interface-derived ICE candidates are disabled. The host's `/dev/null` must retain its standard character-device permissions (`0666`, device `1:3`) so the unprivileged service can suppress media logs.

Add only the exact `/camera-live/v1/` signaling path to the existing HTTPS tunnel hostname. Back up the tunnel configuration, validate it before restarting, preserve all other ingress rules, and compare them after the change. Do not add a catch-all media route.

## Verification and rollback

Before enabling the route, check exact host identity, free loopback ports, available memory, unit validation, source/artifact hashes, and a recoverable backup. Verify authorized access with a real CRM role, unauthenticated/foreign-origin denial, actual decoded frames, renewal, stop, session expiry and cleanup. Do not treat a TCP connection or successful SDP response as proof that video plays. Test the affected UI and console through the production release lane.

Rollback removes only the new exact tunnel rule, restores its verified prior config, stops/disables `ihome-camera-live.service`, and confirms its process group and loopback listeners are gone. Existing network workers and `ihome-camera-monitor.service` continue independently. Preserve release artifacts and receipts. Any NAT removal must target the exact recorded pilot tags, with post-removal readback; never flush firewall tables.
