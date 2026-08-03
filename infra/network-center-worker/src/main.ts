import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NetworkCenterApiClient } from "./apiClient.js";
import { FileBackupStore } from "./backupStore.js";
import { CommandCoordinator, CommandProcessor } from "./commands.js";
import { loadWorkerConfig } from "./config.js";
import { AsyncSemaphore } from "./concurrency.js";
import {
  InterfaceRegistry,
  RouterOperationError,
  createConsoleLogger,
  redactForLog,
  systemClock,
  type JsonObject,
  type NetworkConnection,
  type WorkerLogger,
} from "./domain.js";
import { FilePortCycleEvidenceStore } from "./portCycleEvidence.js";
import { PollingCoordinator, type WorkerHeartbeatStatus } from "./polling.js";
import { SshRouterConnector } from "./routeros/sshConnector.js";

const HEARTBEAT_CAPABILITIES = ["routeros-ssh", "polling", "commands", "snapshots"];

interface WorkerHeartbeatInput {
  status: WorkerHeartbeatStatus;
  workerVersion: string;
  capabilities: string[];
  queueAgeSeconds: number;
  safeMetadata: JsonObject;
  startedAt: string;
}

/**
 * The periodic (non-poll) heartbeat.
 *
 * Its `status` is DERIVED, never asserted. It used to be
 * `emergencyStop ? "PAUSED" : "ONLINE"`, and because `20260729136000` writes
 * `status = EXCLUDED.status` unconditionally while COALESCEing the four poll
 * columns, that literal ONLINE overwrote the DEGRADED the poll cycle had just
 * proved - 60 seconds later, every time. Rows read `status=ONLINE` next to
 * `failedPollCount=1`.
 *
 * It also still carries NO poll keys. That asymmetry is the point: the same
 * migration stamps `poll_observed_at = now()` whenever any of `connections`,
 * `successfulPolls` or `failedPolls` is present, so echoing the last cycle's
 * counts here would manufacture fresh poll evidence from stale numbers and the
 * deploy gate's freshness check would be reading this heartbeat's clock instead
 * of a real observation.
 */
export function periodicHeartbeatInput(options: {
  health: Pick<PollingCoordinator, "fleetStatus">;
  workerVersion: string;
  startedAt: Date;
}): WorkerHeartbeatInput {
  return {
    status: options.health.fleetStatus(),
    workerVersion: options.workerVersion,
    capabilities: [...HEARTBEAT_CAPABILITIES],
    queueAgeSeconds: 0,
    safeMetadata: { source: "periodic" },
    startedAt: options.startedAt.toISOString(),
  };
}

/** The final heartbeat on a clean shutdown. */
export function stoppingHeartbeatInput(options: {
  workerVersion: string;
  startedAt: Date;
}): WorkerHeartbeatInput {
  return {
    status: "STOPPING",
    workerVersion: options.workerVersion,
    capabilities: [...HEARTBEAT_CAPABILITIES],
    queueAgeSeconds: 0,
    safeMetadata: {},
    startedAt: options.startedAt.toISOString(),
  };
}

interface WorkerRuntimeOptions {
  poll(): Promise<void>;
  commands(): Promise<void>;
  heartbeat(): Promise<void>;
  heartbeatStopped(): Promise<void>;
  pollIntervalMs: number;
  commandIntervalMs: number;
  heartbeatIntervalMs: number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  logger: WorkerLogger;
}

export class WorkerRuntime {
  readonly #options: WorkerRuntimeOptions;
  readonly #controller = new AbortController();
  #running: Promise<void> | null = null;

  constructor(options: WorkerRuntimeOptions) {
    this.#options = options;
  }

  async #loop(name: string, operation: () => Promise<void>, intervalMs: number): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.#controller.signal.aborted) {
      try {
        await operation();
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        this.#options.logger.error(`${name} cycle failed`, redactForLog({
          error: error instanceof Error ? error.name : "unknown",
          consecutiveFailures,
        }));
      }
      if (this.#controller.signal.aborted) break;
      const delay = Math.min(
        300_000,
        intervalMs * 2 ** Math.min(Math.max(0, consecutiveFailures - 1), 6),
      );
      await this.#options.sleep(delay, this.#controller.signal);
    }
  }

  start(): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = Promise.all([
      this.#loop("poll", this.#options.poll, this.#options.pollIntervalMs),
      this.#loop("command", this.#options.commands, this.#options.commandIntervalMs),
      this.#loop("heartbeat", this.#options.heartbeat, this.#options.heartbeatIntervalMs),
    ]).then(async () => {
      try {
        await this.#options.heartbeatStopped();
      } catch (error) {
        this.#options.logger.warn("Unable to send stopping heartbeat", redactForLog({
          error: error instanceof Error ? error.name : "unknown",
        }));
      }
    });
    return this.#running;
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await this.#running;
  }
}

async function run(): Promise<void> {
  const logger = createConsoleLogger();
  const config = loadWorkerConfig();
  const startedAt = new Date();
  const api = new NetworkCenterApiClient({
    baseUrl: config.edgeUrl,
    secret: config.workerSecret,
    timeoutMs: config.requestTimeoutMs,
  });
  const interfaceRegistry = new InterfaceRegistry();
  const routerOperationSemaphore = new AsyncSemaphore(3);
  const connectorFactory = async (connection: NetworkConnection) => {
    if (!connection.credentialRef || !connection.hostKeyFingerprint) {
      throw new RouterOperationError("ROUTER_CREDENTIAL_REFERENCE_MISSING", {
        retryable: false,
        mayHaveExecuted: false,
      });
    }
    const credential = config.credentials.get(connection.credentialRef);
    if (!credential) {
      throw new RouterOperationError("ROUTER_CREDENTIAL_NOT_MOUNTED", {
        retryable: false,
        mayHaveExecuted: false,
      });
    }
    return new SshRouterConnector({
      connection,
      credential,
      commandTimeoutMs: config.commandTimeoutMs,
      backupStagingDirectory: resolve(config.backupDirectory, ".staging"),
    });
  };
  const polling = new PollingCoordinator({
    api,
    connectorFactory,
    interfaceRegistry,
    maxConcurrency: config.pollConcurrency,
    now: () => new Date(),
    startedAt,
    workerVersion: config.releaseSha,
    logger,
    enforceScheduling: true,
    // NETWORK_CENTER_EMERGENCY_STOP is a WRITE freeze, not a full stop, and
    // here it is a LABEL only - the read-only poll loop keeps running. That is
    // the intended contract, not an oversight: the deploy gate starts the
    // canary with EMERGENCY_STOP=true and can only promote it once it has
    // produced real poll evidence (scripts/deploy-vultr.ps1
    // Test-ExactPollEvidence), so gating polling here would deadlock every
    // deploy. The write path is gated for real in CommandCoordinator (claim)
    // and re-checked in CommandProcessor immediately before SSH and again
    // after backup. See README "Kill switch và vận hành".
    paused: () => config.emergencyStop,
    routerOperationSemaphore,
  });
  const commandProcessor = new CommandProcessor({
    api,
    connectorFactory,
    backupStore: new FileBackupStore(config.backupDirectory),
    interfaceRegistry,
    emergencyStop: () => config.emergencyStop,
    clock: systemClock,
    leaseSeconds: config.leaseSeconds,
    logger,
    routerOperationSemaphore,
    // The observation budget has to cover the staged events the worker still owes the
    // control plane before it can stamp `observedAt`, so it is sized on the real
    // outbound timeout rather than on a guess.
    apiRequestTimeoutMs: config.requestTimeoutMs,
    // Survives both the per-claim connector and a worker restart, so a port cycle
    // that really happened can still be proven during reconciliation.
    // Shares the command clock: the retention window is measured against the same
    // timestamps the processor stamps on the evidence it records.
    portCycleEvidence: new FilePortCycleEvidenceStore(
      resolve(config.backupDirectory, ".port-cycle-evidence"),
      { now: () => systemClock.now() },
    ),
  });
  const commands = new CommandCoordinator({
    api,
    processor: commandProcessor,
    leaseSeconds: config.leaseSeconds,
    claimLimit: config.commandClaimLimit,
    maxConcurrency: config.commandConcurrency,
    paused: () => config.emergencyStop,
    logger,
  });
  const runtime = new WorkerRuntime({
    poll: async () => {
      await polling.runCycle();
      await api.maintenance(new Date().toISOString());
      await writeFile("/tmp/network-center-worker-health", new Date().toISOString(), { mode: 0o600 });
    },
    commands: () => commands.runCycle(),
    heartbeat: () => api.heartbeat(periodicHeartbeatInput({
      health: polling,
      workerVersion: config.releaseSha,
      startedAt,
    })).then(() => undefined),
    heartbeatStopped: () => api.heartbeat(stoppingHeartbeatInput({
      workerVersion: config.releaseSha,
      startedAt,
    })).then(() => undefined),
    pollIntervalMs: Math.min(config.pollIntervalMs, config.connectionRefreshIntervalMs),
    commandIntervalMs: config.commandPollIntervalMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    sleep: (milliseconds, signal) => systemClock.sleep(milliseconds, signal),
    logger,
  });

  const stop = () => void runtime.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  logger.info("Network Center worker started", {
    workerKey: config.workerKey,
    emergencyStop: config.emergencyStop,
    configuredRouters: config.credentials.size,
  });
  await runtime.start();
  logger.info("Network Center worker stopped");
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  run().catch((error: unknown) => {
    const logger = createConsoleLogger();
    logger.error("Network Center worker terminated", redactForLog({
      error: error instanceof Error ? { name: error.name, message: error.message } : "unknown",
    }));
    process.exitCode = 1;
  });
}
