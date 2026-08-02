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
import { AsyncSemaphore, mapWithConcurrency } from "./concurrency.js";
import type { PortCycleEvidenceStore } from "./portCycleEvidence.js";
import type { RouterConnector } from "./routeros/connector.js";
import {
  reconcileAction,
  type ActionObservation,
  type CommandIntent,
  type CommandIntentAction,
} from "./reconciliation.js";
import {
  ROUTER_BACKUP_MAX_BYTES,
  type StagedSftpFile,
} from "./routeros/boundedSftpRead.js";
import {
  MAX_ACCESS_PORT_CYCLE_SECONDS,
  MIN_ACCESS_PORT_CYCLE_SECONDS,
} from "./routeros/portCycle.js";

type CommandApi = Pick<
  NetworkCenterWorkerApi,
  "renewLease" | "stage" | "observe" | "complete" | "snapshot"
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
  routerOperationSemaphore?: AsyncSemaphore;
  portCycleEvidence?: PortCycleEvidenceStore;
}

interface CommandLeaseMonitor {
  renew(): Promise<void>;
  assert(actionStarted: boolean): void;
  stop(): Promise<void>;
}

interface CommandFinishInput {
  outcome: "EVALUATE_POSTCONDITION" | "RETRYABLE_FAILURE" | "FAILED" | "UNCERTAIN" | "CANCELLED_BY_KILL_SWITCH";
  result: Record<string, unknown>;
  rollback?: Record<string, unknown> | null;
  retryDelaySeconds?: number;
}

const ALLOWED_ACTIONS = new Set([
  "FLUSH_DNS_CACHE",
  "RENEW_DHCP_LEASE",
  "CYCLE_ACCESS_PORT",
  "REBOOT_ROUTER",
  "CAPTURE_SNAPSHOT",
]);

const DISRUPTIVE_ACTIONS = new Set(["CYCLE_ACCESS_PORT", "REBOOT_ROUTER"]);

/**
 * `observation_deadline` is absolute: the server stamps it at command creation and
 * `network_center_record_command_observation_v1` rejects (SQLSTATE 22023) any
 * observation whose `observedAt` is past it. Nothing in the claim predicate keeps a
 * doomed command out of the queue, so the worker has to refuse it itself — and it
 * has to refuse *before* touching the router, because an action that really runs and
 * can never be recorded is strictly worse than one that never ran.
 *
 * Headroom the worker keeps for reading the post-action state off the router. Only
 * the observation timestamp has to beat the deadline, not the report of it, so this
 * covers the RouterOS read and nothing else.
 */
export const OBSERVATION_READ_HEADROOM_MS = 5_000;

/** Settle time the worker itself waits after a reboot before observing. */
const REBOOT_SETTLE_MS = 5_000;

/**
 * Wall-clock the action itself consumes before its result can be observed. Only
 * durations the worker can prove up front are counted; an out-of-range cycle
 * duration is left at zero so it still fails with the precise INVALID_CYCLE_DURATION.
 */
function actionExecutionCostMs(
  action: CommandIntentAction,
  parameters: Record<string, unknown>,
): number {
  if (action === "CYCLE_ACCESS_PORT") {
    const duration = Number(parameters.durationSeconds);
    return Number.isInteger(duration)
      && duration >= MIN_ACCESS_PORT_CYCLE_SECONDS
      && duration <= MAX_ACCESS_PORT_CYCLE_SECONDS
      ? duration * 1_000
      : 0;
  }
  if (action === "REBOOT_ROUTER") return REBOOT_SETTLE_MS;
  return 0;
}

function sameManagedKey(left: string | undefined, right: string | undefined): boolean {
  return typeof left === "string" && typeof right === "string"
    && left.trim().toLowerCase() === right.trim().toLowerCase();
}
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

function safeAction(value: string): CommandIntentAction {
  const action = value.trim().toUpperCase();
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new RouterOperationError("ACTION_NOT_ALLOWED", {
      retryable: false,
      mayHaveExecuted: false,
    });
  }
  return action as CommandIntentAction;
}

type ObservationKind = "PRE_ACTION" | "POST_ACTION" | "RECONCILIATION";

function stableObservationId(claim: CommandClaim, kind: ObservationKind): string {
  const hex = createHash("sha256")
    .update(`${claim.commandId}:${claim.leaseToken}:${kind}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function observationEvidence(observation: ActionObservation): Record<string, unknown> {
  const { observedAt: _observedAt, ...evidence } = observation;
  return evidence;
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
  readonly #routerOperationSemaphore: AsyncSemaphore;
  readonly #portCycleEvidence: PortCycleEvidenceStore | null;
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
    this.#routerOperationSemaphore = options.routerOperationSemaphore ?? new AsyncSemaphore(3);
    this.#portCycleEvidence = options.portCycleEvidence ?? null;
  }

  /**
   * Refuses work whose result provably cannot be observed inside the server's
   * absolute deadline. `requiredLeadMs` is the wall-clock still owed to the router
   * before the observation can be taken.
   */
  #assertObservable(claim: CommandClaim, requiredLeadMs: number, code: string): void {
    const deadline = Date.parse(claim.observationDeadline);
    if (!Number.isFinite(deadline)) {
      throw new RouterOperationError("OBSERVATION_DEADLINE_INVALID", {
        retryable: false,
        mayHaveExecuted: false,
      });
    }
    if (this.#clock.now().getTime() + requiredLeadMs > deadline) {
      throw new RouterOperationError(code, {
        retryable: false,
        mayHaveExecuted: false,
      });
    }
  }

  /**
   * Persists the fact that this attempt saw the managed port go down and come back.
   * Best effort by construction: the port is already restored by the time this runs,
   * so a storage failure must never turn a healthy cycle into a failed command.
   */
  async #recordPortCycleEvidence(claim: CommandClaim, action: CommandIntentAction): Promise<void> {
    if (action !== "CYCLE_ACCESS_PORT" || !this.#portCycleEvidence) return;
    const managedResourceId = String(claim.managedTarget.managedResourceId ?? "").trim();
    const immutableKey = String(claim.managedTarget.immutableKey ?? "").trim();
    if (!managedResourceId || !immutableKey) return;
    try {
      await this.#portCycleEvidence.record({
        commandId: claim.commandId,
        managedResourceId,
        immutableKey,
        observedAt: this.#clock.now().toISOString(),
      });
    } catch (error) {
      this.#logger.warn("Unable to persist access-port cycle evidence", redactForLog({
        commandId: claim.commandId,
        error: error instanceof Error ? error.name : "unknown",
      }));
    }
  }

  /**
   * A reconciliation runs on a fresh connector, so the disable half of a cycle is no
   * longer in that connector's memory even when the cycle really happened. Restores
   * it from the durable record — never inventing it: the record must belong to this
   * command and to the same managed port, and the live read still decides whether
   * the port is enabled now.
   */
  async #withDurableCycleEvidence(
    claim: CommandClaim,
    action: CommandIntentAction,
    observation: ActionObservation,
  ): Promise<ActionObservation> {
    if (action !== "CYCLE_ACCESS_PORT" || !this.#portCycleEvidence) return observation;
    const port = observation.accessInterface;
    if (!port || port.disabledObserved === true) return observation;
    try {
      const evidence = await this.#portCycleEvidence.read(claim.commandId);
      if (
        !evidence
        || !sameManagedKey(evidence.managedResourceId, port.managedResourceId)
        || !sameManagedKey(evidence.immutableKey, port.immutableKey)
      ) return observation;
      return { ...observation, accessInterface: { ...port, disabledObserved: true } };
    } catch (error) {
      this.#logger.warn("Unable to read access-port cycle evidence", redactForLog({
        commandId: claim.commandId,
        error: error instanceof Error ? error.name : "unknown",
      }));
      return observation;
    }
  }

  async #stage(claim: CommandClaim, eventKind: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.#api.stage({
      commandId: claim.commandId,
      leaseToken: claim.leaseToken,
      fencingGeneration: claim.fencingGeneration,
      eventKind,
      payload,
    });
  }

  async #observe(
    claim: CommandClaim,
    kind: ObservationKind,
    observation: ActionObservation,
    transitionVersion: number,
  ): Promise<number> {
    const receipt = await this.#api.observe({
      commandId: claim.commandId,
      leaseToken: claim.leaseToken,
      fencingGeneration: claim.fencingGeneration,
      transitionVersion,
      observationId: stableObservationId(claim, kind),
      observationKind: kind,
      observedAt: observation.observedAt,
      evidence: observationEvidence(observation),
    });
    if (receipt.transitionVersion !== transitionVersion + 1) {
      throw new RouterOperationError("OBSERVATION_VERSION_MISMATCH", {
        retryable: true,
        mayHaveExecuted: kind !== "PRE_ACTION",
      });
    }
    return receipt.transitionVersion;
  }

  async #finish(
    claim: CommandClaim,
    input: CommandFinishInput,
    transitionVersion = claim.transitionVersion,
  ): Promise<void> {
    await this.#api.complete({
      commandId: claim.commandId,
      leaseToken: claim.leaseToken,
      fencingGeneration: claim.fencingGeneration,
      transitionVersion,
      ...input,
    });
    this.#processed.add(`${claim.commandId}:${claim.leaseToken}:${claim.fencingGeneration}`);
  }

  #monitorLease(claim: CommandClaim): CommandLeaseMonitor {
    let leaseError: unknown;
    let stopped = false;
    let activeRenewal: Promise<void> | null = null;
    const renew = () => {
      if (stopped || activeRenewal) return activeRenewal ?? Promise.resolve();
      const request = (async () => {
        try {
          await this.#api.renewLease({
            commandId: claim.commandId,
            leaseToken: claim.leaseToken,
            fencingGeneration: claim.fencingGeneration,
            leaseSeconds: this.#leaseSeconds,
          });
        } catch (error) {
          leaseError = error;
        }
      })();
      activeRenewal = request;
      void request.then(() => {
        if (activeRenewal === request) activeRenewal = null;
      });
      return request;
    };
    const renewal = this.#clock.setInterval(
      renew,
      Math.max(5_000, Math.floor(this.#leaseSeconds * 1_000 / 3)),
    );
    return {
      renew,
      assert: (actionStarted) => {
        if (leaseError) {
          throw new RouterOperationError("LEASE_RENEWAL_FAILED", {
            retryable: !actionStarted,
            mayHaveExecuted: actionStarted,
          });
        }
      },
      stop: async () => {
        if (!stopped) {
          stopped = true;
          this.#clock.clearInterval(renewal);
        }
        await activeRenewal;
      },
    };
  }

  async #performAction(
    action: CommandIntentAction,
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
          : { applied: false, reason: "DHCP_RENEW_NOT_APPLICABLE" };
      case "CYCLE_ACCESS_PORT": {
        if (!claim.interfaceId) throw new RouterOperationError("INTERFACE_REQUIRED", { retryable: false, mayHaveExecuted: false });
        const target = this.#interfaceRegistry.resolve(claim.deviceId, claim.interfaceId);
        if (!target) {
          throw new RouterOperationError("INTERFACE_MAPPING_UNAVAILABLE", {
            retryable: true,
            mayHaveExecuted: false,
          });
        }
        const duration = Number(claim.parameters.durationSeconds);
        if (
          !Number.isInteger(duration)
          || duration < MIN_ACCESS_PORT_CYCLE_SECONDS
          || duration > MAX_ACCESS_PORT_CYCLE_SECONDS
        ) {
          throw new RouterOperationError("INVALID_CYCLE_DURATION", { retryable: false, mayHaveExecuted: false });
        }
        await connector.cycleAccessPort(target, duration);
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

  #intent(action: CommandIntentAction, claim: CommandClaim): CommandIntent {
    return {
      actionType: action,
      deviceId: claim.deviceId,
      managedTarget: claim.managedTarget,
      expectedPostcondition: claim.expectedPostcondition,
      observationDeadline: claim.observationDeadline,
    };
  }

  async #process(
    claim: CommandClaim,
    connection: NetworkConnection,
    lease: CommandLeaseMonitor,
  ): Promise<void> {
    const dedupeKey = `${claim.commandId}:${claim.leaseToken}:${claim.fencingGeneration}`;
    if (this.#processed.has(dedupeKey)) return;
    const finish = async (
      input: CommandFinishInput,
      transitionVersion = claim.transitionVersion,
    ) => {
      await lease.stop();
      await this.#finish(claim, input, transitionVersion);
    };

    if (this.#emergencyStop() || connection.changesPaused) {
      await finish({
        outcome: "CANCELLED_BY_KILL_SWITCH",
        result: { code: "CHANGES_PAUSED", message: "Network changes are paused" },
      });
      return;
    }

    let connector: RouterConnector | undefined;
    let backupReceipt: VerifiedBackup | undefined;
    let stagedArtifact: StagedSftpFile | undefined;
    let actionResult: Record<string, unknown> = { applied: false };
    let beforeObservation: ActionObservation | null = claim.preObservation;
    let transitionVersion = claim.transitionVersion;
    let actionStarted = false;

    try {
      this.#assertObservable(claim, 0, "OBSERVATION_DEADLINE_EXCEEDED");
      await lease.renew();
      lease.assert(actionStarted);
      const action = safeAction(claim.actionType);
      const intent = this.#intent(action, claim);
      connector = await this.#connectorFactory(connection);
      await this.#stage(claim, "VALIDATED", { actionType: action });
      lease.assert(actionStarted);

      if (claim.reconciliation) {
        await this.#stage(claim, "RECONCILIATION_STARTED");
        if (!beforeObservation) {
          await finish({
            outcome: "UNCERTAIN",
            result: {
              code: "MISSING_DURABLE_PRE_OBSERVATION",
              actionType: action,
            },
            retryDelaySeconds: 30,
          }, transitionVersion);
          return;
        }
        this.#assertObservable(
          claim,
          OBSERVATION_READ_HEADROOM_MS,
          "OBSERVATION_DEADLINE_UNREACHABLE",
        );
        const afterObservation = await this.#withDurableCycleEvidence(
          claim,
          action,
          await connector.observeAction(intent),
        );
        transitionVersion = await this.#observe(
          claim,
          "RECONCILIATION",
          afterObservation,
          transitionVersion,
        );
        const decision = reconcileAction(intent, beforeObservation, afterObservation);
        await this.#stage(claim, "RECONCILIATION_COMPLETED", {
          decision,
          observation: afterObservation,
        });
        await finish({
          outcome: "EVALUATE_POSTCONDITION",
          result: { actionType: action },
          retryDelaySeconds: 30,
        }, transitionVersion);
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
        encryptedArtifactHash: backupReceipt.sha256,
      });
      await this.#stage(claim, "BACKUP_COMPLETED", {
        backupSha256: backupReceipt.sha256,
        exportSha256: contentHash,
        bytes: backupReceipt.bytes,
      });
      lease.assert(actionStarted);
      if (this.#emergencyStop()) {
        await finish({
          outcome: "CANCELLED_BY_KILL_SWITCH",
          result: { code: "EMERGENCY_STOP", message: "Network changes were paused before execution" },
          rollback: { backupSha256: backupReceipt.sha256 },
        });
        return;
      }

      if (!beforeObservation) {
        beforeObservation = await connector.observeAction(intent);
        transitionVersion = await this.#observe(
          claim,
          "PRE_ACTION",
          beforeObservation,
          transitionVersion,
        );
      }

      this.#assertObservable(
        claim,
        actionExecutionCostMs(action, claim.parameters) + OBSERVATION_READ_HEADROOM_MS,
        "OBSERVATION_DEADLINE_UNREACHABLE",
      );

      if (action !== "CAPTURE_SNAPSHOT") {
        await this.#stage(claim, "EXECUTION_STARTED", { actionType: action });
        actionStarted = true;
        actionResult = await this.#performAction(action, claim, connector);
        await this.#recordPortCycleEvidence(claim, action);
        await this.#stage(claim, "EXECUTION_COMPLETED", { actionType: action, actionResult });
        if (action === "REBOOT_ROUTER") await this.#clock.sleep(REBOOT_SETTLE_MS);
      }
      lease.assert(actionStarted);

      await this.#stage(claim, "POST_CHECK_STARTED");
      const afterObservation = action === "CAPTURE_SNAPSHOT"
        ? {
          observedAt: this.#clock.now().toISOString(),
          reachable: true,
          snapshot: {
            redactedContentHash: contentHash,
            encryptedArtifactHash: backupReceipt.sha256,
          },
        }
        : await this.#withDurableCycleEvidence(
          claim,
          action,
          await connector.observeAction(intent),
        );
      const decision = reconcileAction(intent, beforeObservation, afterObservation);
      transitionVersion = await this.#observe(
        claim,
        "POST_ACTION",
        afterObservation,
        transitionVersion,
      );
      await this.#stage(claim, "POST_CHECK_COMPLETED", {
        decision,
        observation: afterObservation,
      });
      await finish({
        outcome: "EVALUATE_POSTCONDITION",
        result: {
          actionType: action,
          actionResult,
          backupSha256: backupReceipt.sha256,
        },
        rollback: { backupSha256: backupReceipt.sha256 },
      }, transitionVersion);
    } catch (error) {
      this.#logger.warn("Router command failed", redactForLog({
        commandId: claim.commandId,
        deviceId: claim.deviceId,
        error: error instanceof RouterOperationError ? error.code : "unexpected",
      }));
      const disruptive = DISRUPTIVE_ACTIONS.has(claim.actionType.toUpperCase());
      const classified = classifyWorkerError(error, disruptive, actionStarted);
      await finish({
        outcome: classified.outcome,
        result: classified.result,
        ...(backupReceipt ? { rollback: { backupSha256: backupReceipt.sha256 } } : {}),
        retryDelaySeconds: classified.retryDelaySeconds,
      }, transitionVersion);
    } finally {
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
    const lease = this.#monitorLease(claim);
    const previous = this.#deviceQueues.get(claim.deviceId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#routerOperationSemaphore.use(() => this.#process(claim, connection, lease)));
    const queueTail = current.then(() => undefined, () => undefined);
    this.#deviceQueues.set(claim.deviceId, queueTail);
    try {
      await current;
    } finally {
      await lease.stop();
      if (this.#deviceQueues.get(claim.deviceId) === queueTail) {
        this.#deviceQueues.delete(claim.deviceId);
      }
    }
  }
}

interface CommandCoordinatorOptions {
  api: Pick<NetworkCenterWorkerApi, "listConnections" | "claimCommands" | "complete">;
  processor: Pick<CommandProcessor, "processClaim">;
  leaseSeconds: number;
  claimLimit?: number;
  maxConcurrency?: number;
  paused?: () => boolean;
  logger: WorkerLogger;
}

export class CommandCoordinator {
  readonly #api: CommandCoordinatorOptions["api"];
  readonly #processor: CommandCoordinatorOptions["processor"];
  readonly #leaseSeconds: number;
  readonly #claimLimit: number;
  readonly #maxConcurrency: number;
  readonly #paused: () => boolean;
  readonly #logger: WorkerLogger;

  constructor(options: CommandCoordinatorOptions) {
    this.#api = options.api;
    this.#processor = options.processor;
    this.#leaseSeconds = options.leaseSeconds;
    this.#claimLimit = options.claimLimit ?? 3;
    this.#maxConcurrency = options.maxConcurrency ?? 3;
    this.#paused = options.paused ?? (() => false);
    if (
      !Number.isSafeInteger(this.#claimLimit) || this.#claimLimit < 1 || this.#claimLimit > 3 ||
      !Number.isSafeInteger(this.#maxConcurrency) || this.#maxConcurrency < 1 ||
      this.#maxConcurrency > 3
    ) {
      throw new RangeError("Command claim and concurrency limits must be between 1 and 3");
    }
    this.#logger = options.logger;
  }

  async runCycle(): Promise<void> {
    if (this.#paused()) return;
    const claims = await this.#api.claimCommands(this.#claimLimit, this.#leaseSeconds);
    if (claims.length > this.#claimLimit) {
      throw new RangeError("Claim API returned more claims than requested");
    }
    if (claims.length === 0) return;
    const connections = await this.#api.listConnections(500);
    const byDevice = new Map(connections.map((connection) => [connection.deviceId, connection]));
    const failures: Error[] = [];
    await mapWithConcurrency(claims, this.#maxConcurrency, async (claim) => {
      try {
        const connection = byDevice.get(claim.deviceId);
        if (!connection) {
          await this.#api.complete({
            commandId: claim.commandId,
            leaseToken: claim.leaseToken,
            fencingGeneration: claim.fencingGeneration,
            transitionVersion: claim.transitionVersion,
            outcome: "RETRYABLE_FAILURE",
            result: { code: "CONNECTION_UNAVAILABLE", message: "Router connection is unavailable" },
            retryDelaySeconds: 30,
          });
          return;
        }
        await this.#processor.processClaim(claim, connection);
      } catch (error) {
        this.#logger.error("Command processing did not reach completion", redactForLog({
          commandId: claim.commandId,
          error: error instanceof Error ? error.name : "unknown",
        }));
        failures.push(new Error(error instanceof Error ? error.name : "unknown"));
      }
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} claimed command task failed after batch settlement`,
      );
    }
  }
}
