export interface BootstrapInput {
  routerIdentity: string;
  deploymentId: string;
  routerUser?: string;
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
  /** The router's own address on the recovery interface, e.g. `192.168.88.1/24`. */
  recoveryInterfaceAddress: string;
  recoveryInterface: string;
  wanInterface: string;
  sshStrongCrypto: boolean;
  managementServices: Record<
    "ssh" | "winbox" | "telnet" | "ftp" | "www" | "www-ssl" | "api" | "api-ssl",
    { disabled: boolean; address: string; port: number }
  >;
}

export type GeneratedBootstrapFiles = Record<
  "router-bootstrap.rsc" | "router-lockdown.rsc" | "router-rollback.rsc" |
  "worker-ssh-key.pub" | "wg0.conf",
  string
>;

export function generateBootstrap(input: BootstrapInput): GeneratedBootstrapFiles;

/** `wg pubkey`, in-process. Throws for anything that is not a 32-byte base64 key. */
export function wireGuardPublicKeyFromPrivate(privateKey: string): string;

export function generateWireGuardKeypair(): { privateKey: string; publicKey: string };
