import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { NetworkCenterApiClient } from "./apiClient.js";
import { CommandCoordinator, CommandProcessor, FileBackupStore } from "./commands.js";
import { loadWorkerConfig } from "./config.js";
import {
  InterfaceRegistry,
  RouterOperationError,
  createConsoleLogger,
  redactForLog,
  systemClock,
  type NetworkConnection,
  type WorkerLogger,
} from "./domain.js";
import { PollingCoordinator } from "./polling.js";
import { SshRouterConnector } from "./routeros/sshConnector.js";

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
    });
  };
  const polling = new PollingCoordinator({
    api,
    connectorFactory,
    interfaceRegistry,
    maxConcurrency: config.maxConcurrency,
    now: () => new Date(),
    startedAt,
    workerVersion: "0.1.0",
    logger,
    enforceScheduling: true,
    paused: () => config.emergencyStop,
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
  });
  const commands = new CommandCoordinator({
    api,
    processor: commandProcessor,
    leaseSeconds: config.leaseSeconds,
    logger,
  });
  const runtime = new WorkerRuntime({
    poll: async () => {
      await polling.runCycle();
      await api.maintenance(new Date().toISOString());
      await writeFile("/tmp/network-center-worker-health", new Date().toISOString(), { mode: 0o600 });
    },
    commands: () => commands.runCycle(),
    heartbeat: () => api.heartbeat({
      status: config.emergencyStop ? "PAUSED" : "ONLINE",
      workerVersion: "0.1.0",
      capabilities: ["routeros-ssh", "polling", "commands", "snapshots"],
      queueAgeSeconds: 0,
      safeMetadata: { source: "periodic" },
      startedAt: startedAt.toISOString(),
    }).then(() => undefined),
    heartbeatStopped: () => api.heartbeat({
      status: "STOPPING",
      workerVersion: "0.1.0",
      capabilities: ["routeros-ssh", "polling", "commands", "snapshots"],
      queueAgeSeconds: 0,
      safeMetadata: {},
      startedAt: startedAt.toISOString(),
    }).then(() => undefined),
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
