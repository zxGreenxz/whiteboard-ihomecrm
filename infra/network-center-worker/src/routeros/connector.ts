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
  reboot(): Promise<void>;
  close(): Promise<void>;
}

export type RouterConnectorFactory = (
  connection: NetworkConnection,
  credential: RouterCredential,
) => Promise<RouterConnector>;
