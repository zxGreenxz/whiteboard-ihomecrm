import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  timingSafeEqual,
} from "node:crypto";
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

/**
 * DER prefix of a PKCS#8 X25519 private key. WireGuard keys are the raw 32-byte
 * scalar, so wrapping them is the whole conversion.
 */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/**
 * `wg pubkey`, in-process. Curve25519 clamps the scalar during the base-point
 * multiplication, so this agrees with `wg pubkey` for any 32-byte input; the tests
 * pin it to the published RFC 7748 §6.1 vectors rather than to itself.
 */
export function wireGuardPublicKeyFromPrivate(privateKey) {
  if (typeof privateKey !== "string" || !WIREGUARD_KEY.test(privateKey)) {
    throw new TypeError("invalid WireGuard key");
  }
  const raw = Buffer.from(privateKey, "base64");
  if (raw.length !== 32) throw new TypeError("invalid WireGuard key");
  const key = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

/**
 * Mints one WireGuard keypair. Both halves are returned in memory only; every
 * caller here writes them straight into an owner-only file and nothing prints them.
 */
export function generateWireGuardKeypair() {
  const pair = generateKeyPairSync("x25519");
  const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const privateKey = Buffer.from(pkcs8.subarray(pkcs8.length - 32)).toString("base64");
  return { privateKey, publicKey: wireGuardPublicKeyFromPrivate(privateKey) };
}

/**
 * Refuses a declared public key that is not the public half of the declared
 * private key.
 *
 * This is the assertion that closes the loop the demo router fell through: the hub
 * peer had been reserved with a router public key whose private half existed
 * nowhere, so the tunnel could never come up and nothing noticed until somebody ran
 * `wg pubkey` by hand. With this check, a `wg0.conf` peer can only ever carry the
 * public half of the private key that the matching `router-bootstrap.rsc` installs.
 */
function assertMatchedKeypair(privateKey, publicKey) {
  const declared = Buffer.from(publicKey, "base64");
  const derived = Buffer.from(wireGuardPublicKeyFromPrivate(privateKey), "base64");
  if (declared.length !== derived.length || !timingSafeEqual(declared, derived)) {
    throw new TypeError("WireGuard public key does not match its private key");
  }
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
  // The router's own address on the recovery interface. It is what turns the
  // `:lan-recovery` rule from a decoration into a path: the operator's source
  // address has to be on a subnet this router actually answers on, on that exact
  // interface, or the accept rule can never match a packet.
  const recoveryGateway = ipv4Range(value.recoveryInterfaceAddress);
  const managementOverlapsRecovery = management.first <= recovery.last
    && recovery.first <= management.last;
  const managementOverlapsRecoveryGateway = management.first <= recoveryGateway.last
    && recoveryGateway.first <= management.last;
  const invalidRecoveryGateway = recoveryGateway.prefix > 30
    || !isRfc1918(recoveryGateway)
    // An interface address is a host address, never the network or broadcast one.
    || recoveryGateway.number === recoveryGateway.first
    || recoveryGateway.number === recoveryGateway.last
    // The recovery source range must be reachable through that address.
    || recovery.first < recoveryGateway.first
    || recovery.last > recoveryGateway.last
    || managementOverlapsRecoveryGateway;
  const invalid = invalidRecoveryGateway
    || management.number !== management.first
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

export function routerOsQuote(value) {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/;/g, "\\;")
    .replace(/\$/g, "\\$")}"`;
}

// ---------------------------------------------------------------------------
// RouterOS checking
//
// These scripts had only ever been asserted as text and executed by a simulator
// with no parser, so 22 syntax errors survived every gate and were first seen by
// `/import ... dry-run` on the demo hEX (RouterOS 7.20.8, 2026-08-03). Every
// rule below is derived from what that router actually reported, or from a
// direct read-only probe of the live config; nothing here is invented grammar.
// See test/routerOsSyntax.test.ts for the measurements each rule answers to.
// ---------------------------------------------------------------------------

const ROUTER_OS_BOOLEAN_WORDS = new Set(["yes", "no", "true", "false"]);
const ROUTER_OS_CONDITION_KEYWORDS = [":if", ":while"];
const PLACEHOLDER_PATTERN = /@@([A-Z0-9_]+)@@/gu;

/**
 * One entry per source character, carrying its 1-based line and column and
 * whether it sits inside a string literal or a comment. Indices align with the
 * source string for every index the source has, so a `matchAll` offset can be
 * looked up directly.
 */
function routerOsCharacters(script) {
  const characters = [];
  const lines = script.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    // A RouterOS comment runs to the end of its line.
    const comment = text.trimStart().startsWith("#");
    let inString = false;
    let escaped = false;
    for (let column = 0; column < text.length; column += 1) {
      const character = text[column] ?? "";
      const wasInString = inString;
      const wasEscaped = escaped;
      if (!comment) {
        if (escaped) escaped = false;
        else if (inString && character === "\\") escaped = true;
        else if (character === "\"") inString = !inString;
      }
      characters.push({
        character,
        line: index + 1,
        column: column + 1,
        comment,
        string: wasInString && !(character === "\"" && !inString),
        escaped: wasEscaped,
      });
    }
    characters.push({
      character: "\n",
      line: index + 1,
      column: text.length + 1,
      comment,
      string: false,
      escaped: false,
    });
  }
  return characters;
}

function isRouterOsCode(entry) {
  return Boolean(entry) && !entry.comment && !entry.string;
}

/** The `( ... )` group of every `:if` / `:while`, with the lines it spans. */
function routerOsConditionGroups(characters, source) {
  const groups = [];
  for (let index = 0; index < characters.length; index += 1) {
    if (!isRouterOsCode(characters[index])) continue;
    const keyword = ROUTER_OS_CONDITION_KEYWORDS
      .find((candidate) => source.startsWith(candidate, index));
    if (!keyword) continue;
    const previous = index === 0 ? "" : source[index - 1] ?? "";
    if (previous && !/[\s{};]/u.test(previous)) continue;
    const following = source[index + keyword.length] ?? "";
    if (following && !/[\s(]/u.test(following)) continue;
    let cursor = index + keyword.length;
    while (/[ \t]/u.test(source[cursor] ?? "")) cursor += 1;
    if ((source[cursor] ?? "") !== "(") continue;
    let depth = 0;
    for (let scan = cursor; scan < characters.length; scan += 1) {
      const entry = characters[scan];
      if (!isRouterOsCode(entry)) continue;
      if (entry.character === "(") depth += 1;
      else if (entry.character === ")") {
        depth -= 1;
        if (depth === 0) {
          groups.push({ openLine: characters[cursor].line, closeLine: entry.line });
          break;
        }
      }
    }
    index = cursor;
  }
  return groups;
}

/**
 * The body of every `find where ...`, from just after `where` to the character
 * before the `]` that closes the enclosing selector.
 */
function routerOsSelectorRanges(characters, source) {
  const ranges = [];
  for (let index = 0; index < characters.length; index += 1) {
    if (!isRouterOsCode(characters[index])) continue;
    if (!source.startsWith("where", index)) continue;
    if (!source.slice(0, index).trimEnd().endsWith("find")) continue;
    const following = source[index + "where".length] ?? "";
    if (following && !/\s/u.test(following)) continue;
    let depth = 0;
    let end = characters.length - 1;
    for (let scan = index + "where".length; scan < characters.length; scan += 1) {
      const entry = characters[scan];
      if (!isRouterOsCode(entry)) continue;
      if (entry.character === "[") depth += 1;
      else if (entry.character === "]") {
        if (depth === 0) {
          end = scan - 1;
          break;
        }
        depth -= 1;
      }
    }
    ranges.push({ start: index + "where".length, end });
    index = end;
  }
  return ranges;
}

/** Whitespace-separated selector terms, at bracket depth zero. */
function routerOsSelectorTerms(characters, range) {
  const terms = [];
  let current = null;
  let depth = 0;
  for (let index = range.start; index <= range.end && index < characters.length; index += 1) {
    const entry = characters[index];
    const code = isRouterOsCode(entry);
    if (code) {
      if ("[({".includes(entry.character)) depth += 1;
      else if ("])}".includes(entry.character)) depth -= 1;
    }
    if (code && depth === 0 && /\s/u.test(entry.character)) {
      if (current) terms.push(current);
      current = null;
      continue;
    }
    if (!current) current = { text: "", line: entry.line, column: entry.column };
    current.text += entry.character;
  }
  if (current) terms.push(current);
  return terms;
}

/**
 * Diagnostics for one RouterOS script.
 *
 * `kind` separates what `/import ... dry-run` can see from what it cannot:
 *  - `parse`    — an error dry-run reports and refuses the file for;
 *  - `runtime`  — parses clean, fails when executed (`!~`);
 *  - `selector` — parses clean, runs clean, and silently matches nothing.
 */
export function routerOsScriptDiagnostics(script) {
  const source = String(script).replace(/\r/gu, "");
  const lines = source.split("\n");
  const characters = routerOsCharacters(source);
  const diagnostics = [];

  // A parenthesised condition may not span lines. `do={ ... }` bodies may.
  for (const group of routerOsConditionGroups(characters, source)) {
    if (group.closeLine <= group.openLine) continue;
    diagnostics.push({
      rule: "condition-spans-lines",
      kind: "parse",
      line: group.openLine,
      column: (lines[group.openLine - 1] ?? "").length + 1,
      message: "syntax error",
    });
    for (let line = group.openLine + 2; line <= group.closeLine; line += 1) {
      const text = lines[line - 1] ?? "";
      diagnostics.push({
        rule: "condition-spans-lines",
        kind: "parse",
        line,
        column: text.length - text.trimStart().length + 1,
        message: "expected command name",
      });
    }
  }

  for (let index = 0; index < characters.length; index += 1) {
    const entry = characters[index];
    const next = characters[index + 1];
    // `!~` parses as "invert a string" and dies at run time, exit 1.
    if (isRouterOsCode(entry) && entry.character === "!"
      && isRouterOsCode(next) && next?.character === "~") {
      diagnostics.push({
        rule: "invert-string-operator",
        kind: "runtime",
        line: entry.line,
        column: entry.column,
        message: "`!~` is not a RouterOS operator: Script Error: cannot invert string",
      });
    }
    // A `$` inside a string literal opens a variable reference, so a `$` with
    // no name after it — most often right before the closing quote — is a
    // parse error. `\$` is the working form.
    if (entry.string && entry.character === "$" && !entry.escaped
      && !(next?.string && /[A-Za-z0-9_]/u.test(next.character))) {
      diagnostics.push({
        rule: "unescaped-dollar-in-string",
        kind: "parse",
        line: entry.line,
        column: entry.column,
        message: "syntax error",
      });
    }
  }

  for (const range of routerOsSelectorRanges(characters, source)) {
    for (const term of routerOsSelectorTerms(characters, range)) {
      if (!term.text || term.text === "and" || term.text === "or"
        || term.text.startsWith("!")) continue;
      const separator = term.text.indexOf("=");
      if (separator <= 0) continue;
      const key = term.text.slice(0, separator);
      const value = term.text.slice(separator + 1);
      if (
        value.startsWith("\"")
        || value.startsWith("$")
        || value.startsWith("[")
        || /^-?\d+$/u.test(value)
        || ROUTER_OS_BOOLEAN_WORDS.has(value)
      ) continue;
      diagnostics.push({
        rule: "unquoted-selector-value",
        kind: "selector",
        line: term.line,
        column: term.column + separator + 1,
        message: `unquoted value for \`${key}\` in a find-where selector`,
      });
    }
  }

  return diagnostics.sort((left, right) => left.line - right.line || left.column - right.column);
}

/**
 * A value that carries its own quoting, so a template author cannot interpolate
 * an unquoted one into a selector by forgetting a call. This is the structural
 * half of the fix for `RECOVERY_GATEWAY_ADDRESS`, which was the only value in
 * three scripts rendered bare and consequently matched zero rows on the real
 * router while every other value was quoted.
 */
export function routerOsQuotedValue(value) {
  return { form: "quoted", text: routerOsQuote(String(value)) };
}

/** A value that must NOT be quoted: an assignment operand, or one the template already quotes. */
export function routerOsBareValue(value) {
  return { form: "bare", text: String(value) };
}

/** Whole statements composed by the generator, substituted at statement position. */
export function routerOsScriptBlock(value) {
  return { form: "block", text: String(value) };
}

/**
 * Every `@@NAME@@` occurrence with the syntactic context it lands in.
 * `selector` means the value becomes part of a `find where`, where RouterOS
 * compares against the property's own text and an unquoted operand silently
 * matches nothing.
 */
export function routerOsTemplatePlaceholders(template) {
  const source = String(template).replace(/\r/gu, "");
  const characters = routerOsCharacters(source);
  const ranges = routerOsSelectorRanges(characters, source);
  const found = [];
  for (const match of source.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index ?? 0;
    const entry = characters[index];
    const inSelector = ranges.some((range) => index >= range.start && index <= range.end);
    let context = "statement";
    if (entry?.string) context = "string";
    else if (inSelector) context = "selector";
    found.push({
      placeholder: match[1] ?? "",
      index,
      line: entry?.line ?? 0,
      column: entry?.column ?? 0,
      context,
    });
  }
  return found;
}

/**
 * Substitutes tagged values into a RouterOS template and refuses every
 * mismatch between a value's quoting and the context it lands in.
 */
export function renderRouterOsTemplate(template, values) {
  const source = String(template).replace(/\r/gu, "");
  for (const occurrence of routerOsTemplatePlaceholders(source)) {
    const value = values[occurrence.placeholder];
    if (!value || typeof value.text !== "string") {
      throw new Error(`unresolved bootstrap placeholder ${occurrence.placeholder}`);
    }
    if (occurrence.context === "selector" && value.form !== "quoted") {
      throw new Error(
        `@@${occurrence.placeholder}@@ at line ${occurrence.line} is interpolated into a`
        + " RouterOS find-where selector and must be a quoted value",
      );
    }
    if (occurrence.context === "string" && value.form !== "bare") {
      throw new Error(
        `@@${occurrence.placeholder}@@ at line ${occurrence.line} sits inside a quoted string`
        + " literal and must be a bare value",
      );
    }
    if (value.form === "block" && occurrence.context !== "statement") {
      throw new Error(
        `@@${occurrence.placeholder}@@ at line ${occurrence.line} is a script block and may`
        + " only stand at statement position",
      );
    }
  }
  let output = source;
  for (const [name, value] of Object.entries(values)) {
    output = output.replaceAll(`@@${name}@@`, value.text);
  }
  if (PLACEHOLDER_PATTERN.test(output)) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    throw new Error("unresolved bootstrap placeholder");
  }
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return output.endsWith("\n") ? output : `${output}\n`;
}

function readTemplate(name) {
  return readFileSync(join(templateDirectory, name), "utf8").replace(/\r/g, "");
}

/** `wg0.conf` is an INI file, not a RouterOS script, so no RouterOS rule applies. */
function renderPlainTemplate(template, values) {
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
  const recoveryInterfaceAddress = cidr(
    requiredString(input, "recoveryInterfaceAddress"),
    4,
  );
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
    recoveryInterfaceAddress,
    recoveryInterface,
    wanInterface,
    sshStrongCrypto: input.sshStrongCrypto,
    managementServices: managementServices(input),
  };
  validateNetworks(normalized);
  assertMatchedKeypair(
    normalized.routerWireGuardPrivateKey,
    normalized.routerWireGuardPublicKey,
  );
  assertMatchedKeypair(normalized.vpsWireGuardPrivateKey, normalized.vpsWireGuardPublicKey);
  if (normalized.routerWireGuardPrivateKey === normalized.vpsWireGuardPrivateKey) {
    throw new TypeError("router and VPS must not share a WireGuard key");
  }
  return normalized;
}

export function generateBootstrap(input) {
  const value = normalizeInput(input);
  const ownershipMarker = `ihomecrm-network-center:v1:${value.deploymentId}`;
  const serviceRollbackCommands = MANAGEMENT_SERVICE_NAMES.map((name) => {
    const state = value.managementServices[name];
    // `and !dynamic` is load-bearing, not tidiness: RouterOS lists a dynamic
    // connection entry beside the static service while a session is live, so
    // `find where name="ssh"` alone resolves to two rows, the `set` is refused,
    // and `/import` stops there. That is the FIRST mutating line of this file, so
    // without the exclusion the rollback undoes nothing at all.
    return `/ip/service set [find where name=${routerOsQuote(name)} and !dynamic] disabled=${
      state.disabled ? "yes" : "no"
    } port=${state.port} address=${routerOsQuote(state.address)}`;
  }).join("\n");
  const placeholders = {
    ROUTER_USER: routerOsQuotedValue(value.routerUser),
    ROUTER_PASSWORD: routerOsQuotedValue(value.routerPassword),
    ROUTER_WG_PRIVATE_KEY: routerOsQuotedValue(value.routerWireGuardPrivateKey),
    VPS_WG_PUBLIC_KEY: routerOsQuotedValue(value.vpsWireGuardPublicKey),
    VPS_ENDPOINT: routerOsQuotedValue(value.vpsEndpointHost),
    WG_PORT: routerOsBareValue(value.wireGuardPort),
    MANAGEMENT_CIDR: routerOsBareValue(value.managementCidr),
    VPS_PEER_ADDRESS: routerOsBareValue(value.vpsPeerAddress),
    ROUTER_ADDRESS: routerOsBareValue(value.routerAddress),
    RECOVERY_CIDR: routerOsBareValue(value.recoveryCidr),
    // Quoted because it lands inside a `find where`: RouterOS matched 0 rows for
    // the bare form and 1 for the quoted one against the live demo config, so
    // the bare form made the preflight take its own error branch every time.
    RECOVERY_GATEWAY_ADDRESS: routerOsQuotedValue(value.recoveryInterfaceAddress),
    RECOVERY_INTERFACE: routerOsQuotedValue(value.recoveryInterface),
    WAN_INTERFACE: routerOsQuotedValue(value.wanInterface),
    OWNERSHIP_MARKER: routerOsQuotedValue(ownershipMarker),
    SERVICE_ROLLBACK_COMMANDS: routerOsScriptBlock(serviceRollbackCommands),
    SSH_STRONG_CRYPTO_ROLLBACK: routerOsBareValue(value.sshStrongCrypto ? "yes" : "no"),
  };
  const scripts = {
    "router-bootstrap.rsc": renderRouterOsTemplate(
      readTemplate("router-bootstrap.rsc.tmpl"),
      placeholders,
    ),
    "router-lockdown.rsc": renderRouterOsTemplate(
      readTemplate("router-lockdown.rsc.tmpl"),
      placeholders,
    ),
    "router-rollback.rsc": renderRouterOsTemplate(
      readTemplate("router-rollback.rsc.tmpl"),
      placeholders,
    ),
  };
  // Nothing leaves this function that a router would reject or silently
  // mis-evaluate. Values are never echoed into the message.
  for (const [name, content] of Object.entries(scripts)) {
    const diagnostics = routerOsScriptDiagnostics(content);
    const [first] = diagnostics;
    if (first) {
      throw new Error(
        `${name} is not valid RouterOS: ${first.rule} at line ${first.line} column`
        + ` ${first.column} (${diagnostics.length} diagnostic(s))`,
      );
    }
  }
  return {
    ...scripts,
    "worker-ssh-key.pub": `${value.workerSshPublicKey}\n`,
    "wg0.conf": renderPlainTemplate(readTemplate("wg0.conf.tmpl"), {
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

/**
 * Mints the two keypairs one building needs and writes them, and nothing else,
 * into a single owner-only file that the operator merges into the bootstrap input.
 *
 * Both private halves have exactly one destination each and never a second one:
 * the router's goes into `router-bootstrap.rsc`, which is uploaded, imported and
 * then removed from the router's Files; the VPS's goes into `wg0.conf`, which
 * `install-host.sh` installs root-owned 0600. Nothing here writes to stdout, and
 * the output path is refused inside a Git workspace by the same guard the
 * generated bundle uses.
 */
function runKeypairCli(keypairPath) {
  if (!isAbsolute(keypairPath)) throw new Error("bootstrap keypair path must be absolute");
  if (isInsideGitWorkspace(dirname(keypairPath))) {
    throw new Error("bootstrap keypair file must stay outside a Git workspace");
  }
  const router = generateWireGuardKeypair();
  const vps = generateWireGuardKeypair();
  writeFileSync(
    keypairPath,
    `${JSON.stringify({
      routerWireGuardPrivateKey: router.privateKey,
      routerWireGuardPublicKey: router.publicKey,
      vpsWireGuardPrivateKey: vps.privateKey,
      vpsWireGuardPublicKey: vps.publicKey,
    }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

function runCli() {
  if (process.argv.length > 2) throw new Error("command-line arguments are not accepted");
  const keypairPath = process.env.NETWORK_BOOTSTRAP_KEYPAIR_FILE?.trim() ?? "";
  if (keypairPath) {
    runKeypairCli(keypairPath);
    return;
  }
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
