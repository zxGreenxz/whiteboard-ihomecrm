import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { Client } from "ssh2";
import { describe, expect, it, vi } from "vitest";

import { AsyncSemaphore } from "../src/concurrency.js";
import {
  ROUTER_OS_COMMANDS,
  ROUTER_OS_READ_COMMANDS,
  SshRouterConnector,
  leaseExpiryIso,
  normalizeHostFingerprint,
  parseArubaNeighbors,
  parseRouterOsResourceId,
  parseRouterOsRecords,
  quoteRouterOsValue,
  resolveManagedAccessPort,
  routerOsOwnershipMarker,
  routerOsRecoveryInterfaceNames,
  routerOsCommandFailed,
  routerOsInterfaceState,
} from "../src/routeros/sshConnector.js";
import { createFakeRouterSession, createTestConnector } from "./support/fakeRouterClient.js";
import { FakeRouterOs } from "./support/fakeRouterOs.js";

describe("RouterOS SSH boundary", () => {
  it("parses singleton and terse output without exposing a raw command API", async () => {
    expect(parseRouterOsRecords("name=ether1;running=true\nname=ether2;running=false\n"))
      .toEqual([
        { name: "ether1", running: "true" },
        { name: "ether2", running: "false" },
      ]);
    expect(parseRouterOsRecords(
      '0 R name=ether1 default-name=ether1 type=ether comment="WAN uplink"\n' +
      '1  S name=ether2 address= disabled=false\n',
    )).toEqual([
      { ".flags": "R", name: "ether1", "default-name": "ether1", type: "ether", comment: "WAN uplink" },
      { ".flags": "S", name: "ether2", address: "", disabled: "false" },
    ]);
    expect(parseRouterOsRecords(
      "0 R name=ether1 last-link-up-time=jul/28/2026 21:25:44 comment=WAN uplink link-downs=1\n" +
      "1 D address=192.0.2.10 class-id=dhcpcd 5.0\n",
    )).toEqual([
      {
        ".flags": "R",
        name: "ether1",
        "last-link-up-time": "jul/28/2026 21:25:44",
        comment: "WAN uplink",
        "link-downs": "1",
      },
      { ".flags": "D", address: "192.0.2.10", "class-id": "dhcpcd 5.0" },
    ]);

    const module = await import("../src/routeros/sshConnector.js");
    expect(Object.keys(module)).not.toContain("execRouterOs");
    expect(Object.keys(ROUTER_OS_COMMANDS).sort()).toEqual([
      "flushDnsCache",
      "reboot",
      "renewDhcpLease",
    ]);
    expect(ROUTER_OS_READ_COMMANDS.identity).toBe(":put [/system/identity/print as-value]");
    expect(ROUTER_OS_READ_COMMANDS.resource).toBe(":put [/system/resource/print as-value]");
    expect(ROUTER_OS_READ_COMMANDS.dns).toBe(":put [/ip/dns/print as-value]");
    for (const command of [
      ROUTER_OS_READ_COMMANDS.interfaces,
      ROUTER_OS_READ_COMMANDS.dhcpClients,
      ROUTER_OS_READ_COMMANDS.leases,
      ROUTER_OS_READ_COMMANDS.neighbors,
    ]) {
      expect(command).toContain("detail terse without-paging");
    }
  });

  it("quotes dynamic values and normalizes pinned SHA256 fingerprints", () => {
    expect(quoteRouterOsValue("ether 4\"; /system/reboot")).toBe(
      "\"ether 4\\\"\\; /system/reboot\"",
    );
    expect(normalizeHostFingerprint("SHA256:YWJjZGVmZ2hpamtsbW5vcHFyc3Q=")).toBe(
      "YWJjZGVmZ2hpamtsbW5vcHFyc3Q",
    );
    expect(() => normalizeHostFingerprint("MD5:aa:bb")).toThrow(/SHA256/i);
  });

  it("gives dynamic and static leases a bounded current-state expiry", () => {
    const observedAt = "2026-07-28T00:00:00.000Z";
    expect(leaseExpiryIso(observedAt, "2m30s", 180)).toBe("2026-07-28T00:02:30.000Z");
    expect(leaseExpiryIso(observedAt, undefined, 180)).toBe("2026-07-28T00:03:00.000Z");
  });

  it("recognizes RouterOS command errors returned on stdout with exit code zero", () => {
    expect(routerOsCommandFailed("expected end of command (line 1 column 24)\n")).toBe(true);
    expect(routerOsCommandFailed("failure: no such item\n")).toBe(true);
    expect(routerOsCommandFailed("0 R name=ether1 comment=failure: drill\n")).toBe(false);
  });

  it("waits for the SSH client terminal event before close resolves", async () => {
    class FakeClient extends EventEmitter {
      connect(options: { hostVerifier?: (key: Buffer) => boolean }): void {
        options.hostVerifier?.(Buffer.from("fake-host-key"));
        queueMicrotask(() => this.emit("ready"));
      }

      exec(_command: string, callback: (error: Error | undefined, channel: unknown) => void): void {
        const channel = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          close: () => void;
        };
        channel.stderr = new EventEmitter();
        channel.close = () => undefined;
        callback(undefined, channel);
        queueMicrotask(() => channel.emit("close", 0));
      }

      destroy(): void {}
      end(): void {}
    }
    const client = new FakeClient();
    const connector = new SshRouterConnector({
      connection: {
        connectionId: "connection-id",
        organizationId: "organization-id",
        buildingId: "building-id",
        deviceId: "device-id",
        deviceKind: "MIKROTIK",
        externalKey: "router-id",
        displayName: "Router",
        transport: "ROUTEROS_SSH",
        managementIp: "192.0.2.1",
        managementPort: 22,
        credentialRef: "router/demo",
        hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        pollIntervalSeconds: 30,
        connectTimeoutMs: 1_000,
        monitoringEnabled: true,
        changesPaused: false,
      },
      credential: {
        username: "ihome-nc-worker",
        privateKey: "fake-private-key",
        backupPassword: "fake-backup-password",
      },
      commandTimeoutMs: 1_000,
      backupStagingDirectory: ".",
      clientFactory: () => client as unknown as Client,
    });
    await connector.flushDnsCache();

    let resolved = false;
    const closing = connector.close().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    client.emit("close");
    await closing;
    expect(resolved).toBe(true);
  });

  it("does not release close on SSH end before the client actually closes", async () => {
    class FakeClient extends EventEmitter {
      connect(options: { hostVerifier?: (key: Buffer) => boolean }): void {
        options.hostVerifier?.(Buffer.from("fake-host-key"));
        queueMicrotask(() => this.emit("ready"));
      }

      exec(_command: string, callback: (error: Error | undefined, channel: unknown) => void): void {
        const channel = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          close: () => void;
        };
        channel.stderr = new EventEmitter();
        channel.close = () => undefined;
        callback(undefined, channel);
        queueMicrotask(() => channel.emit("close", 0));
      }

      destroy(): void {}
      end(): void {}
    }
    const client = new FakeClient();
    const connector = new SshRouterConnector({
      connection: {
        connectionId: "connection-id",
        organizationId: "organization-id",
        buildingId: "building-id",
        deviceId: "device-id",
        deviceKind: "MIKROTIK",
        externalKey: "router-id",
        displayName: "Router",
        transport: "ROUTEROS_SSH",
        managementIp: "192.0.2.1",
        managementPort: 22,
        credentialRef: "router/demo",
        hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        pollIntervalSeconds: 30,
        connectTimeoutMs: 1_000,
        monitoringEnabled: true,
        changesPaused: false,
      },
      credential: {
        username: "ihome-nc-worker",
        privateKey: "fake-private-key",
        backupPassword: "fake-backup-password",
      },
      commandTimeoutMs: 1_000,
      backupStagingDirectory: ".",
      clientFactory: () => client as unknown as Client,
    });
    await connector.flushDnsCache();

    let resolved = false;
    const closing = connector.close().then(() => {
      resolved = true;
    });
    client.emit("end");
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(resolved).toBe(false);

    client.emit("close");
    await closing;
    expect(resolved).toBe(true);
  });

  it("retains an errored established client until explicit close teardown completes", async () => {
    let destroyCalls = 0;
    class FakeClient extends EventEmitter {
      connect(options: { hostVerifier?: (key: Buffer) => boolean }): void {
        options.hostVerifier?.(Buffer.from("fake-host-key"));
        queueMicrotask(() => this.emit("ready"));
      }

      exec(_command: string, callback: (error: Error | undefined, channel: unknown) => void): void {
        const channel = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          close: () => void;
        };
        channel.stderr = new EventEmitter();
        channel.close = () => undefined;
        callback(undefined, channel);
        queueMicrotask(() => channel.emit("close", 0));
      }

      destroy(): void {
        destroyCalls += 1;
      }
      end(): void {}
    }
    const client = new FakeClient();
    const connector = new SshRouterConnector({
      connection: {
        connectionId: "connection-id",
        organizationId: "organization-id",
        buildingId: "building-id",
        deviceId: "device-id",
        deviceKind: "MIKROTIK",
        externalKey: "router-id",
        displayName: "Router",
        transport: "ROUTEROS_SSH",
        managementIp: "192.0.2.1",
        managementPort: 22,
        credentialRef: "router/demo",
        hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        pollIntervalSeconds: 30,
        connectTimeoutMs: 1_000,
        monitoringEnabled: true,
        changesPaused: false,
      },
      credential: {
        username: "ihome-nc-worker",
        privateKey: "fake-private-key",
        backupPassword: "fake-backup-password",
      },
      commandTimeoutMs: 1_000,
      backupStagingDirectory: ".",
      clientFactory: () => client as unknown as Client,
    });
    await connector.flushDnsCache();

    client.emit("error", new Error("transport failed"));
    const closing = connector.close();
    let resolved = false;
    void closing.then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(destroyCalls).toBe(1);
    expect(resolved).toBe(false);

    client.emit("close");
    await expect(closing).resolves.toBeUndefined();
  });

  it("settles close after timeout destroy even when the SSH client never emits close", async () => {
    vi.useFakeTimers();
    try {
      let destroyCalls = 0;
      class FakeClient extends EventEmitter {
        connect(options: { hostVerifier?: (key: Buffer) => boolean }): void {
          options.hostVerifier?.(Buffer.from("fake-host-key"));
          queueMicrotask(() => this.emit("ready"));
        }

        exec(_command: string, callback: (error: Error | undefined, channel: unknown) => void): void {
          const channel = new EventEmitter() as EventEmitter & {
            stderr: EventEmitter;
            close: () => void;
          };
          channel.stderr = new EventEmitter();
          channel.close = () => undefined;
          callback(undefined, channel);
          queueMicrotask(() => channel.emit("close", 0));
        }

        destroy(): void {
          destroyCalls += 1;
        }
        end(): void {}
      }
      const client = new FakeClient();
      const connector = new SshRouterConnector({
        connection: {
          connectionId: "connection-id",
          organizationId: "organization-id",
          buildingId: "building-id",
          deviceId: "device-id",
          deviceKind: "MIKROTIK",
          externalKey: "router-id",
          displayName: "Router",
          transport: "ROUTEROS_SSH",
          managementIp: "192.0.2.1",
          managementPort: 22,
          credentialRef: "router/demo",
          hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          pollIntervalSeconds: 30,
          connectTimeoutMs: 1_000,
          monitoringEnabled: true,
          changesPaused: false,
        },
        credential: {
          username: "ihome-nc-worker",
          privateKey: "fake-private-key",
          backupPassword: "fake-backup-password",
        },
        commandTimeoutMs: 1_000,
        backupStagingDirectory: ".",
        clientFactory: () => client as unknown as Client,
      });
      await connector.flushDnsCache();

      const closing = connector.close();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(closing).resolves.toBeUndefined();
      expect(destroyCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes shared SFTP transfers and releases the gate after a transfer failure", async () => {
    const stagingDirectory = await mkdtemp(join(tmpdir(), "network-center-sftp-gate-"));
    const sftpSemaphore = new AsyncSemaphore(1);
    let releaseFailedTransfer!: () => void;
    const failedTransferGate = new Promise<void>((resolve) => {
      releaseFailedTransfer = resolve;
    });
    let failedTransferStarted!: () => void;
    const failedTransferStart = new Promise<void>((resolve) => {
      failedTransferStarted = resolve;
    });
    let activeSftp = 0;
    let maximumActiveSftp = 0;
    const sftpStarts: string[] = [];

    class FakeClient extends EventEmitter {
      readonly #label: string;
      #failNextTransfer: boolean;

      constructor(label: string, failNextTransfer: boolean) {
        super();
        this.#label = label;
        this.#failNextTransfer = failNextTransfer;
      }

      connect(options: { hostVerifier?: (key: Buffer) => boolean }): void {
        options.hostVerifier?.(Buffer.from("fake-host-key"));
        queueMicrotask(() => this.emit("ready"));
      }

      exec(_command: string, callback: (error: Error | undefined, channel: unknown) => void): void {
        const channel = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          close: () => void;
        };
        channel.stderr = new EventEmitter();
        channel.close = () => undefined;
        callback(undefined, channel);
        queueMicrotask(() => channel.emit("close", 0));
      }

      sftp(callback: (error: Error | undefined, session: unknown) => void): void {
        const fail = this.#failNextTransfer;
        this.#failNextTransfer = false;
        sftpStarts.push(this.#label);
        activeSftp += 1;
        maximumActiveSftp = Math.max(maximumActiveSftp, activeSftp);
        callback(undefined, {
          createReadStream: () => {
            if (!fail) return Readable.from([Buffer.from("backup-or-export")]);
            failedTransferStarted();
            return Readable.from((async function* () {
              await failedTransferGate;
              throw new Error("simulated SFTP failure");
            })());
          },
          end: () => {
            activeSftp -= 1;
          },
        });
      }

      destroy(): void {}
      end(): void {
        queueMicrotask(() => this.emit("close"));
      }
    }

    const makeConnector = (label: string, failNextTransfer: boolean) =>
      new SshRouterConnector({
        connection: {
          connectionId: `${label}-connection`,
          organizationId: "organization-id",
          buildingId: "building-id",
          deviceId: `${label}-device`,
          deviceKind: "MIKROTIK",
          externalKey: `${label}-router`,
          displayName: "Router",
          transport: "ROUTEROS_SSH",
          managementIp: "192.0.2.1",
          managementPort: 22,
          credentialRef: `router/${label}`,
          hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          pollIntervalSeconds: 30,
          connectTimeoutMs: 1_000,
          monitoringEnabled: true,
          changesPaused: false,
        },
        credential: {
          username: "ihome-nc-worker",
          privateKey: "fake-private-key",
          backupPassword: "fake-backup-password",
        },
        commandTimeoutMs: 1_000,
        backupStagingDirectory: stagingDirectory,
        clientFactory: () => new FakeClient(label, failNextTransfer) as unknown as Client,
        sftpSemaphore,
      });

    const first = makeConnector("first", true);
    const second = makeConnector("second", false);
    try {
      const failedBackup = first.captureBackup();
      await failedTransferStart;
      const successfulBackup = second.captureBackup();
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

      expect(sftpStarts).toEqual(["first"]);
      expect(maximumActiveSftp).toBe(1);

      releaseFailedTransfer();
      await expect(failedBackup).rejects.toMatchObject({ code: "SFTP_READ_FAILED" });
      const backup = await successfulBackup;
      await backup.artifact.dispose();

      expect(sftpStarts).toEqual(["first", "second", "second"]);
      expect(maximumActiveSftp).toBe(1);
      expect(activeSftp).toBe(0);
    } finally {
      releaseFailedTransfer();
      await Promise.allSettled([first.close(), second.close()]);
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("derives interface state from terse flags when boolean fields are absent", () => {
    expect(routerOsInterfaceState({ ".flags": "R" })).toEqual({ enabled: true, running: true });
    expect(routerOsInterfaceState({ ".flags": "X" })).toEqual({ enabled: false, running: false });
    expect(routerOsInterfaceState({ running: "false", disabled: "false" }))
      .toEqual({ enabled: true, running: false });
  });

  it("deduplicates Aruba aliases by serial first and hardware MAC second", () => {
    const parsed = parseArubaNeighbors([
      {
        identity: "old-name",
        "serial-number": "ap-001",
        "mac-address": "AA:BB:CC:DD:EE:01",
        platform: "Aruba Instant",
      },
      {
        identity: "new-name",
        "serial-number": "AP-001",
        "mac-address": "AA:BB:CC:DD:EE:01",
        platform: "Aruba Instant",
      },
      {
        identity: "mac-only",
        "mac-address": "AA:BB:CC:DD:EE:02",
        platform: "HPE Aruba",
      },
    ]);

    expect(parsed.quarantined).toEqual([]);
    expect(parsed.valid).toHaveLength(2);
    expect(parsed.valid[0]).toMatchObject({
      stableIdentity: "AP-001",
      identitySource: "SERIAL",
      externalKey: "serial:AP-001",
      displayName: "new-name",
      displayOnly: true,
    });
    expect(parsed.valid[0]?.aliases).toEqual(expect.arrayContaining(["old-name", "new-name"]));
    expect(parsed.valid[1]).toMatchObject({
      stableIdentity: "aa:bb:cc:dd:ee:02",
      identitySource: "HARDWARE_MAC",
      externalKey: "mac:aa:bb:cc:dd:ee:02",
      displayOnly: true,
    });
  });

  it("quarantines only the malformed Aruba item and never returns its raw identity", () => {
    const parsed = parseArubaNeighbors([
      {
        identity: "valid-ap",
        "serial-number": "VALID-001",
        platform: "Aruba Instant",
      },
      {
        identity: "secret malformed name",
        "mac-address": "01:00:5e:00:00:01",
        platform: "Aruba Instant",
      },
    ]);

    expect(parsed.valid).toHaveLength(1);
    expect(parsed.quarantined).toHaveLength(1);
    expect(parsed.quarantined[0]).toMatchObject({
      code: "ARUBA_STABLE_IDENTITY_INVALID",
    });
    expect(parsed.quarantined[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(parsed.quarantined)).not.toContain("secret malformed name");
    expect(JSON.stringify(parsed.quarantined)).not.toContain("01:00:5e:00:00:01");
  });

  it("rejects renamed ether1 even when its display role looks like access", () => {
    expect(() => resolveManagedAccessPort({
      managedResourceId: "managed-resource-uuid",
      interfaceId: "interface-uuid",
      interfaceKey: "ether1",
      currentName: "room-101",
      immutableKey: "ether1",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }, [{
      ".id": "*1",
      name: "room-101",
      "default-name": "ether1",
      type: "ether",
      running: "true",
    }])).toThrowError(expect.objectContaining({ code: "PROTECTED_INTERFACE" }));
  });

  it("rejects a secondary physical port whose current name identifies a WAN", () => {
    expect(() => resolveManagedAccessPort({
      managedResourceId: "managed-resource-uuid",
      interfaceId: "interface-uuid",
      interfaceKey: "ether2",
      currentName: "wan-backup",
      immutableKey: "ether2",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }, [{
      name: "wan-backup",
      "default-name": "ether2",
      type: "ether",
      running: "true",
    }])).toThrowError(expect.objectContaining({ code: "PROTECTED_INTERFACE" }));
  });

  it("protects the interface named by an owned bootstrap recovery rule", () => {
    expect(routerOsRecoveryInterfaceNames([{
      chain: "input",
      action: "accept",
      "in-interface": "ether2",
      comment: "ihomecrm-network-center:v1:demo-router-20260730:lan-recovery",
    }, {
      chain: "input",
      action: "accept",
      "in-interface": "ether3",
      comment: "unowned recovery rule",
    }])).toEqual(new Set(["ether2"]));
  });

  it("never takes an ownership claim from a dynamic firewall row", () => {
    // Both readers of this list run FAIL-OPEN: a matching rule is what SUPPLIES
    // the deployment marker and what marks an interface protected, so anything
    // that reaches them is something the worker then trusts. The bootstrap
    // writes this rule statically and selects it with `and !dynamic` in the
    // preflight, the rollback and the router-side cycle guard; the read side
    // has to agree, or the two disagree about which rows are ours.
    const marker = "ihomecrm-network-center:v1:demo-router-20260730:lan-recovery";
    const flagged = {
      ".flags": "D",
      chain: "input",
      action: "accept",
      "in-interface": "ether2",
      comment: marker,
    };
    const property = {
      chain: "input",
      action: "accept",
      dynamic: "yes",
      "in-interface": "ether3",
      comment: marker,
    };

    // `print detail terse` reports it as a flag letter; some menus expose it as
    // a property. Neither may be believed.
    expect(routerOsRecoveryInterfaceNames([flagged, property])).toEqual(new Set());
    expect(() => routerOsOwnershipMarker([flagged, property]))
      .toThrowError(expect.objectContaining({ code: "ROUTER_OWNERSHIP_MARKER_UNAVAILABLE" }));

    // The control: the same rows, static, are accepted — so the exclusion is
    // what rejected them and not some unrelated field.
    const { ".flags": _flags, ...staticFlagged } = flagged;
    expect(routerOsOwnershipMarker([staticFlagged]))
      .toBe("ihomecrm-network-center:v1:demo-router-20260730");
    expect(routerOsRecoveryInterfaceNames([staticFlagged, { ...property, dynamic: "no" }]))
      .toEqual(new Set(["ether2", "ether3"]));
  });

  it("targets only one live enrolled access port with matching current and immutable names", () => {
    const target = {
      managedResourceId: "managed-resource-uuid",
      interfaceId: "interface-uuid",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS" as const,
      protected: false,
      enrollmentState: "ENROLLED" as const,
    };
    expect(resolveManagedAccessPort(target, [{
      ".id": "*A",
      name: "room-401",
      "default-name": "ether4",
      type: "ether",
    }])).toEqual({ resourceId: "*A", currentName: "room-401", immutableKey: "ether4" });
    expect(resolveManagedAccessPort(target, [{
      name: "room-401",
      "default-name": "ether4",
      type: "ether",
    }])).toEqual({ resourceId: null, currentName: "room-401", immutableKey: "ether4" });
    expect(() => resolveManagedAccessPort(target, [{
      ".id": "*A",
      name: "stale-name",
      "default-name": "ether4",
      type: "ether",
    }])).toThrowError(expect.objectContaining({ code: "INTERFACE_IDENTITY_MISMATCH" }));
    expect(() => resolveManagedAccessPort({ ...target, enrollmentState: "REVOKED" }, []))
      .toThrowError(expect.objectContaining({ code: "INTERFACE_NOT_ENROLLED" }));
    expect(parseRouterOsResourceId("*A\n")).toBe("*A");
    expect(parseRouterOsResourceId("*A *B")).toBeNull();
  });

  it("rereads owned recovery firewall state immediately before cycling a port", async () => {
    const commands: string[] = [];
    class FakeClient extends EventEmitter {
      connect(options: { hostVerifier?: (key: Buffer) => boolean }): void {
        options.hostVerifier?.(Buffer.from("fake-host-key"));
        queueMicrotask(() => this.emit("ready"));
      }

      exec(command: string, callback: (error: Error | undefined, channel: unknown) => void): void {
        commands.push(command);
        const channel = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          close: () => void;
        };
        channel.stderr = new EventEmitter();
        channel.close = () => undefined;
        callback(undefined, channel);
        const output = command === ROUTER_OS_READ_COMMANDS.interfaces
          ? ".id=*A name=ether2 default-name=ether2 type=ether\n"
          : command === ROUTER_OS_READ_COMMANDS.firewallFilters
            ? "chain=input action=accept in-interface=ether2 comment=ihomecrm-network-center:v1:demo-router-20260730:lan-recovery\n"
            : "*A\n";
        queueMicrotask(() => {
          channel.emit("data", Buffer.from(output));
          channel.emit("close", 0);
        });
      }

      destroy(): void {}
      end(): void {}
    }

    const connector = new SshRouterConnector({
      connection: {
        connectionId: "connection-id",
        organizationId: "organization-id",
        buildingId: "building-id",
        deviceId: "device-id",
        deviceKind: "MIKROTIK",
        externalKey: "router-id",
        displayName: "Router",
        transport: "ROUTEROS_SSH",
        managementIp: "192.0.2.1",
        managementPort: 22,
        credentialRef: "router/demo",
        hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        pollIntervalSeconds: 30,
        connectTimeoutMs: 1_000,
        monitoringEnabled: true,
        changesPaused: false,
      },
      credential: {
        username: "ihome-nc-worker",
        privateKey: "fake-private-key",
        backupPassword: "fake-backup-password",
      },
      commandTimeoutMs: 60_000,
      backupStagingDirectory: ".",
      clientFactory: () => new FakeClient() as unknown as Client,
    });

    await expect(connector.cycleAccessPort({
      managedResourceId: "managed-resource-uuid",
      interfaceId: "interface-uuid",
      interfaceKey: "ether2",
      currentName: "ether2",
      immutableKey: "ether2",
      enrolledRole: "ACCESS",
      protected: false,
      enrollmentState: "ENROLLED",
    }, 5)).rejects.toMatchObject({ code: "PROTECTED_INTERFACE" });
    expect(commands).toEqual([
      ROUTER_OS_READ_COMMANDS.interfaces,
      ROUTER_OS_READ_COMMANDS.firewallFilters,
    ]);
  });

  it("accepts a port cycle only after ordered RouterOS disable/enable readback markers", async () => {
    // Driven by a RouterOS console simulator rather than a canned reply table, so the
    // generated script has to actually run against router state to be accepted.
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*B", name: "room-401", defaultName: "ether4", type: "ether", disabled: false },
      ],
      firewall: [{
        chain: "input",
        action: "accept",
        "in-interface": "ether9",
        comment: "ihomecrm-network-center:v1:demo-router-20260730:lan-recovery",
      }],
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);
    const commands = session.commands;
    const target = {
      managedResourceId: "managed-resource-uuid",
      interfaceId: "interface-uuid",
      interfaceKey: "ether4",
      currentName: "room-401",
      immutableKey: "ether4",
      enrolledRole: "ACCESS" as const,
      protected: false,
      enrollmentState: "ENROLLED" as const,
    };

    await connector.cycleAccessPort(target, 5);
    const observation = await connector.observeAction({
      actionType: "CYCLE_ACCESS_PORT",
      deviceId: "device-id",
      managedTarget: target,
      expectedPostcondition: { kind: "IMMUTABLE_ACCESS_INTERFACE_CYCLE" },
      observationDeadline: "2026-07-30T00:05:00.000Z",
    });

    const cycleCommand = commands.find((command) => command.includes("/interface/disable"));
    expect(cycleCommand).toContain("NC_CYCLE_DISABLED");
    expect(cycleCommand).toContain("NC_CYCLE_ENABLED");
    expect(observation.accessInterface).toMatchObject({
      managedResourceId: target.managedResourceId,
      immutableKey: target.immutableKey,
      disabledObserved: true,
      enabledObserved: true,
      enabled: true,
    });

    // The guard must be armed by the same console job that disables the port, and
    // before it: anything between the two anchors is recovery window already spent.
    expect(cycleCommand).toContain(":execute");
    expect(cycleCommand?.indexOf(":execute"))
      .toBeLessThan(cycleCommand?.indexOf("/interface/disable") ?? -1);
    expect(commands.filter((command) => command.includes(":execute"))).toHaveLength(1);
  });
});
