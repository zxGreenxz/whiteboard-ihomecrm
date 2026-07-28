import type {
  NetworkConnection,
  RouterCredential,
  RouterObservation,
} from "../domain.js";

export interface RouterBackup {
  binary: Uint8Array;
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
  flushDnsCache(): Promise<void>;
  renewDhcpLease(): Promise<void>;
  cycleAccessPort(interfaceExternalKey: string, durationSeconds: number): Promise<void>;
  reboot(): Promise<void>;
  close(): Promise<void>;
}

export type RouterConnectorFactory = (
  connection: NetworkConnection,
  credential: RouterCredential,
) => Promise<RouterConnector>;
