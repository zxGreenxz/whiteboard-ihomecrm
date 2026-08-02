import { FakeRouterOsDevice, type RouterOsRow } from "./fakeRouterOsImport.js";

/**
 * WireGuard keys for tests are the published RFC 7748 §6.1 X25519 vectors, so the
 * fixture doubles as a cross-check that the generator's key derivation agrees with
 * `wg pubkey` rather than with itself. They are test vectors, not secrets.
 */
export const RFC7748_ALICE_PRIVATE = "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=";
export const RFC7748_ALICE_PUBLIC = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
export const RFC7748_BOB_PRIVATE = "XasIfmJKikt54X+Lg4AO5m87sSkmGLb9HC+LJ/+I4Os=";
export const RFC7748_BOB_PUBLIC = "3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=";

export const MANAGEMENT_SERVICE_STATE = {
  ssh: { disabled: false, address: "192.168.88.0/24", port: 22 },
  winbox: { disabled: false, address: "192.168.88.0/24", port: 8291 },
  telnet: { disabled: true, address: "", port: 23 },
  ftp: { disabled: true, address: "", port: 21 },
  www: { disabled: true, address: "", port: 80 },
  "www-ssl": { disabled: true, address: "", port: 443 },
  api: { disabled: true, address: "", port: 8728 },
  "api-ssl": { disabled: true, address: "", port: 8729 },
} as const;

/**
 * The measured demo topology: a stock RouterOS `defconf` hEX where ether2-ether5
 * are bridge ports with no address of their own and the LAN is the bridge.
 */
export const bootstrapFixture = {
  routerIdentity: "MikroTik Demo",
  deploymentId: "demo-router-20260730",
  routerUser: "ihome-nc-worker",
  routerPassword: "temporary-random-password-1234567890",
  routerWireGuardPrivateKey: RFC7748_ALICE_PRIVATE,
  routerWireGuardPublicKey: RFC7748_ALICE_PUBLIC,
  vpsWireGuardPrivateKey: RFC7748_BOB_PRIVATE,
  vpsWireGuardPublicKey: RFC7748_BOB_PUBLIC,
  workerSshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeWorkerPublicKeyOnly network-center",
  vpsEndpointHost: "203.0.113.10",
  wireGuardPort: 51820,
  managementCidr: "10.77.0.0/24",
  vpsAddress: "10.77.0.1/24",
  vpsPeerAddress: "10.77.0.1/32",
  routerAddress: "10.77.0.2/24",
  routerPeerAddress: "10.77.0.2/32",
  recoveryCidr: "192.168.88.10/32",
  recoveryInterface: "bridge",
  recoveryInterfaceAddress: "192.168.88.1/24",
  wanInterface: "ether1",
  sshStrongCrypto: false,
  managementServices: MANAGEMENT_SERVICE_STATE,
};

/** The alternative topology: a dedicated out-of-band port carrying its own IP. */
export const dedicatedPortFixture = {
  ...bootstrapFixture,
  recoveryInterface: "ether5",
  recoveryInterfaceAddress: "192.168.99.1/24",
  recoveryCidr: "192.168.99.10/32",
};

export const OWNERSHIP_MARKER = `ihomecrm-network-center:v1:${bootstrapFixture.deploymentId}`;

function serviceRows(liveSshSession: boolean): RouterOsRow[] {
  const rows: RouterOsRow[] = Object.entries(MANAGEMENT_SERVICE_STATE).map(([name, state]) => ({
    name,
    disabled: state.disabled ? "true" : "false",
    port: String(state.port),
    address: state.address,
    dynamic: "false",
  }));
  if (liveSshSession) {
    // The defect's trigger, measured on the hardware: RouterOS lists a dynamic
    // entry beside the static `ssh` service while a session is connected, and a
    // bootstrap delivered over SSH always has one.
    rows.push({ name: "ssh", disabled: "false", port: "22", address: "", dynamic: "true" });
  }
  return rows;
}

export interface StockDeviceOptions {
  /** Defaults to true: the scripts are delivered over SSH, so a session is live. */
  liveSshSession?: boolean;
  /** Give the named ether port its own address and take it out of the bridge. */
  dedicatedRecoveryPort?: { name: string; address: string };
  /** Drop the bridge's static address, leaving only a DHCP-assigned one. */
  bridgeAddressDynamic?: boolean;
  /** Disable the named interface. */
  disabledInterface?: string;
  /** Extra firewall rows, e.g. an adversarial dynamic rule. */
  extraFirewallRows?: RouterOsRow[];
}

/**
 * Builds the measured stock hEX: ether1 WAN with a dynamic DHCP address,
 * ether2-ether5 bridged with `addrs=0`, and the LAN address on the bridge.
 */
export function stockHexDevice(options: StockDeviceOptions = {}): FakeRouterOsDevice {
  const liveSshSession = options.liveSshSession ?? true;
  const dedicated = options.dedicatedRecoveryPort;
  const bridgedPorts = ["ether2", "ether3", "ether4", "ether5"]
    .filter((name) => name !== dedicated?.name);
  const addresses: RouterOsRow[] = [
    // Dynamic, from the WAN DHCP client. Present so a preflight that accepts any
    // address cannot pass by matching a lease that can vanish.
    { address: "203.0.113.5/24", interface: "ether1", disabled: "false", dynamic: "true" },
    {
      address: "192.168.88.1/24",
      interface: "bridge",
      disabled: "false",
      dynamic: options.bridgeAddressDynamic ? "true" : "false",
    },
  ];
  if (dedicated) {
    addresses.push({
      address: dedicated.address,
      interface: dedicated.name,
      disabled: "false",
      dynamic: "false",
    });
  }
  return new FakeRouterOsDevice({
    "/interface": {
      rows: [
        ...["ether1", "ether2", "ether3", "ether4", "ether5"].map((name) => ({
          name,
          "default-name": name,
          type: "ether",
          disabled: options.disabledInterface === name ? "true" : "false",
          dynamic: "false",
        })),
        // A bridge carries no `default-name`, which is why a preflight that reads
        // one unconditionally cannot be used on it.
        {
          name: "bridge",
          type: "bridge",
          disabled: options.disabledInterface === "bridge" ? "true" : "false",
          dynamic: "false",
        },
      ],
    },
    "/interface/bridge/port": {
      rows: bridgedPorts.map((name) => ({ interface: name, bridge: "bridge", dynamic: "false" })),
    },
    "/interface/wireguard": { rows: [] },
    "/interface/wireguard/peers": { rows: [] },
    "/ip/address": { rows: addresses },
    "/ip/service": { rows: serviceRows(liveSshSession) },
    "/ip/firewall/filter": {
      rows: [
        {
          chain: "input",
          action: "accept",
          "connection-state": "established,related,untracked",
          comment: "defconf: accept established,related,untracked",
          disabled: "false",
          dynamic: "false",
        },
        {
          chain: "input",
          action: "drop",
          "in-interface-list": "!LAN",
          comment: "defconf: drop all not coming from LAN",
          disabled: "false",
          dynamic: "false",
        },
        ...(options.extraFirewallRows ?? []),
      ],
    },
    "/user": { rows: [{ name: "admin", group: "full", comment: "", disabled: "false" }] },
    "/user/group": {
      rows: [
        { name: "full", policy: "local,telnet,ssh,ftp,reboot,read,write,policy,test" },
        { name: "read", policy: "local,telnet,ssh,reboot,read,test,winbox,password" },
      ],
    },
    "/user/ssh-keys": { rows: [] },
    "/ip/ssh": { settings: { "strong-crypto": "no" } },
  });
}
