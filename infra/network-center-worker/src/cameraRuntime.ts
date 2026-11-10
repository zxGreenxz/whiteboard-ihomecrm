import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DahuaClient, CameraClientError } from "./camera/dahuaClient.js";
import type { CameraClientErrorCode } from "./camera/errors.js";
import type { CameraStreamMessage } from "./camera/eventParser.js";
import { HikvisionClient } from "./camera/hikvisionClient.js";
import type { CameraPollingClient, CameraSnapshot } from "./camera/types.js";
import type { CameraConnection, CameraDeviceEvent, CameraIngest, CameraWorkerApi } from "./cameraApiTypes.js";
import { validateCameraOrigin, type CameraCredential } from "./cameraConfig.js";
import { CameraOutbox } from "./cameraOutbox.js";
import type { WorkerLogger } from "./domain.js";

const delay = async (ms: number, signal: AbortSignal) => {
  try { await sleep(ms, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; }
};

export function cameraPayload(connection: CameraConnection, snapshot: CameraSnapshot,
  streamHealthy: boolean, events: CameraDeviceEvent[] = [], eventStream = true): CameraIngest {
  return {
    ...snapshot, recorderId: connection.recorderId, connectionId: connection.connectionId, events,
    eventCoverage: streamHealthy ? "EVENT_STREAM" : "STATE_POLLING_ONLY",
    // A recorder observed by polling only has no stream to lose. Flagging it on
    // every snapshot would mark complete data as partial.
    issues: [...new Set([...snapshot.issues, ...(streamHealthy || !eventStream ? [] : ["EVENT_STREAM_UNAVAILABLE" as const])])],
  };
}

export function boundCameraCredential(connection: CameraConnection, credentials: ReadonlyMap<string, CameraCredential>): CameraCredential {
  const credential = credentials.get(connection.credentialRef);
  if (!credential || credential.origin !== validateCameraOrigin(connection.endpoint)) throw new Error("CAMERA_CREDENTIAL_BINDING_INVALID");
  return credential;
}

/** How one recorder is observed. Building it makes no network call. */
export interface CameraCollector {
  client: CameraPollingClient;
  /** Absent for a vendor observed by polling only: no stream loop runs, and neither a stream gap nor a stream issue is reported. */
  openEventStream?: (signal: AbortSignal) => AsyncGenerator<CameraStreamMessage>;
  /** Wait after a refused login before the next attempt. */
  authDeniedDelayMs: number;
  /** Keep that wait when this process rebuilds the collector (assignment refresh), not only inside one poll loop. */
  holdAuthDeniedAcrossRebuild: boolean;
  /** Fixed code of the first failure in the client's latest poll, when the client exposes one. */
  lastFailure?: () => CameraClientErrorCode | null;
}

/** Choose the protocol client from the enrolled vendor. An unknown vendor is refused: no client, no request. */
export function cameraCollector(connection: CameraConnection, credential: CameraCredential): CameraCollector {
  if (connection.vendor === "HIKVISION") {
    const client = new HikvisionClient({
      baseUrl: connection.endpoint, username: credential.username, password: credential.password,
      tlsFingerprint256: credential.tlsFingerprint256, timeoutMs: connection.connectTimeoutMs, channelCount: connection.channelCount,
    });
    // These recorders lock the account and the client address after a few refused logins, for about half an hour.
    return { client, authDeniedDelayMs: 1_800_000, holdAuthDeniedAcrossRebuild: true, lastFailure: () => client.lastFailure };
  }
  // A database older than the vendor field sends none; every recorder enrolled before it speaks the Dahua protocol.
  if (connection.vendor !== undefined && connection.vendor !== "KBVISION" && connection.vendor !== "DAHUA") throw new Error("CAMERA_VENDOR_UNSUPPORTED");
  // This client validates TLS against public roots and cannot honour a pin. A pin it would ignore is refused.
  if (credential.tlsFingerprint256 !== undefined) throw new Error("CAMERA_TLS_PIN_UNSUPPORTED");
  const client = new DahuaClient({
    baseUrl: connection.endpoint, username: credential.username, password: credential.password,
    timeoutMs: connection.connectTimeoutMs, expectedChannelCount: connection.channelCount,
  });
  return { client, openEventStream: (signal) => client.openEventStream(signal), authDeniedDelayMs: 300_000, holdAuthDeniedAcrossRebuild: false };
}

function collectorRefusal(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "CAMERA_VENDOR_UNSUPPORTED") return "Camera vendor unsupported; recorder not collected";
  if (code.startsWith("CAMERA_TLS_PIN_")) return "Camera TLS pin configuration invalid; recorder not collected";
  return "Camera collector stopped";
}

export function cameraBatchQuarantineReason(connectionId: string, payload: CameraIngest, now = Date.now()) {
  if (payload.connectionId !== connectionId) return "BINDING_CHANGED" as const;
  // The server accepts a 30-day backlog. Leave a one-minute margin for delivery latency.
  const oldest = now - 30 * 86_400_000 + 60_000;
  return Date.parse(payload.observedAt) < oldest || payload.events.some((event) => Date.parse(event.observedAt) < oldest) ? "EXPIRED" as const : null;
}

/** This process has no command path: it only observes cameras and delivers telemetry. */
export class CameraRuntime {
  private readonly running = new Map<string, { signature: string; controller: AbortController; done: Promise<void> }>();
  /** Earliest next login per recorder binding, kept for the life of the process. */
  private readonly authDeniedUntil = new Map<string, number>();
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly collector: typeof cameraCollector;
  constructor(private readonly options: {
    api: CameraWorkerApi; credentials: ReadonlyMap<string, CameraCredential>;
    stateDirectory: string; logger: WorkerLogger;
    /** Test seams; production uses the real clock and the vendor clients. */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number; collector?: typeof cameraCollector;
  }) {
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? Date.now;
    this.collector = options.collector ?? cameraCollector;
  }

  private async recorder(connection: CameraConnection, collector: CameraCollector, signal: AbortSignal): Promise<void> {
    const { client, openEventStream } = collector;
    const streamed = openEventStream !== undefined;
    const queue = new CameraOutbox(join(this.options.stateDirectory, connection.recorderId));
    const holdKey = `${connection.recorderId}\n${connection.endpoint}\n${connection.credentialRef}`;
    let latest: CameraSnapshot | null = null;
    let streamLastMessage = 0;
    let gapPending = true; // Restart cannot prove coverage while the collector was stopped.
    let authenticationDenied = false;
    let reportedFailure: CameraClientErrorCode | null = null;
    const reportFailure = (operation: string, error: unknown) => this.options.logger.error(operation, {
      recorderId: connection.recorderId,
      code: error instanceof CameraClientError ? error.code : "CAMERA_COLLECTION_OR_DELIVERY_FAILED",
    });
    const gap = (): CameraDeviceEvent => ({
      eventKey: randomUUID(), code: "COVERAGE_GAP", action: "Pulse", channel: null, observedAt: new Date().toISOString(),
    });
    const streamHealthy = () => streamLastMessage > 0 && Date.now() - streamLastMessage < 20_000;
    const poll = async () => {
      if (collector.holdAuthDeniedAcrossRebuild) {
        // A rebuilt collector inherits the rest of the wait: a new loop must not spend another login attempt.
        const remaining = (this.authDeniedUntil.get(holdKey) ?? 0) - this.now();
        if (remaining > 0) await this.sleep(remaining, signal);
      }
      while (!signal.aborted) {
        try {
          latest = await client.poll();
          authenticationDenied = latest.status === "AUTH_DENIED";
          if (collector.holdAuthDeniedAcrossRebuild) {
            if (authenticationDenied) this.authDeniedUntil.set(holdKey, this.now() + collector.authDeniedDelayMs);
            else this.authDeniedUntil.delete(holdKey);
          }
          // Name the cause once per change; the snapshot itself only carries the fixed issue codes.
          const failure = collector.lastFailure?.() ?? null;
          if (failure !== reportedFailure) {
            reportedFailure = failure;
            if (failure) reportFailure("Camera poll failed", new CameraClientError(failure));
          }
          // A polling-only recorder never claimed stream coverage, so it has no gap to report.
          const includeGap = streamed && gapPending;
          // Consume before yielding: a stream interruption/quarantine during the
          // disk write must remain pending for the next successful observation.
          gapPending = false;
          await queue.enqueue(cameraPayload(connection, latest, streamHealthy(), includeGap ? [gap()] : [], streamed));
        } catch (error) { gapPending = true; reportFailure("Camera observation could not be saved", error); }
        // Slow retries after authentication refusal avoid locking an operator account.
        await this.sleep(authenticationDenied ? collector.authDeniedDelayMs : connection.pollIntervalSeconds * 1000, signal);
      }
    };
    const events = async (open: NonNullable<CameraCollector["openEventStream"]>) => {
      let failures = 0;
      while (!signal.aborted) {
        if (!latest || authenticationDenied) { await this.sleep(5000, signal); continue; }
        try {
          for await (const message of open(signal)) {
            streamLastMessage = Date.now(); failures = 0;
            if (message.type !== "event" || !latest) continue;
            const event: CameraDeviceEvent = {
              eventKey: randomUUID(), code: message.event.code,
              action: message.event.action, channel: message.event.channelNumber ?? null,
              observedAt: new Date().toISOString(),
            };
            // Keep the last poll timestamp. A heartbeat/event never makes old channel evidence fresh.
            await queue.enqueue(cameraPayload(connection, latest, true, [event]));
          }
          if (!signal.aborted) throw new CameraClientError("STREAM_ENDED");
        } catch (error) {
          if (!signal.aborted) {
            reportFailure("Camera event stream interrupted", error);
            failures += 1;
            if (error instanceof CameraClientError && error.code === "AUTH_DENIED") authenticationDenied = true;
          }
        } finally {
          streamLastMessage = 0;
          gapPending = true;
        }
        await this.sleep(authenticationDenied ? collector.authDeniedDelayMs : Math.min(60_000, 5000 * 2 ** Math.min(failures, 4)), signal);
      }
    };
    const delivery = async () => {
      while (!signal.aborted) {
        try { await queue.drain((payload) => this.options.api.ingestCamera(payload), 20, {
          reason: (payload) => cameraBatchQuarantineReason(connection.connectionId, payload),
          recorded: (reason) => {
            gapPending = true;
            this.options.logger.error("Camera batch quarantined for operator review; original evidence retained", { recorderId: connection.recorderId, reason });
          },
        }); }
        catch (error) { reportFailure("Camera telemetry delivery failed; saved batches retained", error); }
        await this.sleep(2000, signal);
      }
    };
    // Without an event stream there is no stream loop at all, so nothing retries a connection that cannot exist.
    await Promise.all([poll(), ...(openEventStream ? [events(openEventStream)] : []), delivery()]);
  }

  private async stopAll(): Promise<void> {
    for (const value of this.running.values()) value.controller.abort();
    await Promise.all([...this.running.values()].map((value) => value.done));
    this.running.clear();
  }

  async run(signal: AbortSignal): Promise<void> {
    const abort = () => { for (const value of this.running.values()) value.controller.abort(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (!signal.aborted) {
        try {
          const connections = await this.options.api.listCameraConnections();
          const desired = new Map(connections.map((connection) => [connection.recorderId, connection]));
          for (const [id, value] of this.running) {
            const connection = desired.get(id);
            if (!connection || value.controller.signal.aborted || JSON.stringify(connection) !== value.signature) {
              value.controller.abort(); await value.done; this.running.delete(id);
            }
          }
          for (const connection of connections) {
            if (signal.aborted || this.running.has(connection.recorderId)) continue;
            let credential: CameraCredential;
            try { credential = boundCameraCredential(connection, this.options.credentials); }
            catch { this.options.logger.error("Camera credential binding unavailable", { recorderId: connection.recorderId }); continue; }
            let collector: CameraCollector;
            // Fail closed per recorder before any request: unknown vendor or unusable TLS pin.
            try { collector = this.collector(connection, credential); }
            catch (error) { this.options.logger.error(collectorRefusal(error), { recorderId: connection.recorderId }); continue; }
            const controller = new AbortController();
            const done = this.recorder(connection, collector, controller.signal).catch(() => {
              this.options.logger.error("Camera collector stopped", { recorderId: connection.recorderId });
              controller.abort();
            });
            this.running.set(connection.recorderId, { signature: JSON.stringify(connection), controller, done });
          }
        } catch {
          // Losing the assignment service is a coverage gap, not proof that every recorder is offline.
          this.options.logger.error("Camera assignments unavailable; collection suspended");
          await this.stopAll();
        }
        await this.sleep(30_000, signal);
      }
    } finally { signal.removeEventListener("abort", abort); await this.stopAll(); }
  }
}
