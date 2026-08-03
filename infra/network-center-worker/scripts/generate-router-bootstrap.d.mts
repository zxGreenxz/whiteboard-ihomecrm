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

/**
 * What `/import ... dry-run` would refuse (`parse`), what parses but fails when
 * executed (`runtime`), and what parses, runs, and silently matches no rows
 * (`selector`). Only the last of the three can be found by executing the script
 * against a config, and only the first two by a dry-run — which is why both
 * gates exist.
 */
export type RouterOsDiagnosticKind = "parse" | "runtime" | "selector";

export interface RouterOsDiagnostic {
  rule:
    | "condition-spans-lines"
    | "invert-string-operator"
    | "unescaped-dollar-in-string"
    | "unquoted-selector-value";
  kind: RouterOsDiagnosticKind;
  /** 1-based, as `/import` reports it. */
  line: number;
  column: number;
  message: string;
}

export function routerOsScriptDiagnostics(script: string): RouterOsDiagnostic[];

export interface RouterOsStatement {
  /** The statement as written, with its string literals intact. */
  text: string;
  /** The same statement with string-literal contents blanked out. */
  code: string;
  /** 1-based, as `/import` reports it. */
  line: number;
}

/** Top-level statements, split the way `/import` executes them. */
export function routerOsStatements(script: string): RouterOsStatement[];

export interface RouterOsDiagnosabilityDefect {
  rule:
    | "error-identity-missing"
    | "mutation-without-breadcrumb"
    | "breadcrumb-without-mutation"
    | "step-out-of-sequence";
  line: number;
  message: string;
}

/**
 * What would make a failure on the router undiagnosable under `verbose=no`: an
 * `:error` with no unique identity, or a mutation with no `NC_STEP` breadcrumb
 * to place it in the run.
 */
export function routerOsDiagnosabilityDefects(script: string): RouterOsDiagnosabilityDefect[];

export interface RouterOsScriptIdentity {
  kind: "error" | "step";
  slug: string;
  line: number;
}

/** Every diagnostic identity a script declares, in source order. */
export function routerOsScriptIdentities(script: string): RouterOsScriptIdentity[];

/**
 * Throws for the first defect, or for the first identity used twice. Returns the
 * identity index (slug -> "<file> line <n>") when the bundle is clean.
 */
export function assertRouterOsBundleDiagnosable(
  scripts: Record<string, string>,
): Map<string, string>;

/** A RouterOS string literal, escaped. */
export function routerOsQuote(value: string): string;

export interface RouterOsTemplateValue {
  form: "quoted" | "bare" | "block";
  text: string;
}

export function routerOsQuotedValue(value: string | number): RouterOsTemplateValue;
export function routerOsBareValue(value: string | number): RouterOsTemplateValue;
export function routerOsScriptBlock(value: string): RouterOsTemplateValue;

export interface RouterOsTemplatePlaceholder {
  placeholder: string;
  index: number;
  line: number;
  column: number;
  /**
   * `selector` is the dangerous one: RouterOS compares a `find where` operand
   * against the property's own text, so an unquoted value matches nothing.
   */
  context: "selector" | "string" | "statement";
}

export function routerOsTemplatePlaceholders(template: string): RouterOsTemplatePlaceholder[];

/** Throws when a value's quoting does not match the context it lands in. */
export function renderRouterOsTemplate(
  template: string,
  values: Record<string, RouterOsTemplateValue>,
): string;

/**
 * Exactly the policies the managed worker's command surface needs, in RouterOS's
 * canonical order. `sensitive` is deliberately absent: measured on the demo hEX
 * (7.20.8), the WireGuard private key is reachable only via
 * `/interface/wireguard/print detail`, a submenu the worker never issues.
 */
export const WORKER_GROUP_POLICIES: readonly string[];

/** Policies the managed group must never hold: `sensitive` and `policy`. */
export const WORKER_GROUP_DENIED_POLICIES: readonly string[];

/** `"(^|;)<name>(;|\$)"` — anchored so a denied `!name` cannot read as granted. */
export function workerGroupPolicyTerm(name: string): string;

/** One `:if`/`:error` per required and per denied policy, joined by newlines. */
export function workerGroupPolicyAssertions(
  slugPrefix: string,
  groupsVariable: string,
): string;

/** `wg pubkey`, in-process. Throws for anything that is not a 32-byte base64 key. */
export function wireGuardPublicKeyFromPrivate(privateKey: string): string;

export function generateWireGuardKeypair(): { privateKey: string; publicKey: string };
