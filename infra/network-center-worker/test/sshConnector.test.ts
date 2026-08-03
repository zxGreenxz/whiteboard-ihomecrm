import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "ssh2";
import { describe, expect, it, vi } from "vitest";

import {
  ROUTER_OS_COMMANDS,
  ROUTER_OS_EXPORT_COMMAND,
  ROUTER_OS_READ_COMMANDS,
  SshRouterConnector,
  leaseExpiryIso,
  normalizeHostFingerprint,
  parseArubaNeighbors,
  parseInterfaceCounters,
  parseLinkSpeedBps,
  parseRouterOsResourceId,
  parseRouterOsRecords,
  parseRouterOsValueRecords,
  quoteRouterOsValue,
  resolveManagedAccessPort,
  routerOsOwnershipMarker,
  routerOsRecoveryInterfaceNames,
  routerOsCommandFailed,
  routerOsExportCommandIsRedacted,
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

  // The SFTP-serialisation test that lived here is GONE, not disabled: the
  // worker opens no SFTP session on any router any more. Its subject —
  // "two connectors must not run concurrent SFTP transfers" — describes a
  // capability that was removed, and a test kept alive against a deleted code
  // path is how a suite starts certifying fiction. What replaces it is
  // "never opens an SFTP session" below, which asserts the removal itself.
  it("captures the pre-action snapshot as a redacted export off stdout, opening no SFTP session", async () => {
    const stagingDirectory = await mkdtemp(join(tmpdir(), "network-center-export-"));
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false },
      ],
    });
    let sftpAttempts = 0;
    const session = createFakeRouterSession(router, { onSftp: () => { sftpAttempts += 1; } });
    const connector = createTestConnector(session.clientFactory, {
      backupStagingDirectory: stagingDirectory,
    });

    try {
      const backup = await connector.captureBackup();

      // The command actually sent, byte for byte. `show-sensitive=no` is a
      // RouterOS syntax error and `show-sensitive` leaks the WireGuard key.
      expect(session.commands).toContain("/export terse hide-sensitive");
      expect(session.commands.join(" ")).not.toContain("show-sensitive");
      expect(session.commands.join(" ")).not.toContain("/system/backup/save");
      // Nothing was written on the router, so there is nothing to clean up.
      expect(session.commands.join(" ")).not.toContain("/file/remove");
      expect(sftpAttempts).toBe(0);

      expect(backup.redactedExport).toContain("/interface wireguard add");
      expect(backup.redactedExport).not.toContain("private-key");
      // The staged artifact IS the export, verified by hash rather than assumed.
      expect(backup.artifact.bytes).toBe(Buffer.byteLength(backup.redactedExport, "utf8"));
      expect(backup.artifact.sha256).toBe(
        createHash("sha256").update(backup.redactedExport, "utf8").digest("hex"),
      );
      expect(await readFile(backup.artifact.path, "utf8")).toBe(backup.redactedExport);
      await backup.artifact.dispose();
    } finally {
      await connector.close();
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("fails the pre-action snapshot closed when the router refuses the export", async () => {
    // A refusal arrives on STDOUT with exit status 0. Unlike the counters read,
    // this one must NOT degrade quietly: a snapshot that captured nothing is
    // exactly what `/export terse show-sensitive=no` was silently doing.
    const stagingDirectory = await mkdtemp(join(tmpdir(), "network-center-export-fail-"));
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false },
      ],
      refuseExport: true,
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory, {
      backupStagingDirectory: stagingDirectory,
    });

    try {
      await expect(connector.captureBackup()).rejects.toMatchObject({
        code: "ROUTEROS_COMMAND_REJECTED",
      });
      expect(await readdir(stagingDirectory)).toEqual([]);
    } finally {
      await connector.close();
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("refuses to stage an empty export rather than record a zero-byte snapshot", async () => {
    const stagingDirectory = await mkdtemp(join(tmpdir(), "network-center-export-empty-"));
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false },
      ],
      emptyExport: true,
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory, {
      backupStagingDirectory: stagingDirectory,
    });

    try {
      await expect(connector.captureBackup()).rejects.toMatchObject({
        code: "ROUTER_EXPORT_EMPTY",
      });
      expect(await readdir(stagingDirectory)).toEqual([]);
    } finally {
      await connector.close();
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  });

  it("pins the export command to the redacted flag in both directions", () => {
    expect(ROUTER_OS_EXPORT_COMMAND).toBe("/export terse hide-sensitive");
    expect(routerOsExportCommandIsRedacted(ROUTER_OS_EXPORT_COMMAND)).toBe(true);
    // The one-word slip that turns a broken snapshot into an exfiltration:
    // `/export terse show-sensitive` PARSES on 7.20.8 and prints the WireGuard
    // private key in full (measured, 44 chars).
    expect(routerOsExportCommandIsRedacted("/export terse show-sensitive")).toBe(false);
    expect(routerOsExportCommandIsRedacted("/export terse")).toBe(false);
    expect(routerOsExportCommandIsRedacted("/export terse hide-sensitive show-sensitive")).toBe(false);
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

describe("interface telemetry honesty", () => {
  // The exact interface shape the demo hEX printed on 2026-08-02, which is what
  // made `nominalSpeedBps: 3` and `nominalSpeedBps: 8` land in the inventory:
  // no `rate` field anywhere, and a `link-downs` flap counter on every port.
  const hardwareShapedRouter = () => new FakeRouterOs({
    interfaces: [
      { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false, linkDowns: 3 },
      { id: "*2", name: "ether2", defaultName: "ether2", type: "ether", disabled: false, linkDowns: 8 },
    ],
  });

  it("parses a RouterOS link rate and refuses anything that is not one", () => {
    expect(parseLinkSpeedBps("1Gbps")).toBe(1_000_000_000);
    expect(parseLinkSpeedBps("100Mbps")).toBe(100_000_000);
    expect(parseLinkSpeedBps("1000Mbps")).toBe(1_000_000_000);
    expect(parseLinkSpeedBps("10Kbps")).toBe(10_000);
    expect(parseLinkSpeedBps("2.5Gbps")).toBe(2_500_000_000);
    // The two values the old code actually stored, straight from the hEX.
    expect(parseLinkSpeedBps("3")).toBeNull();
    expect(parseLinkSpeedBps("8")).toBeNull();
    expect(parseLinkSpeedBps("0Mbps")).toBeNull();
    expect(parseLinkSpeedBps(undefined)).toBeNull();
  });

  it("keeps an absent counter absent instead of summing it to zero", () => {
    expect(parseInterfaceCounters([
      { name: "ether1", "rx-byte": "17", "tx-byte": "29", "rx-error": "2", "tx-error": "1" },
    ]).get("ether1")).toEqual({ rxBytes: 17, txBytes: 29, errorCount: 3 });
    // Only one half printed: the sum is still meaningful, so it is taken.
    expect(parseInterfaceCounters([
      { name: "ether2", "rx-error": "4" },
    ]).get("ether2")).toEqual({ rxBytes: null, txBytes: null, errorCount: 4 });
    // Neither half printed: `(rx ?? 0) + (tx ?? 0)` would say 0. It must say null.
    expect(parseInterfaceCounters([{ name: "ether3" }]).get("ether3"))
      .toEqual({ rxBytes: null, txBytes: null, errorCount: null });
    // An unnamed record cannot be attributed to an interface at all.
    expect(parseInterfaceCounters([{ "rx-byte": "5" }]).size).toBe(0);
  });

  it("never reports the link-flap counter as a line speed", async () => {
    const session = createFakeRouterSession(hardwareShapedRouter());
    const connector = createTestConnector(session.clientFactory);

    const observation = await connector.poll();

    expect(observation.interfaces.map((entry) => entry.displayName))
      .toEqual(["ether1", "ether2"]);
    for (const entry of observation.interfaces) {
      expect(entry.sample).not.toHaveProperty("nominalSpeedBps");
    }
  });

  it("reports a genuine negotiated rate when the router prints one", async () => {
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false, rate: "1Gbps", linkDowns: 3 },
      ],
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    const observation = await connector.poll();

    expect(observation.interfaces[0]?.sample?.nominalSpeedBps).toBe(1_000_000_000);
  });

  it("records not-collected rather than zero when the router prints no counters", async () => {
    const session = createFakeRouterSession(hardwareShapedRouter());
    const connector = createTestConnector(session.clientFactory);

    const observation = await connector.poll();

    for (const entry of observation.interfaces) {
      expect(entry.sample).toMatchObject({
        rxBytes: null,
        txBytes: null,
        errorCount: null,
      });
    }
  });

  it("reads the real byte counters from the stats print", async () => {
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false, linkDowns: 3 },
        { id: "*2", name: "ether2", defaultName: "ether2", type: "ether", disabled: false, linkDowns: 8 },
      ],
      interfaceCounters: {
        ether1: { rxByte: 1_234_567, txByte: 89_012, rxError: 1, txError: 2 },
      },
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    const observation = await connector.poll();

    // The command sent must be the as-value form. `/interface/print stats terse`
    // returns a fixed-width COLUMN TABLE on 7.20.8 — `stats` ignores `terse`,
    // byte-identical 870 B either way — with no `name=`/`rx-byte=` tokens at
    // all, so a key=value parser matches nothing and every counter reads null
    // forever. Pinned literally so a "tidy-up" back to `terse` fails here.
    expect(ROUTER_OS_READ_COMMANDS.interfaceStats).toBe(":put [/interface/print as-value stats]");
    expect(session.commands).toContain(ROUTER_OS_READ_COMMANDS.interfaceStats);
    expect(observation.interfaces[0]?.sample).toMatchObject({
      rxBytes: 1_234_567,
      txBytes: 89_012,
      errorCount: 3,
    });
    // ether2 was not in the stats output at all, so it stays "not collected"
    // rather than inheriting a neighbour's zero.
    expect(observation.interfaces[1]?.sample).toMatchObject({
      rxBytes: null,
      txBytes: null,
      errorCount: null,
    });
  });

  it("splits the single-line as-value answer into one record per interface", () => {
    // CAPTURED VERBATIM from the demo hEX, 2026-08-03:
    //   :put [/interface/print as-value stats]
    // Eight interfaces, 1305 bytes, ONE line, records concatenated with `.id=`
    // as the only boundary. Trimmed to four interfaces here; not one character
    // of the surviving text is hand-written.
    const captured = ".id=*2;disabled=false;name=ether1;running=true;rx-byte=79740110494;"
      + "rx-drop=0;rx-error=0;rx-packet=105512018;tx-byte=119752269836;tx-drop=0;"
      + "tx-error=0;tx-packet=121576454;tx-queue-drop=2234046;"
      + ".id=*3;disabled=false;name=ether2;running=true;rx-byte=123518176767;"
      + "rx-packet=123858267;slave=true;tx-byte=80159300638;tx-packet=104819944;"
      + "tx-queue-drop=857;"
      + ".id=*7;comment=defconf;disabled=false;dynamic=false;name=bridge;running=true;"
      + "rx-byte=123021591925;rx-drop=0;rx-error=0;rx-packet=123917871;"
      + "tx-byte=79688209862;tx-drop=0;tx-error=0;tx-packet=104820823;tx-queue-drop=0;"
      + ".id=*8;comment=ihomecrm-network-center:v1:demo-router-20260803:wireguard;"
      + "disabled=false;name=wg-ihome-mgmt;running=true;rx-byte=129180;rx-drop=0;"
      + "rx-error=0;rx-packet=874;tx-byte=360776;tx-drop=0;tx-error=0;tx-packet=1789;"
      + "tx-queue-drop=0\n";

    const records = parseRouterOsValueRecords(captured);

    expect(records).toHaveLength(4);
    expect(records.map((record) => record.name))
      .toEqual(["ether1", "ether2", "bridge", "wg-ihome-mgmt"]);

    const counters = parseInterfaceCounters(records);
    expect(counters.get("ether1")).toEqual({
      rxBytes: 79_740_110_494,
      txBytes: 119_752_269_836,
      errorCount: 0,
    });
    // ether2 is a bridge SLAVE: the router emits `slave=true` and omits
    // rx-error/tx-error entirely. That is why the storage decision is
    // null-not-zero — 0 here would invent an error count the router never gave.
    expect(records[1]?.slave).toBe("true");
    expect(records[1]).not.toHaveProperty("rx-error");
    expect(counters.get("ether2")).toEqual({
      rxBytes: 123_518_176_767,
      txBytes: 80_159_300_638,
      errorCount: null,
    });
    expect(counters.get("wg-ihome-mgmt")).toEqual({
      rxBytes: 129_180,
      txBytes: 360_776,
      errorCount: 0,
    });
  });

  it("does not let a semicolon in a comment split one interface into two", () => {
    // as-value neither quotes nor escapes its values. MEASURED by setting a
    // comment on a throwaway group and reading it back: the router returned
    //   .id=*E;comment=alpha;name=INJECTED;.id=*999;beta;name=zzcbrw-g1-grp;…
    // verbatim. An operator comment as ordinary as "uplink; do not touch" is
    // therefore enough to corrupt a naive `.id=`-splitting parser — and a
    // counter series silently cut in half is precisely the class of defect this
    // whole read is being rewritten to remove.
    //
    // HAND-WRITTEN fixture: it is the captured `bridge` record with its
    // `comment=defconf` swapped for a hostile one, because no interface on the
    // live gateway may be given such a comment to capture it for real.
    const hostile = ".id=*2;disabled=false;name=ether1;running=true;rx-byte=100;"
      + "rx-error=0;tx-byte=200;tx-error=0;"
      + ".id=*7;comment=uplink; do not touch;.id=*999;name=EVIL;rx-byte=7;"
      + "disabled=false;name=bridge;running=true;rx-byte=123021591925;rx-error=0;"
      + "tx-byte=79688209862;tx-error=0\n";

    const records = parseRouterOsValueRecords(hostile);

    // Two interfaces, not three: the `.id=*999` smuggled through the comment is
    // not a record boundary, because the record it landed in had no `name` yet.
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.name)).toEqual(["ether1", "bridge"]);

    // And the genuine values win over the injected ones. RouterOS emits fields
    // alphabetically after a forced-first `.id`, and `comment` sorts before
    // `name` and before every counter, so anything a comment injects always
    // lands BEFORE its real counterpart — which is what makes last-wins correct.
    const counters = parseInterfaceCounters(records);
    expect(counters.get("EVIL")).toBeUndefined();
    expect(counters.get("bridge")).toEqual({
      rxBytes: 123_021_591_925,
      txBytes: 79_688_209_862,
      errorCount: 0,
    });
  });

  it("keeps every interface's counters apart when the router answers on one line", async () => {
    // The whole as-value answer for the WHOLE fleet of interfaces arrives as a
    // single line (1305 B for eight interfaces on the demo hEX). A line-oriented
    // parser therefore folds all of them into ONE record whose every field is
    // the last interface's — so ether1 would silently inherit ether2's traffic
    // and ether2 would report ether1's as "not collected".
    //
    // This needs TWO interfaces that BOTH carry counters. With only one the
    // merge is invisible: a single record and a single merged record are the
    // same thing, which is exactly how the previous version of this suite
    // passed while the connector used the wrong parser.
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false },
        { id: "*2", name: "ether2", defaultName: "ether2", type: "ether", disabled: false },
      ],
      interfaceCounters: {
        ether1: { rxByte: 11, txByte: 12, rxError: 1, txError: 0 },
        ether2: { rxByte: 22, txByte: 23, slave: true },
      },
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    const observation = await connector.poll();

    expect(observation.interfaces[0]?.sample)
      .toMatchObject({ rxBytes: 11, txBytes: 12, errorCount: 1 });
    // A bridge slave: the router omits rx-error/tx-error, so "not collected".
    expect(observation.interfaces[1]?.sample)
      .toMatchObject({ rxBytes: 22, txBytes: 23, errorCount: null });
  });

  it("still completes the poll when the router refuses the stats print", async () => {
    // RouterOS reports a rejected command on STDOUT with exit code 0, so this is
    // the shape an older build would produce. The counters must degrade to
    // not-collected; the whole cycle must NOT fail, because every other reading
    // in this poll is still good.
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false },
      ],
      refuseInterfaceStats: true,
    });
    const session = createFakeRouterSession(router);
    const connector = createTestConnector(session.clientFactory);

    const observation = await connector.poll();

    expect(observation.device.reachable).toBe(true);
    expect(observation.interfaces).toHaveLength(1);
    expect(observation.interfaces[0]?.sample).toMatchObject({
      rxBytes: null,
      txBytes: null,
      errorCount: null,
    });
  });

  it("survives a stats channel that died without an exit status", async () => {
    const router = new FakeRouterOs({
      interfaces: [
        { id: "*1", name: "ether1", defaultName: "ether1", type: "ether", disabled: false },
      ],
      interfaceCounters: { ether1: { rxByte: 42, txByte: 43 } },
    });
    const session = createFakeRouterSession(router, {
      interrupt: (command) => command === ROUTER_OS_READ_COMMANDS.interfaceStats
        ? { kind: "no-exit-status" }
        : null,
    });
    const connector = createTestConnector(session.clientFactory);

    const observation = await connector.poll();

    // Output arrived, but nothing proves the router finished printing it, so the
    // partial counters are discarded rather than stored as if they were complete.
    expect(observation.interfaces[0]?.sample).toMatchObject({
      rxBytes: null,
      txBytes: null,
      errorCount: null,
    });
  });
});
