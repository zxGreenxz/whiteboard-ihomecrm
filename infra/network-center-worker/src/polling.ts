import { createHash } from "node:crypto";

import {
  InterfaceRegistry,
  chunkAll,
  redactForLog,
  type InventoryMapping,
  type NetworkCenterWorkerApi,
  type NetworkConnection,
  type RouterObservation,
  type WorkerLogger,
} from "./domain.js";
import type { RouterConnector } from "./routeros/connector.js";

type PollingApi = Pick<
  NetworkCenterWorkerApi,
  "listConnections" | "heartbeat" | "ingest" | "inventory" | "upsertIncident"
>;

interface PollingCoordinatorOptions {
  api: PollingApi;
  connectorFactory: (connection: NetworkConnection) => Promise<Pick<RouterConnector, "poll" | "close">>;
  interfaceRegistry: InterfaceRegistry;
  maxConcurrency: number;
  now: () => Date;
  startedAt: Date;
  workerVersion: string;
  logger: WorkerLogger;
  paused?: () => boolean;
  enforceScheduling?: boolean;
  retryBackoffBaseMs?: number;
  retryBackoffMaximumMs?: number;
}

interface PollState {
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  retryAt: number;
}

const BATCH_LIMIT = 256;

async function concurrentMap<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, queue.length)) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) await operation(item);
      }
    },
  );
  await Promise.all(workers);
}

function inventoryInterface(
  item: RouterObservation["interfaces"][number],
  sortOrder: number,
): Record<string, unknown> {
  const sample = item.sample ?? {};
  return {
    interfaceKey: item.externalKey,
    displayName: item.displayName,
    interfaceKind: typeof sample.interfaceKind === "string" ? sample.interfaceKind : "OTHER",
    interfaceRole: item.role,
    macAddress: typeof sample.macAddress === "string" ? sample.macAddress : null,
    ifIndex: typeof sample.ifIndex === "number" ? sample.ifIndex : null,
    nominalSpeedBps: typeof sample.nominalSpeedBps === "number" ? sample.nominalSpeedBps : null,
    isProtected: item.protected,
    sortOrder,
    isEnabled: item.enabled,
    metadata: { discoveredBy: "routeros-worker" },
  };
}

function inventoryAruba(
  item: RouterObservation["aruba"][number],
  sortOrder: number,
): Record<string, unknown> {
  return {
    externalKey: item.externalKey,
    displayName: item.displayName,
    model: item.model ?? null,
    serialNumber: null,
    uplinkInterfaceKey: null,
    managementAddress: item.managementIp ?? null,
    sortOrder,
    lifecycleStatus: item.reachable ? "ONLINE" : "OFFLINE",
    metadata: item.metadata ?? {},
  };
}

function telemetryInterface(
  item: RouterObservation["interfaces"][number],
  interfaceId: string,
): Record<string, unknown> {
  const sample = item.sample ?? {};
  return {
    interfaceId,
    linkState: sample.linkState ?? (item.enabled ? "UNKNOWN" : "DOWN"),
    rxBps: sample.rxBps ?? null,
    txBps: sample.txBps ?? null,
    utilizationPct: sample.utilizationPct ?? null,
    rxBytes: sample.rxBytes ?? null,
    txBytes: sample.txBytes ?? null,
    errorCount: sample.errorCount ?? null,
    discardCount: sample.discardCount ?? null,
    queueDropCount: sample.queueDropCount ?? null,
    errorDelta: sample.errorDelta ?? null,
    discardDelta: sample.discardDelta ?? null,
    queueDropDelta: sample.queueDropDelta ?? null,
  };
}

export class PollingCoordinator {
  readonly #api: PollingApi;
  readonly #connectorFactory: (
    connection: NetworkConnection,
  ) => Promise<Pick<RouterConnector, "poll" | "close">>;
  readonly #interfaceRegistry: InterfaceRegistry;
  readonly #maxConcurrency: number;
  readonly #now: () => Date;
  readonly #startedAt: Date;
  readonly #workerVersion: string;
  readonly #logger: WorkerLogger;
  readonly #paused: () => boolean;
  readonly #enforceScheduling: boolean;
  readonly #retryBackoffBaseMs: number;
  readonly #retryBackoffMaximumMs: number;
  readonly #states = new Map<string, PollState>();

  constructor(options: PollingCoordinatorOptions) {
    this.#api = options.api;
    this.#connectorFactory = options.connectorFactory;
    this.#interfaceRegistry = options.interfaceRegistry;
    this.#maxConcurrency = options.maxConcurrency;
    this.#now = options.now;
    this.#startedAt = options.startedAt;
    this.#workerVersion = options.workerVersion;
    this.#logger = options.logger;
    this.#paused = options.paused ?? (() => false);
    this.#enforceScheduling = options.enforceScheduling ?? false;
    this.#retryBackoffBaseMs = options.retryBackoffBaseMs ?? 5_000;
    this.#retryBackoffMaximumMs = options.retryBackoffMaximumMs ?? 300_000;
  }

  #shouldPoll(connection: NetworkConnection, now: number): boolean {
    if (!this.#enforceScheduling) return true;
    const state = this.#states.get(connection.deviceId);
    if (!state) return true;
    if (state.retryAt > now) return false;
    if (state.lastSuccessAt === null) return true;
    return now - state.lastSuccessAt >= connection.pollIntervalSeconds * 1_000;
  }

  async #syncInventory(
    connection: NetworkConnection,
    observation: RouterObservation,
  ): Promise<Map<string, string>> {
    const interfaces = observation.interfaces.map(inventoryInterface);
    const aruba = observation.aruba.map(inventoryAruba);
    const interfaceChunks = chunkAll(interfaces, BATCH_LIMIT);
    const arubaChunks = chunkAll(aruba, BATCH_LIMIT);
    const batchCount = Math.max(interfaceChunks.length, arubaChunks.length, 1);
    const externalToId = new Map<string, string>();

    for (let index = 0; index < batchCount; index += 1) {
      const mapping: InventoryMapping = await this.#api.inventory({
        routerDeviceId: connection.deviceId,
        interfaces: interfaceChunks[index] ?? [],
        aruba: arubaChunks[index] ?? [],
      });
      this.#interfaceRegistry.update(connection.deviceId, mapping.interfaces);
      for (const item of mapping.interfaces) externalToId.set(item.interfaceKey, item.id);
    }
    return externalToId;
  }

  async #syncTelemetry(
    connection: NetworkConnection,
    observation: RouterObservation,
    interfaceIds: Map<string, string>,
  ): Promise<void> {
    const devices = [{
      ...observation.device,
      deviceId: connection.deviceId,
      lastSeenAt: observation.observedAt,
      reachable: true,
    }];
    const interfaces = observation.interfaces.flatMap((item) => {
      const interfaceId = interfaceIds.get(item.externalKey);
      return interfaceId ? [telemetryInterface(item, interfaceId)] : [];
    });
    const clients = observation.clients.map((item) => ({
      ...item,
      deviceId: connection.deviceId,
    }));
    const deviceChunks = chunkAll(devices, BATCH_LIMIT);
    const interfaceChunks = chunkAll(interfaces, BATCH_LIMIT);
    const clientChunks = chunkAll(clients, BATCH_LIMIT);
    const batchCount = Math.max(deviceChunks.length, interfaceChunks.length, clientChunks.length, 1);
    for (let index = 0; index < batchCount; index += 1) {
      await this.#api.ingest({
        observedAt: observation.observedAt,
        devices: deviceChunks[index] ?? [],
        interfaces: interfaceChunks[index] ?? [],
        clients: clientChunks[index] ?? [],
      });
    }
  }

  async #incident(
    connection: NetworkConnection,
    resolved: boolean,
    observedAt: string,
  ): Promise<void> {
    const fingerprint = createHash("sha256")
      .update(`router-unreachable:${connection.deviceId}`)
      .digest("hex");
    await this.#api.upsertIncident({
      deviceId: connection.deviceId,
      eventKey: `router:${connection.deviceId}:unreachable`,
      fingerprint,
      incidentType: "ROUTER_UNREACHABLE",
      severity: "CRITICAL",
      title: "MikroTik mất kết nối quản trị",
      summary: resolved
        ? "Worker đã kết nối lại được tới MikroTik"
        : "Worker không thể đọc trạng thái MikroTik qua đường quản trị",
      observedAt,
      observedValues: { transport: "ROUTEROS_SSH" },
      resolved,
    });
  }

  async #pollConnection(connection: NetworkConnection): Promise<boolean> {
    let connector: Pick<RouterConnector, "poll" | "close"> | undefined;
    const now = this.#now();
    try {
      connector = await this.#connectorFactory(connection);
      const observation = await connector.poll();
      const mapping = await this.#syncInventory(connection, observation);
      await this.#syncTelemetry(connection, observation, mapping);
      await this.#incident(connection, true, observation.observedAt);
      this.#states.set(connection.deviceId, {
        lastSuccessAt: now.getTime(),
        consecutiveFailures: 0,
        retryAt: 0,
      });
      return true;
    } catch (error) {
      const previous = this.#states.get(connection.deviceId);
      const failures = (previous?.consecutiveFailures ?? 0) + 1;
      const delay = Math.min(
        this.#retryBackoffMaximumMs,
        this.#retryBackoffBaseMs * 2 ** Math.min(failures - 1, 10),
      );
      this.#states.set(connection.deviceId, {
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        consecutiveFailures: failures,
        retryAt: now.getTime() + delay,
      });
      this.#logger.warn("Router polling failed", redactForLog({
        buildingId: connection.buildingId,
        deviceId: connection.deviceId,
        failures,
      }));
      try {
        await this.#incident(connection, false, now.toISOString());
      } catch (incidentError) {
        this.#logger.error("Unable to record router incident", redactForLog({
          deviceId: connection.deviceId,
          error: incidentError instanceof Error ? incidentError.name : "unknown",
        }));
      }
      return false;
    } finally {
      try {
        await connector?.close();
      } catch {
        this.#logger.warn("Router connector close failed", { deviceId: connection.deviceId });
      }
    }
  }

  async runCycle(): Promise<void> {
    const now = this.#now();
    const connections = (await this.#api.listConnections(500)).filter((connection) =>
      connection.deviceKind === "MIKROTIK" &&
      connection.transport === "ROUTEROS_SSH" &&
      connection.monitoringEnabled &&
      this.#shouldPoll(connection, now.getTime())
    );
    let successes = 0;
    let failures = 0;
    await concurrentMap(connections, this.#maxConcurrency, async (connection) => {
      if (await this.#pollConnection(connection)) successes += 1;
      else failures += 1;
    });
    await this.#api.heartbeat({
      status: this.#paused() ? "PAUSED" : failures > 0 ? "DEGRADED" : "ONLINE",
      workerVersion: this.#workerVersion,
      capabilities: ["routeros-ssh", "polling", "commands", "snapshots"],
      queueAgeSeconds: 0,
      safeMetadata: {
        connections: connections.length,
        successfulPolls: successes,
        failedPolls: failures,
      },
      startedAt: this.#startedAt.toISOString(),
    });
  }
}
