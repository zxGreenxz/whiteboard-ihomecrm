export interface BootstrapInput {
  routerIdentity: string;
  routerUser: string;
  routerPassword: string;
  routerWireGuardPrivateKey: string;
  routerWireGuardPublicKey: string;
  vpsWireGuardPrivateKey: string;
  vpsWireGuardPublicKey: string;
  workerSshPublicKey: string;
  vpsEndpointHost: string;
  wireGuardPort: number;
  managementCidr: string;
  vpsAddress: string;
  vpsPeerAddress: string;
  routerAddress: string;
  routerPeerAddress: string;
  recoveryCidr: string;
  wanInterface: string;
}

export type GeneratedBootstrapFiles = Record<
  "router-bootstrap.rsc" | "router-lockdown.rsc" | "router-rollback.rsc" |
  "worker-ssh-key.pub" | "wg0.conf",
  string
>;

export function generateBootstrap(input: BootstrapInput): GeneratedBootstrapFiles;
