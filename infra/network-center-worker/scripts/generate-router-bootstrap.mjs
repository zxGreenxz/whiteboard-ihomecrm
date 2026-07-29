import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const templateDirectory = resolve(scriptDirectory, "../templates");
const WIREGUARD_KEY = /^[A-Za-z0-9+/]{43}=$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const SAFE_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
const MANAGED_ROUTER_USER = "ihome-nc-worker";
const MANAGEMENT_SERVICE_NAMES = Object.freeze([
  "ssh",
  "winbox",
  "telnet",
  "ftp",
  "www",
  "www-ssl",
  "api",
  "api-ssl",
]);

function requiredString(input, key, minimum = 1, maximum = 512) {
  const value = input?.[key];
  if (typeof value !== "string") throw new TypeError("invalid bootstrap input");
  const normalized = value.trim();
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || /[\x00-\x1f\x7f]/.test(normalized)
  ) {
    throw new TypeError("invalid bootstrap input");
  }
  return normalized;
}

function cidr(value, family) {
  const [address, prefix, extra] = value.split("/");
  const maximum = family === 4 ? 32 : 128;
  if (extra !== undefined || isIP(address ?? "") !== family || !/^\d+$/.test(prefix ?? "")) {
    throw new TypeError("invalid bootstrap network");
  }
  const number = Number(prefix);
  if (!Number.isInteger(number) || number < 0 || number > maximum) {
    throw new TypeError("invalid bootstrap network");
  }
  return `${address}/${number}`;
}

function wireGuardKey(input, key) {
  const value = requiredString(input, key, 44, 44);
  if (!WIREGUARD_KEY.test(value)) throw new TypeError("invalid WireGuard key");
  return value;
}

function ipv4Range(value) {
  const [address, prefixText] = value.split("/");
  const octets = address.split(".").map(Number);
  const number = octets.reduce((result, octet) => result * 256 + octet, 0);
  const prefix = Number(prefixText);
  const size = 2 ** (32 - prefix);
  const first = Math.floor(number / size) * size;
  return { address, prefix, number, first, last: first + size - 1 };
}

function isRfc1918(range) {
  const blocks = [
    ipv4Range("10.0.0.0/8"),
    ipv4Range("172.16.0.0/12"),
    ipv4Range("192.168.0.0/16"),
  ];
  return blocks.some((block) => range.first >= block.first && range.last <= block.last);
}

function serviceAddress(value) {
  if (
    typeof value !== "string"
    || value.length > 512
    || /[\x00-\x1f\x7f]/.test(value)
  ) throw new TypeError("invalid management service state");
  if (!value) return "";
  const entries = value.split(",");
  for (const entry of entries) {
    const [address] = entry.split("/");
    const family = isIP(address ?? "");
    if (!family) throw new TypeError("invalid management service state");
    cidr(entry, family);
  }
  return entries.join(",");
}

function managementServices(input) {
  const value = input?.managementServices;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid management service state");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...MANAGEMENT_SERVICE_NAMES].sort().join(",")) {
    throw new TypeError("invalid management service state");
  }
  return Object.fromEntries(MANAGEMENT_SERVICE_NAMES.map((name) => {
    const state = value[name];
    if (
      !state
      || typeof state !== "object"
      || Array.isArray(state)
      || typeof state.disabled !== "boolean"
      || !Number.isInteger(state.port)
      || state.port < 1
      || state.port > 65_535
    ) throw new TypeError("invalid management service state");
    return [name, {
      disabled: state.disabled,
      address: serviceAddress(state.address),
      port: state.port,
    }];
  }));
}

function validateNetworks(value) {
  const management = ipv4Range(value.managementCidr);
  const recovery = ipv4Range(value.recoveryCidr);
  const vpsAddress = ipv4Range(value.vpsAddress);
  const routerAddress = ipv4Range(value.routerAddress);
  const vpsPeer = ipv4Range(value.vpsPeerAddress);
  const routerPeer = ipv4Range(value.routerPeerAddress);
  const managementOverlapsRecovery = management.first <= recovery.last
    && recovery.first <= management.last;
  const invalid = management.number !== management.first
    || management.prefix > 30
    || recovery.number !== recovery.first
    || recovery.prefix < 28
    || recovery.prefix > 32
    || !isRfc1918(recovery)
    || vpsAddress.prefix !== management.prefix
    || routerAddress.prefix !== management.prefix
    || vpsPeer.prefix !== 32
    || routerPeer.prefix !== 32
    || vpsAddress.number !== vpsPeer.number
    || routerAddress.number !== routerPeer.number
    || vpsAddress.number === routerAddress.number
    || vpsAddress.number < management.first
    || vpsAddress.number > management.last
    || routerAddress.number < management.first
    || routerAddress.number > management.last
    || vpsAddress.number === management.first
    || vpsAddress.number === management.last
    || routerAddress.number === management.first
    || routerAddress.number === management.last
    || managementOverlapsRecovery;
  if (invalid) throw new TypeError("invalid bootstrap network");
}

function routerOsQuote(value) {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/;/g, "\\;")
    .replace(/\$/g, "\\$")}"`;
}

function readTemplate(name) {
  return readFileSync(join(templateDirectory, name), "utf8").replace(/\r/g, "");
}

function render(template, values) {
  let output = template;
  for (const [name, value] of Object.entries(values)) {
    output = output.replaceAll(`@@${name}@@`, value);
  }
  if (/@@[A-Z0-9_]+@@/.test(output)) throw new Error("unresolved bootstrap placeholder");
  return output.endsWith("\n") ? output : `${output}\n`;
}

function normalizeInput(input) {
  const routerIdentity = requiredString(input, "routerIdentity", 1, 64);
  const deploymentId = requiredString(input, "deploymentId", 8, 64);
  if (!DEPLOYMENT_ID.test(deploymentId)) throw new TypeError("invalid deployment marker");
  if (
    input?.routerUser !== undefined
    && requiredString(input, "routerUser", 3, 63) !== MANAGED_ROUTER_USER
  ) throw new TypeError("invalid managed RouterOS user");
  const routerUser = MANAGED_ROUTER_USER;
  const routerPassword = requiredString(input, "routerPassword", 24, 128);
  const wanInterface = requiredString(input, "wanInterface", 1, 64);
  const recoveryInterface = requiredString(input, "recoveryInterface", 1, 64);
  if (!SAFE_NAME.test(wanInterface) || !SAFE_NAME.test(recoveryInterface)) {
    throw new TypeError("invalid RouterOS name");
  }
  if (
    recoveryInterface.toLowerCase() === wanInterface.toLowerCase()
    || /^(?:ether1(?:$|\D)|wan|uplink|pppoe|sfp|wg|wireguard)/i.test(recoveryInterface)
  ) throw new TypeError("invalid recovery interface");
  if (typeof input?.sshStrongCrypto !== "boolean") {
    throw new TypeError("invalid SSH strong-crypto state");
  }
  const endpoint = requiredString(input, "vpsEndpointHost", 1, 253);
  if (!isIP(endpoint) && !SAFE_HOST.test(endpoint)) throw new TypeError("invalid VPS endpoint");
  const wireGuardPort = input?.wireGuardPort;
  if (!Number.isInteger(wireGuardPort) || wireGuardPort < 1_024 || wireGuardPort > 65_535) {
    throw new TypeError("invalid WireGuard port");
  }
  const workerSshPublicKey = requiredString(input, "workerSshPublicKey", 40, 16_384);
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?$/.test(workerSshPublicKey)) {
    throw new TypeError("invalid SSH public key");
  }
  const managementCidr = cidr(requiredString(input, "managementCidr"), 4);
  const vpsAddress = cidr(requiredString(input, "vpsAddress"), 4);
  const vpsPeerAddress = cidr(requiredString(input, "vpsPeerAddress"), 4);
  const routerAddress = cidr(requiredString(input, "routerAddress"), 4);
  const routerPeerAddress = cidr(requiredString(input, "routerPeerAddress"), 4);
  const recoveryCidr = cidr(requiredString(input, "recoveryCidr"), 4);
  const normalized = {
    routerIdentity,
    deploymentId,
    routerUser,
    routerPassword,
    routerWireGuardPrivateKey: wireGuardKey(input, "routerWireGuardPrivateKey"),
    routerWireGuardPublicKey: wireGuardKey(input, "routerWireGuardPublicKey"),
    vpsWireGuardPrivateKey: wireGuardKey(input, "vpsWireGuardPrivateKey"),
    vpsWireGuardPublicKey: wireGuardKey(input, "vpsWireGuardPublicKey"),
    workerSshPublicKey,
    vpsEndpointHost: endpoint,
    wireGuardPort,
    managementCidr,
    vpsAddress,
    vpsPeerAddress,
    routerAddress,
    routerPeerAddress,
    recoveryCidr,
    recoveryInterface,
    wanInterface,
    sshStrongCrypto: input.sshStrongCrypto,
    managementServices: managementServices(input),
  };
  validateNetworks(normalized);
  return normalized;
}

export function generateBootstrap(input) {
  const value = normalizeInput(input);
  const ownershipMarker = `ihomecrm-network-center:v1:${value.deploymentId}`;
  const serviceRollbackCommands = MANAGEMENT_SERVICE_NAMES.map((name) => {
    const state = value.managementServices[name];
    return `/ip/service set [find where name=${routerOsQuote(name)}] disabled=${
      state.disabled ? "yes" : "no"
    } port=${state.port} address=${routerOsQuote(state.address)}`;
  }).join("\n");
  const placeholders = {
    ROUTER_USER: routerOsQuote(value.routerUser),
    ROUTER_PASSWORD: routerOsQuote(value.routerPassword),
    ROUTER_WG_PRIVATE_KEY: routerOsQuote(value.routerWireGuardPrivateKey),
    VPS_WG_PUBLIC_KEY: routerOsQuote(value.vpsWireGuardPublicKey),
    VPS_ENDPOINT: routerOsQuote(value.vpsEndpointHost),
    WG_PORT: String(value.wireGuardPort),
    MANAGEMENT_CIDR: value.managementCidr,
    VPS_PEER_ADDRESS: value.vpsPeerAddress,
    ROUTER_ADDRESS: value.routerAddress,
    RECOVERY_CIDR: value.recoveryCidr,
    RECOVERY_INTERFACE: routerOsQuote(value.recoveryInterface),
    WAN_INTERFACE: routerOsQuote(value.wanInterface),
    OWNERSHIP_MARKER: routerOsQuote(ownershipMarker),
    SERVICE_ROLLBACK_COMMANDS: serviceRollbackCommands,
    SSH_STRONG_CRYPTO_ROLLBACK: value.sshStrongCrypto ? "yes" : "no",
  };
  return {
    "router-bootstrap.rsc": render(readTemplate("router-bootstrap.rsc.tmpl"), placeholders),
    "router-lockdown.rsc": render(readTemplate("router-lockdown.rsc.tmpl"), placeholders),
    "router-rollback.rsc": render(readTemplate("router-rollback.rsc.tmpl"), placeholders),
    "worker-ssh-key.pub": `${value.workerSshPublicKey}\n`,
    "wg0.conf": render(readTemplate("wg0.conf.tmpl"), {
      VPS_ADDRESS_RAW: value.vpsAddress,
      WG_PORT: String(value.wireGuardPort),
      VPS_WG_PRIVATE_KEY_RAW: value.vpsWireGuardPrivateKey,
      ROUTER_IDENTITY_RAW: value.routerIdentity.replace(/[^\x20-\x7e]/g, "?"),
      ROUTER_WG_PUBLIC_KEY_RAW: value.routerWireGuardPublicKey,
      ROUTER_PEER_ADDRESS_RAW: value.routerPeerAddress,
    }),
  };
}

function assertOwnerOnlyFile(path) {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0 || (mode & 0o400) === 0) {
    throw new Error("bootstrap input file is not owner-only");
  }
}

function isInsideGitWorkspace(path) {
  let current = resolve(path);
  const root = parse(current).root;
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    if (current === root) return false;
    current = dirname(current);
  }
}

function runCli() {
  if (process.argv.length > 2) throw new Error("command-line arguments are not accepted");
  const inputPath = process.env.NETWORK_BOOTSTRAP_INPUT_FILE?.trim() ?? "";
  const outputDirectory = process.env.NETWORK_BOOTSTRAP_OUTPUT_DIR?.trim() ?? "";
  if (!inputPath || !outputDirectory || !isAbsolute(inputPath) || !isAbsolute(outputDirectory)) {
    throw new Error("bootstrap input and output paths are required");
  }
  if (isInsideGitWorkspace(outputDirectory)) {
    throw new Error("bootstrap output must stay outside a Git workspace");
  }
  assertOwnerOnlyFile(inputPath);
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const files = generateBootstrap(input);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(outputDirectory, 0o700);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(outputDirectory, name), content, { flag: "wx", mode: 0o600 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch {
    process.stderr.write("Bootstrap generation failed\n");
    process.exitCode = 1;
  }
}
