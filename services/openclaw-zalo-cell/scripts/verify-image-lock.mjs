import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  verifyCommittedInputs,
  verifySigstoreAttestations,
} from "../vendor/zalouser-bridge/scripts/verify-upstream.mjs";

const HEX_64 = /^[0-9a-f]{64}$/;
const REVIEWED_TREE = /^[0-9a-f]{40}$/;
const BASE_IMAGE =
  "ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f";
const BUILDKIT_IMAGE =
  "moby/buildkit:v0.13.2@sha256:9194b5ec1be368f41c516df7f93f7f540630ea06136056b2ffebb62226ed4ad6";
const BUILDX_WINDOWS_SHA256 =
  "6b113e84cbc3cd645646aa82f00a7f7d3737cc10375b4341e0aca0de0c997c75";
const BUILDX_LINUX_SHA256 =
  "3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c";
const DOCKER_LINUX_SHA256 =
  "40cdaf7fd0f21089dd9e15b0c3a7dd7f2399027f010e366dac6304ae0615954a";
const SESSION_DIST = [
  "session-crypto/dist/crypto.js",
  "session-crypto/dist/daemon.js",
  "session-crypto/dist/package.json",
];
const BASE_AMD64_LAYER_DIGESTS = [
  "sha256:068fedd6b0f109b8186d00d49327b6fc6747c428fd3c9a8739424ff5f38d7531",
  "sha256:9bea510bd805f72c63e2d093c23fca1da9b02127c4849c121b6117a45d4d2ba7",
  "sha256:e008f534e95cab9dfc584b72c1beb5ccd5b4e7b6b73973a6fd6791f0d8e2ac29",
  "sha256:b2b95943836ce3dea08d21af828b011a0645bdca70cd53536131ccd295ef3def",
  "sha256:06d464f614a98416f8f326dcd40292b0a96bf6a56a6fba9e2f98ed770cdacf11",
  "sha256:f02110821b68b61c05f9c769c319c285c30fce601188f68a8442b4da07abe931",
  "sha256:fba04109c655a22c7139f277f6323eae025be54462bbc240f0e4930ab72e09c9",
  "sha256:d301bb7ca54ecc4507913a2cf397d167543dbf5c1bd73c85a1a74d6322232044",
  "sha256:2d1d5819c0bb5ff67ffe951211449d1d8b4ce764ffa809890902d96682020300",
  "sha256:7b15f824809e3b1bdfe29d75ce8a734832a470614f41226e425d91f36e4e9191",
  "sha256:83652162d972b1cfd2f873abf5c279613a3a254aad1e4ccb9d06dd671ce6a58d",
  "sha256:cc75351a20379406889f888f8c60dd18bb871290a099db0151ebb424d31c7d7d",
  "sha256:b7fefb8f1a7b6d1fb657145af6c9bf1468b9819797214e24876099672794247a",
  "sha256:a9a8e81dbd59939765cec0938f0393ca3c9b02f35690b5302590f0d9e2184647",
  "sha256:ade79bee3a723f0ca1bc54064f17865bbc30386ad432d905e69cb92980d8a7cb",
  "sha256:78337a35b2b5ccd2217d58f6d50c17648f8b8e8ff9802b7dc6d239fce131728a",
  "sha256:ecdc564e2837c2ea5e1716e48fe51b703d03311441a34b8b992990a0c7249951",
  "sha256:a3495566486c007b3eb1e0ea3753d345889cf5c7f1b2f6a90c513957ce1e2580",
  "sha256:c7037bbdcd5db109284c7b4131a16caed1a0f006ab4e505ce7561fa6d7fba869",
  "sha256:f2bf856e3441730e164115852235a74fee84adaa972551cc770df159e1249a7f",
  "sha256:4f4fb700ef54461cfa02571ae0db9a0dc1e0cdb5577484a6d75e68dc38e8acc1",
  "sha256:4f4fb700ef54461cfa02571ae0db9a0dc1e0cdb5577484a6d75e68dc38e8acc1",
  "sha256:4f4fb700ef54461cfa02571ae0db9a0dc1e0cdb5577484a6d75e68dc38e8acc1",
  "sha256:4f4fb700ef54461cfa02571ae0db9a0dc1e0cdb5577484a6d75e68dc38e8acc1",
  "sha256:2bb3393a0fd03b10971fc965d40276d6fe7e067679a5c86d1962bb1546347d88",
  "sha256:b597d7a31e9105eccc87e346b2823a4ffc8cb878229294368feaec452875414f",
];
const BASE_AMD64_DIFF_IDS = [
  "sha256:b2008ac19409fa6fee4b52596271400498aebd0be04dffac5351bd1dcf230f2a",
  "sha256:1a49327bff76fa2fc2d3c6a0747073c7ccbf85c3215145b847493eae4665ca1c",
  "sha256:368a384a9b02c507eeb84852567eff5187d5cf56a719a38f18494a04bf06851c",
  "sha256:63f1a0ed3c0ccb05bf1aecd776cc5110df58cb81d977daa746097730b08356e0",
  "sha256:223a7a42ca231e1795e6aaea0bcc34a07b27ca868ba3a6c8eedb8c98937a1067",
  "sha256:f32349dbc62b6082da51b1bb8d4e15496e39941274941fa5415a0040da7b43bc",
  "sha256:f262d8723a4fbf57b00294f167519cb0538e4da116cd23c1b7def7295a2300bc",
  "sha256:fcfdcef20c14928a7933856908c821698fb024a11e36b154c1e546f853a55d48",
  "sha256:a1597fca42d2b24717da80fdb6881b24e2f711335c17c3ea9a62940091341131",
  "sha256:2a70367cc54e55fc9289c6e6cb7f3154df792a58987ff0ce8988866772f8e1da",
  "sha256:91b29631a27cbba15d2c8880e45de40f3511887565f76dd458b9b69b0c2ecca5",
  "sha256:09e209bd4612d4fbc83e153931c7af5e43287e14c775859dd7e520de7c38a151",
  "sha256:4ecc44996cc8d91d03285d4e8045fae281983abcdc17d7a66a808c1cd088f611",
  "sha256:1fd6277ff7870257736dd9aa1ac21357a3f40c2c0f4bd51be94dd532b80f9831",
  "sha256:6d6389c5ccfed10dd25d182a16aa912f6d3acd197a8c5299c41a1ac8f3651b97",
  "sha256:105e8bde7b304f650980f7d2dd778ad01c89d7fc8646b61e9b3245ccb8b8ad10",
  "sha256:75d7e52f178dbd53b8f7e33aed6108675a5b5b4d3cc94fdff2bfb425c50315ab",
  "sha256:0777be0aa3247c0f30b255d6bcb11f1c26a64c3dfa329bbb1258ff6eeea509ad",
  "sha256:e22e16c936ed2a35454019523254c567f3951716fbb72d6eb4c759db0d55756a",
  "sha256:c5004ad4d06190bc762350f7458b63f0ac86f12373e6255f555d3a2d7d3caff0",
  "sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef",
  "sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef",
  "sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef",
  "sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef",
  "sha256:51d3bde6fa2f66c5357010ea449fe42a79f7dff1b789b086be65cd047944e7fa",
  "sha256:406294c2578d5cf9a5cdcb236c07c63b5bed2e0701d42be65c54aa5eab10dac9",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactKeys(object, expected, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(object).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing properties`);
  }
}

function parseJsonStrict(bytes, label) {
  const text = Buffer.from(bytes).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${label} contains a BOM`);
  let offset = 0;
  const skipWhitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset += 1;
  };
  const parseString = () => {
    const start = offset;
    if (text[offset] !== '"') throw new Error(`${label} contains an invalid JSON string`);
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length) throw new Error(`${label} contains an unterminated JSON escape`);
        const escape = text[offset];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) {
            throw new Error(`${label} contains an invalid Unicode escape`);
          }
          offset += 5;
        } else if ('"\\/bfnrt'.includes(escape)) {
          offset += 1;
        } else {
          throw new Error(`${label} contains an invalid JSON escape`);
        }
        continue;
      }
      if (code < 0x20) throw new Error(`${label} contains a control character in a JSON string`);
      offset += 1;
    }
    throw new Error(`${label} contains an unterminated JSON string`);
  };
  const parseValue = () => {
    skipWhitespace();
    const token = text[offset];
    if (token === '"') return parseString();
    if (token === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error(`${label} contains a duplicate JSON key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") throw new Error(`${label} contains a malformed JSON object`);
        offset += 1;
        parseValue();
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new Error(`${label} contains a malformed JSON object`);
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON object`);
    }
    if (token === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        parseValue();
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") throw new Error(`${label} contains a malformed JSON array`);
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON array`);
    }
    const start = offset;
    while (offset < text.length && !/[\u0009\u000a\u000d\u0020,\]}]/.test(text[offset])) offset += 1;
    if (start === offset) throw new Error(`${label} contains an invalid JSON value`);
    const value = JSON.parse(text.slice(start, offset));
    if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value))) {
      throw new Error(`${label} contains a non-I-JSON number`);
    }
    return value;
  };
  parseValue();
  skipWhitespace();
  if (offset !== text.length) throw new Error(`${label} contains trailing bytes`);
  return JSON.parse(text);
}

const ZALOUSER_PLUGIN_ROOT =
  "/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser";

function assertProbeProcess(result, label, expectedExitCode) {
  if (
    !result ||
    result.exitCode !== expectedExitCode ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    throw new Error(`${label} process result is invalid`);
  }
}

function parsePluginList(result, label) {
  assertProbeProcess(result, label, 0);
  if (result.stderr.length !== 0) throw new Error(`${label} wrote unexpected stderr`);
  const parsed = parseJsonStrict(result.stdout, label);
  if (!Array.isArray(parsed?.plugins)) throw new Error(`${label} plugins array is missing`);
  const ids = new Set();
  const collisionKeys = new Set();
  for (const [index, plugin] of parsed.plugins.entries()) {
    const id = plugin?.id;
    if (typeof id !== "string" || !id) throw new Error(`${label} plugin ${index} has no id`);
    const collisionKey = id.normalize("NFC").toLowerCase();
    if (id !== id.normalize("NFC") || ids.has(id) || collisionKeys.has(collisionKey)) {
      throw new Error(`${label} has a duplicate or shadow plugin id: ${id}`);
    }
    ids.add(id);
    collisionKeys.add(collisionKey);
  }
  return parsed;
}

function assertZalouserPlugin(plugin, label) {
  const expectedSource = `${ZALOUSER_PLUGIN_ROOT}/dist/index.js`;
  if (
    plugin?.id !== "zalouser" ||
    plugin?.name !== "Zalo Personal" ||
    plugin?.version !== "2026.7.1" ||
    plugin?.source !== expectedSource ||
    plugin?.rootDir !== ZALOUSER_PLUGIN_ROOT ||
    plugin?.origin !== "global" ||
    plugin?.enabled !== true ||
    plugin?.status !== "loaded" ||
    JSON.stringify(plugin?.channelIds) !== JSON.stringify(["zalouser"]) ||
    JSON.stringify(plugin?.contracts?.tools) !== JSON.stringify(["zalouser"]) ||
    plugin?.dependencyStatus?.installed !== true ||
    plugin?.dependencyStatus?.requiredInstalled !== true ||
    plugin?.dependencyStatus?.optionalInstalled !== true ||
    (plugin?.dependencyStatus?.missing?.length ?? -1) !== 0 ||
    (plugin?.dependencyStatus?.missingOptional?.length ?? -1) !== 0
  ) {
    throw new Error(`${label} does not describe the exact loaded zalouser fork`);
  }
}

export function validatePluginProbeResults({
  forkList,
  forkInspect,
  stockList,
  stockInspect,
}) {
  const parsedForkList = parsePluginList(forkList, "fork plugin list");
  const parsedStockList = parsePluginList(stockList, "stock plugin list");
  const forkMatches = parsedForkList.plugins.filter(({ id }) => id === "zalouser");
  const stockMatches = parsedStockList.plugins.filter(({ id }) => id === "zalouser");
  if (forkMatches.length !== 1) throw new Error("fork must expose exactly one zalouser plugin");
  if (stockMatches.length !== 0) throw new Error("stock image unexpectedly exposes zalouser");
  if (parsedForkList.plugins.length !== parsedStockList.plugins.length + 1) {
    throw new Error("fork plugin list must add only zalouser to the stock registry");
  }
  assertZalouserPlugin(forkMatches[0], "fork plugin list record");

  assertProbeProcess(forkInspect, "fork plugin inspect", 0);
  if (forkInspect.stderr.length !== 0) throw new Error("fork plugin inspect wrote unexpected stderr");
  const parsedForkInspect = parseJsonStrict(forkInspect.stdout, "fork plugin inspect");
  assertZalouserPlugin(parsedForkInspect?.plugin, "fork plugin inspect record");
  if (parsedForkInspect.plugin.imported !== true) {
    throw new Error("fork plugin inspect did not import zalouser");
  }
  const install = parsedForkInspect.install;
  if (
    install?.source !== "npm" ||
    install?.spec !== "@openclaw/zalouser@2026.7.1" ||
    install?.installPath !== ZALOUSER_PLUGIN_ROOT ||
    install?.version !== "2026.7.1" ||
    install?.resolvedName !== "@openclaw/zalouser" ||
    install?.resolvedVersion !== "2026.7.1" ||
    install?.resolvedSpec !== "@openclaw/zalouser@2026.7.1"
  ) {
    throw new Error("fork plugin inspect install provenance mismatch");
  }

  assertProbeProcess(stockInspect, "stock plugin inspect", 1);
  if (stockInspect.stdout.length !== 0 || !/Plugin not found: zalouser/u.test(stockInspect.stderr)) {
    throw new Error("stock plugin inspect did not fail specifically for missing zalouser");
  }
  const projectPath = "/home/node/.openclaw/npm/projects/zalouser";
  return {
    fork: {
      list_sha256: sha256(forkList.stdout),
      list_size: forkList.stdout.length,
      inspect_sha256: sha256(forkInspect.stdout),
      inspect_size: forkInspect.stdout.length,
      plugin_count: parsedForkList.plugins.length,
      plugin: {
        id: "zalouser",
        name: forkMatches[0].name,
        version: forkMatches[0].version,
        source: forkMatches[0].source,
        root_dir: forkMatches[0].rootDir,
        origin: forkMatches[0].origin,
        enabled: forkMatches[0].enabled,
        status: forkMatches[0].status,
        channel_ids: forkMatches[0].channelIds,
      },
      inspect: {
        imported: true,
        package_name: parsedForkInspect.plugin.packageName,
        source: parsedForkInspect.plugin.source,
        root_dir: parsedForkInspect.plugin.rootDir,
        install_source: install.source,
        install_spec: install.spec,
        install_path: install.installPath,
        resolved_version: install.resolvedVersion,
      },
      discovery_roots: [projectPath, ZALOUSER_PLUGIN_ROOT],
    },
    stock: {
      list_sha256: sha256(stockList.stdout),
      list_size: stockList.stdout.length,
      inspect_stderr_sha256: sha256(stockInspect.stderr),
      inspect_stderr_size: stockInspect.stderr.length,
      inspect_exit_code: stockInspect.exitCode,
      plugin_count: parsedStockList.plugins.length,
    },
    differential: {
      fork_pass: true,
      stock_fail: true,
      plugin_delta: parsedForkList.plugins.length - parsedStockList.plugins.length,
    },
  };
}

export function dockerProbeRunArguments({ image, cliArguments }) {
  if (!/^ihome\/[a-z0-9._/-]+:[0-9a-f]{32}$/u.test(image ?? "")) {
    throw new Error("Docker probe image tag is invalid");
  }
  const allowedCommands = [
    ["plugins", "list", "--json"],
    ["plugins", "inspect", "zalouser", "--runtime", "--json"],
  ];
  if (
    !Array.isArray(cliArguments) ||
    !allowedCommands.some((allowed) => JSON.stringify(allowed) === JSON.stringify(cliArguments))
  ) {
    throw new Error("Docker probe CLI arguments are not allowlisted");
  }
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "768m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700",
    "--tmpfs",
    "/home/node/.openclaw/state:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700",
    "--entrypoint",
    "node",
    image,
    "openclaw.mjs",
    ...cliArguments,
  ];
}

const MANDATORY_RUNTIME_SCENARIOS = [
  "plugin-discovery",
  "configuration",
  "setup",
  "doctor",
  "qr-login",
  "session-restore",
  "inbound-text",
  "inbound-media",
  "outbound-text",
  "outbound-media",
  "outbound-link",
  "outbound-reaction",
  "control-traffic",
  "authorization-denial",
  "unknown-after-handoff",
  "offline-restart",
];

function exactRuntimeMemberSet(fork) {
  const allowlist = fork?.runtimeReachabilityAllowlist;
  if (
    !Array.isArray(allowlist) ||
    allowlist.length === 0 ||
    allowlist.some((path) => !/^package\/dist\/[A-Za-z0-9._/-]+\.js$/u.test(path))
  ) {
    throw new Error("FORK runtime reachability allowlist is invalid");
  }
  const sorted = [...allowlist].sort(compareUtf8);
  if (new Set(sorted).size !== sorted.length || JSON.stringify(sorted) !== JSON.stringify(allowlist)) {
    throw new Error("FORK runtime reachability allowlist must be unique and sorted");
  }
  return sorted;
}

function dynamicTarget(fork, allowlist, source, pattern) {
  const matches = new Set();
  for (const site of fork?.runtimeDynamicSiteInventory ?? []) {
    if (site?.source !== source || site?.operation !== "dynamic-import") continue;
    for (const member of site.expandedMembers ?? []) {
      if (allowlist.includes(member) && pattern.test(member)) matches.add(member);
    }
  }
  if (matches.size !== 1) {
    throw new Error(`FORK runtime inventory does not resolve one exact target for ${source}`);
  }
  return [...matches][0];
}

export function runtimeScenarioPlan(fork) {
  const allowlist = exactRuntimeMemberSet(fork);
  const requireMember = (path) => {
    if (!allowlist.includes(path)) throw new Error(`mandatory runtime target is absent: ${path}`);
    return path;
  };
  const accounts = dynamicTarget(fork, allowlist, "src/accounts.ts", /\/accounts\.runtime-[A-Z0-9]+\.js$/u);
  const channelCandidates = new Set(
    ["src/channel.ts", "src/channel.adapters.ts"].map((source) =>
      dynamicTarget(fork, allowlist, source, /\/channel\.runtime-[A-Z0-9]+\.js$/u),
    ),
  );
  if (channelCandidates.size !== 1) throw new Error("channel runtime dynamic sites disagree");
  const channel = [...channelCandidates][0];
  const setupSurface = dynamicTarget(fork, allowlist, "src/channel.ts", /\/setup-surface-[A-Z0-9]+\.js$/u);
  const monitor = dynamicTarget(fork, allowlist, "src/channel.ts", /\/monitor-[A-Z0-9]+\.js$/u);
  const zca = dynamicTarget(fork, allowlist, "src/zca-client.ts", /\/dist-[A-Z0-9]+\.js$/u);
  const targets = {
    "plugin-discovery": [requireMember("package/dist/index.js")],
    configuration: [requireMember("package/dist/channel-plugin-api.js"), requireMember("package/dist/contract-api.js")],
    setup: [
      requireMember("package/dist/setup-entry.js"),
      requireMember("package/dist/setup-plugin-api.js"),
      setupSurface,
    ],
    doctor: [requireMember("package/dist/doctor-contract-api.js")],
    "qr-login": [accounts, zca],
    "session-restore": [accounts, zca],
    "inbound-text": [monitor],
    "inbound-media": [monitor, zca],
    "outbound-text": [channel, zca],
    "outbound-media": [channel, zca],
    "outbound-link": [channel, zca],
    "outbound-reaction": [channel, zca],
    "control-traffic": [channel],
    "authorization-denial": [channel],
    "unknown-after-handoff": [channel],
    "offline-restart": [requireMember("package/dist/index.js"), requireMember("package/dist/channel-plugin-api.js")],
  };
  return MANDATORY_RUNTIME_SCENARIOS.map((scenario) => ({
    scenario,
    targetMembers: [...new Set(targets[scenario])].sort(compareUtf8),
  }));
}

const RUNTIME_SCENARIO_EVAL = String.raw`
import { registerHooks } from "node:module";
import { relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = "/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser";
const rootUrl = pathToFileURL(root + "/").href;
const payload = JSON.parse(Buffer.from(process.env.IHOME_RUNTIME_SCENARIO, "base64url").toString("utf8"));
const resolved = new Set();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolutionContext =
      specifier === "openclaw" || specifier.startsWith("openclaw/")
        ? { ...context, parentURL: "file:///app/openclaw.mjs" }
        : context;
    const result = nextResolve(specifier, resolutionContext);
    if (typeof result?.url === "string" && result.url.startsWith(rootUrl)) {
      const path = relative(root, fileURLToPath(result.url)).replaceAll("\\", "/");
      if (path && path !== ".." && !path.startsWith("../")) resolved.add("package/" + path);
    }
    return result;
  },
});
for (const member of payload.targetMembers) {
  const relativeMember = member.slice("package/".length);
  await import(pathToFileURL(root + "/" + relativeMember).href);
}
const compare = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
process.stdout.write(JSON.stringify({
  schema: 1,
  scenario: payload.scenario,
  traceKind: "instrumented-installed-runtime",
  resolvedMembers: [...resolved].sort(compare),
}) + "\n");
`;

const PRIVATE_RPC_PROBE_EVAL = String.raw`
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const root = "/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolutionContext =
      specifier === "openclaw" || specifier.startsWith("openclaw/")
        ? { ...context, parentURL: "file:///app/openclaw.mjs" }
        : context;
    return nextResolve(specifier, resolutionContext);
  },
});
const loaded = await import(pathToFileURL(root + "/dist/index.js").href);
const entry = loaded.default;
if (!entry || typeof entry.register !== "function") throw new Error("installed plugin register export is missing");
const gatewayMethods = [];
let providerFrameCount = 0;
const noop = () => undefined;
const apiTarget = {
  registrationMode: "full",
  runtime: {},
  config: {},
  logger: { debug: noop, info: noop, warn: noop, error: noop },
  registerChannel: noop,
  registerTool: noop,
  registerGatewayMethod(method, handler, options) {
    gatewayMethods.push({ method, handler, options });
  },
};
const api = new Proxy(apiTarget, {
  get(target, property) {
    if (property in target) return target[property];
    return noop;
  },
});
await entry.register(api);
const privateMethods = gatewayMethods.filter(({ method }) => method === "zalouser.bridge.send");
if (privateMethods.length !== 1) throw new Error("private bridge RPC registration count mismatch");
const registration = privateMethods[0];
let response;
await registration.handler({
  client: {},
  params: {
    context: {},
    frames: [{ kind: "text", text: "probe" }],
  },
  respond(ok, payload, error) {
    response = { ok, payload, error };
  },
});
if (response?.ok !== false || response?.error?.code !== "PRIVATE_RPC_REQUIRED") {
  throw new Error("private bridge RPC did not fail closed without its runtime");
}
process.stdout.write(JSON.stringify({
  schema: 1,
  method: registration.method,
  scope: registration.options?.scope,
  registeredMethodCount: privateMethods.length,
  deniedWithoutRuntime: true,
  errorCode: response.error.code,
  providerFrameCount,
}) + "\n");
`;

export function dockerRuntimeScenarioArguments({ image, scenario }) {
  if (!/^ihome\/[a-z0-9._/-]+:[0-9a-f]{32}$/u.test(image ?? "")) {
    throw new Error("Docker runtime scenario image tag is invalid");
  }
  exactKeys(scenario, ["scenario", "targetMembers"], "runtime scenario");
  if (
    !MANDATORY_RUNTIME_SCENARIOS.includes(scenario.scenario) ||
    !Array.isArray(scenario.targetMembers) ||
    scenario.targetMembers.length === 0 ||
    scenario.targetMembers.some((path) => !/^package\/dist\/[A-Za-z0-9._/-]+\.js$/u.test(path))
  ) {
    throw new Error("runtime scenario is invalid");
  }
  const encoded = Buffer.from(JSON.stringify(scenario), "utf8").toString("base64url");
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "768m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700",
    "--tmpfs",
    "/home/node/.openclaw/state:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700",
    "--env",
    `IHOME_RUNTIME_SCENARIO=${encoded}`,
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    RUNTIME_SCENARIO_EVAL,
  ];
}

export function dockerPrivateRpcProbeArguments({ image }) {
  if (!/^ihome\/[a-z0-9._/-]+:[0-9a-f]{32}$/u.test(image ?? "")) {
    throw new Error("Docker private RPC probe image tag is invalid");
  }
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "768m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700",
    "--tmpfs",
    "/home/node/.openclaw/state:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    PRIVATE_RPC_PROBE_EVAL,
  ];
}

export function validatePrivateRpcProbeResult(processResult) {
  assertProbeProcess(processResult, "private bridge RPC probe", 0);
  if (processResult.stderr.length !== 0) throw new Error("private bridge RPC probe wrote stderr");
  const parsed = parseJsonStrict(processResult.stdout, "private bridge RPC probe");
  exactKeys(
    parsed,
    [
      "schema",
      "method",
      "scope",
      "registeredMethodCount",
      "deniedWithoutRuntime",
      "errorCode",
      "providerFrameCount",
    ],
    "private bridge RPC probe",
  );
  if (
    parsed.schema !== 1 ||
    parsed.method !== "zalouser.bridge.send" ||
    parsed.scope !== "operator.write" ||
    parsed.registeredMethodCount !== 1 ||
    parsed.deniedWithoutRuntime !== true ||
    parsed.errorCode !== "PRIVATE_RPC_REQUIRED" ||
    parsed.providerFrameCount !== 0
  ) {
    throw new Error("private bridge RPC probe result mismatch");
  }
  return {
    method: parsed.method,
    scope: parsed.scope,
    registered_method_count: parsed.registeredMethodCount,
    denied_without_runtime: parsed.deniedWithoutRuntime,
    error_code: parsed.errorCode,
    provider_frame_count: parsed.providerFrameCount,
    stdout_size: processResult.stdout.length,
    stdout_sha256: sha256(processResult.stdout),
  };
}

function validateRuntimeScenarioResults(fork, plan, processResults) {
  const allowlist = exactRuntimeMemberSet(fork);
  if (!Array.isArray(processResults) || processResults.length !== plan.length) {
    throw new Error("mandatory runtime scenario result count mismatch");
  }
  const traces = [];
  const resolvedRuntimeSet = new Set();
  for (let index = 0; index < plan.length; index += 1) {
    const scenario = plan[index];
    const processResult = processResults[index];
    assertProbeProcess(processResult, `runtime scenario ${scenario.scenario}`, 0);
    if (processResult.stderr.length !== 0) {
      throw new Error(`runtime scenario ${scenario.scenario} wrote unexpected stderr`);
    }
    const parsed = parseJsonStrict(processResult.stdout, `runtime scenario ${scenario.scenario}`);
    exactKeys(parsed, ["schema", "scenario", "traceKind", "resolvedMembers"], `runtime scenario ${scenario.scenario}`);
    if (
      parsed.schema !== 1 ||
      parsed.scenario !== scenario.scenario ||
      parsed.traceKind !== "instrumented-installed-runtime" ||
      !Array.isArray(parsed.resolvedMembers) ||
      parsed.resolvedMembers.length === 0
    ) {
      throw new Error(`runtime scenario ${scenario.scenario} trace is invalid`);
    }
    const resolvedMembers = [...parsed.resolvedMembers].sort(compareUtf8);
    if (
      parsed.resolvedMembers.some((path) => typeof path !== "string" || !allowlist.includes(path)) ||
      new Set(resolvedMembers).size !== resolvedMembers.length ||
      JSON.stringify(resolvedMembers) !== JSON.stringify(parsed.resolvedMembers) ||
      scenario.targetMembers.some((target) => !resolvedMembers.includes(target))
    ) {
      throw new Error(`runtime scenario ${scenario.scenario} resolved outside or omitted its finite targets`);
    }
    for (const member of resolvedMembers) resolvedRuntimeSet.add(member);
    traces.push({
      scenario: scenario.scenario,
      trace_kind: parsed.traceKind,
      target_members: scenario.targetMembers,
      resolved_members: resolvedMembers,
      stdout_size: processResult.stdout.length,
      stdout_sha256: sha256(processResult.stdout),
    });
  }
  const aggregate = [...resolvedRuntimeSet].sort(compareUtf8);
  if (aggregate.length === 0 || aggregate.some((path) => !allowlist.includes(path))) {
    throw new Error("aggregate resolved runtime set is empty or outside the allowlist");
  }
  return { traces, resolved_runtime_set: aggregate };
}

export function validateRecordedRuntimeEvidence(fork, recorded) {
  exactKeys(
    recorded,
    [
      "dynamic_site_inventory",
      "derived_runtime_set",
      "runtime_reachability_allowlist",
      "scenario_traces",
      "resolved_runtime_set",
    ],
    "recorded runtime reachability evidence",
  );
  const allowlist = exactRuntimeMemberSet(fork);
  const derived = [...(fork?.derivedRuntimeSet ?? [])].sort(compareUtf8);
  if (
    derived.length === 0 ||
    new Set(derived).size !== derived.length ||
    JSON.stringify(derived) !== JSON.stringify(fork.derivedRuntimeSet) ||
    JSON.stringify(derived) !== JSON.stringify(allowlist)
  ) {
    throw new Error("FORK derived runtime set does not equal the allowlist");
  }
  assertJsonEqual(
    recorded.dynamic_site_inventory,
    fork.runtimeDynamicSiteInventory,
    "recorded dynamic site inventory",
  );
  assertJsonEqual(recorded.derived_runtime_set, derived, "recorded derived runtime set");
  assertJsonEqual(
    recorded.runtime_reachability_allowlist,
    allowlist,
    "recorded runtime reachability allowlist",
  );
  const plan = runtimeScenarioPlan(fork);
  if (!Array.isArray(recorded.scenario_traces) || recorded.scenario_traces.length !== plan.length) {
    throw new Error("recorded mandatory runtime scenario trace count mismatch");
  }
  const aggregate = new Set();
  for (let index = 0; index < plan.length; index += 1) {
    const expected = plan[index];
    const trace = recorded.scenario_traces[index];
    exactKeys(
      trace,
      [
        "scenario",
        "trace_kind",
        "target_members",
        "resolved_members",
        "stdout_size",
        "stdout_sha256",
      ],
      `recorded runtime scenario ${expected.scenario}`,
    );
    if (
      trace.scenario !== expected.scenario ||
      trace.trace_kind !== "instrumented-installed-runtime" ||
      !Number.isInteger(trace.stdout_size) ||
      trace.stdout_size < 1 ||
      !HEX_64.test(trace.stdout_sha256)
    ) {
      throw new Error(`recorded runtime scenario ${expected.scenario} metadata mismatch`);
    }
    assertJsonEqual(trace.target_members, expected.targetMembers, `runtime targets ${expected.scenario}`);
    if (!Array.isArray(trace.resolved_members) || trace.resolved_members.length === 0) {
      throw new Error(`recorded runtime scenario ${expected.scenario} is empty`);
    }
    const sorted = [...trace.resolved_members].sort(compareUtf8);
    if (
      new Set(sorted).size !== sorted.length ||
      JSON.stringify(sorted) !== JSON.stringify(trace.resolved_members) ||
      sorted.some((member) => !allowlist.includes(member)) ||
      expected.targetMembers.some((member) => !sorted.includes(member))
    ) {
      throw new Error(`recorded runtime scenario ${expected.scenario} escaped its allowlist`);
    }
    for (const member of sorted) aggregate.add(member);
  }
  const resolvedRuntimeSet = [...aggregate].sort(compareUtf8);
  if (resolvedRuntimeSet.length === 0) throw new Error("recorded resolved runtime set is empty");
  assertJsonEqual(
    recorded.resolved_runtime_set,
    resolvedRuntimeSet,
    "recorded resolved runtime set",
  );
  return { derived_runtime_set: derived, resolved_runtime_set: resolvedRuntimeSet };
}

function invokeNativeBounded(file, args, { maxBytes = 4 * 1024 * 1024, timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      rejectPromise(error);
    };
    timer = setTimeout(
      () => fail(new Error(`native command timed out: ${file}`)),
      timeoutMs,
    );
    child.once("error", fail);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        fail(new Error(`native command stdout exceeded ${maxBytes} bytes`));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBytes) {
        fail(new Error(`native command stderr exceeded ${maxBytes} bytes`));
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        rejectPromise(new Error(`native command terminated by ${signal}: ${file}`));
        return;
      }
      resolvePromise({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function assertNativeResult(result, label, allowedExitCodes = [0]) {
  if (
    !result ||
    !Number.isInteger(result.exitCode) ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    throw new Error(`${label} returned an invalid native result`);
  }
  if (!allowedExitCodes.includes(result.exitCode)) {
    const stderr = result.stderr.toString("utf8").slice(0, 1024);
    throw new Error(`${label} failed with exit ${result.exitCode}: ${stderr}`);
  }
  return result;
}

export async function probeOpenClawRuntimeImages({
  archivePath,
  baseImage,
  dockerPath,
  dockerSha256,
  expectedDockerVersion,
  manifestDigest,
  nonce,
  fork,
  invoke = invokeNativeBounded,
}) {
  if (!isAbsolute(archivePath)) throw new Error("runtime probe OCI archive path must be absolute");
  if (!isAbsolute(dockerPath)) throw new Error("runtime probe Docker path must be absolute");
  if (baseImage !== BASE_IMAGE) throw new Error("runtime probe base image is not pinned");
  if (!HEX_64.test(dockerSha256 ?? "")) throw new Error("runtime probe Docker SHA-256 is invalid");
  if (expectedDockerVersion !== "29.1.3") throw new Error("runtime probe Docker version is not pinned");
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifestDigest ?? "")) {
    throw new Error("runtime probe manifest digest is invalid");
  }
  if (!/^[0-9a-f]{32}$/u.test(nonce ?? "")) throw new Error("runtime probe nonce is invalid");
  const scenarioPlan = runtimeScenarioPlan(fork);
  for (const [path, label] of [
    [archivePath, "runtime probe OCI archive"],
    [dockerPath, "runtime probe Docker CLI"],
  ]) {
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
  }
  if ((await hashFile(dockerPath)).sha256 !== dockerSha256) {
    throw new Error("runtime probe Docker CLI hash mismatch");
  }

  const call = async (args, label, allowedExitCodes = [0]) =>
    assertNativeResult(await invoke(dockerPath, args), label, allowedExitCodes);
  const version = await call(
    [
      "version",
      "--format",
      "{{.Client.Version}}|{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}",
    ],
    "Docker version probe",
  );
  const expectedVersionLine = `${expectedDockerVersion}|${expectedDockerVersion}|linux|amd64`;
  if (version.stderr.length !== 0 || version.stdout.toString("utf8").trim() !== expectedVersionLine) {
    throw new Error("Docker client/server version or platform mismatch");
  }

  const forkTag = `ihome/openclaw-fork-probe:${nonce}`;
  const stockTag = `ihome/openclaw-stock-probe:${nonce}`;
  for (const tag of [forkTag, stockTag]) {
    const absent = await call(["image", "inspect", tag], "Docker probe tag preflight", [1]);
    if (absent.exitCode !== 1) throw new Error(`Docker probe tag already exists: ${tag}`);
  }

  let forkTagCreated = false;
  let stockTagCreated = false;
  let primaryError;
  let result;
  const cleanupErrors = [];
  try {
    await call(["load", "--input", archivePath], "Docker OCI load");
    await call(["tag", manifestDigest, forkTag], "Docker fork tag");
    forkTagCreated = true;
    await call(["pull", "--platform", "linux/amd64", baseImage], "Docker stock pull");
    await call(["tag", baseImage, stockTag], "Docker stock tag");
    stockTagCreated = true;
    const forkList = await call(
      dockerProbeRunArguments({ image: forkTag, cliArguments: ["plugins", "list", "--json"] }),
      "fork plugin list",
    );
    const forkInspect = await call(
      dockerProbeRunArguments({
        image: forkTag,
        cliArguments: ["plugins", "inspect", "zalouser", "--runtime", "--json"],
      }),
      "fork plugin inspect",
    );
    const stockList = await call(
      dockerProbeRunArguments({ image: stockTag, cliArguments: ["plugins", "list", "--json"] }),
      "stock plugin list",
    );
    const stockInspect = await call(
      dockerProbeRunArguments({
        image: stockTag,
        cliArguments: ["plugins", "inspect", "zalouser", "--runtime", "--json"],
      }),
      "stock plugin inspect",
      [1],
    );
    const privateRpcProbe = await call(
      dockerPrivateRpcProbeArguments({ image: forkTag }),
      "installed private bridge RPC probe",
    );
    const scenarioResults = [];
    for (const scenario of scenarioPlan) {
      scenarioResults.push(
        await call(
          dockerRuntimeScenarioArguments({ image: forkTag, scenario }),
          `installed runtime scenario ${scenario.scenario}`,
        ),
      );
    }
    result = {
      ...validatePluginProbeResults({ forkList, forkInspect, stockList, stockInspect }),
      private_rpc: validatePrivateRpcProbeResult(privateRpcProbe),
      runtime_scenarios: validateRuntimeScenarioResults(fork, scenarioPlan, scenarioResults),
    };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const [tag, created] of [
      [forkTag, forkTagCreated],
      [stockTag, stockTagCreated],
    ]) {
      if (!created) continue;
      try {
        await call(["image", "rm", "--force", tag], `Docker probe cleanup ${tag}`);
        const absent = await call(
          ["image", "inspect", tag],
          `Docker probe cleanup verification ${tag}`,
          [1],
        );
        if (absent.exitCode !== 1) throw new Error(`Docker probe tag remains: ${tag}`);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors.map((value) => new Error(value))],
        "runtime probe and cleanup failed",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors.map((value) => new Error(value)),
      "runtime probe cleanup failed",
    );
  }
  return {
    docker: {
      path: dockerPath,
      sha256: dockerSha256,
      client_version: expectedDockerVersion,
      server_version: expectedDockerVersion,
      server_os: "linux",
      server_arch: "amd64",
    },
    ...result,
  };
}

function assertReviewIdentity(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function reviewEvidenceFromBytes(bytes, expected) {
  if (!expected || !["M", "R"].includes(expected.checkpoint)) {
    throw new Error("expected review checkpoint must be M or R");
  }
  if (!REVIEWED_TREE.test(expected.reviewedSha)) throw new Error("expected reviewed SHA is invalid");
  const report = parseJsonStrict(bytes, `${expected.checkpoint} review report`);
  const keys = [
    "checkpoint",
    "decision",
    "findings",
    "reviewedSha",
    "reviewerIdentity",
    "reviewerRole",
    "reviewerRunId",
    "schema",
  ];
  exactKeys(report, keys, `${expected.checkpoint} review report`);
  if (report.schema !== 1) throw new Error("review report schema must be 1");
  if (report.checkpoint !== expected.checkpoint) throw new Error("review report checkpoint mismatch");
  if (report.reviewedSha !== expected.reviewedSha) throw new Error("review report SHA mismatch");
  if (report.reviewerRole !== "reviewer") throw new Error("review report role must be reviewer");
  if (report.decision !== "APPROVED") throw new Error("review report decision must be APPROVED");
  if (!Array.isArray(report.findings) || report.findings.length !== 0) {
    throw new Error("review report findings must be empty");
  }
  assertReviewIdentity(report.reviewerIdentity, "reviewer identity");
  assertReviewIdentity(report.reviewerRunId, "reviewer run ID");
  const canonicalReport = {
    checkpoint: report.checkpoint,
    decision: report.decision,
    findings: report.findings,
    reviewedSha: report.reviewedSha,
    reviewerIdentity: report.reviewerIdentity,
    reviewerRole: report.reviewerRole,
    reviewerRunId: report.reviewerRunId,
    schema: report.schema,
  };
  const canonical = Buffer.from(`${JSON.stringify(canonicalReport)}\n`, "utf8");
  if (!bytes.equals(canonical)) throw new Error("review report bytes are not canonical");
  return {
    checkpoint: report.checkpoint,
    report_base64: bytes.toString("base64"),
    report_size: bytes.length,
    report_sha256: sha256(bytes),
    reviewed_sha: report.reviewedSha,
    reviewer_role: report.reviewerRole,
    reviewer_identity: report.reviewerIdentity,
    reviewer_run_id: report.reviewerRunId,
    decision: report.decision,
    findings: report.findings,
  };
}

export function validateEmbeddedReviewRecord(record, expected) {
  const keys = [
    "checkpoint",
    "report_base64",
    "report_size",
    "report_sha256",
    "reviewed_sha",
    "reviewer_role",
    "reviewer_identity",
    "reviewer_run_id",
    "decision",
    "findings",
  ];
  exactKeys(record, keys, `${expected.checkpoint} embedded review`);
  if (typeof record.report_base64 !== "string" || record.report_base64.length === 0) {
    throw new Error("embedded review base64 is invalid");
  }
  const bytes = Buffer.from(record.report_base64, "base64");
  if (bytes.toString("base64") !== record.report_base64) {
    throw new Error("embedded review base64 is not canonical");
  }
  const computed = reviewEvidenceFromBytes(bytes, expected);
  for (const key of keys) {
    if (JSON.stringify(record[key]) !== JSON.stringify(computed[key])) {
      throw new Error(`${expected.checkpoint} embedded review ${key} mismatch`);
    }
  }
  return computed;
}

export async function readCanonicalReviewReport(reportPath, expected) {
  if (!isAbsolute(reportPath)) throw new Error("review report path must be absolute");
  const item = await lstat(reportPath);
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error("review report must be a regular non-symlink file");
  }
  return reviewEvidenceFromBytes(await readFile(reportPath), expected);
}

function assertPortablePath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path !== path.normalize("NFC")
  ) {
    throw new Error(`${label} is not a canonical portable relative path`);
  }
}

function contextRecord(role, type, mode, path, digest) {
  return Buffer.from(`${role}\0${type}\0${mode}\0${path}\0${digest}\0`, "utf8");
}

export function computeContextRootV2(lockSha256, inputs) {
  if (!HEX_64.test(lockSha256)) throw new Error("invalid image-lock sha256");
  const sorted = [...inputs].sort((left, right) => compareUtf8(left.path, right.path));
  const preimage = [
    Buffer.from("ihome-openclaw-context-root-v2\0", "utf8"),
    Buffer.from(`count\0${1 + sorted.length}\0`, "utf8"),
    contextRecord("lock", "blob", "100644", "image-lock.json", lockSha256),
  ];
  for (const input of sorted) {
    preimage.push(
      contextRecord("input", input.type, input.mode, input.path, input.sha256),
    );
  }
  return sha256(Buffer.concat(preimage));
}

export function validateImageLock(lock) {
  exactKeys(
    lock,
    [
      "schema_version",
      "algorithm",
      "source_date_epoch",
      "platform",
      "base_image",
      "buildkit_image",
      "buildx",
      "docker",
      "inputs",
    ],
    "image lock",
  );
  if (lock.schema_version !== 2) throw new Error("image lock schema_version must be 2");
  if (lock.algorithm !== "ihome-openclaw-context-root-v2") {
    throw new Error("unsupported image lock algorithm");
  }
  if (lock.source_date_epoch !== "1785062400") throw new Error("wrong source date epoch");
  if (lock.platform !== "linux/amd64") throw new Error("wrong locked platform");
  if (lock.base_image !== BASE_IMAGE) throw new Error("wrong pinned OpenClaw base image");
  if (lock.buildkit_image !== BUILDKIT_IMAGE) throw new Error("wrong pinned BuildKit image");
  exactKeys(
    lock.buildx,
    ["version", "windows_amd64_sha256", "linux_amd64_sha256"],
    "buildx lock",
  );
  if (lock.buildx.version !== "0.13.1") throw new Error("buildx version must be 0.13.1");
  if (lock.buildx.windows_amd64_sha256 !== BUILDX_WINDOWS_SHA256) {
    throw new Error("wrong Windows buildx digest");
  }
  if (lock.buildx.linux_amd64_sha256 !== BUILDX_LINUX_SHA256) {
    throw new Error("wrong Linux buildx digest");
  }
  exactKeys(lock.docker, ["version", "linux_amd64_sha256"], "Docker lock");
  if (lock.docker.version !== "29.1.3") throw new Error("Docker version must be 29.1.3");
  if (lock.docker.linux_amd64_sha256 !== DOCKER_LINUX_SHA256) {
    throw new Error("wrong Linux Docker CLI digest");
  }
  if (!Array.isArray(lock.inputs) || lock.inputs.length === 0) {
    throw new Error("image lock inputs must be a nonempty array");
  }

  const paths = new Set();
  const collisionKeys = new Set();
  let previousPath;
  for (const [index, input] of lock.inputs.entries()) {
    exactKeys(input, ["path", "type", "mode", "size", "sha256"], `input ${index}`);
    assertPortablePath(input.path, `input ${index} path`);
    if (input.path === "image-lock.json") throw new Error("image lock cannot list itself");
    if (input.type !== "blob") throw new Error(`${input.path} type must be blob`);
    if (input.mode !== "100644" && input.mode !== "100755") {
      throw new Error(`${input.path} has unsupported mode`);
    }
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw new Error(`${input.path} has invalid size`);
    }
    if (!HEX_64.test(input.sha256)) throw new Error(`${input.path} has invalid sha256`);
    if (paths.has(input.path)) throw new Error(`duplicate image input: ${input.path}`);
    paths.add(input.path);
    const collisionKey = input.path.toLowerCase();
    if (collisionKeys.has(collisionKey)) throw new Error(`case-colliding image input: ${input.path}`);
    collisionKeys.add(collisionKey);
    if (previousPath !== undefined && compareUtf8(previousPath, input.path) >= 0) {
      throw new Error("image lock inputs must be raw UTF-8 path sorted");
    }
    previousPath = input.path;
  }
  const sessionPaths = lock.inputs
    .filter(({ path }) => path.startsWith("session-crypto/dist/"))
    .map(({ path }) => path);
  if (JSON.stringify(sessionPaths) !== JSON.stringify(SESSION_DIST)) {
    throw new Error("image lock must bind exactly the three session dist files");
  }
  return lock;
}

function containedPath(root, portablePath) {
  const candidate = resolve(root, ...portablePath.split("/"));
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${portablePath} escaped image root`);
  }
  return candidate;
}

export async function verifyImageLock({ root, lockPath }) {
  const absoluteRoot = resolve(root);
  const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("image root must be a real directory");
  }
  const absoluteLock = resolve(lockPath);
  const lockBytes = await readFile(absoluteLock);
  const lock = validateImageLock(JSON.parse(lockBytes.toString("utf8")));

  for (const input of lock.inputs) {
    const absolute = containedPath(absoluteRoot, input.path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${input.path} must be a regular file`);
    }
    const bytes = await readFile(absolute);
    if (bytes.length !== input.size) throw new Error(`${input.path} size mismatch`);
    if (sha256(bytes) !== input.sha256) throw new Error(`${input.path} sha256 mismatch`);
  }

  const lockSha256 = sha256(lockBytes);
  return {
    lock,
    lockSha256,
    contextRootSha256: computeContextRootV2(lockSha256, lock.inputs),
  };
}

function parseTarNumber(bytes, label) {
  const text = bytes.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid tar ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`oversized tar ${label}`);
  return value;
}

function tarPath(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
  return prefix ? `${prefix}/${name}` : name;
}

export function parseRuntimeLayerTar(bytes) {
  const records = [];
  const paths = new Set();
  const collisionKeys = new Set();
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > bytes.length ||
        !bytes.subarray(offset + 512, offset + 1024).every((byte) => byte === 0) ||
        !bytes.subarray(offset + 1024).every((byte) => byte === 0)
      ) {
        throw new Error("runtime layer tar terminator is invalid");
      }
      terminated = true;
      break;
    }
    const storedChecksum = parseTarNumber(header.subarray(148, 156), "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) throw new Error("runtime layer tar checksum mismatch");
    const magic = header.subarray(257, 263).toString("binary");
    if (magic !== "ustar\0" && magic !== "ustar ") {
      throw new Error("runtime layer tar is not ustar");
    }
    const typeCode = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    if (typeCode !== "0" && typeCode !== "5") {
      throw new Error(`unsupported runtime layer tar entry type: ${typeCode}`);
    }
    const rawPath = tarPath(header);
    const path = typeCode === "5" ? rawPath.replace(/\/$/, "") : rawPath;
    assertPortablePath(path, "runtime layer path");
    const collisionKey = path.toLowerCase();
    if (paths.has(path) || collisionKeys.has(collisionKey)) {
      throw new Error(`duplicate or collision runtime layer path: ${path}`);
    }
    paths.add(path);
    collisionKeys.add(collisionKey);
    const size = parseTarNumber(header.subarray(124, 136), "size");
    const modeValue = parseTarNumber(header.subarray(100, 108), "mode") & 0o7777;
    const mtime = parseTarNumber(header.subarray(136, 148), "mtime");
    if (typeCode === "5" && size !== 0) {
      throw new Error(`runtime layer directory has content: ${path}`);
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error("runtime layer tar member is truncated");
    const body = bytes.subarray(dataStart, dataEnd);
    records.push({
      path,
      type: typeCode === "5" ? "directory" : "file",
      mode: modeValue.toString(8).padStart(4, "0"),
      size,
      sha256: sha256(body),
      mtime,
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!terminated) throw new Error("runtime layer tar is missing its terminator");
  return records;
}

async function hashRegion(handle, offset, size, capture = false) {
  const hash = createHash("sha256");
  const chunks = [];
  let remaining = size;
  let position = offset;
  while (remaining > 0) {
    const buffer = Buffer.alloc(Math.min(1024 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw new Error("truncated tar member");
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (capture) chunks.push(chunk);
    remaining -= bytesRead;
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), bytes: capture ? Buffer.concat(chunks) : undefined };
}

async function inspectOciArchive(path) {
  const handle = await open(path, "r");
  try {
    const fileInfo = await handle.stat();
    const entries = new Map();
    const collisionKeys = new Set();
    let offset = 0;
    while (offset + 512 <= fileInfo.size) {
      const header = Buffer.alloc(512);
      const { bytesRead } = await handle.read(header, 0, 512, offset);
      if (bytesRead !== 512) throw new Error("truncated tar header");
      if (header.every((byte) => byte === 0)) break;
      const pathName = tarPath(header);
      assertPortablePath(pathName.replace(/\/$/, ""), "OCI archive path");
      const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
      const size = parseTarNumber(header.subarray(124, 136), "size");
      const dataOffset = offset + 512;
      if (entries.has(pathName)) throw new Error(`duplicate OCI archive path: ${pathName}`);
      const collisionKey = pathName.toLowerCase();
      if (collisionKeys.has(collisionKey)) throw new Error(`case-colliding OCI path: ${pathName}`);
      collisionKeys.add(collisionKey);
      if (type === "0") {
        const capture = pathName === "index.json" || pathName === "oci-layout";
        const hashed = await hashRegion(handle, dataOffset, size, capture);
        entries.set(pathName, { path: pathName, size, offset: dataOffset, ...hashed });
      } else if (type !== "5") {
        throw new Error(`unsupported OCI tar entry type ${type}: ${pathName}`);
      }
      offset = dataOffset + Math.ceil(size / 512) * 512;
    }

    const layoutEntry = entries.get("oci-layout");
    const indexEntry = entries.get("index.json");
    if (!layoutEntry?.bytes || !indexEntry?.bytes) throw new Error("OCI layout files are missing");
    const layout = JSON.parse(layoutEntry.bytes.toString("utf8"));
    if (layout.imageLayoutVersion !== "1.0.0") throw new Error("unsupported OCI layout version");
    const index = JSON.parse(indexEntry.bytes.toString("utf8"));
    if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
      throw new Error("OCI index must contain exactly one manifest");
    }
    const manifestDescriptor = index.manifests[0];
    const manifestHex = String(manifestDescriptor.digest ?? "").replace(/^sha256:/, "");
    if (!HEX_64.test(manifestHex)) throw new Error("invalid OCI manifest digest");
    const manifestEntry = entries.get(`blobs/sha256/${manifestHex}`);
    if (!manifestEntry || manifestEntry.sha256 !== manifestHex) {
      throw new Error("OCI manifest blob mismatch");
    }
    const manifestBytes = (await hashRegion(handle, manifestEntry.offset, manifestEntry.size, true)).bytes;
    const manifest = parseJsonStrict(manifestBytes, "OCI manifest");
    const descriptors = [manifest.config, ...(manifest.layers ?? [])];
    for (const descriptor of descriptors) {
      const digest = String(descriptor?.digest ?? "").replace(/^sha256:/, "");
      const entry = entries.get(`blobs/sha256/${digest}`);
      if (!HEX_64.test(digest) || !entry || entry.sha256 !== digest || entry.size !== descriptor.size) {
        throw new Error(`OCI descriptor mismatch: ${descriptor?.digest ?? "missing"}`);
      }
    }
    const configHex = String(manifest.config.digest).replace(/^sha256:/, "");
    const configEntry = entries.get(`blobs/sha256/${configHex}`);
    const configBytes = (
      await hashRegion(handle, configEntry.offset, configEntry.size, true)
    ).bytes;
    const config = parseJsonStrict(configBytes, "OCI image config");
    const archiveEntryManifest = [...entries.values()]
      .map(({ path: entryPath, size, sha256: digest }) => ({
        path: entryPath,
        size,
        sha256: digest,
      }))
      .sort((left, right) => compareUtf8(left.path, right.path));
    const records = archiveEntryManifest.map(
      ({ path: entryPath, size, sha256: digest }) => `${entryPath}\0${size}\0${digest}\0`,
    );
    const result = {
      index_sha256: indexEntry.sha256,
      manifest_digest: `sha256:${manifestHex}`,
      config_digest: manifest.config.digest,
      layer_digests: manifest.layers.map(({ digest }) => digest),
      blob_manifest_sha256: sha256(Buffer.from(records.join(""), "utf8")),
      archive_entry_count: archiveEntryManifest.length,
      archive_entries: archiveEntryManifest,
    };
    Object.defineProperties(result, {
      manifest: { value: manifest, enumerable: false },
      config: { value: config, enumerable: false },
      archiveEntries: { value: entries, enumerable: false },
    });
    return result;
  } finally {
    await handle.close();
  }
}

export async function verifyOciRuntimeImage({ archivePath, fork, lock }) {
  if (lock?.base_image !== BASE_IMAGE) throw new Error("wrong pinned base image");
  if (!fork?.installedTree || !Array.isArray(fork.installedTree.entries)) {
    throw new Error("FORK installed tree is missing");
  }
  const inspected = await inspectOciArchive(archivePath);
  const layerDigests = inspected.manifest.layers.map(({ digest }) => digest);
  if (
    layerDigests.length <= BASE_AMD64_LAYER_DIGESTS.length ||
    BASE_AMD64_LAYER_DIGESTS.some((digest, index) => layerDigests[index] !== digest)
  ) {
    throw new Error("OCI image does not preserve the pinned base layer prefix");
  }
  if (
    inspected.config?.architecture !== "amd64" ||
    inspected.config?.os !== "linux" ||
    inspected.config?.rootfs?.type !== "layers" ||
    !Array.isArray(inspected.config?.rootfs?.diff_ids) ||
    inspected.config.rootfs.diff_ids.length !== layerDigests.length
  ) {
    throw new Error("OCI image config platform/rootfs is invalid");
  }
  if (
    BASE_AMD64_DIFF_IDS.some(
      (digest, index) => inspected.config.rootfs.diff_ids[index] !== digest,
    )
  ) {
    throw new Error("OCI image does not preserve the pinned base diff-ID prefix");
  }
  const deltaLayers = inspected.manifest.layers.slice(BASE_AMD64_LAYER_DIGESTS.length);
  if (deltaLayers.length !== 5) {
    throw new Error("OCI image must contain exactly five reviewed runtime delta layers");
  }
  const finalRecords = new Map();
  const layerEvidence = [];
  const handle = await open(archivePath, "r");
  try {
    for (let offset = 0; offset < deltaLayers.length; offset += 1) {
      const descriptor = deltaLayers[offset];
      if (descriptor.mediaType !== "application/vnd.oci.image.layer.v1.tar+gzip") {
        throw new Error("runtime delta layer must use OCI gzip media type");
      }
      if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > 32 * 1024 * 1024) {
        throw new Error("runtime delta layer compressed size is invalid");
      }
      const digest = String(descriptor.digest ?? "").replace(/^sha256:/, "");
      const archiveEntry = inspected.archiveEntries.get(`blobs/sha256/${digest}`);
      if (!archiveEntry) throw new Error("runtime delta layer blob is missing");
      const compressed = (
        await hashRegion(handle, archiveEntry.offset, archiveEntry.size, true)
      ).bytes;
      let tar;
      try {
        tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
      } catch (error) {
        throw new Error(`runtime delta layer gzip is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      const diffId = `sha256:${sha256(tar)}`;
      const expectedDiffId = inspected.config.rootfs.diff_ids[
        BASE_AMD64_DIFF_IDS.length + offset
      ];
      if (diffId !== expectedDiffId) throw new Error("runtime delta layer diff-ID mismatch");
      const records = parseRuntimeLayerTar(tar);
      for (const record of records) {
        const previous = finalRecords.get(record.path);
        if (previous && (record.type !== "directory" || previous.type !== "directory")) {
          throw new Error(`runtime delta file is overwritten across layers: ${record.path}`);
        }
        finalRecords.set(record.path, record);
      }
      layerEvidence.push({
        digest: descriptor.digest,
        diff_id: diffId,
        record_count: records.length,
        records_sha256: sha256(
          Buffer.from(
            records
              .map(
                ({ path, type, mode, size, sha256: digestValue, mtime }) =>
                  `${path}\0${type}\0${mode}\0${size}\0${digestValue}\0${mtime}\0`,
              )
              .join(""),
            "utf8",
          ),
        ),
      });
    }
  } finally {
    await handle.close();
  }
  const runtimeDelta = verifyRuntimeDeltaRecords({
    fork,
    lock,
    records: [...finalRecords.values()],
  });
  const result = {
    ...inspected,
    rootfs: {
      architecture: inspected.config.architecture,
      os: inspected.config.os,
      base_layer_count: BASE_AMD64_LAYER_DIGESTS.length,
      delta_layer_count: deltaLayers.length,
      diff_ids: inspected.config.rootfs.diff_ids,
      layers: layerEvidence,
      ...runtimeDelta,
    },
  };
  Object.defineProperties(result, {
    manifest: { value: inspected.manifest, enumerable: false },
    config: { value: inspected.config, enumerable: false },
    archiveEntries: { value: inspected.archiveEntries, enumerable: false },
  });
  return result;
}

export function verifyRuntimeDeltaRecords({ fork, lock, records }) {
  if (!fork?.installedTree || !Array.isArray(fork.installedTree.entries)) {
    throw new Error("installed fork manifest is missing");
  }
  if (!Array.isArray(records)) throw new Error("runtime delta records must be an array");
  const epoch = Number(lock?.source_date_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("runtime delta epoch is invalid");
  const forkRoot = "home/node/.openclaw/npm/projects/zalouser";
  const sessionRoot = "opt/openclaw-cell/session-crypto/dist";
  const configPath = "opt/openclaw-cell/openclaw.json.tmpl";
  const expected = new Map();
  for (const entry of fork.installedTree.entries) {
    expected.set(`${forkRoot}/${entry.path}`, { ...entry, mtime: epoch });
  }
  const sessionInputs = lock.inputs.filter(({ path }) => SESSION_DIST.includes(path));
  if (sessionInputs.length !== SESSION_DIST.length) {
    throw new Error("session input closure is missing");
  }
  for (const input of sessionInputs) {
    expected.set(`opt/openclaw-cell/${input.path}`, {
      path: input.path,
      type: "file",
      mode: input.mode === "100755" ? "0755" : "0644",
      size: input.size,
      sha256: input.sha256,
      mtime: epoch,
    });
  }
  const configInput = lock.inputs.find(({ path }) => path === "config/openclaw.json.tmpl");
  if (!configInput) throw new Error("runtime config input is missing");
  expected.set(configPath, {
    path: configInput.path,
    type: "file",
    mode: configInput.mode === "100755" ? "0755" : "0644",
    size: configInput.size,
    sha256: configInput.sha256,
    mtime: epoch,
  });

  const allowedAncestors = new Set([
    "home",
    "home/node",
    "home/node/.openclaw",
    "home/node/.openclaw/npm",
    "home/node/.openclaw/npm/projects",
    forkRoot,
    "opt",
    "opt/openclaw-cell",
    "opt/openclaw-cell/session-crypto",
    sessionRoot,
  ]);
  const actual = new Map();
  const collisionKeys = new Set();
  for (const record of records) {
    assertPortablePath(record?.path, "runtime delta path");
    const collisionKey = record.path.toLowerCase();
    if (actual.has(record.path) || collisionKeys.has(collisionKey)) {
      throw new Error(`duplicate or shadow runtime delta path: ${record.path}`);
    }
    collisionKeys.add(collisionKey);
    if (!expected.has(record.path) && !allowedAncestors.has(record.path)) {
      throw new Error(`unexpected runtime delta path: ${record.path}`);
    }
    if (allowedAncestors.has(record.path) && !expected.has(record.path)) {
      if (record.type !== "directory") {
        throw new Error(`runtime delta ancestor is not a directory: ${record.path}`);
      }
    }
    actual.set(record.path, record);
  }

  for (const [path, wanted] of expected) {
    const found = actual.get(path);
    const label = path.startsWith(`${forkRoot}/`)
      ? "installed fork"
      : path.startsWith(`${sessionRoot}/`)
        ? "session"
        : "runtime config";
    if (
      !found ||
      found.type !== wanted.type ||
      found.mode !== wanted.mode ||
      found.size !== wanted.size ||
      found.sha256 !== wanted.sha256 ||
      found.mtime !== epoch
    ) {
      throw new Error(`${label} rootfs mismatch: ${path}`);
    }
  }
  const exactRecords = [...actual.values()].sort((left, right) => compareUtf8(left.path, right.path));
  const forkRecords = fork.installedTree.entries.map((entry) => actual.get(`${forkRoot}/${entry.path}`));
  const sessionRecords = SESSION_DIST.map((path) => actual.get(`opt/openclaw-cell/${path}`));
  const configRecord = actual.get(configPath);
  return {
    config_path: configPath,
    fork_root: forkRoot,
    record_count: exactRecords.length,
    session_paths: SESSION_DIST.map((path) => `opt/openclaw-cell/${path}`),
    records: exactRecords,
    records_sha256: sha256(
      Buffer.from(
        exactRecords
          .map(
            ({ path, type, mode, size, sha256: digest, mtime }) =>
              `${path}\0${type}\0${mode}\0${size}\0${digest}\0${mtime}\0`,
          )
          .join(""),
        "utf8",
      ),
    ),
    fork_records: forkRecords,
    session_records: sessionRecords,
    config_record: configRecord,
  };
}

async function hashFile(path) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    return { size: info.size, ...(await hashRegion(handle, 0, info.size)) };
  } finally {
    await handle.close();
  }
}

async function compareFiles(leftPath, rightPath) {
  const left = await hashFile(leftPath);
  const right = await hashFile(rightPath);
  if (left.size !== right.size || left.sha256 !== right.sha256) {
    throw new Error("OCI archives are not byte-identical");
  }
  return left;
}

function validateSchemaValue(value, schema, path = "$", rootSchema = schema) {
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/$defs/")) throw new Error(`${path} has unsupported schema ref`);
    const definition = rootSchema.$defs?.[schema.$ref.slice("#/$defs/".length)];
    if (!definition) throw new Error(`${path} references a missing schema definition`);
    validateSchemaValue(value, definition, path, rootSchema);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${path} does not match const`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} is outside enum`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) throw new Error(`${path}.${required} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          throw new Error(`${path}.${key} is not allowed`);
        }
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateSchemaValue(value[key], childSchema, `${path}.${key}`, rootSchema);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} has too few items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${path} must contain at most ${schema.maxItems} items`);
    }
    for (const [index, item] of value.entries()) {
      validateSchemaValue(item, schema.items, `${path}[${index}]`, rootSchema);
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path} does not match pattern`);
    }
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
}

export function validateJsonSchema(value, schema) {
  validateSchemaValue(value, schema, "$", schema);
  return value;
}

async function writeAtomically(path, bytes) {
  if (!isAbsolute(path)) throw new Error(`output path must be absolute: ${path}`);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== resolve(parent)) throw new Error("output parent must not traverse a link");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function promoteFile(source, destination) {
  if (!isAbsolute(destination)) throw new Error("release artifact path must be absolute");
  const sourceHash = await hashFile(source);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await copyFile(source, temporary);
    const copiedHash = await hashFile(temporary);
    if (copiedHash.size !== sourceHash.size || copiedHash.sha256 !== sourceHash.sha256) {
      throw new Error("promoted OCI archive copy mismatch");
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return sourceHash;
}

export async function publishVerifiedRelease({
  archivePath,
  evidence,
  evidencePath,
  releaseArtifactPath,
  schema,
  promote = promoteFile,
}) {
  validateJsonSchema(evidence, schema);
  if (!isAbsolute(archivePath)) throw new Error("candidate OCI archive path must be absolute");
  if (!isAbsolute(evidencePath)) throw new Error("evidence path must be absolute");
  if (!isAbsolute(releaseArtifactPath)) throw new Error("release artifact path must be absolute");
  const archive = await hashFile(archivePath);
  if (
    evidence?.oci?.promoted_archive_path !== releaseArtifactPath ||
    evidence?.oci?.promoted_archive_sha256 !== archive.sha256
  ) {
    throw new Error("evidence does not bind the candidate release archive");
  }
  const promoted = await promote(archivePath, releaseArtifactPath);
  if (promoted.size !== archive.size || promoted.sha256 !== archive.sha256) {
    throw new Error("promoted archive hash mismatch");
  }
  await writeAtomically(evidencePath, Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8"));
  return { evidence, promoted };
}

async function assertPathHasNoSymbolicLink(absolutePath, label) {
  const chain = [];
  let cursor = resolve(absolutePath);
  while (true) {
    chain.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of chain.reverse()) {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new Error(`${label} must not traverse links`);
    }
  }
}

export async function verifyReviewedExportBinding({
  manifestPath,
  manifestSha256,
  reviewedTree,
  sourceRoot,
}) {
  if (!REVIEWED_TREE.test(reviewedTree)) throw new Error("reviewed export tree is invalid");
  if (!HEX_64.test(manifestSha256)) throw new Error("reviewed export manifest SHA-256 is invalid");
  if (!isAbsolute(sourceRoot) || !isAbsolute(manifestPath)) {
    throw new Error("reviewed export source and manifest paths must be absolute");
  }
  const sourceItem = await lstat(sourceRoot);
  const manifestItem = await lstat(manifestPath);
  if (!sourceItem.isDirectory() || sourceItem.isSymbolicLink()) {
    throw new Error("reviewed export source root must be a real directory");
  }
  if (!manifestItem.isFile() || manifestItem.isSymbolicLink()) {
    throw new Error("reviewed export manifest must be a regular non-symlink file");
  }
  await assertPathHasNoSymbolicLink(sourceRoot, "reviewed export source root");
  await assertPathHasNoSymbolicLink(manifestPath, "reviewed export manifest");
  const canonicalSourceRoot = await realpath(sourceRoot);
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== manifestSha256) {
    throw new Error("reviewed export manifest SHA-256 mismatch");
  }
  const manifest = parseJsonStrict(manifestBytes, "reviewed export manifest");
  const canonical = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (!manifestBytes.equals(canonical)) throw new Error("reviewed export manifest bytes are not canonical");
  exactKeys(
    manifest,
    ["schema_version", "git_object_format", "reviewed_tree", "entries"],
    "reviewed export manifest",
  );
  if (
    manifest.schema_version !== 1 ||
    manifest.git_object_format !== "sha1" ||
    manifest.reviewed_tree !== reviewedTree ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0
  ) {
    throw new Error("reviewed export manifest identity mismatch");
  }
  const paths = new Set();
  const foldedPaths = new Set();
  let previousPath = null;
  for (const entry of manifest.entries) {
    exactKeys(
      entry,
      [
        "path",
        "type",
        "mode",
        "git_object_id",
        "git_object_size",
        "content_size",
        "content_sha256",
      ],
      "reviewed export manifest entry",
    );
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path !== entry.path.normalize("NFC") ||
      entry.path.includes("\\") ||
      entry.path.startsWith("/") ||
      entry.path.endsWith("/") ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      !REVIEWED_TREE.test(entry.git_object_id) ||
      !Number.isSafeInteger(entry.git_object_size) ||
      entry.git_object_size < 0 ||
      !Number.isSafeInteger(entry.content_size) ||
      entry.content_size < 0 ||
      !HEX_64.test(entry.content_sha256)
    ) {
      throw new Error("reviewed export manifest entry is invalid");
    }
    if (previousPath !== null && compareUtf8(previousPath, entry.path) >= 0) {
      throw new Error("reviewed export manifest entries are not uniquely UTF-8 sorted");
    }
    previousPath = entry.path;
    const folded = entry.path.toLowerCase();
    if (paths.has(entry.path) || foldedPaths.has(folded)) {
      throw new Error(`reviewed export manifest path collision: ${entry.path}`);
    }
    paths.add(entry.path);
    foldedPaths.add(folded);
    const absolute = resolve(sourceRoot, ...entry.path.split("/"));
    const relativePath = relative(sourceRoot, absolute);
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`reviewed export entry escaped its source root: ${entry.path}`);
    }
    const item = await lstat(absolute);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`reviewed export entry is not a regular file: ${entry.path}`);
    }
    const canonicalEntry = await realpath(absolute);
    const expectedCanonicalEntry = resolve(canonicalSourceRoot, ...entry.path.split("/"));
    const comparableCanonicalEntry = process.platform === "win32" ? canonicalEntry.toLowerCase() : canonicalEntry;
    const comparableExpectedEntry =
      process.platform === "win32" ? expectedCanonicalEntry.toLowerCase() : expectedCanonicalEntry;
    if (comparableCanonicalEntry !== comparableExpectedEntry) {
      throw new Error(`reviewed export entry must not traverse links: ${entry.path}`);
    }
    const bytes = await readFile(absolute);
    const objectId = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
      .update(bytes)
      .digest("hex");
    if (
      bytes.length !== entry.git_object_size ||
      bytes.length !== entry.content_size ||
      sha256(bytes) !== entry.content_sha256 ||
      objectId !== entry.git_object_id
    ) {
      throw new Error(`reviewed export size, SHA-256, or Git object mismatch: ${entry.path}`);
    }
    if (process.platform !== "win32") {
      const executable = (item.mode & 0o111) !== 0;
      if (executable !== (entry.mode === "100755")) {
        throw new Error(`reviewed export mode mismatch: ${entry.path}`);
      }
    }
  }
  return {
    manifest_path: resolve(manifestPath),
    manifest_sha256: manifestSha256,
    manifest_size: manifestBytes.length,
    reviewed_tree: reviewedTree,
    entry_count: manifest.entries.length,
    entries_sha256: sha256(Buffer.from(JSON.stringify(manifest.entries), "utf8")),
  };
}

export function validateRecordedReviewedExport(recorded, reviewedTree) {
  if (!REVIEWED_TREE.test(reviewedTree)) throw new Error("reviewed export tree is invalid");
  exactKeys(
    recorded,
    [
      "manifest_path",
      "manifest_sha256",
      "manifest_size",
      "reviewed_tree",
      "entry_count",
      "entries_sha256",
    ],
    "recorded reviewed export",
  );
  if (
    !isAbsolute(recorded.manifest_path) ||
    !HEX_64.test(recorded.manifest_sha256) ||
    !Number.isSafeInteger(recorded.manifest_size) ||
    recorded.manifest_size < 1 ||
    recorded.reviewed_tree !== reviewedTree ||
    !Number.isSafeInteger(recorded.entry_count) ||
    recorded.entry_count < 1 ||
    !HEX_64.test(recorded.entries_sha256)
  ) {
    throw new Error("recorded reviewed export is not bound to the reviewed tree");
  }
  return recorded;
}

function gitBlobObjectId(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

async function committedFileRecord(sourceRoot, repositoryPath) {
  const bytes = await readFile(resolve(sourceRoot, ...repositoryPath.split("/")));
  return {
    path: repositoryPath,
    mode: "100644",
    git_object_id: gitBlobObjectId(bytes),
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

function canonicalValueSha256(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

export async function collectSupplyChainMetadata({
  sourceRoot,
  mReviewedTree,
  reviewedExport,
}) {
  if (!isAbsolute(sourceRoot)) throw new Error("supply-chain source root must be absolute");
  if (!REVIEWED_TREE.test(mReviewedTree)) throw new Error("supply-chain M reviewed tree is invalid");
  if (reviewedExport !== undefined) validateRecordedReviewedExport(reviewedExport, reviewedExport.reviewed_tree);
  const vendorRelative = "services/openclaw-zalo-cell/vendor/zalouser-bridge";
  const vendorRoot = resolve(sourceRoot, ...vendorRelative.split("/"));
  const committed = await verifyCommittedInputs({
    repoRoot: sourceRoot,
    vendorRoot,
    ...(reviewedExport
      ? {
          reviewedExportManifestPath: reviewedExport.manifest_path,
          reviewedExportManifestSha256: reviewedExport.manifest_sha256,
          reviewedTree: reviewedExport.reviewed_tree,
        }
      : {}),
  });
  const upstream = committed.upstream;
  const upstreamPath = `${vendorRelative}/UPSTREAM.json`;
  const upstreamRecord = await committedFileRecord(sourceRoot, upstreamPath);
  if (
    upstreamRecord.git_object_id !== committed.upstreamBlobOid ||
    upstreamRecord.sha256 !== committed.upstreamSha256
  ) {
    throw new Error("supply-chain UPSTREAM.json Git binding mismatch");
  }
  const provenanceInputs = [];
  for (const input of upstream.provenanceInputs) {
    const repositoryPath = `${vendorRelative}/${input.path}`;
    const record = await committedFileRecord(sourceRoot, repositoryPath);
    if (record.size !== input.size || record.sha256 !== input.sha256) {
      throw new Error(`supply-chain provenance input mismatch: ${input.path}`);
    }
    provenanceInputs.push({
      ...record,
      endpoint: input.endpoint,
      cap: input.cap,
    });
  }

  const forkPath = `${vendorRelative}/FORK.json`;
  const forkBytes = await readFile(resolve(sourceRoot, ...forkPath.split("/")));
  const fork = parseJsonStrict(forkBytes, "FORK.json");
  const artifactPath = `${vendorRelative}/${fork.artifactPath}`;
  const artifactRecord = await committedFileRecord(sourceRoot, artifactPath);
  if (
    artifactRecord.sha256 !== fork.artifactSha256 ||
    artifactRecord.sha256 !== fork.builtTgzSha256
  ) {
    throw new Error("supply-chain fork artifact hash mismatch");
  }
  const licensePath = `${vendorRelative}/${upstream.licenseManifestPath}`;
  const licenseRecord = await committedFileRecord(sourceRoot, licensePath);
  if (licenseRecord.sha256 !== upstream.licenseManifestSha256) {
    throw new Error("supply-chain license manifest hash mismatch");
  }
  const npmSpkiSha256 = sha256(Buffer.from(upstream.npmSignature.spki, "base64"));

  return {
    m_reviewed_tree: mReviewedTree,
    committed_inputs: {
      input_count: committed.inputCount,
      source_blob_count: committed.sourceBlobCount,
      aggregate_sha256: committed.aggregateSha256,
      upstream_json: upstreamRecord,
      provenance_inputs: provenanceInputs,
    },
    upstream: {
      package: upstream.package,
      version: upstream.version,
      source_commit: upstream.sourceCommit,
      tarball: {
        url: upstream.tarball.url,
        size: upstream.tarball.lock.size,
        sha1: upstream.tarball.lock.sha1,
        sha256: upstream.tarball.lock.sha256,
        sha512: upstream.tarball.lock.sha512,
        sri: upstream.tarball.lock.sri,
        regular_file_count: upstream.tarball.counts.regularFiles,
        package_owned_file_count: upstream.tarball.counts.packageOwnedFiles,
        bundled_file_count: upstream.tarball.counts.bundledFiles,
        dependency_package_root_count: upstream.tarball.counts.dependencyPackageRoots,
      },
      attestation_subject: upstream.attestation.subject,
      attestation_subject_sha512: upstream.attestation.subjectSha512,
      npm_key_id: upstream.npmSignature.keyId,
      npm_algorithm: upstream.npmSignature.algorithm,
      npm_spki_sha256: npmSpkiSha256,
      slsa: {
        uri_san: upstream.slsa.uriSan,
        oidc_issuer: upstream.slsa.oidcIssuer,
        workflow_event: upstream.slsa.workflowEvent,
        repository: upstream.slsa.repository,
        ref: upstream.slsa.ref,
        environment: upstream.slsa.environment,
        build_type: upstream.slsa.buildType,
        resolved_commit: upstream.slsa.resolvedCommit,
        leaf_certificate_sha256: upstream.slsa.leafCertificateSha256,
        fulcio_root_der_sha256: upstream.slsa.fulcioRootDerSha256,
        fulcio_intermediate_der_sha256: upstream.slsa.fulcioIntermediateDerSha256,
        rekor_key_id_base64: upstream.slsa.rekorKeyIdBase64,
        rekor_spki_sha256: upstream.slsa.rekorSpkiSha256,
      },
      oci: {
        index_digest: upstream.openclawOci.indexDigest,
        linux_amd64_digest: upstream.openclawOci.linuxAmd64Digest,
        linux_arm64_reference_digest: upstream.openclawOci.linuxArm64ReferenceDigest,
      },
      source_manifest_count: upstream.sourceManifest.length,
      source_manifest_sha256: canonicalValueSha256(upstream.sourceManifest),
      root_compliance_count: upstream.rootCompliance.length,
      root_compliance_sha256: canonicalValueSha256(upstream.rootCompliance),
      license_manifest: licenseRecord,
      license_package_root_count: upstream.licensePackageRootCount,
      license_carrier_count: upstream.licenseCarrierCount,
    },
    fork: {
      package: fork.package.name,
      version: fork.package.version,
      plugin_id: fork.plugin.id,
      channels: fork.plugin.channels,
      manifest: {
        path: forkPath,
        mode: "100644",
        git_object_id: gitBlobObjectId(forkBytes),
        size: forkBytes.length,
        sha256: sha256(forkBytes),
      },
      artifact_path: artifactRecord.path,
      artifact_size: artifactRecord.size,
      artifact_sha256: artifactRecord.sha256,
      artifact_member_count: fork.artifactMembers.length,
      artifact_members_sha256: fork.artifactMembersSha256,
      patch_count: fork.patches.length,
      patch_series_sha256: fork.patchSeriesSha256,
      bridge_overlay_count: fork.bridgeOverlay.members.length,
      bridge_overlay_sha256: fork.bridgeOverlay.sha256,
      license_manifest_sha256: fork.licenseManifestSha256,
      installed_tree_file_count: fork.installedTree.fileCount,
      installed_tree_directory_count: fork.installedTree.directoryCount,
      installed_tree_root_sha256: fork.installedTree.rootSha256,
    },
  };
}

export async function collectQualifyingSupplyChainEvidence({
  sourceRoot,
  mReviewedTree,
  reviewedExport,
}) {
  const metadata = await collectSupplyChainMetadata({ sourceRoot, mReviewedTree, reviewedExport });
  const vendorRoot = resolve(
    sourceRoot,
    "services/openclaw-zalo-cell/vendor/zalouser-bridge",
  );
  const verifiedTarballPath = resolve(vendorRoot, ".work/verified-upstream.tgz");
  const item = await lstat(verifiedTarballPath);
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error("qualifying verified upstream tarball must be a regular non-symlink file");
  }
  const tarballBytes = await readFile(verifiedTarballPath);
  if (
    tarballBytes.length !== metadata.upstream.tarball.size ||
    sha256(tarballBytes) !== metadata.upstream.tarball.sha256
  ) {
    throw new Error("qualifying verified upstream tarball hash mismatch");
  }
  const upstream = parseJsonStrict(await readFile(resolve(vendorRoot, "UPSTREAM.json")), "UPSTREAM.json");
  const sigstore = verifySigstoreAttestations({
    vendorRoot,
    upstream,
    tarballBytes,
  });
  if (sigstore.npm !== "verified" || sigstore.slsa !== "verified" || sigstore.rekorEntries !== 2) {
    throw new Error("qualifying Sigstore verification result mismatch");
  }
  return {
    ...metadata,
    proof: {
      npm_signature: sigstore.npm,
      slsa: sigstore.slsa,
      rekor_entries: sigstore.rekorEntries,
      dsse_pae_verified: true,
      set_verified: true,
      inclusion_proof_verified: true,
      checkpoint_verified: true,
      certificate_chain_verified: true,
      body_binding_verified: true,
      verified_tarball_sha256: sha256(tarballBytes),
    },
  };
}

export async function validateRecordedSupplyChainEvidence(
  recorded,
  { sourceRoot, mReviewedTree },
) {
  exactKeys(recorded, ["m_reviewed_tree", "committed_inputs", "upstream", "fork", "proof"], "supply-chain evidence");
  const expected = await collectSupplyChainMetadata({ sourceRoot, mReviewedTree });
  assertJsonEqual(
    {
      m_reviewed_tree: recorded.m_reviewed_tree,
      committed_inputs: recorded.committed_inputs,
      upstream: recorded.upstream,
      fork: recorded.fork,
    },
    expected,
    "supply-chain metadata",
  );
  exactKeys(
    recorded.proof,
    [
      "npm_signature",
      "slsa",
      "rekor_entries",
      "dsse_pae_verified",
      "set_verified",
      "inclusion_proof_verified",
      "checkpoint_verified",
      "certificate_chain_verified",
      "body_binding_verified",
      "verified_tarball_sha256",
    ],
    "supply-chain proof",
  );
  if (
    recorded.proof.npm_signature !== "verified" ||
    recorded.proof.slsa !== "verified" ||
    recorded.proof.rekor_entries !== 2 ||
    recorded.proof.dsse_pae_verified !== true ||
    recorded.proof.set_verified !== true ||
    recorded.proof.inclusion_proof_verified !== true ||
    recorded.proof.checkpoint_verified !== true ||
    recorded.proof.certificate_chain_verified !== true ||
    recorded.proof.body_binding_verified !== true ||
    recorded.proof.verified_tarball_sha256 !== expected.upstream.tarball.sha256
  ) {
    throw new Error("supply-chain proof is incomplete or mismatched");
  }
  return recorded;
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

export async function verifyEvidenceFile({
  root,
  lockPath,
  evidencePath,
  schemaPath,
  reviewedTree,
  releaseArtifactPath,
}) {
  if (!REVIEWED_TREE.test(reviewedTree)) throw new Error("invalid reviewed tree");
  if (!isAbsolute(releaseArtifactPath)) throw new Error("release artifact path must be absolute");
  const evidenceItem = await lstat(evidencePath);
  const schemaItem = await lstat(schemaPath);
  const archiveItem = await lstat(releaseArtifactPath);
  for (const [item, label] of [
    [evidenceItem, "evidence"],
    [schemaItem, "evidence schema"],
    [archiveItem, "release artifact"],
  ]) {
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
  }

  const evidenceBytes = await readFile(evidencePath);
  const evidence = parseJsonStrict(evidenceBytes, "build evidence");
  const canonicalEvidence = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (!evidenceBytes.equals(canonicalEvidence)) throw new Error("build evidence bytes are not canonical");
  const schema = parseJsonStrict(await readFile(schemaPath), "build evidence schema");
  validateJsonSchema(evidence, schema);
  if (evidence.reviewed_tree !== reviewedTree) throw new Error("build evidence reviewed tree mismatch");
  exactKeys(evidence.reviews, ["M", "R"], "build evidence reviews");
  validateEmbeddedReviewRecord(evidence.reviews.M, {
    checkpoint: "M",
    reviewedSha: evidence.reviews.M.reviewed_sha,
  });
  validateEmbeddedReviewRecord(evidence.reviews.R, {
    checkpoint: "R",
    reviewedSha: reviewedTree,
  });
  if (evidence.reviews.M.reviewed_sha === reviewedTree) {
    throw new Error("embedded M and R reviewed SHAs must be distinct");
  }
  validateRecordedReviewedExport(evidence.reviewed_export, reviewedTree);
  await validateRecordedSupplyChainEvidence(evidence.supply_chain, {
    sourceRoot: resolve(root, "../.."),
    mReviewedTree: evidence.reviews.M.reviewed_sha,
  });

  const lockResult = await verifyImageLock({ root, lockPath });
  if (evidence.image_lock.sha256 !== lockResult.lockSha256) {
    throw new Error("build evidence image lock hash mismatch");
  }
  if (evidence.image_lock.algorithm !== lockResult.lock.algorithm) {
    throw new Error("build evidence context algorithm mismatch");
  }
  if (evidence.image_lock.context_root_sha256 !== lockResult.contextRootSha256) {
    throw new Error("build evidence context root mismatch");
  }
  if (evidence.source_date_epoch !== lockResult.lock.source_date_epoch) {
    throw new Error("build evidence source epoch mismatch");
  }
  if (evidence.platform !== lockResult.lock.platform) {
    throw new Error("build evidence platform mismatch");
  }
  if (evidence.base_image.reference !== lockResult.lock.base_image) {
    throw new Error("build evidence base image mismatch");
  }
  if (evidence.buildkit.image !== lockResult.lock.buildkit_image) {
    throw new Error("build evidence BuildKit image mismatch");
  }
  if (
    evidence.buildx.version !== lockResult.lock.buildx.version ||
    ![
      lockResult.lock.buildx.windows_amd64_sha256,
      lockResult.lock.buildx.linux_amd64_sha256,
    ].includes(evidence.buildx.sha256)
  ) {
    throw new Error("build evidence buildx lock mismatch");
  }
  if (!isAbsolute(evidence.buildx.path)) throw new Error("build evidence buildx path must be absolute");
  const buildxItem = await lstat(evidence.buildx.path);
  if (!buildxItem.isFile() || buildxItem.isSymbolicLink()) {
    throw new Error("build evidence buildx path must be a regular non-symlink file");
  }
  if ((await hashFile(evidence.buildx.path)).sha256 !== evidence.buildx.sha256) {
    throw new Error("build evidence buildx binary hash mismatch");
  }
  if (
    evidence.docker_runtime.client_version !== lockResult.lock.docker.version ||
    evidence.docker_runtime.server_version !== lockResult.lock.docker.version ||
    evidence.docker_runtime.sha256 !== lockResult.lock.docker.linux_amd64_sha256 ||
    evidence.docker_runtime.server_os !== "linux" ||
    evidence.docker_runtime.server_arch !== "amd64"
  ) {
    throw new Error("build evidence Docker runtime lock mismatch");
  }
  if (!isAbsolute(evidence.docker_runtime.path)) {
    throw new Error("build evidence Docker runtime path must be absolute");
  }
  const dockerItem = await lstat(evidence.docker_runtime.path);
  if (!dockerItem.isFile() || dockerItem.isSymbolicLink()) {
    throw new Error("build evidence Docker runtime path must be a regular non-symlink file");
  }
  if ((await hashFile(evidence.docker_runtime.path)).sha256 !== evidence.docker_runtime.sha256) {
    throw new Error("build evidence Docker runtime binary hash mismatch");
  }

  if (!isAbsolute(evidence.oci.promoted_archive_path)) {
    throw new Error("build evidence promoted archive path must be absolute");
  }
  const canonicalArchive = resolve(releaseArtifactPath);
  if (resolve(evidence.oci.promoted_archive_path) !== canonicalArchive) {
    throw new Error("build evidence promoted archive path mismatch");
  }
  const archiveHash = await hashFile(canonicalArchive);
  for (const [field, value] of [
    ["archive_a_sha256", evidence.oci.archive_a_sha256],
    ["archive_b_sha256", evidence.oci.archive_b_sha256],
    ["promoted_archive_sha256", evidence.oci.promoted_archive_sha256],
  ]) {
    if (value !== archiveHash.sha256) throw new Error(`build evidence ${field} mismatch`);
  }
  const fork = parseJsonStrict(
    await readFile(resolve(root, "vendor/zalouser-bridge/FORK.json")),
    "FORK.json",
  );
  validateRecordedRuntimeEvidence(fork, evidence.runtime_reachability);
  if (
    evidence.plugin_probe.fork.plugin.id !== "zalouser" ||
    evidence.plugin_probe.fork.plugin.version !== "2026.7.1" ||
    evidence.plugin_probe.fork.plugin.root_dir !== ZALOUSER_PLUGIN_ROOT ||
    evidence.plugin_probe.fork.inspect.root_dir !== ZALOUSER_PLUGIN_ROOT ||
    evidence.plugin_probe.fork.inspect.install_path !== ZALOUSER_PLUGIN_ROOT ||
    JSON.stringify(evidence.plugin_probe.fork.discovery_roots) !==
      JSON.stringify(["/home/node/.openclaw/npm/projects/zalouser", ZALOUSER_PLUGIN_ROOT]) ||
    evidence.plugin_probe.differential.fork_pass !== true ||
    evidence.plugin_probe.differential.stock_fail !== true ||
    evidence.plugin_probe.differential.plugin_delta !== 1 ||
    evidence.plugin_probe.private_rpc.method !== "zalouser.bridge.send" ||
    evidence.plugin_probe.private_rpc.scope !== "operator.write" ||
    evidence.plugin_probe.private_rpc.registered_method_count !== 1 ||
    evidence.plugin_probe.private_rpc.denied_without_runtime !== true ||
    evidence.plugin_probe.private_rpc.error_code !== "PRIVATE_RPC_REQUIRED" ||
    evidence.plugin_probe.private_rpc.provider_frame_count !== 0
  ) {
    throw new Error("build evidence plugin discovery/differential proof mismatch");
  }
  const inspectedOci = await verifyOciRuntimeImage({
    archivePath: canonicalArchive,
    fork,
    lock: lockResult.lock,
  });
  for (const key of [
    "index_sha256",
    "manifest_digest",
    "config_digest",
    "layer_digests",
    "blob_manifest_sha256",
    "archive_entry_count",
    "archive_entries",
    "rootfs",
  ]) {
    assertJsonEqual(evidence.oci[key], inspectedOci[key], `build evidence OCI ${key}`);
  }
  if (evidence.image_digest !== inspectedOci.manifest_digest) {
    throw new Error("build evidence image digest mismatch");
  }

  assertJsonEqual(evidence.installed_fork.entries, fork.installedTree.entries, "installed fork entries");
  if (
    evidence.installed_fork.file_count !== fork.installedTree.fileCount ||
    evidence.installed_fork.directory_count !== fork.installedTree.directoryCount ||
    evidence.installed_fork.root_sha256 !== fork.installedTree.sha256
  ) {
    throw new Error("installed fork summary mismatch");
  }
  const expectedSession = lockResult.lock.inputs.filter(({ path }) => SESSION_DIST.includes(path));
  const expectedInstalledSession = inspectedOci.rootfs.session_records;
  assertJsonEqual(evidence.session_crypto.inputs, expectedSession, "session crypto inputs");
  assertJsonEqual(
    evidence.session_crypto.installed,
    expectedInstalledSession,
    "session crypto installed files",
  );
  const expectedClosure = sha256(
    Buffer.from(
      expectedInstalledSession
        .map(({ path, sha256: digest, mtime }) => `${path}\0${digest}\0${mtime}\0`)
        .join(""),
      "utf8",
    ),
  );
  if (evidence.session_crypto.closure_sha256 !== expectedClosure) {
    throw new Error("session crypto closure mismatch");
  }
  return { evidence_sha256: sha256(evidenceBytes), archive_sha256: archiveHash.sha256 };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key}`);
    result[key.slice(2)] = value;
  }
  return result;
}

async function readReviewsFromArgs(args) {
  const required = [
    "m-reviewed-tree",
    "reviewed-tree",
    "m-review-report",
    "r-review-report",
  ];
  const present = required.filter((key) => args[key]);
  if (present.length === 0) return undefined;
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
  if (!REVIEWED_TREE.test(args["m-reviewed-tree"])) throw new Error("invalid M reviewed tree");
  if (!REVIEWED_TREE.test(args["reviewed-tree"])) throw new Error("invalid reviewed tree");
  if (args["m-reviewed-tree"] === args["reviewed-tree"]) {
    throw new Error("M and R reviewed trees must be distinct");
  }
  return {
    M: await readCanonicalReviewReport(args["m-review-report"], {
      checkpoint: "M",
      reviewedSha: args["m-reviewed-tree"],
    }),
    R: await readCanonicalReviewReport(args["r-review-report"], {
      checkpoint: "R",
      reviewedSha: args["reviewed-tree"],
    }),
  };
}

async function readReviewedExportFromArgs(args) {
  const required = [
    "reviewed-source-root",
    "reviewed-export-manifest",
    "reviewed-export-manifest-sha256",
    "reviewed-tree",
  ];
  const present = required.filter((key) => args[key]);
  if (present.length === 0) return undefined;
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
  const recorded = await verifyReviewedExportBinding({
    sourceRoot: args["reviewed-source-root"],
    manifestPath: args["reviewed-export-manifest"],
    manifestSha256: args["reviewed-export-manifest-sha256"],
    reviewedTree: args["reviewed-tree"],
  });
  return validateRecordedReviewedExport(recorded, args["reviewed-tree"]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptCellRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = resolve(args.root ?? (args.lock ? dirname(args.lock) : scriptCellRoot));
  const lockPath = resolve(args.lock ?? resolve(root, "image-lock.json"));
  if (!args["oci-a"] && !args["oci-b"] && args.evidence) {
    for (const key of ["schema", "reviewed-tree", "release-artifact"]) {
      if (!args[key]) throw new Error(`--${key} is required with --evidence`);
    }
    const result = await verifyEvidenceFile({
      root,
      lockPath,
      evidencePath: resolve(args.evidence),
      schemaPath: resolve(args.schema),
      reviewedTree: args["reviewed-tree"],
      releaseArtifactPath: args["release-artifact"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const lockResult = await verifyImageLock({ root, lockPath });
  const reviews = await readReviewsFromArgs(args);
  const reviewedExport = await readReviewedExportFromArgs(args);
  const supplyChain =
    reviews && reviewedExport
      ? await collectQualifyingSupplyChainEvidence({
          sourceRoot: args["reviewed-source-root"],
          mReviewedTree: reviews.M.reviewed_sha,
          reviewedExport,
        })
      : undefined;
  if (!args["oci-a"] && !args["oci-b"]) {
    process.stdout.write(
      `${JSON.stringify({
        ...lockResult,
        ...(reviews ? { reviews } : {}),
        ...(reviewedExport ? { reviewed_export: reviewedExport } : {}),
        ...(supplyChain ? { supply_chain: supplyChain } : {}),
      })}\n`,
    );
    return;
  }

  const required = [
    "oci-a",
    "oci-b",
    "m-reviewed-tree",
    "reviewed-tree",
    "m-review-report",
    "r-review-report",
    "schema",
    "evidence",
    "release-artifact",
    "buildx-path",
    "buildx-sha256",
    "docker-path",
    "docker-sha256",
    "reviewed-source-root",
    "reviewed-export-manifest",
    "reviewed-export-manifest-sha256",
  ];
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
  if (!reviews) throw new Error("canonical M/R review reports are required");
  if (!reviewedExport) throw new Error("reviewed export binding is required");
  if (!supplyChain) throw new Error("qualifying supply-chain evidence is required");
  if (!REVIEWED_TREE.test(args["m-reviewed-tree"])) throw new Error("invalid M reviewed tree");
  if (!REVIEWED_TREE.test(args["reviewed-tree"])) throw new Error("invalid reviewed tree");
  if (!isAbsolute(args["buildx-path"])) throw new Error("buildx path must be absolute");
  if (!HEX_64.test(args["buildx-sha256"])) throw new Error("invalid buildx sha256");
  if (!isAbsolute(args["docker-path"])) throw new Error("Docker path must be absolute");
  if (!HEX_64.test(args["docker-sha256"])) throw new Error("invalid Docker sha256");

  const archive = await compareFiles(args["oci-a"], args["oci-b"]);
  const forkPath = resolve(root, "vendor/zalouser-bridge/FORK.json");
  const fork = parseJsonStrict(await readFile(forkPath), "FORK.json");
  if (!fork.installedTree || !Array.isArray(fork.installedTree.entries)) {
    throw new Error("FORK.json installedTree is missing");
  }
  const oci = await verifyOciRuntimeImage({
    archivePath: args["oci-a"],
    fork,
    lock: lockResult.lock,
  });
  const runtimeProbe = await probeOpenClawRuntimeImages({
    archivePath: resolve(args["oci-a"]),
    baseImage: lockResult.lock.base_image,
    dockerPath: args["docker-path"],
    dockerSha256: args["docker-sha256"],
    expectedDockerVersion: lockResult.lock.docker.version,
    manifestDigest: oci.manifest_digest,
    nonce: randomBytes(16).toString("hex"),
    fork,
  });

  const evidence = {
    schema_version: 1,
    reviewed_tree: args["reviewed-tree"],
    reviews,
    reviewed_export: reviewedExport,
    supply_chain: supplyChain,
    source_date_epoch: lockResult.lock.source_date_epoch,
    platform: lockResult.lock.platform,
    image_digest: oci.manifest_digest,
    image_lock: {
      path: "services/openclaw-zalo-cell/image-lock.json",
      sha256: lockResult.lockSha256,
      algorithm: lockResult.lock.algorithm,
      context_root_sha256: lockResult.contextRootSha256,
    },
    base_image: {
      reference: lockResult.lock.base_image,
      digest: `sha256:${lockResult.lock.base_image.split("@sha256:")[1]}`,
    },
    buildx: {
      path: args["buildx-path"],
      version: lockResult.lock.buildx.version,
      sha256: args["buildx-sha256"],
    },
    buildkit: { image: lockResult.lock.buildkit_image, version: "v0.13.2" },
    docker_runtime: runtimeProbe.docker,
    docker: {
      stages: ["install", "runtime"],
      network_none: true,
      offline_install: true,
      session_dist_paths: SESSION_DIST,
    },
    oci: {
      archive_a_sha256: archive.sha256,
      archive_b_sha256: archive.sha256,
      byte_identical: true,
      promoted_archive_path: args["release-artifact"],
      promoted_archive_sha256: archive.sha256,
      ...oci,
    },
    plugin_probe: {
      fork: runtimeProbe.fork,
      stock: runtimeProbe.stock,
      differential: runtimeProbe.differential,
      private_rpc: runtimeProbe.private_rpc,
    },
    runtime_reachability: {
      dynamic_site_inventory: fork.runtimeDynamicSiteInventory,
      derived_runtime_set: fork.derivedRuntimeSet,
      runtime_reachability_allowlist: fork.runtimeReachabilityAllowlist,
      scenario_traces: runtimeProbe.runtime_scenarios.traces,
      resolved_runtime_set: runtimeProbe.runtime_scenarios.resolved_runtime_set,
    },
    installed_fork: {
      entries: fork.installedTree.entries,
      file_count: fork.installedTree.fileCount,
      directory_count: fork.installedTree.directoryCount,
      root_sha256: fork.installedTree.sha256,
    },
    session_crypto: {
      inputs: lockResult.lock.inputs.filter(({ path }) => SESSION_DIST.includes(path)),
      installed: oci.rootfs.session_records,
      closure_sha256: sha256(
        Buffer.from(
          oci.rootfs.session_records
            .map(({ path, sha256: digest, mtime }) => `${path}\0${digest}\0${mtime}\0`)
            .join(""),
          "utf8",
        ),
      ),
    },
    verification: {
      image_lock: true,
      schema: true,
      normalized_install: true,
      minimal_rootfs: true,
      plugin_probe: true,
      runtime_reachability: true,
      reviewed_export: true,
      supply_chain: true,
      rootfs: true,
      private_rpc: true,
    },
  };
  const schema = JSON.parse(await readFile(args.schema, "utf8"));
  validateJsonSchema(evidence, schema);
  await publishVerifiedRelease({
    archivePath: resolve(args["oci-a"]),
    evidence,
    evidencePath: resolve(args.evidence),
    releaseArtifactPath: args["release-artifact"],
    schema,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
