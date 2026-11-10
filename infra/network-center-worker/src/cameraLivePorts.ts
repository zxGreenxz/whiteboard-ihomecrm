/**
 * Loopback ports of one gateway instance. Production sets none of these variables and keeps the defaults.
 * A second instance on the same host (testing a recorder next to production) must set all four: a partial
 * override would leave it talking to the production media process.
 */
export interface LivePorts { gateway: number; webrtc: number; rtsp: number; api: number }
const defaults: LivePorts = { gateway: 18751, webrtc: 18889, rtsp: 18895, api: 18897 };
const variables: Record<keyof LivePorts, string> = { gateway: "CAMERA_LIVE_PORT", webrtc: "CAMERA_MEDIA_WEBRTC_PORT", rtsp: "CAMERA_MEDIA_RTSP_PORT", api: "CAMERA_MEDIA_API_PORT" };

export function livePorts(env: Record<string, string | undefined> = process.env): LivePorts {
  const keys = Object.keys(variables) as (keyof LivePorts)[];
  const given = keys.filter((key) => env[variables[key]] !== undefined);
  if (!given.length) return { ...defaults };
  const ports = { ...defaults };
  for (const key of keys) {
    const raw = env[variables[key]] ?? "";
    if (!/^[1-9]\d{3,4}$/u.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) throw new Error("LIVE_PORT_INVALID");
    ports[key] = Number(raw);
  }
  if (new Set(Object.values(ports)).size !== keys.length || Object.values(ports).some((port) => Object.values(defaults).includes(port))) throw new Error("LIVE_PORT_INVALID");
  return ports;
}
export const ports = livePorts();
