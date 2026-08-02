import { describe, expect, it } from "vitest";

import { InterfaceRegistry, RouterOperationError, type NetworkConnection } from "../src/domain.js";
import { PollingCoordinator } from "../src/polling.js";
import { periodicHeartbeatInput, stoppingHeartbeatInput } from "../src/main.js";

// The defect this file exists to keep dead:
//
//   F2 - the 60 s periodic heartbeat used to write `status: "ONLINE"`
//        unconditionally, so it overwrote whatever health the poll cycle had
//        just proved.
//   F3 - retry backoff (5 s * 2^n, capped at 300 s) filters a failing
//        connection OUT of the cycle once the delay exceeds the poll interval,
//        so the reported connection count decayed to zero.
//
//   Together a fleet where EVERY router is unreachable settled into
//   `status=ONLINE, connections=0, successfulPolls=0, failedPolls=0` - byte
//   identical to the signature of a healthy fleet with nothing provisioned yet.
//
// Measured on the live production worker over 13 minutes: cycles 1-9 reported
// connections=1/successful=0/failed=1, then cycles 10, 12 and 13 reported
// 0/0/0 while the router was still exactly as unreachable.

const CYCLE_INTERVAL_MS = 60_000;
const START_MS = Date.parse("2026-08-03T00:00:00.000Z");

interface HeartbeatInput {
  status: string;
  workerVersion: string;
  capabilities: string[];
  queueAgeSeconds: number;
  safeMetadata: Record<string, unknown>;
  startedAt: string;
}

interface HeartbeatShape {
  status: string;
  connections: unknown;
  successfulPolls: unknown;
  failedPolls: unknown;
}

function connection(index: number, overrides: Partial<NetworkConnection> = {}): NetworkConnection {
  const suffix = String(index + 1).padStart(12, "0");
  return {
    connectionId: `10000000-0000-4000-8000-${suffix}`,
    organizationId: "20000000-0000-4000-8000-000000000001",
    buildingId: "30000000-0000-4000-8000-000000000001",
    deviceId: `40000000-0000-4000-8000-${suffix}`,
    deviceKind: "MIKROTIK",
    externalKey: `slot:${index}`,
    displayName: `Router ${index}`,
    transport: "ROUTEROS_SSH",
    managementIp: "10.88.0.2",
    managementPort: 22,
    credentialRef: "router/demo",
    hostKeyFingerprint: "SHA256:ZmFrZWhvc3RrZXk=",
    pollIntervalSeconds: 60,
    connectTimeoutMs: 5_000,
    monitoringEnabled: true,
    changesPaused: false,
    ...overrides,
  } as NetworkConnection;
}

interface FleetOptions {
  connections: NetworkConnection[];
  cycles: number;
  reachable?: boolean;
  paused?: boolean;
}

async function runFleet(options: FleetOptions): Promise<{
  heartbeats: HeartbeatInput[];
  pollAttempts: string[];
  coordinator: PollingCoordinator;
}> {
  const heartbeats: HeartbeatInput[] = [];
  const pollAttempts: string[] = [];
  let nowMs = START_MS;
  const reachable = options.reachable ?? false;
  const coordinator = new PollingCoordinator({
    api: {
      listConnections: async () => options.connections,
      heartbeat: async (input) => {
        heartbeats.push(input as HeartbeatInput);
      },
      ingest: async () => undefined,
      inventory: async (payload: Record<string, unknown>) => ({
        routerDeviceId: String(payload.routerDeviceId),
        interfaces: [],
        aruba: [],
      }),
      upsertIncident: async () => undefined,
    },
    connectorFactory: async (target) => {
      pollAttempts.push(target.deviceId);
      if (!reachable) {
        throw new RouterOperationError("ROUTER_UNREACHABLE", {
          retryable: true,
          mayHaveExecuted: false,
        });
      }
      return {
        poll: async () => ({
          observedAt: new Date(nowMs).toISOString(),
          device: { reachable: true },
          interfaces: [],
          clients: [],
          aruba: [],
        }),
        close: async () => undefined,
      };
    },
    interfaceRegistry: new InterfaceRegistry(),
    maxConcurrency: 1,
    now: () => new Date(nowMs),
    startedAt: new Date(START_MS - 60_000),
    workerVersion: "a".repeat(40),
    logger: { info() {}, warn() {}, error() {} },
    enforceScheduling: true,
    paused: () => options.paused ?? false,
  });

  for (let cycle = 0; cycle < options.cycles; cycle += 1) {
    await coordinator.runCycle();
    nowMs += CYCLE_INTERVAL_MS;
  }
  return { heartbeats, pollAttempts, coordinator };
}

function shape(input: HeartbeatInput): HeartbeatShape {
  return {
    status: input.status,
    connections: input.safeMetadata.connections,
    successfulPolls: input.safeMetadata.successfulPolls,
    failedPolls: input.safeMetadata.failedPolls,
  };
}

function signature(input: HeartbeatInput): string {
  const value = shape(input);
  return `${value.status}|connections=${String(value.connections)}` +
    `|successfulPolls=${String(value.successfulPolls)}` +
    `|failedPolls=${String(value.failedPolls)}`;
}

describe("fleet health honesty", () => {
  it("never lets an all-unreachable fleet produce the heartbeat shape of an unprovisioned fleet", async () => {
    // 13 cycles at the production 60 s interval is exactly the window in which
    // the measured decay happened: by cycle 6 the 80 s backoff already exceeds
    // the poll interval, so the failing connection stops being attempted.
    const dead = await runFleet({
      connections: [connection(0), connection(1)],
      cycles: 13,
    });
    const greenfield = await runFleet({ connections: [], cycles: 3 });

    expect(dead.heartbeats).toHaveLength(13);
    expect(greenfield.heartbeats).toHaveLength(3);

    const greenfieldSignatures = new Set(greenfield.heartbeats.map(signature));
    expect(greenfieldSignatures.size).toBe(1);

    const collisions = dead.heartbeats
      .map((heartbeat, index) => ({ cycle: index + 1, value: signature(heartbeat) }))
      .filter((entry) => greenfieldSignatures.has(entry.value));

    expect(
      collisions,
      `a fleet of 2 configured, 0 reachable connections must never report the ` +
      `shape of a fleet with 0 configured connections ` +
      `(${[...greenfieldSignatures].join(", ")})`,
    ).toEqual([]);
  });

  it("keeps a backoff-deferred connection in the configured count and on the failing side", async () => {
    const dead = await runFleet({
      connections: [connection(0), connection(1)],
      cycles: 13,
    });

    // Every cycle must account for every configured connection, because the
    // server CHECK is successful + failed = connections.
    for (const [index, heartbeat] of dead.heartbeats.entries()) {
      const metadata = heartbeat.safeMetadata;
      expect(metadata.connections, `cycle ${index + 1} connections`).toBe(2);
      expect(
        Number(metadata.successfulPolls) + Number(metadata.failedPolls),
        `cycle ${index + 1} poll metrics must sum to the configured count`,
      ).toBe(2);
      expect(metadata.successfulPolls, `cycle ${index + 1} successfulPolls`).toBe(0);
      expect(metadata.failedPolls, `cycle ${index + 1} failedPolls`).toBe(2);
      expect(heartbeat.status, `cycle ${index + 1} status`).toBe("DEGRADED");
    }

    // ... and at least one cycle must have attempted nothing at all, otherwise
    // this test never reached the backoff-deferred state it claims to cover.
    const deferredCycles = dead.heartbeats.filter(
      (heartbeat) => heartbeat.safeMetadata.attemptedPolls === 0,
    );
    expect(
      deferredCycles.length,
      "the 13-cycle window must actually enter the backoff-deferred state",
    ).toBeGreaterThan(0);
    for (const heartbeat of deferredCycles) {
      expect(heartbeat.safeMetadata.deferredPolls).toBe(2);
    }
  });

  it("distinguishes nothing-to-poll from everything-deferred in the poll evidence", async () => {
    const greenfield = await runFleet({ connections: [], cycles: 1 });
    const dead = await runFleet({
      connections: [connection(0)],
      cycles: 13,
    });
    const deferred = dead.heartbeats.find(
      (heartbeat) => heartbeat.safeMetadata.attemptedPolls === 0,
    );

    expect(greenfield.heartbeats[0]?.safeMetadata).toMatchObject({
      connections: 0,
      successfulPolls: 0,
      failedPolls: 0,
      attemptedPolls: 0,
      deferredPolls: 0,
    });
    expect(deferred?.safeMetadata).toMatchObject({
      connections: 1,
      successfulPolls: 0,
      failedPolls: 1,
      attemptedPolls: 0,
      deferredPolls: 1,
    });
  });

  it("counts a connection whose poll interval has not elapsed as healthy, not as failing", async () => {
    // A five-minute per-connection interval against a one-minute cycle means
    // four of every five cycles legitimately skip a HEALTHY connection. That
    // skip must not be confused with a backoff deferral, or a correct fleet
    // would report failures and the deploy gate would never pass.
    const healthy = await runFleet({
      connections: [connection(0, { pollIntervalSeconds: 300 })],
      cycles: 4,
      reachable: true,
    });

    expect(healthy.pollAttempts).toHaveLength(1);
    for (const [index, heartbeat] of healthy.heartbeats.entries()) {
      expect(heartbeat.status, `cycle ${index + 1}`).toBe("ONLINE");
      expect(heartbeat.safeMetadata.connections).toBe(1);
      expect(heartbeat.safeMetadata.successfulPolls).toBe(1);
      expect(heartbeat.safeMetadata.failedPolls).toBe(0);
    }
    expect(healthy.heartbeats.at(-1)?.safeMetadata.freshPolls).toBe(1);
  });

  it("never calls a currently-failing connection fresh, even inside its poll window", async () => {
    // `pollIntervalSeconds` is re-read from the control plane every cycle, so
    // an operator widening it after a failure moves `now - lastSuccessAt` back
    // inside the window while the connection is still down. Classifying by the
    // poll interval before the failure state would report that connection as
    // healthy: an outage hidden behind a settings edit.
    const heartbeats: HeartbeatInput[] = [];
    let nowMs = START_MS;
    let reachable = true;
    let pollIntervalSeconds = 60;
    const coordinator = new PollingCoordinator({
      api: {
        listConnections: async () => [connection(0, { pollIntervalSeconds })],
        heartbeat: async (input) => {
          heartbeats.push(input as HeartbeatInput);
        },
        ingest: async () => undefined,
        inventory: async (payload: Record<string, unknown>) => ({
          routerDeviceId: String(payload.routerDeviceId),
          interfaces: [],
          aruba: [],
        }),
        upsertIncident: async () => undefined,
      },
      connectorFactory: async () => {
        if (!reachable) {
          throw new RouterOperationError("ROUTER_UNREACHABLE", {
            retryable: true,
            mayHaveExecuted: false,
          });
        }
        return {
          poll: async () => ({
            observedAt: new Date(nowMs).toISOString(),
            device: { reachable: true },
            interfaces: [],
            clients: [],
            aruba: [],
          }),
          close: async () => undefined,
        };
      },
      interfaceRegistry: new InterfaceRegistry(),
      maxConcurrency: 1,
      now: () => new Date(nowMs),
      startedAt: new Date(START_MS - 60_000),
      workerVersion: "a".repeat(40),
      logger: { info() {}, warn() {}, error() {} },
      enforceScheduling: true,
    });

    await coordinator.runCycle();
    expect(heartbeats.at(-1)?.status).toBe("ONLINE");

    nowMs += CYCLE_INTERVAL_MS;
    reachable = false;
    await coordinator.runCycle();
    expect(heartbeats.at(-1)?.status).toBe("DEGRADED");

    // Operator widens the interval to ten minutes while the router is down.
    pollIntervalSeconds = 600;
    nowMs += CYCLE_INTERVAL_MS;
    await coordinator.runCycle();

    expect(heartbeats.at(-1)?.status).toBe("DEGRADED");
    expect(heartbeats.at(-1)?.safeMetadata).toMatchObject({
      connections: 1,
      successfulPolls: 0,
      failedPolls: 1,
      freshPolls: 0,
    });
  });

  it("excludes connections the worker never polls from the configured count", async () => {
    const mixed = await runFleet({
      connections: [
        connection(0, { monitoringEnabled: false }),
        connection(1, { transport: "SSH" as NetworkConnection["transport"] }),
        connection(2, { deviceKind: "ARUBA" as NetworkConnection["deviceKind"] }),
        connection(3),
      ],
      cycles: 1,
      reachable: true,
    });

    // Parity with the server-derived expectedConnectionCount of migration
    // 20260729143000: it counts exactly the MIKROTIK/ROUTEROS_SSH, monitoring
    // enabled subset the polling cycle attempts.
    expect(mixed.heartbeats[0]?.safeMetadata.connections).toBe(1);
    expect(mixed.heartbeats[0]?.safeMetadata.successfulPolls).toBe(1);
  });

  describe("periodic heartbeat", () => {
    it("reports the health the poll cycle proved instead of a hardcoded ONLINE", async () => {
      const dead = await runFleet({
        connections: [connection(0)],
        cycles: 13,
      });

      expect(dead.coordinator.fleetStatus()).toBe("DEGRADED");
      expect(
        periodicHeartbeatInput({
          health: dead.coordinator,
          workerVersion: "a".repeat(40),
          startedAt: new Date(START_MS),
        }).status,
      ).toBe("DEGRADED");
    });

    it("reports ONLINE only once a cycle has proved it", async () => {
      const healthy = await runFleet({
        connections: [connection(0)],
        cycles: 1,
        reachable: true,
      });
      expect(healthy.coordinator.fleetStatus()).toBe("ONLINE");
    });

    it("refuses to claim health before any cycle has completed", async () => {
      const pending = await runFleet({ connections: [connection(0)], cycles: 0 });
      expect(pending.coordinator.fleetStatus()).toBe("DEGRADED");
    });

    it("goes back to unproven when a poll cycle fails outright", async () => {
      let nowMs = START_MS;
      let listConnectionsFails = false;
      const coordinator = new PollingCoordinator({
        api: {
          listConnections: async () => {
            if (listConnectionsFails) throw new Error("control plane unreachable");
            return [connection(0)];
          },
          heartbeat: async () => undefined,
          ingest: async () => undefined,
          inventory: async (payload: Record<string, unknown>) => ({
            routerDeviceId: String(payload.routerDeviceId),
            interfaces: [],
            aruba: [],
          }),
          upsertIncident: async () => undefined,
        },
        connectorFactory: async () => ({
          poll: async () => ({
            observedAt: new Date(nowMs).toISOString(),
            device: { reachable: true },
            interfaces: [],
            clients: [],
            aruba: [],
          }),
          close: async () => undefined,
        }),
        interfaceRegistry: new InterfaceRegistry(),
        maxConcurrency: 1,
        now: () => new Date(nowMs),
        startedAt: new Date(START_MS - 60_000),
        workerVersion: "a".repeat(40),
        logger: { info() {}, warn() {}, error() {} },
        enforceScheduling: true,
      });

      await coordinator.runCycle();
      expect(coordinator.fleetStatus()).toBe("ONLINE");

      nowMs += CYCLE_INTERVAL_MS;
      listConnectionsFails = true;
      await expect(coordinator.runCycle()).rejects.toThrow();
      expect(
        coordinator.fleetStatus(),
        "a worker that can no longer complete a cycle has no evidence of health",
      ).toBe("DEGRADED");
    });

    it("never restamps poll freshness, because it carries no poll evidence", async () => {
      const healthy = await runFleet({
        connections: [connection(0)],
        cycles: 1,
        reachable: true,
      });
      const input = periodicHeartbeatInput({
        health: healthy.coordinator,
        workerVersion: "a".repeat(40),
        startedAt: new Date(START_MS),
      });

      // 20260729136000 stamps poll_observed_at whenever ANY of these three keys
      // is present, so a periodic heartbeat that echoed the last cycle's counts
      // would manufacture fresh poll evidence out of stale numbers.
      for (const key of ["connections", "successfulPolls", "failedPolls"]) {
        expect(Object.hasOwn(input.safeMetadata, key), `safeMetadata.${key}`).toBe(false);
      }
      expect(stoppingHeartbeatInput({
        workerVersion: "a".repeat(40),
        startedAt: new Date(START_MS),
      }).status).toBe("STOPPING");
    });
  });

  describe("EMERGENCY_STOP contract", () => {
    // Pinned deliberately. NETWORK_CENTER_EMERGENCY_STOP is a WRITE freeze, not
    // a full stop: it gates command claiming and execution, and it does NOT
    // gate the read-only poll loop. The deploy gate depends on that - the
    // canary is started with EMERGENCY_STOP=true and can only be promoted once
    // it has produced real poll evidence. Changing either half of this without
    // redesigning deploy-vultr.ps1 would deadlock the deploy exactly the way an
    // -AllowNoConnections flag would have.
    it("keeps polling and keeps reporting real poll evidence while paused", async () => {
      const paused = await runFleet({
        connections: [connection(0)],
        cycles: 1,
        reachable: true,
        paused: true,
      });

      expect(paused.pollAttempts).toHaveLength(1);
      expect(paused.heartbeats[0]?.status).toBe("PAUSED");
      expect(paused.heartbeats[0]?.safeMetadata).toMatchObject({
        connections: 1,
        successfulPolls: 1,
        failedPolls: 0,
      });
    });

    it("labels a paused worker PAUSED even when every router is unreachable", async () => {
      const paused = await runFleet({
        connections: [connection(0)],
        cycles: 13,
        paused: true,
      });

      for (const heartbeat of paused.heartbeats) {
        expect(heartbeat.status).toBe("PAUSED");
      }
      // PAUSED is an operator state, not a health claim, so the poll evidence
      // still has to carry the failure - that is what the deploy gate reads.
      expect(paused.heartbeats.at(-1)?.safeMetadata).toMatchObject({
        connections: 1,
        successfulPolls: 0,
        failedPolls: 1,
      });
    });
  });
});
