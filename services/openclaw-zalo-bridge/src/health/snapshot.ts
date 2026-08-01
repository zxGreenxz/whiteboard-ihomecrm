/**
 * Readiness is split so one failure does not silently disable everything.
 * A channel pause stops outbound but keeps inbound flowing; a model-provider
 * outage disables only AI-assisted automation; neither is used for maintenance
 * readiness, which is why retention and audit keep running after a disconnect.
 */

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_STALE_MS = 90_000;

export interface ReadinessInput {
  spoolReady: boolean;
  channelPaused: boolean;
  runtimeTokenValid: boolean;
  modelProviderHealthy: boolean;
  lastHeartbeatAtMs: number | null;
  nowMs: number;
}

export interface Readiness {
  inboundReady: boolean;
  outboundReady: boolean;
  aiReady: boolean;
  heartbeatStale: boolean;
}

export function evaluateReadiness(input: ReadinessInput): Readiness {
  const heartbeatStale = input.lastHeartbeatAtMs === null ||
    input.nowMs - input.lastHeartbeatAtMs > HEARTBEAT_STALE_MS;

  const inboundReady = input.spoolReady && input.runtimeTokenValid && !heartbeatStale;
  const outboundReady = inboundReady && !input.channelPaused;
  const aiReady = outboundReady && input.modelProviderHealthy;

  return { inboundReady, outboundReady, aiReady, heartbeatStale };
}

/** `/livez` only proves the process is alive; it never consults dependencies. */
export function liveness(): { status: "ok" } {
  return { status: "ok" };
}