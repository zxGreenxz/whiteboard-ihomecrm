import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DahuaClient, CameraClientError } from "./camera/dahuaClient.js";
import type { CameraSnapshot } from "./camera/types.js";
import type { CameraConnection, CameraDeviceEvent, CameraIngest, CameraWorkerApi } from "./cameraApiTypes.js";
import { validateCameraOrigin, type CameraCredential } from "./cameraConfig.js";
import { CameraOutbox } from "./cameraOutbox.js";
import type { WorkerLogger } from "./domain.js";

const delay = async (ms: number, signal: AbortSignal) => {
  try { await sleep(ms, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; }
};

export function cameraPayload(connection: CameraConnection, snapshot: CameraSnapshot,
  streamHealthy: boolean, events: CameraDeviceEvent[] = []): CameraIngest {
  return {
    ...snapshot, recorderId: connection.recorderId, connectionId: connection.connectionId, events,
    eventCoverage: streamHealthy ? "EVENT_STREAM" : "STATE_POLLING_ONLY",
    issues: [...new Set([...snapshot.issues, ...(streamHealthy ? [] : ["EVENT_STREAM_UNAVAILABLE" as const])])],
  };
}

export function boundCameraCredential(connection: CameraConnection, credentials: ReadonlyMap<string, CameraCredential>): CameraCredential {
  const credential = credentials.get(connection.credentialRef);
  if (!credential || credential.origin !== validateCameraOrigin(connection.endpoint)) throw new Error("CAMERA_CREDENTIAL_BINDING_INVALID");
  return credential;
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
  constructor(private readonly options: {
    api: CameraWorkerApi; credentials: ReadonlyMap<string, CameraCredential>;
    stateDirectory: string; logger: WorkerLogger;
  }) {}

  private async recorder(connection: CameraConnection, signal: AbortSignal): Promise<void> {
    const credential = boundCameraCredential(connection, this.options.credentials);
    const client = new DahuaClient({
      baseUrl: connection.endpoint, username: credential.username, password: credential.password,
      timeoutMs: connection.connectTimeoutMs, expectedChannelCount: connection.channelCount,
    });
    const queue = new CameraOutbox(join(this.options.stateDirectory, connection.recorderId));
    let latest: CameraSnapshot | null = null;
    let streamLastMessage = 0;
    let gapPending = true; // Restart cannot prove coverage while the collector was stopped.
    let authenticationDenied = false;
    const reportFailure = (operation: string, error: unknown) => this.options.logger.error(operation, {
      recorderId: connection.recorderId,
      code: error instanceof CameraClientError ? error.code : "CAMERA_COLLECTION_OR_DELIVERY_FAILED",
    });
    const gap = (): CameraDeviceEvent => ({
      eventKey: randomUUID(), code: "COVERAGE_GAP", action: "Pulse", channel: null, observedAt: new Date().toISOString(),
    });
    const streamHealthy = () => streamLastMessage > 0 && Date.now() - streamLastMessage < 20_000;
    const poll = async () => {
      while (!signal.aborted) {
        try {
          latest = await client.poll();
          authenticationDenied = latest.status === "AUTH_DENIED";
          const includeGap = gapPending;
          // Consume before yielding: a stream interruption/quarantine during the
          // disk write must remain pending for the next successful observation.
          gapPending = false;
          await queue.enqueue(cameraPayload(connection, latest, streamHealthy(), includeGap ? [gap()] : []));
        } catch (error) { gapPending = true; reportFailure("Camera observation could not be saved", error); }
        // Slow retries after authentication refusal avoid locking an operator account.
        await delay(authenticationDenied ? 300_000 : connection.pollIntervalSeconds * 1000, signal);
      }
    };
    const events = async () => {
      let failures = 0;
      while (!signal.aborted) {
        if (!latest || authenticationDenied) { await delay(5000, signal); continue; }
        try {
          for await (const message of client.openEventStream(signal)) {
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
        await delay(authenticationDenied ? 300_000 : Math.min(60_000, 5000 * 2 ** Math.min(failures, 4)), signal);
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
        await delay(2000, signal);
      }
    };
    await Promise.all([poll(), events(), delivery()]);
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
            try { boundCameraCredential(connection, this.options.credentials); }
            catch { this.options.logger.error("Camera credential binding unavailable", { recorderId: connection.recorderId }); continue; }
            const controller = new AbortController();
            const done = this.recorder(connection, controller.signal).catch(() => {
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
        await delay(30_000, signal);
      }
    } finally { signal.removeEventListener("abort", abort); await this.stopAll(); }
  }
}
