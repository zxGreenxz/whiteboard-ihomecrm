import { createHash, randomUUID } from "node:crypto";

import {
  type BackupStore,
  type VerifiedBackup,
} from "./backupStore.js";
import {
  InterfaceRegistry,
  RouterOperationError,
  classifyWorkerError,
  redactForLog,
  type CommandClaim,
  type NetworkCenterWorkerApi,
  type NetworkConnection,
  type WorkerClock,
  type WorkerLogger,
} from "./domain.js";
import type { RouterConnector } from "./routeros/connector.js";
import {
  ROUTER_BACKUP_MAX_BYTES,
  type StagedSftpFile,
} from "./routeros/boundedSftpRead.js";

type CommandApi = Pick<
  NetworkCenterWorkerApi,
  "renewLease" | "stage" | "complete" | "snapshot"
>;

interface CommandProcessorOptions {
  api: CommandApi;
  connectorFactory: (connection: NetworkConnection) => Promise<RouterConnector>;
  backupStore: BackupStore;
  interfaceRegistry: InterfaceRegistry;
  emergencyStop: () => boolean;
  clock: WorkerClock;
  leaseSeconds: number;
  logger: WorkerLogger;
}

const ALLOWED_ACTIONS = new Set([
  "FLUSH_DNS_CACHE",
  "RENEW_DHCP_LEASE",
  "CYCLE_ACCESS_PORT",
  "REBOOT_ROUTER",
  "CAPTURE_SNAPSHOT",
]);

const DISRUPTIVE_ACTIONS = new Set(["CYCLE_ACCESS_PORT", "REBOOT_ROUTER"]);
const REDACTED_ASSIGNMENT = /(password|passphrase|private-key|preshared-key|secret|community|source|script|on-event|http-header-field|http-data)(\s*=\s*|=)("(?:[^"\\]|\\.)*"|[^\s;]+)/gi;

export function sanitizeRouterExport(value: string): string {
  const redacted = value
    .replace(/\r/g, "")
    .split("\n")
    .slice(0, 20_000)
    .map((line) => line.replace(REDACTED_ASSIGNMENT, "$1$2[REDACTED]").slice(0, 16_384))
    .join("\n");
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= 900_000) return redacted;
  return bytes.subarray(0, 900_000).toString("utf8").replace(/�+$/u, "");
}

function hasNoParameters(parameters: Record<string, unknown>): boolean {
  return Object.keys(parameters).length === 0;
}

function safeAction(value: string): string {
  const action = value.trim().toUpperCase();
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new RouterOperationError("ACTION_NOT_ALLOWED", {
      retryable: false,
      mayHaveExecuted: false,
    });
  }
  return action;
}

export class CommandProcessor {
  readonly #api: CommandApi;
  readonly #connectorFactory: (connection: NetworkConnection) => Promise<RouterConnector>;
  readonly #backupStore: BackupStore;
  readonly #interfaceRegistry: InterfaceRegistry;
  readonly #emergencyStop: () => boolean;
  readonly #clock: WorkerClock;
  readonly #leaseSeconds: number;
  readonly #logger: WorkerLogger;
  readonly #processed = new Set<string>();
  readonly #deviceQueues = new Map<string, Promise<void>>();

  constructor(options: CommandProcessorOptions) {
    this.#api = options.api;
    this.#connectorFactory = options.connectorFactory;
    this.#backupStore = options.backupStore;
    this.#interfaceRegistry = options.interfaceRegistry;
    this.#emergencyStop = options.emergencyStop;
    this.#clock = options.clock;
    this.#leaseSeconds = options.leaseSeconds;
    this.#logger = options.logger;
  }

  async #stage(claim: CommandClaim, eventKind: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.#api.stage({
      commandId: claim.commandId,
      leaseToken: claim.leaseToken,
      eventKind,
      payload,
    });
  }

  async #finish(
    claim: CommandClaim,
    input: {
      outcome: "SUCCEEDED" | "RETRYABLE_FAILURE" | "FAILED" | "UNCERTAIN" | "CANCELLED_BY_KILL_SWITCH";
      result: Record<string, unknown>;
      rollback?: Record<string, unknown> | null;
      retryDelaySeconds?: number;
    },
  ): Promise<void> {
    await this.#api.complete({
      commandId: claim.commandId,
      leaseToken: claim.leaseToken,
      ...input,
    });
    this.#processed.add(`${claim.commandId}:${claim.attemptNo}`);
  }

  async #performAction(
    action: string,
    claim: CommandClaim,
    connector: RouterConnector,
  ): Promise<Record<string, unknown>> {
    switch (action) {
      case "FLUSH_DNS_CACHE":
        if (!hasNoParameters(claim.parameters)) throw new RouterOperationError("INVALID_PARAMETERS", { retryable: false, mayHaveExecuted: false });
        await connector.flushDnsCache();
        return { applied: true };
      case "RENEW_DHCP_LEASE":
        if (!hasNoParameters(claim.parameters)) throw new RouterOperationError("INVALID_PARAMETERS", { retryable: false, mayHaveExecuted: false });
        return await connector.renewDhcpLease()
          ? { applied: true }
          : { applied: false, reason: "NO_BOUND_DHCP_CLIENT" };
      case "CYCLE_ACCESS_PORT": {
        if (!claim.interfaceId) throw new RouterOperationError("INTERFACE_REQUIRED", { retryable: false, mayHaveExecuted: false });
        const interfaceKey = this.#interfaceRegistry.resolve(claim.deviceId, claim.interfaceId);
        if (!interfaceKey) {
          throw new RouterOperationError("INTERFACE_MAPPING_UNAVAILABLE", {
            retryable: true,
            mayHaveExecuted: false,
          });
        }
        const duration = Number(claim.parameters.durationSeconds);
        if (!Number.isInteger(duration) || duration < 5 || duration > 30) {
          throw new RouterOperationError("INVALID_CYCLE_DURATION", { retryable: false, mayHaveExecuted: false });
        }
        await connector.cycleAccessPort(interfaceKey, duration);
        return { applied: true, durationSeconds: duration };
      }
      case "REBOOT_ROUTER":
        if (!hasNoParameters(claim.parameters)) throw new RouterOperationError("INVALID_PARAMETERS", { retryable: false, mayHaveExecuted: false });
        await connector.reboot();
        return { applied: true };
      case "CAPTURE_SNAPSHOT":
        return { applied: false, reason: "SNAPSHOT_ONLY" };
      default:
        throw new RouterOperationError("ACTION_NOT_ALLOWED", { retryable: false, mayHaveExecuted: false });
    }
  }

  async #process(claim: CommandClaim, connection: NetworkConnection): Promise<void> {
    const dedupeKey = `${claim.commandId}:${claim.attemptNo}`;
    if (this.#processed.has(dedupeKey)) return;

    if (this.#emergencyStop() || connection.changesPaused) {
      await this.#finish(claim, {
        outcome: "CANCELLED_BY_KILL_SWITCH",
        result: { code: "CHANGES_PAUSED", message: "Network changes are paused" },
      });
      return;
    }

    let connector: RouterConnector | undefined;
    let backupReceipt: VerifiedBackup | undefined;
    let stagedArtifact: StagedSftpFile | undefined;
    let actionResult: Record<string, unknown> = { applied: false };
    let actionStarted = false;
    let leaseError: unknown;
    const renewLease = async () => {
      try {
        await this.#api.renewLease({
          commandId: claim.commandId,
          leaseToken: claim.leaseToken,
          leaseSeconds: this.#leaseSeconds,
        });
      } catch (error) {
        leaseError = error;
      }
    };
    const renewal = this.#clock.setInterval(renewLease, Math.max(5_000, Math.floor(this.#leaseSeconds * 1_000 / 3)));
    const assertLease = () => {
      if (leaseError) {
        throw new RouterOperationError("LEASE_RENEWAL_FAILED", {
          retryable: !actionStarted,
          mayHaveExecuted: actionStarted,
        });
      }
    };

    try {
      await renewLease();
      assertLease();
      const action = safeAction(claim.actionType);
      connector = await this.#connectorFactory(connection);
      await this.#stage(claim, "VALIDATED", { actionType: action });
      assertLease();

      if (claim.reconciliation) {
        await this.#stage(claim, "RECONCILIATION_STARTED");
        const health = await connector.healthCheck();
        await this.#stage(claim, "RECONCILIATION_COMPLETED", { ...health });
        await this.#finish(claim, {
          outcome: health.reachable ? "SUCCEEDED" : "RETRYABLE_FAILURE",
          result: { reconciled: health.reachable, health },
          retryDelaySeconds: 30,
        });
        return;
      }

      await this.#backupStore.assertReserve(ROUTER_BACKUP_MAX_BYTES);
      await this.#stage(claim, "BACKUP_STARTED");
      const backup = await connector.captureBackup();
      stagedArtifact = backup.artifact;
      const sanitizedExport = sanitizeRouterExport(backup.redactedExport);
      backupReceipt = await this.#backupStore.saveVerified({
        organizationId: claim.organizationId,
        buildingId: claim.buildingId,
        deviceId: claim.deviceId,
        commandId: claim.commandId,
        attemptNo: claim.attemptNo,
        createdAt: this.#clock.now(),
        encryption: "ROUTEROS_AES_SHA256",
        artifact: stagedArtifact,
      });
      stagedArtifact = undefined;
      const contentHash = createHash("sha256").update(sanitizedExport).digest("hex");
      const redactedLines = sanitizedExport.split("\n");
      await this.#api.snapshot({
        snapshotId: randomUUID(),
        deviceId: claim.deviceId,
        commandId: claim.commandId,
        source: "PRE_ACTION",
        normalizedContent: { format: "routeros-export-v1", lines: redactedLines },
        redactedLines,
        contentHash,
      });
      await this.#stage(claim, "BACKUP_COMPLETED", {
        backupSha256: backupReceipt.sha256,
        exportSha256: contentHash,
        bytes: backupReceipt.bytes,
      });
      assertLease();
      if (this.#emergencyStop()) {
        await this.#finish(claim, {
          outcome: "CANCELLED_BY_KILL_SWITCH",
          result: { code: "EMERGENCY_STOP", message: "Network changes were paused before execution" },
          rollback: { backupSha256: backupReceipt.sha256 },
        });
        return;
      }

      if (action !== "CAPTURE_SNAPSHOT") {
        await this.#stage(claim, "EXECUTION_STARTED", { actionType: action });
        actionStarted = true;
        actionResult = await this.#performAction(action, claim, connector);
        await this.#stage(claim, "EXECUTION_COMPLETED", { actionType: action, actionResult });
        if (action === "REBOOT_ROUTER") await this.#clock.sleep(5_000);
      }
      assertLease();

      await this.#stage(claim, "POST_CHECK_STARTED");
      const health = await connector.healthCheck();
      const postCheckPassed = health.reachable && (
        action === "FLUSH_DNS_CACHE" ? health.dnsOk
          : action === "RENEW_DHCP_LEASE" ? health.wanUp
            : true
      );
      await this.#stage(claim, "POST_CHECK_COMPLETED", { ...health, passed: postCheckPassed });
      if (!postCheckPassed) {
        throw new RouterOperationError("POST_CHECK_FAILED", {
          retryable: true,
          mayHaveExecuted: actionStarted,
        });
      }
      await this.#finish(claim, {
        outcome: "SUCCEEDED",
        result: { actionType: action, actionResult, health, backupSha256: backupReceipt.sha256 },
        rollback: { backupSha256: backupReceipt.sha256 },
      });
    } catch (error) {
      this.#logger.warn("Router command failed", redactForLog({
        commandId: claim.commandId,
        deviceId: claim.deviceId,
        error: error instanceof RouterOperationError ? error.code : "unexpected",
      }));
      const disruptive = DISRUPTIVE_ACTIONS.has(claim.actionType.toUpperCase());
      const classified = classifyWorkerError(error, disruptive);
      await this.#finish(claim, {
        outcome: classified.outcome,
        result: classified.result,
        ...(backupReceipt ? { rollback: { backupSha256: backupReceipt.sha256 } } : {}),
        retryDelaySeconds: classified.retryDelaySeconds,
      });
    } finally {
      this.#clock.clearInterval(renewal);
      await stagedArtifact?.dispose();
      backupReceipt?.release();
      try {
        await connector?.close();
      } catch {
        this.#logger.warn("Router connector close failed", { deviceId: claim.deviceId });
      }
    }
  }

  async processClaim(claim: CommandClaim, connection: NetworkConnection): Promise<void> {
    const previous = this.#deviceQueues.get(claim.deviceId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#process(claim, connection));
    const queueTail = current.then(() => undefined, () => undefined);
    this.#deviceQueues.set(claim.deviceId, queueTail);
    try {
      await current;
    } finally {
      if (this.#deviceQueues.get(claim.deviceId) === queueTail) {
        this.#deviceQueues.delete(claim.deviceId);
      }
    }
  }
}

interface CommandCoordinatorOptions {
  api: Pick<NetworkCenterWorkerApi, "listConnections" | "claimCommands" | "complete">;
  processor: CommandProcessor;
  leaseSeconds: number;
  claimLimit?: number;
  logger: WorkerLogger;
}

export class CommandCoordinator {
  readonly #api: CommandCoordinatorOptions["api"];
  readonly #processor: CommandProcessor;
  readonly #leaseSeconds: number;
  readonly #claimLimit: number;
  readonly #logger: WorkerLogger;

  constructor(options: CommandCoordinatorOptions) {
    this.#api = options.api;
    this.#processor = options.processor;
    this.#leaseSeconds = options.leaseSeconds;
    this.#claimLimit = options.claimLimit ?? 5;
    this.#logger = options.logger;
  }

  async runCycle(): Promise<void> {
    const claims = await this.#api.claimCommands(this.#claimLimit, this.#leaseSeconds);
    if (claims.length === 0) return;
    const connections = await this.#api.listConnections(500);
    const byDevice = new Map(connections.map((connection) => [connection.deviceId, connection]));
    await Promise.all(claims.map(async (claim) => {
      const connection = byDevice.get(claim.deviceId);
      if (!connection) {
        await this.#api.complete({
          commandId: claim.commandId,
          leaseToken: claim.leaseToken,
          outcome: "RETRYABLE_FAILURE",
          result: { code: "CONNECTION_UNAVAILABLE", message: "Router connection is unavailable" },
          retryDelaySeconds: 30,
        });
        return;
      }
      try {
        await this.#processor.processClaim(claim, connection);
      } catch (error) {
        this.#logger.error("Command processing did not reach completion", redactForLog({
          commandId: claim.commandId,
          error: error instanceof Error ? error.name : "unknown",
        }));
      }
    }));
  }
}
