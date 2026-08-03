import { EventEmitter } from "node:events";

import type { Client } from "ssh2";

import {
  ROUTER_OS_COMMANDS,
  ROUTER_OS_EXPORT_COMMAND,
  ROUTER_OS_READ_COMMANDS,
  SshRouterConnector,
} from "../../src/routeros/sshConnector.js";
import { FakeRouterOs, RouterOsScriptError, RouterOsSessionInterrupted } from "./fakeRouterOs.js";

/**
 * How the exec channel terminates, reproducing ssh2 1.17's own event contract
 * (`lib/client.js` CHANNEL_REQUEST → `exit`, `lib/utils.js` onCHANNEL_CLOSE → `close`):
 *
 *  - `exit-status` makes ssh2 emit `exit(code)`, and `close` then repeats the same
 *    arguments for session channels: `close(code)`.
 *  - `exit-signal` makes ssh2 emit `exit(null, signal, dump, desc)` and, because
 *    `_exit.code` is `null`, `close(null, signal, dump, desc)`.
 *  - a session torn down before either request never emits `exit` at all, and
 *    `close` is called with the still-`undefined` `_exit.code`.
 */
export type ChannelEnding =
  /** Remote sent `exit-status`. `exit(code)` then `close(code)`. */
  | {
    kind: "exit";
    code: number;
    /**
     * ssh2 only repeats the exit arguments on `close` for session channels; the
     * `direct-tcpip` / `direct-streamlocal` branch emits a bare `close()`. Forces
     * that shape so the exit status is *only* reachable through the `exit` event.
     */
    closeWithoutArguments?: boolean;
    truncateOutputTo?: number;
  }
  /** Session torn down before `exit-status`. No `exit`; `close(undefined)`. */
  | { kind: "no-exit-status"; truncateOutputTo?: number }
  /** Remote sent `exit-signal`. `exit(null, …)` then `close(null, signal, dump, desc)`. */
  | { kind: "signal"; signal: string; truncateOutputTo?: number };

export interface FakeRouterClientOptions {
  /** Return an ending to force the channel to die instead of completing. */
  interrupt?: (command: string) => ChannelEnding | null;
  /**
   * Runs before the router sees the command. Lets a test move router state
   * *between* two execs, which is the only way to reproduce a time-of-check /
   * time-of-use race against a read the worker already did.
   */
  beforeCommand?: (command: string) => void;
  /**
   * Called whenever the connector asks the SSH client for an SFTP session. Its
   * whole point is to be able to assert ZERO calls: the worker must not open one
   * at all now that the binary backup is gone, and `ftp` has left the managed
   * group, so a router would REFUSE the subsystem ("Unable to start subsystem:
   * sftp", measured under `ssh,read,write`). A fake that silently granted SFTP
   * would let that regression through.
   */
  onSftp?: () => void;
}

export interface FakeRouterSession {
  clientFactory: () => Client;
  commands: string[];
}

function readCommandOutput(router: FakeRouterOs, command: string): string | null {
  if (command === ROUTER_OS_READ_COMMANDS.identity) return router.printIdentity();
  if (command === ROUTER_OS_READ_COMMANDS.interfaces) return router.printInterfaces();
  if (command === ROUTER_OS_READ_COMMANDS.interfaceStats) return router.printInterfaceStats();
  if (command === ROUTER_OS_READ_COMMANDS.firewallFilters) return router.printFirewall();
  if (command === ROUTER_OS_READ_COMMANDS.resource) return "version=7.15 uptime=1h cpu-load=1\n";
  if (
    command === ROUTER_OS_READ_COMMANDS.dhcpClients
    || command === ROUTER_OS_READ_COMMANDS.leases
    || command === ROUTER_OS_READ_COMMANDS.neighbors
  ) return "";
  if (command === ROUTER_OS_READ_COMMANDS.dns) return "servers=1.1.1.1\n";
  // The redacted config export the pre-action snapshot now captures off stdout.
  // Shaped like the real thing: a `#` header block, then one `/`-prefixed
  // command per line, and NOT one `private-key=` anywhere — `hide-sensitive`
  // strips them at the router (measured: 0 occurrences in 8133 B).
  if (command === ROUTER_OS_EXPORT_COMMAND) return router.printExport();
  if (
    command === ROUTER_OS_COMMANDS.reboot
    || command === ROUTER_OS_COMMANDS.flushDnsCache
    || command === ROUTER_OS_COMMANDS.renewDhcpLease
  ) return "";
  return null;
}

export function createFakeRouterSession(
  router: FakeRouterOs,
  options: FakeRouterClientOptions = {},
): FakeRouterSession {
  const commands: string[] = [];

  class FakeClient extends EventEmitter {
    connect(connectOptions: { hostVerifier?: (key: Buffer) => boolean }): void {
      connectOptions.hostVerifier?.(Buffer.from("fake-host-key"));
      queueMicrotask(() => this.emit("ready"));
    }

    exec(command: string, callback: (error: Error | undefined, channel: unknown) => void): void {
      commands.push(command);
      options.beforeCommand?.(command);
      const channel = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        close: () => void;
      };
      channel.stderr = new EventEmitter();
      channel.close = () => undefined;
      callback(undefined, channel);

      const ending = options.interrupt?.(command) ?? null;
      const settle = (output: string, close: ChannelEnding) => queueMicrotask(() => {
        // A dying channel delivers whatever already reached the wire, then closes.
        const delivered = close.truncateOutputTo === undefined
          ? output
          : output.slice(0, close.truncateOutputTo);
        if (delivered) channel.emit("data", Buffer.from(delivered));
        if (close.kind === "exit") {
          channel.emit("exit", close.code);
          if (close.closeWithoutArguments) channel.emit("close");
          else channel.emit("close", close.code);
          return;
        }
        if (close.kind === "signal") {
          channel.emit("exit", null, close.signal, false, "");
          channel.emit("close", null, close.signal, false, "");
          return;
        }
        // No `exit-status` request ever arrived, so ssh2 closes with `_exit.code`
        // still `undefined` and never emits `exit`.
        channel.emit("close", undefined);
      });

      const readOutput = readCommandOutput(router, command);
      if (readOutput !== null) {
        settle(readOutput, ending ?? { kind: "exit", code: 0 });
        return;
      }

      try {
        const output = router.execute(command, {
          interruptAtDelay: ending !== null && ending.kind !== "exit",
        });
        settle(output, ending ?? { kind: "exit", code: 0 });
      } catch (error) {
        if (error instanceof RouterOsSessionInterrupted) {
          settle(error.partialOutput, ending ?? { kind: "no-exit-status" });
          return;
        }
        if (error instanceof RouterOsScriptError) {
          // RouterOS reports script failures on stdout with a zero exit status, after
          // everything the same command already printed.
          settle(`${error.partialOutput}script error: ${error.message}\n`, {
            kind: "exit",
            code: 0,
          });
          return;
        }
        throw error;
      }
    }

    sftp(callback: (error: Error | undefined, session: unknown) => void): void {
      options.onSftp?.();
      // Mirrors a router whose group has no `ftp`: the subsystem never starts.
      callback(new Error("Unable to start subsystem: sftp"), undefined);
    }

    destroy(): void {}
    end(): void {
      queueMicrotask(() => this.emit("close"));
    }
  }

  return { clientFactory: () => new FakeClient() as unknown as Client, commands };
}

export function createTestConnector(
  clientFactory: () => Client,
  overrides: { commandTimeoutMs?: number; backupStagingDirectory?: string } = {},
): SshRouterConnector {
  return new SshRouterConnector({
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
    commandTimeoutMs: overrides.commandTimeoutMs ?? 60_000,
    backupStagingDirectory: overrides.backupStagingDirectory ?? ".",
    clientFactory,
  });
}
