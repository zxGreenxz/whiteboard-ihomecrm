import type {
  ManagedInterfaceTarget,
  NetworkConnection,
  RouterCredential,
  RouterObservation,
} from "../domain.js";
import type { ActionObservation, CommandIntent } from "../reconciliation.js";
import type { StagedSftpFile } from "./boundedSftpRead.js";

export interface RouterBackup {
  artifact: StagedSftpFile;
  redactedExport: string;
}

export interface RouterHealth {
  reachable: boolean;
  wanUp: boolean;
  dnsOk: boolean;
  details?: Record<string, unknown>;
}

export interface RouterConnector {
  poll(): Promise<RouterObservation>;
  captureBackup(): Promise<RouterBackup>;
  healthCheck(): Promise<RouterHealth>;
  observeAction(intent: CommandIntent): Promise<ActionObservation>;
  flushDnsCache(): Promise<void>;
  renewDhcpLease(): Promise<boolean>;
  cycleAccessPort(target: ManagedInterfaceTarget, durationSeconds: number): Promise<void>;
  /**
   * The managed access port this connector saw the *router* report as disabled during
   * a cycle, or null. Must be readable after `cycleAccessPort` rejects: the session
   * that dies inside the router-side delay is exactly the one whose disable can no
   * longer be proven any other way.
   *
   * Reports the disable half only. Whether the port is up again is always a fresh
   * `observeAction` read, so nothing here can complete a cycle on its own.
   */
  observedPortDisable(): { managedResourceId: string; immutableKey: string } | null;
  reboot(): Promise<void>;
  close(): Promise<void>;
}

export type RouterConnectorFactory = (
  connection: NetworkConnection,
  credential: RouterCredential,
) => Promise<RouterConnector>;
