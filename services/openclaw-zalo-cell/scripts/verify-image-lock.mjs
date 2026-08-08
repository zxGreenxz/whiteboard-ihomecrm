import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants as FS_CONSTANTS } from "node:fs";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseTask2ApprovalManifest } from "./install-reviewed-task2-launcher.mjs";
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
  "226408f543344f0d2bfc84c7df4243c5364baccf509e8984d04e1e62c74efac0";
const GIT_LINUX_SHA256 =
  "5516c9f362c29376ab9a499a33082f9f611941d8c75930c880e30ad109e39c9a";
const NODE_LINUX_SHA256 =
  "d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c";
const NODE_LINUX_SIZE = 122889056;
const EXPECTED_OCI_ENV = Object.freeze([
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "NODE_VERSION=24.16.0",
  "YARN_VERSION=1.22.22",
  "COREPACK_HOME=/usr/local/share/corepack",
  "PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright",
  "NODE_ENV=production",
]);
const EXPECTED_OCI_ENTRYPOINT = Object.freeze(["tini", "-s", "--"]);
const EXPECTED_OCI_CMD = Object.freeze(["node", "openclaw.mjs", "gateway"]);
const SESSION_DIST = [
  "session-crypto/dist/crypto.js",
  "session-crypto/dist/daemon.js",
  "session-crypto/dist/package.json",
];
const VENDOR_REPOSITORY_PATH = "services/openclaw-zalo-cell/vendor/zalouser-bridge";
const UPSTREAM_REPOSITORY_PATH = `${VENDOR_REPOSITORY_PATH}/UPSTREAM.json`;
const UPSTREAM_VERIFIER_REPOSITORY_PATH =
  `${VENDOR_REPOSITORY_PATH}/scripts/verify-upstream.mjs`;
const REQUIRED_UPSTREAM_VERIFIER_EXPORTS = Object.freeze([
  "computeMInputAggregate",
  "inspectTarball",
  "verifyCommittedInputs",
  "verifyOnlineInputs",
  "verifySigstoreAttestations",
]);
const REQUIRED_UPSTREAM_VERIFIER_BUILTINS = Object.freeze([
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:path",
  "node:url",
  "node:zlib",
]);
const upstreamVerifierResolutionHooks = new Map();
let qualifyingUpstreamVerifier;
let unqualifiedUpstreamVerifierPromise;
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
const REVIEWED_RUNTIME_DELTA_LAYER_COUNT = 7;
// BuildKit `rewrite-timestamp` chỉ KÉO LÙI các mtime mới hơn SOURCE_DATE_EPOCH.
// Thư mục tổ tiên đến từ BASE_IMAGE mà build không ghi vào (không tạo/xoá entry
// con trực tiếp) giữ nguyên mtime đã nướng sẵn trong base digest, nên chúng
// KHÔNG bằng epoch. Các giá trị dưới đây là hằng số của base image đã ghim
// (`ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992…`), quan sát giống hệt
// nhau ở cả fork A lẫn fork B. Ghim đúng từng giá trị là siết chặt chứ không
// phải nới: đổi base digest hoặc chèn thay đổi vào `home`/`home/node` đều làm
// qualifier fail ngay.
const PINNED_BASE_ROOTFS_MTIMES = Object.freeze({
  home: 1779387206,
  "home/node": 1783950995,
});
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

function equalStringArrays(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

export function verifyOciRuntimeConfig(imageConfig) {
  if (imageConfig?.architecture !== "amd64" || imageConfig?.os !== "linux") {
    throw new Error("OCI runtime platform must be exactly linux/amd64");
  }
  const runtime = imageConfig?.config;
  if (!runtime || runtime.User !== "node") {
    throw new Error("OCI runtime user must be exactly node");
  }
  if (!equalStringArrays(runtime.Entrypoint, EXPECTED_OCI_ENTRYPOINT)) {
    throw new Error("OCI runtime entrypoint does not match the pinned OpenClaw startup");
  }
  if (!equalStringArrays(runtime.Cmd, EXPECTED_OCI_CMD)) {
    throw new Error("OCI runtime command does not match the pinned OpenClaw gateway command");
  }
  if (!equalStringArrays(runtime.Env, EXPECTED_OCI_ENV)) {
    throw new Error("OCI runtime environment does not match the pinned OpenClaw environment");
  }
  if (runtime.WorkingDir !== "/app") {
    throw new Error("OCI runtime working directory must be exactly /app");
  }
  return {
    platform: { architecture: "amd64", os: "linux" },
    user: "node",
    entrypoint: [...EXPECTED_OCI_ENTRYPOINT],
    cmd: [...EXPECTED_OCI_CMD],
    env: [...EXPECTED_OCI_ENV],
    working_dir: "/app",
  };
}

async function readRegularFileHandleBound(path, label) {
  await assertPathHasNoSymbolicLink(path, label);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const handle = await open(path, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed before its nofollow handle was bound`);
    }
    const bytes = await handle.readFile();
    const [handleAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      !pathAfter.isFile() || pathAfter.isSymbolicLink() ||
      handleAfter.dev !== opened.dev || handleAfter.ino !== opened.ino ||
      pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino ||
      handleAfter.size !== opened.size || pathAfter.size !== opened.size ||
      handleAfter.mtimeNs !== opened.mtimeNs || handleAfter.ctimeNs !== opened.ctimeNs ||
      BigInt(bytes.length) !== opened.size
    ) {
      throw new Error(`${label} changed while its exact bytes were read`);
    }
    return { bytes, size: bytes.length, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

function dockerSocketPath(dockerHost) {
  if (typeof dockerHost !== "string" || !/^unix:\/\/\/[^?#\0]+$/u.test(dockerHost)) {
    throw new Error("Docker host must be an explicit absolute unix socket URI");
  }
  return dockerHost.slice("unix://".length);
}

export function buildTrustedDockerEnvironment(dockerHost) {
  dockerSocketPath(dockerHost);
  return Object.freeze({
    DOCKER_HOST: dockerHost,
    HOME: "/nonexistent",
  });
}

export async function assertTrustedDockerSocket(dockerHost) {
  const socketPath = dockerSocketPath(dockerHost);
  await assertPathHasNoSymbolicLink(socketPath, "Docker socket authority");
  const item = await lstat(socketPath, { bigint: true });
  if (!item.isSocket() || item.isSymbolicLink()) {
    throw new Error("Docker host authority must be a real Unix socket");
  }
  if (typeof process.getuid === "function" && item.uid !== BigInt(process.getuid())) {
    throw new Error("Docker socket authority must be owned by the verifier user");
  }
  if ((item.mode & 0o002n) !== 0n) {
    throw new Error("Docker socket authority must not be world-writable");
  }
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : item.uid;
  let cursor = dirname(socketPath);
  while (true) {
    const ancestor = await lstat(cursor, { bigint: true });
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) {
      throw new Error("Docker socket authority must have real directory ancestors");
    }
    if (ancestor.uid !== 0n && ancestor.uid !== currentUid) {
      throw new Error("Docker socket authority has an untrusted directory owner");
    }
    if ((ancestor.mode & 0o002n) !== 0n) {
      throw new Error("Docker socket authority has a world-writable directory ancestor");
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { dockerHost, socketPath };
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

export function buildTrustedGitEnvironment(ambient = process.env) {
  const environment = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "TMPDIR"]) {
    if (typeof ambient[key] === "string" && ambient[key]) environment[key] = ambient[key];
  }
  environment.HOME = process.platform === "win32" ? "C:\\Windows\\Temp" : "/nonexistent";
  environment.LANG = "C";
  environment.LC_ALL = "C";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_COUNT = "0";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  return Object.freeze(environment);
}

const TRUSTED_GIT_CONFIG_ARGUMENTS = Object.freeze([
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgSign=false",
  "-c", "core.attributesFile=/dev/null",
]);

export async function assertTrustedGitExecutable({
  gitPath,
  expectedVersion,
  expectedSha256,
  invoke = spawnSync,
}) {
  if (!isAbsolute(gitPath ?? "")) throw new Error("Git path must be absolute");
  if (expectedVersion !== "2.53.0" || expectedSha256 !== GIT_LINUX_SHA256) {
    throw new Error("Git authority does not match image-lock.json");
  }
  const before = await readRegularFileHandleBound(gitPath, "Git executable");
  if (before.sha256 !== expectedSha256) throw new Error("Git executable SHA-256 mismatch");
  const result = invoke(
    gitPath,
    ["--no-replace-objects", ...TRUSTED_GIT_CONFIG_ARGUMENTS, "--version"],
    {
      encoding: null,
      env: buildTrustedGitEnvironment(),
      maxBuffer: 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  const stdout = Buffer.from(result.stdout ?? []);
  if (
    result.error || result.signal !== null || result.status !== 0 ||
    Buffer.from(result.stderr ?? []).length !== 0 ||
    !new RegExp(`^git version ${expectedVersion.replaceAll(".", "\\.")}\\r?\\n$`, "u")
      .test(stdout.toString("utf8"))
  ) {
    throw new Error("Git executable version check failed");
  }
  const after = await readRegularFileHandleBound(gitPath, "Git executable");
  if (after.size !== before.size || after.sha256 !== before.sha256) {
    throw new Error("Git executable changed during verification");
  }
  return Object.freeze({ path: gitPath, size: before.size, sha256: before.sha256, version: expectedVersion });
}

async function assertTrustedGitAuthorityUnchanged({
  authority,
  repositoryRoot,
  expectedM,
  reviewedTree,
  expectedBinding,
}) {
  const current = await assertTrustedGitExecutable({
    gitPath: authority.path,
    expectedVersion: authority.version,
    expectedSha256: authority.sha256,
  });
  if (current.size !== authority.size) throw new Error("Git executable changed during verification");
  const currentBinding = await verifyGitLineage({
    gitPath: authority.path,
    repositoryRoot,
    expectedM,
    reviewedTree,
  });
  if (JSON.stringify(currentBinding) !== JSON.stringify(expectedBinding)) {
    throw new Error("Git repository authority changed during verification");
  }
  return Object.freeze({ authority: current, binding: currentBinding });
}

function gitChecked(gitPath, repositoryRoot, args, { input, allowedStatuses = [0] } = {}) {
  if (!isAbsolute(gitPath ?? "")) throw new Error("Git path must be absolute");
  if (!isAbsolute(repositoryRoot)) throw new Error("Git repository root must be absolute");
  if (
    !Array.isArray(args) || args.length === 0 ||
    args.some((argument) => typeof argument !== "string" || argument.length === 0 || argument.includes("\0"))
  ) {
    throw new Error("Git command arguments are invalid");
  }
  if (
    !Array.isArray(allowedStatuses) || allowedStatuses.length === 0 ||
    allowedStatuses.some((status) => !Number.isInteger(status) || status < 0)
  ) {
    throw new Error("Git allowed status contract is invalid");
  }
  const result = spawnSync(
    gitPath,
    [
      "--no-replace-objects",
      ...TRUSTED_GIT_CONFIG_ARGUMENTS,
      "-c", "core.commitGraph=false",
      "-C", repositoryRoot,
      ...args,
    ],
    {
      encoding: null,
      env: buildTrustedGitEnvironment(),
      input,
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error) throw new Error(`Git command failed: ${result.error.message}`);
  if (result.signal !== null) throw new Error(`Git command was terminated by signal: ${result.signal}`);
  const stderr = Buffer.from(result.stderr ?? []);
  if (stderr.length !== 0) {
    throw new Error(`Git command wrote stderr: ${stderr.toString("utf8").slice(0, 2048)}`);
  }
  if (!allowedStatuses.includes(result.status ?? -1)) {
    throw new Error(`Git command failed (${result.status ?? -1})`);
  }
  return {
    status: result.status ?? -1,
    stdout: Buffer.from(result.stdout ?? []),
    stderr,
  };
}

function gitSingleLine(result, label) {
  const match = /^([^\0\r\n]+)\r?\n$/u.exec(result.stdout.toString("utf8"));
  if (!match) throw new Error(`${label} output is invalid`);
  return match[1];
}

function readAuthenticatedGitObjects({ gitPath, repositoryRoot, oids, expectedType }) {
  if (!Array.isArray(oids) || oids.length === 0 || oids.some((oid) => !REVIEWED_TREE.test(oid))) {
    throw new Error("Git object authentication requires exact SHA-1 object IDs");
  }
  const uniqueOids = [...new Set(oids)];
  const batch = gitChecked(gitPath, repositoryRoot, ["cat-file", "--batch"], {
    input: Buffer.from(`${uniqueOids.join("\n")}\n`, "ascii"),
  }).stdout;
  const objects = new Map();
  let offset = 0;
  for (const requestedOid of uniqueOids) {
    const newline = batch.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`truncated Git object header: ${requestedOid}`);
    const header = batch.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]{40}) ([a-z]+) ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== requestedOid) {
      throw new Error(`Git object identity mismatch: ${requestedOid}`);
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid Git object size: ${requestedOid}`);
    const start = newline + 1;
    const end = start + size;
    if (end >= batch.length || batch[end] !== 0x0a) {
      throw new Error(`truncated Git object bytes: ${requestedOid}`);
    }
    const type = match[2];
    if (expectedType !== undefined && type !== expectedType) {
      throw new Error(`Git object ${requestedOid} is not ${expectedType}`);
    }
    const bytes = Buffer.from(batch.subarray(start, end));
    const calculatedOid = createHash("sha1")
      .update(Buffer.from(`${type} ${bytes.length}\0`, "ascii"))
      .update(bytes)
      .digest("hex");
    if (calculatedOid !== requestedOid) {
      throw new Error(`Git object hash mismatch: ${requestedOid}`);
    }
    objects.set(requestedOid, Object.freeze({ oid: requestedOid, type, bytes }));
    offset = end + 1;
  }
  if (offset !== batch.length) throw new Error("Git cat-file returned unexpected trailing bytes");
  return objects;
}

function parseAuthenticatedCommit(object) {
  if (object.type !== "commit") throw new Error(`Git object ${object.oid} is not a commit`);
  const headerEnd = object.bytes.indexOf(Buffer.from("\n\n", "ascii"));
  if (headerEnd < 0) throw new Error(`Git commit header is malformed: ${object.oid}`);
  const header = object.bytes.subarray(0, headerEnd).toString("ascii");
  const lines = header.split("\n");
  const treeLine = /^tree ([0-9a-f]{40})$/u.exec(lines[0] ?? "");
  if (!treeLine) throw new Error(`Git commit tree header is malformed: ${object.oid}`);
  const parents = [];
  for (const line of lines.slice(1)) {
    const parent = /^parent ([0-9a-f]{40})$/u.exec(line);
    if (parent) parents.push(parent[1]);
    else if (line.startsWith("parent ")) throw new Error(`Git commit parent header is malformed: ${object.oid}`);
  }
  return Object.freeze({ oid: object.oid, tree: treeLine[1], parents: Object.freeze(parents) });
}

function authenticateCommitLineage({ gitPath, repositoryRoot, expectedM, reviewedTree }) {
  const revisionOutput = gitChecked(gitPath, repositoryRoot, [
    "rev-list",
    "--ancestry-path",
    "--topo-order",
    `${expectedM}..${reviewedTree}`,
  ]).stdout.toString("ascii");
  const revisionOids = revisionOutput.trim() === "" ? [] : revisionOutput.trim().split(/\r?\n/u);
  if (
    revisionOids.length === 0 || revisionOids.length > 4096 ||
    revisionOids.some((oid) => !REVIEWED_TREE.test(oid)) ||
    new Set(revisionOids).size !== revisionOids.length ||
    !revisionOids.includes(reviewedTree)
  ) {
    throw new Error("Git commit ancestry enumeration is invalid");
  }
  const authenticated = readAuthenticatedGitObjects({
    gitPath,
    repositoryRoot,
    oids: [...revisionOids, expectedM],
    expectedType: "commit",
  });
  const commits = new Map(
    [...authenticated.values()].map((object) => {
      const commit = parseAuthenticatedCommit(object);
      return [commit.oid, commit];
    }),
  );
  const queue = [reviewedTree];
  const visited = new Set();
  while (queue.length > 0) {
    const oid = queue.shift();
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (oid === expectedM) {
      return Object.freeze({ reviewedCommit: reviewedTree, expectedCommit: expectedM, commitCount: visited.size });
    }
    const commit = commits.get(oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if ((parent === expectedM || commits.has(parent)) && !visited.has(parent)) queue.push(parent);
    }
  }
  throw new Error("ExpectedM is not an ancestor of reviewed R");
}

async function assertGitRepositoryAuthority({ gitPath, repositoryRoot }) {
  const objectFormat = gitSingleLine(
    gitChecked(gitPath, repositoryRoot, ["rev-parse", "--show-object-format"]),
    "Git object format",
  );
  if (objectFormat !== "sha1") throw new Error("Git repository object format must be sha1");
  const commonText = gitSingleLine(
    gitChecked(gitPath, repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "Git common-dir",
  );
  if (!isAbsolute(commonText)) throw new Error("Git common-dir must be absolute");
  const commonDir = resolve(commonText);
  await assertPathHasNoSymbolicLink(commonDir, "Git common directory");
  const commonItem = await lstat(commonDir);
  if (!commonItem.isDirectory() || commonItem.isSymbolicLink()) {
    throw new Error("Git common directory must be a real directory");
  }
  const replacements = gitChecked(gitPath, repositoryRoot, [
    "for-each-ref", "--format=%(refname)", "refs/replace",
  ]);
  if (replacements.stdout.length !== 0) {
    throw new Error("Git refs/replace authority is forbidden");
  }
  for (const [relativePath, label] of [
    ["info/grafts", "Git info/grafts"],
    ["objects/info/alternates", "Git objects/info/alternates"],
    ["objects/info/http-alternates", "Git objects/info/http-alternates"],
  ]) {
    const candidate = resolve(commonDir, ...relativePath.split("/"));
    try {
      await assertPathHasNoSymbolicLink(candidate, label);
      const item = await lstat(candidate);
      if (!item.isFile() || item.isSymbolicLink() || item.size !== 0) {
        throw new Error(`${label} must be absent or an empty regular file`);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  return Object.freeze({ repositoryRoot, commonDir });
}

function verifyGitLineageChecked({ gitPath, repositoryRoot, expectedM, reviewedTree }) {
  if (!isAbsolute(repositoryRoot)) throw new Error("Git repository root must be absolute");
  if (!REVIEWED_TREE.test(expectedM ?? "")) throw new Error("ExpectedM must be an exact 40-hex Git commit");
  if (!REVIEWED_TREE.test(reviewedTree ?? "")) throw new Error("reviewed R must be an exact 40-hex Git commit");
  if (expectedM === reviewedTree) throw new Error("ExpectedM and reviewed R must be distinct commits");
  authenticateCommitLineage({ gitPath, repositoryRoot, expectedM, reviewedTree });
  return {
    expected_m: expectedM,
    reviewed_r: reviewedTree,
    m_object_type: "commit",
    r_object_type: "commit",
    m_ancestor_of_r: true,
    input_source: "git-objects",
  };
}

export async function verifyGitLineage({ gitPath, repositoryRoot, expectedM, reviewedTree }) {
  if (!isAbsolute(repositoryRoot)) throw new Error("Git repository root must be absolute");
  await assertPathHasNoSymbolicLink(repositoryRoot, "Git repository root");
  const item = await lstat(repositoryRoot);
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new Error("Git repository root must be a real directory");
  }
  const canonicalRoot = await realpath(repositoryRoot);
  await assertGitRepositoryAuthority({ gitPath, repositoryRoot: canonicalRoot });
  return verifyGitLineageChecked({ gitPath, repositoryRoot: canonicalRoot, expectedM, reviewedTree });
}

export function verifyReviewGitBinding({ gitPath, repositoryPath, repositoryRoot, expectedM, reviewedTree }) {
  return verifyGitLineage({
    gitPath,
    repositoryRoot: repositoryRoot ?? repositoryPath,
    expectedM,
    reviewedTree,
  });
}

function parseGitTree(raw) {
  const records = new Map();
  for (const record of raw.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const match = /^(\d{6}) (\S+) ([0-9a-f]{40})\t(.+)$/u.exec(record);
    if (!match) throw new Error("invalid Git tree record");
    const path = match[4];
    if (records.has(path)) throw new Error(`duplicate Git tree path: ${path}`);
    records.set(path, { mode: match[1], type: match[2], oid: match[3], path });
  }
  return records;
}

function authenticateCommitAndTreeObjects({ gitPath, repositoryRoot, commit }) {
  const commitObject = readAuthenticatedGitObjects({
    gitPath,
    repositoryRoot,
    oids: [commit],
    expectedType: "commit",
  }).get(commit);
  const authenticatedCommit = parseAuthenticatedCommit(commitObject);
  const recursiveTree = parseGitTree(
    gitChecked(
      gitPath,
      repositoryRoot,
      ["ls-tree", "-r", "-z", "-t", "--full-tree", `${commit}^{tree}`],
    ).stdout,
  );
  const treeOids = [
    authenticatedCommit.tree,
    ...[...recursiveTree.values()].filter(({ type }) => type === "tree").map(({ oid }) => oid),
  ];
  readAuthenticatedGitObjects({
    gitPath,
    repositoryRoot,
    oids: treeOids,
    expectedType: "tree",
  });
  return authenticatedCommit;
}

export async function readGitBlobRecords({ gitPath, repositoryRoot, commit, paths }) {
  if (!isAbsolute(repositoryRoot)) throw new Error("Git repository root must be absolute");
  if (!REVIEWED_TREE.test(commit ?? "")) throw new Error("Git object commit is invalid");
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("Git object paths must be nonempty");
  authenticateCommitAndTreeObjects({ gitPath, repositoryRoot, commit });
  const tree = parseGitTree(
    gitChecked(gitPath, repositoryRoot, ["ls-tree", "-rz", "--full-tree", commit]).stdout,
  );
  const selected = paths.map((path) => {
    assertPortablePath(path, "Git object path");
    const item = tree.get(path);
    if (!item) throw new Error(`missing Git object path: ${path}`);
    if (item.type !== "blob" || !["100644", "100755"].includes(item.mode)) {
      throw new Error(`Git object path is not an approved blob: ${path}`);
    }
    return item;
  });
  if (new Set(selected.map(({ path }) => path.toLowerCase())).size !== selected.length) {
    throw new Error("Git object paths collide");
  }
  const batch = gitChecked(gitPath, repositoryRoot, ["cat-file", "--batch"], {
    input: Buffer.from(`${selected.map(({ oid }) => oid).join("\n")}\n`, "ascii"),
  }).stdout;
  const objects = [];
  let offset = 0;
  for (const item of selected) {
    const newline = batch.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`truncated Git object header: ${item.path}`);
    const header = batch.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]{40}) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== item.oid) throw new Error(`Git object identity mismatch: ${item.path}`);
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Git object size is invalid: ${item.path}`);
    const start = newline + 1;
    const end = start + size;
    if (end >= batch.length || batch[end] !== 0x0a) throw new Error(`truncated Git object bytes: ${item.path}`);
    const bytes = Buffer.from(batch.subarray(start, end));
    if (gitBlobObjectId(bytes) !== item.oid) throw new Error(`Git object SHA-1 mismatch: ${item.path}`);
    objects.push({
      source: "git-object",
      path: item.path,
      mode: item.mode,
      git_object_id: item.oid,
      size: bytes.length,
      sha256: sha256(bytes),
      bytes,
    });
    offset = end + 1;
  }
  if (offset !== batch.length) throw new Error("unexpected Git object batch trailing bytes");
  return objects;
}

export async function readCommittedGitObjects({ gitPath, repositoryPath, repositoryRoot, commit, paths }) {
  return readGitBlobRecords({ gitPath, repositoryRoot: repositoryRoot ?? repositoryPath, commit, paths });
}

export async function verifyReviewedFileBlob({
  gitPath,
  repositoryRoot,
  reviewedTree,
  filePath,
  repositoryPath,
  label = "reviewed file",
}) {
  if (!isAbsolute(filePath)) throw new Error(`${label} path must be absolute`);
  await assertPathHasNoSymbolicLink(filePath, label);
  const item = await lstat(filePath);
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const [record] = await readGitBlobRecords({
    gitPath,
    repositoryRoot,
    commit: reviewedTree,
    paths: [repositoryPath],
  });
  const bound = await readRegularFileHandleBound(filePath, label);
  if (
    bound.size !== record.size ||
    bound.sha256 !== record.sha256 ||
    !bound.bytes.equals(record.bytes)
  ) {
    throw new Error(`${label} bytes do not match the exact reviewed R Git blob`);
  }
  return record;
}

export async function verifyReviewedVerifierBlob({ gitPath, repositoryRoot, reviewedTree, verifierPath }) {
  return await verifyReviewedFileBlob({
    gitPath,
    repositoryRoot,
    reviewedTree,
    filePath: verifierPath,
    repositoryPath: "services/openclaw-zalo-cell/scripts/verify-image-lock.mjs",
    label: "reviewed verifier",
  });
}

function validateUpstreamVerifierModule(module) {
  for (const name of REQUIRED_UPSTREAM_VERIFIER_EXPORTS) {
    if (typeof module?.[name] !== "function") {
      throw new Error(`reviewed upstream verifier export is missing: ${name}`);
    }
  }
  return Object.freeze(Object.fromEntries(
    REQUIRED_UPSTREAM_VERIFIER_EXPORTS.map((name) => [name, module[name]]),
  ));
}

async function importUpstreamVerifierBytes(bytes, sha256Digest) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("upstream verifier source must be bytes");
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const url = `data:text/javascript;base64,${bytes.toString("base64")}#sha256=${sha256Digest}`;
  let binding = upstreamVerifierResolutionHooks.get(url);
  if (!binding) {
    const observed = new Set();
    const allowed = new Set(REQUIRED_UPSTREAM_VERIFIER_BUILTINS);
    const hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL === url) {
          if (!allowed.has(specifier)) {
            throw new Error(
              `reviewed upstream verifier has a local or dynamic module dependency: ${specifier}`,
            );
          }
          observed.add(specifier);
        }
        return nextResolve(specifier, context);
      },
    });
    binding = Object.freeze({ hook, observed });
    upstreamVerifierResolutionHooks.set(url, binding);
  }
  const module = validateUpstreamVerifierModule(await import(url));
  const observed = [...binding.observed].sort(compareUtf8);
  if (
    observed.length !== REQUIRED_UPSTREAM_VERIFIER_BUILTINS.length ||
    observed.some((specifier, index) => specifier !== REQUIRED_UPSTREAM_VERIFIER_BUILTINS[index])
  ) {
    throw new Error("reviewed upstream verifier module request closure is incomplete");
  }
  return module;
}

async function loadUnqualifiedUpstreamVerifier() {
  unqualifiedUpstreamVerifierPromise ??= import(
    new URL("../vendor/zalouser-bridge/scripts/verify-upstream.mjs", import.meta.url).href
  ).then(validateUpstreamVerifierModule);
  return unqualifiedUpstreamVerifierPromise;
}

async function getUpstreamVerifier({ requireQualifyingAuthority = false } = {}) {
  if (qualifyingUpstreamVerifier) return qualifyingUpstreamVerifier.module;
  if (requireQualifyingAuthority) {
    throw new Error("qualifying upstream verifier module has not been authenticated");
  }
  return loadUnqualifiedUpstreamVerifier();
}

export async function loadReviewedUpstreamVerifier({
  gitPath,
  repositoryRoot,
  reviewedTree,
  reviewedSourceRoot,
  verifierPath = fileURLToPath(import.meta.url),
}) {
  if (!isAbsolute(reviewedSourceRoot) || !isAbsolute(verifierPath)) {
    throw new Error("reviewed verifier closure paths must be absolute");
  }
  await Promise.all([
    assertPathHasNoSymbolicLink(reviewedSourceRoot, "reviewed verifier source root"),
    assertPathHasNoSymbolicLink(verifierPath, "reviewed verifier path"),
  ]);
  const canonicalSourceRoot = await realpath(reviewedSourceRoot);
  const expectedVerifierPath = resolve(
    canonicalSourceRoot,
    "services/openclaw-zalo-cell/scripts/verify-image-lock.mjs",
  );
  if ((await realpath(verifierPath)) !== expectedVerifierPath) {
    throw new Error("reviewed verifier path escaped or disagrees with reviewed source root");
  }
  await verifyReviewedVerifierBlob({ gitPath, repositoryRoot, reviewedTree, verifierPath });
  const modulePath = resolve(canonicalSourceRoot, ...UPSTREAM_VERIFIER_REPOSITORY_PATH.split("/"));
  const moduleRelative = relative(canonicalSourceRoot, modulePath);
  if (
    isAbsolute(moduleRelative) || moduleRelative === "" || moduleRelative === ".." ||
    moduleRelative.startsWith(`..${sep}`)
  ) {
    throw new Error("reviewed upstream verifier path escaped reviewed source root");
  }
  const [record] = await readGitBlobRecords({
    gitPath,
    repositoryRoot,
    commit: reviewedTree,
    paths: [UPSTREAM_VERIFIER_REPOSITORY_PATH],
  });
  const bound = await readRegularFileHandleBound(modulePath, "reviewed upstream verifier");
  if (
    bound.size !== record.size ||
    bound.sha256 !== record.sha256 ||
    !bound.bytes.equals(record.bytes)
  ) {
    throw new Error("reviewed upstream verifier Git blob mismatch");
  }
  const module = await importUpstreamVerifierBytes(bound.bytes, bound.sha256);
  const binding = Object.freeze({
    module,
    reviewed_tree: reviewedTree,
    repository_root: await realpath(repositoryRoot),
    reviewed_source_root: canonicalSourceRoot,
    module_path: UPSTREAM_VERIFIER_REPOSITORY_PATH,
    module_git_object_id: record.git_object_id,
    module_size: record.size,
    module_sha256: record.sha256,
  });
  if (qualifyingUpstreamVerifier) {
    const previous = qualifyingUpstreamVerifier;
    if (
      previous.reviewed_tree !== binding.reviewed_tree ||
      previous.repository_root !== binding.repository_root ||
      previous.reviewed_source_root !== binding.reviewed_source_root ||
      previous.module_sha256 !== binding.module_sha256
    ) {
      throw new Error("qualifying upstream verifier authority cannot be rebound");
    }
    return previous.module;
  }
  qualifyingUpstreamVerifier = binding;
  return module;
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
    throw new Error(`${label} does not describe the exact loaded zalouser package`);
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
  if (stockMatches.length !== 1) throw new Error("stock must expose exactly one authentic zalouser plugin");
  const forkIds = parsedForkList.plugins.map(({ id }) => id).sort(compareUtf8);
  const stockIds = parsedStockList.plugins.map(({ id }) => id).sort(compareUtf8);
  if (JSON.stringify(forkIds) !== JSON.stringify(stockIds)) {
    throw new Error("fork and stock plugin registries differ outside package behavior");
  }
  assertZalouserPlugin(forkMatches[0], "fork plugin list record");
  assertZalouserPlugin(stockMatches[0], "stock plugin list record");
  const parseInspect = (result, label) => {
    assertProbeProcess(result, label, 0);
    if (result.stderr.length !== 0) throw new Error(`${label} wrote unexpected stderr`);
    const parsed = parseJsonStrict(result.stdout, label);
    assertZalouserPlugin(parsed?.plugin, `${label} record`);
    if (parsed.plugin.imported !== true) throw new Error(`${label} did not import zalouser`);
    const install = parsed.install;
    if (
      install?.source !== "npm" ||
      install?.spec !== "@openclaw/zalouser@2026.7.1" ||
      install?.installPath !== ZALOUSER_PLUGIN_ROOT ||
      install?.version !== "2026.7.1" ||
      install?.resolvedName !== "@openclaw/zalouser" ||
      install?.resolvedVersion !== "2026.7.1" ||
      install?.resolvedSpec !== "@openclaw/zalouser@2026.7.1"
    ) {
      throw new Error(`${label} install provenance mismatch`);
    }
    return { parsed, install };
  };
  const forkInspection = parseInspect(forkInspect, "fork plugin inspect");
  const stockInspection = parseInspect(stockInspect, "stock plugin inspect");
  const projectPath = "/home/node/.openclaw/npm/projects/zalouser";
  const describe = ({ listResult, inspectResult, parsedList, match, inspection }) => ({
    list_sha256: sha256(listResult.stdout),
    list_size: listResult.stdout.length,
    inspect_sha256: sha256(inspectResult.stdout),
    inspect_size: inspectResult.stdout.length,
    plugin_count: parsedList.plugins.length,
    plugin: {
      id: "zalouser",
      name: match.name,
      version: match.version,
      source: match.source,
      root_dir: match.rootDir,
      origin: match.origin,
      enabled: match.enabled,
      status: match.status,
      channel_ids: match.channelIds,
    },
    inspect: {
      imported: true,
      package_name: inspection.parsed.plugin.packageName,
      source: inspection.parsed.plugin.source,
      root_dir: inspection.parsed.plugin.rootDir,
      install_source: inspection.install.source,
      install_spec: inspection.install.spec,
      install_path: inspection.install.installPath,
      resolved_version: inspection.install.resolvedVersion,
    },
    discovery_roots: [projectPath, ZALOUSER_PLUGIN_ROOT],
  });
  return {
    fork: describe({
      listResult: forkList,
      inspectResult: forkInspect,
      parsedList: parsedForkList,
      match: forkMatches[0],
      inspection: forkInspection,
    }),
    stock: describe({
      listResult: stockList,
      inspectResult: stockInspect,
      parsedList: parsedStockList,
      match: stockMatches[0],
      inspection: stockInspection,
    }),
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
    "--pull=never",
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

// Probe hai pha trong CÙNG một container ephemeral:
//  1. Không cấu hình bridge -> register phải ném BRIDGE_CONFIGURATION_INVALID và
//     KHÔNG đăng ký method nào (cell không thể khởi động khi thiếu cấu hình).
//  2. Cấu hình đầy đủ (giá trị giả, mạng none) -> đăng ký ĐÚNG một gateway method
//     `zalouser.bridge.send` scope `operator.write`, và gọi nó bằng client không phải
//     thiết bị bridge đã xác thực phải bị từ chối PRIVATE_BRIDGE_CLIENT_DENIED.
// Pha 1 ném trước khi cài bất kỳ runtime nào nên không làm bẩn state của pha 2.
const PRIVATE_RPC_PROBE_EVAL = String.raw`
import { mkdirSync, writeFileSync } from "node:fs";
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
const noop = () => undefined;
const createApi = () => {
  const gatewayMethods = [];
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
  return {
    gatewayMethods,
    api: new Proxy(apiTarget, {
      get(target, property) {
        if (property in target) return target[property];
        return noop;
      },
    }),
  };
};
const BRIDGE_ENVIRONMENT = {
  OPENCLAW_ZALO_BRIDGE_URL: "http://bridge.invalid",
  OPENCLAW_ZALO_ORGANIZATION_ID: "probe-organization",
  OPENCLAW_ZALO_ACCOUNT_ID: "probe-account",
  OPENCLAW_ZALO_CELL_ID: "probe-cell",
  OPENCLAW_ZALO_SESSION_GENERATION: "1",
  OPENCLAW_ZALO_FENCING_TOKEN: "1",
  OPENCLAW_ZALO_CONTROL_VERSION: "0",
  OPENCLAW_ZALO_TAKEOVER_VERSION: "0",
  OPENCLAW_ZALO_GATEWAY_DEVICE_ID: "probe-gateway-device",
  OPENCLAW_ZALO_CUSTOMER_AI_BASE_URL: "https://customer-ai.invalid/v1",
  OPENCLAW_ZALO_CUSTOMER_AI_API_KEY: "probe-placeholder",
  OPENCLAW_ZALO_CUSTOMER_AI_MODEL: "probe-model",
  OPENCLAW_ZALO_BRIDGE_SECRET_FILE: "/run/secrets/openclaw_zalo_bridge_hmac",
};
for (const name of Object.keys(BRIDGE_ENVIRONMENT)) delete process.env[name];
const unconfigured = createApi();
let unconfiguredErrorCode = "";
try {
  await entry.register(unconfigured.api);
} catch (error) {
  unconfiguredErrorCode = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : "ERROR";
}
if (unconfiguredErrorCode !== "BRIDGE_CONFIGURATION_INVALID" || unconfigured.gatewayMethods.length !== 0) {
  throw new Error("installed plugin did not fail closed without bridge configuration");
}
mkdirSync("/run/secrets", { recursive: true });
writeFileSync("/run/secrets/openclaw_zalo_bridge_hmac", "ab".repeat(32), { mode: 0o400 });
Object.assign(process.env, BRIDGE_ENVIRONMENT);
const configured = createApi();
await entry.register(configured.api);
const privateMethods = configured.gatewayMethods.filter(({ method }) => method === "zalouser.bridge.send");
if (privateMethods.length !== 1 || configured.gatewayMethods.length !== 1) {
  throw new Error("private bridge RPC registration count mismatch");
}
const registration = privateMethods[0];
let response;
let providerFrameCount = 0;
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
if (response?.ok !== false || response?.error?.code !== "PRIVATE_BRIDGE_CLIENT_DENIED") {
  throw new Error("private bridge RPC did not deny an unauthenticated gateway client");
}
process.stdout.write(JSON.stringify({
  schema: 2,
  method: registration.method,
  scope: registration.options?.scope,
  registeredMethodCount: privateMethods.length,
  unconfiguredStartupDenied: true,
  unconfiguredErrorCode,
  deniedWithoutAuthenticatedClient: true,
  errorCode: response.error.code,
  providerFrameCount,
}) + "\n");
`;

export function dockerBehaviorProbeArguments({ image, variant }) {
  if (!/^ihome\/[a-z0-9._/-]+:[0-9a-f]{32}$/u.test(image ?? "")) {
    throw new Error("Docker behavior probe image tag is invalid");
  }
  if (!['fork', 'stock'].includes(variant)) throw new Error("Docker behavior probe variant is invalid");
  return [
    "run", "--pull=never", "--rm", "-i", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "768m",
    "--cpus", "1", "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=0700",
    "--tmpfs", "/home/node/.openclaw/state:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700",
    "--env", `IHOME_BEHAVIOR_VARIANT=${variant}`, "--entrypoint", "node", image,
    "--input-type=module",
  ];
}

const FORK_BEHAVIOR_CASES = [
  ["inbound-committed", ["bridge:inbound.ready", "bridge:inbound.commit", "plugin:dispatch-inbound"]],
  ["inbound-duplicate", ["bridge:inbound.commit"]],
  ["inbound-corrupt", ["bridge:inbound.commit"]],
  ["outbound-group-text-authorized", ["bridge:outbox.authorize-send", "provider:send-message"]],
  ["outbound-peer-media-authorized", ["bridge:media.materialize", "bridge:outbox.authorize-send", "provider:send-message"]],
  ["outbound-link-rejected", []],
  ["outbound-reaction-rejected", []],
  ["outbound-authorization-denied", ["bridge:outbox.authorize-send"]],
  ["outbound-partial-handoff-unknown", [
    "bridge:outbox.authorize-send",
    "provider:send-message",
    "provider:send-message",
  ]],
  ["control-authorized", ["bridge:control.authorize", "provider:typing"]],
  ["control-denied", ["bridge:control.authorize"]],
];

const MEDIA_PROBE_SHA256 = "c3741084a5f5129dfce6049b9e21c8af58cfa9174265000a63d35f6ad0d3e120";

function assertBehaviorOutcome(record, id, variant) {
  exactKeys(record, record.kind === "return" ? ["kind", "value"] : ["kind", "code"], `${variant} behavior outcome ${id}`);
  if (record.kind === "error") {
    if (typeof record.code !== "string" || !record.code) throw new Error(`${variant} behavior error code is invalid`);
    return;
  }
  if (record.kind !== "return") throw new Error(`${variant} behavior outcome kind is invalid`);
}

function assertGatewayResponse(caseRecord, { ok, code, status }) {
  const response = caseRecord.outcome.value;
  exactKeys(response, ["ok", "value", "error"], `behavior gateway response ${caseRecord.id}`);
  if (response.ok !== ok) throw new Error(`behavior gateway response ${caseRecord.id} has an invalid ok flag`);
  if (code !== undefined && response.error?.code !== code) {
    throw new Error(`behavior gateway response ${caseRecord.id} has an invalid error code`);
  }
  if (status !== undefined && response.value?.status !== status) {
    throw new Error(`behavior gateway response ${caseRecord.id} has an invalid delivery status`);
  }
}

function assertGatewayDelivery(caseRecord, expected) {
  assertGatewayResponse(caseRecord, { ok: true, status: expected.status });
  const value = caseRecord.outcome.value.value;
  exactKeys(value, [
    "knownProviderMessageIds",
    "possibleHandoffPrefixLength",
    "reasonCode",
    "receipts",
    "status",
    "totalPartCount",
  ], `behavior delivery ${caseRecord.id}`);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`behavior delivery ${caseRecord.id} has invalid receipt/handoff evidence`);
  }
}

export function validateBehaviorTranscript(parsed, expectedVariant) {
  exactKeys(
    parsed,
    [
      "schema",
      "contract",
      "implementation",
      "package",
      "unconfigured_startup_error",
      "registered_methods",
      "cases",
    ],
    `${expectedVariant} installed behavior transcript`,
  );
  if (
    !["fork", "stock"].includes(expectedVariant) ||
    parsed.schema !== 4 ||
    parsed.contract !== "ihome.zalouser.business.v1" ||
    parsed.implementation !== expectedVariant
  ) {
    throw new Error("installed behavior transcript identity mismatch");
  }
  exactKeys(parsed.package, ["name", "version"], "installed behavior package");
  if (parsed.package.name !== "@openclaw/zalouser" || parsed.package.version !== "2026.7.1") {
    throw new Error("installed behavior package identity mismatch");
  }
  // Probe chạy KHÔNG cấu hình bridge: fork phải fail-closed ngay khi khởi động, còn
  // stock vốn không có RPC riêng nên khởi động bình thường. Sau đó fork đăng ký thẳng
  // `zalouser.bridge.send` từ module đã ghim để chạy các case outbound/control; stock
  // KHÔNG được có method đó (đây vẫn là differential fork/stock thật).
  const expectedStartupError = expectedVariant === "fork" ? "BRIDGE_CONFIGURATION_INVALID" : null;
  if (parsed.unconfigured_startup_error !== expectedStartupError) {
    throw new Error("installed behavior unconfigured startup behavior mismatch");
  }
  const expectedMethods = expectedVariant === "fork" ? ["zalouser.bridge.send"] : [];
  if (JSON.stringify(parsed.registered_methods) !== JSON.stringify(expectedMethods)) {
    throw new Error("installed behavior registered method mismatch");
  }
  const expectedCases = expectedVariant === "fork"
    ? FORK_BEHAVIOR_CASES
    : [["outbound-text-authorized", []]];
  if (!Array.isArray(parsed.cases) || parsed.cases.length !== expectedCases.length) {
    throw new Error("installed behavior case count mismatch");
  }
  for (let index = 0; index < expectedCases.length; index += 1) {
    const [expectedId, expectedEvents] = expectedCases[index];
    const caseRecord = parsed.cases[index];
    exactKeys(caseRecord, ["id", "outcome", "events"], `${expectedVariant} behavior case`);
    if (caseRecord.id !== expectedId || !Array.isArray(caseRecord.events)) {
      throw new Error("installed behavior case identity mismatch");
    }
    assertBehaviorOutcome(caseRecord.outcome, expectedId, expectedVariant);
    const signatures = caseRecord.events.map((event, eventIndex) => {
      if (!event || typeof event !== "object" || Array.isArray(event) || event.seq !== eventIndex) {
        throw new Error(`installed behavior event sequence mismatch for ${expectedId}`);
      }
      const allowed = event.operation === "send-message"
        ? event.messageKind === "text"
          ? ["seq", "actor", "operation", "callIndex", "messageKind", "text", "threadId", "type"]
          : [
            "seq", "actor", "operation", "callIndex", "messageKind", "attachmentBytes",
            "attachmentSha256", "threadId", "type",
          ]
        : event.operation === "typing"
          ? ["seq", "actor", "operation", "threadId", "type"]
          : ["seq", "actor", "operation"];
      exactKeys(event, allowed, `installed behavior event ${expectedId}`);
      if (typeof event.actor !== "string" || typeof event.operation !== "string") {
        throw new Error(`installed behavior event is invalid for ${expectedId}`);
      }
      return `${event.actor}:${event.operation}`;
    });
    if (JSON.stringify(signatures) !== JSON.stringify(expectedEvents)) {
      throw new Error(`installed behavior event ordering mismatch for ${expectedId}`);
    }
  }
  if (expectedVariant === "stock") {
    if (parsed.cases[0].outcome.kind !== "error" || parsed.cases[0].outcome.code !== "METHOD_NOT_REGISTERED") {
      throw new Error("stock installed behavior did not execute the missing private method control");
    }
    return parsed;
  }
  if (parsed.cases[0].outcome.value?.status !== "dispatched") throw new Error("inbound commit did not precede dispatch");
  if (parsed.cases[1].outcome.value?.status !== "duplicate") throw new Error("duplicate inbound outcome mismatch");
  if (parsed.cases[2].outcome.code !== "INBOUND_BRIDGE_INVALID_ACK") throw new Error("corrupt inbound acknowledgement was accepted");
  assertGatewayDelivery(parsed.cases[3], {
    knownProviderMessageIds: ["provider-0"],
    possibleHandoffPrefixLength: 1,
    reasonCode: "ALL_PARTS_ACKNOWLEDGED",
    receipts: [{ providerMessageId: "provider-0" }],
    status: "SENT",
    totalPartCount: 1,
  });
  const groupTextEvent = parsed.cases[3].events[1];
  if (
    groupTextEvent.callIndex !== 0 || groupTextEvent.messageKind !== "text" ||
    groupTextEvent.text !== "probe" || groupTextEvent.threadId !== "group-a" || groupTextEvent.type !== 1
  ) {
    throw new Error("group text provider I/O did not use the exact authorized sink/payload");
  }
  assertGatewayDelivery(parsed.cases[4], {
    knownProviderMessageIds: ["provider-0"],
    possibleHandoffPrefixLength: 1,
    reasonCode: "ALL_PARTS_ACKNOWLEDGED",
    receipts: [{ providerMessageId: "provider-0" }],
    status: "SENT",
    totalPartCount: 1,
  });
  const peerMediaEvent = parsed.cases[4].events[2];
  if (
    peerMediaEvent.callIndex !== 0 || peerMediaEvent.messageKind !== "media" ||
    peerMediaEvent.attachmentBytes !== 19 || peerMediaEvent.attachmentSha256 !== MEDIA_PROBE_SHA256 ||
    peerMediaEvent.threadId !== "peer-a" || peerMediaEvent.type !== 0
  ) {
    throw new Error("peer media provider I/O did not use exact materialized bytes/sink");
  }
  assertGatewayResponse(parsed.cases[5], { ok: false, code: "UNSUPPORTED_BUSINESS_PART" });
  assertGatewayResponse(parsed.cases[6], { ok: false, code: "UNSUPPORTED_BUSINESS_PART" });
  assertGatewayResponse(parsed.cases[7], { ok: false, code: "AUTHORIZATION_DENIED" });
  assertGatewayDelivery(parsed.cases[8], {
    knownProviderMessageIds: ["provider-0"],
    possibleHandoffPrefixLength: 2,
    reasonCode: "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF",
    receipts: [{ providerMessageId: "provider-0" }],
    status: "UNKNOWN",
    totalPartCount: 2,
  });
  const partialEvents = parsed.cases[8].events.slice(1);
  if (
    partialEvents.length !== 2 ||
    partialEvents[0].callIndex !== 0 || partialEvents[0].text !== "first" ||
    partialEvents[1].callIndex !== 1 || partialEvents[1].text !== "second" ||
    partialEvents.some((event) => event.threadId !== "peer-a" || event.type !== 0)
  ) {
    throw new Error("partial handoff did not execute exactly two ordered provider calls without retry");
  }
  if (parsed.cases[9].outcome.value !== null) throw new Error("authorized control outcome mismatch");
  const typingEvent = parsed.cases[9].events[1];
  if (typingEvent.threadId !== "thread-a" || typingEvent.type !== 0) {
    throw new Error("authorized typing did not use the exact provider sink");
  }
  if (parsed.cases[10].outcome.code !== "CONTROL_AUTHORIZATION_DENIED") throw new Error("denied control outcome mismatch");
  return parsed;
}

function validateBehaviorProbeProcess(processResult, variant) {
  assertProbeProcess(processResult, `${variant} installed behavior probe`, 0);
  if (processResult.stderr.length !== 0) throw new Error(`${variant} installed behavior probe wrote stderr`);
  const parsed = validateBehaviorTranscript(
    parseJsonStrict(processResult.stdout, `${variant} installed behavior probe`),
    variant,
  );
  if (!Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8").equals(processResult.stdout)) {
    throw new Error(`${variant} installed behavior probe stdout is not canonical JSON`);
  }
  return {
    transcript_base64: processResult.stdout.toString("base64"),
    transcript_size: processResult.stdout.length,
    transcript_sha256: sha256(processResult.stdout),
  };
}

export function validateRecordedBehaviorEvidence(recorded) {
  exactKeys(
    recorded,
    ["runner", "fork_oci", "stock_oci", "fork", "stock"],
    "recorded installed behavior evidence",
  );
  exactKeys(recorded.runner, ["path", "size", "sha256"], "recorded behavior runner");
  if (
    recorded.runner.path !== "scripts/behavior-probe-runner.mjs" ||
    !Number.isSafeInteger(recorded.runner.size) ||
    recorded.runner.size < 1 ||
    !HEX_64.test(recorded.runner.sha256)
  ) {
    throw new Error("recorded behavior runner binding is invalid");
  }
  for (const [variant, identity] of Object.entries({
    fork: recorded.fork_oci,
    stock: recorded.stock_oci,
  })) {
    exactKeys(identity, ["archive_sha256", "manifest_digest"], `recorded ${variant} behavior OCI identity`);
    if (!HEX_64.test(identity.archive_sha256) || !/^sha256:[0-9a-f]{64}$/u.test(identity.manifest_digest)) {
      throw new Error(`recorded ${variant} behavior OCI identity is invalid`);
    }
  }
  for (const [variant, result] of Object.entries({ fork: recorded.fork, stock: recorded.stock })) {
    exactKeys(
      result,
      ["transcript_base64", "transcript_size", "transcript_sha256"],
      `recorded ${variant} installed behavior`,
    );
    if (
      typeof result.transcript_base64 !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(result.transcript_base64) ||
      !Number.isSafeInteger(result.transcript_size) ||
      result.transcript_size < 1 ||
      !HEX_64.test(result.transcript_sha256)
    ) {
      throw new Error(`recorded ${variant} installed behavior transcript binding is invalid`);
    }
    const raw = Buffer.from(result.transcript_base64, "base64");
    if (
      raw.toString("base64") !== result.transcript_base64 ||
      raw.length !== result.transcript_size ||
      sha256(raw) !== result.transcript_sha256
    ) {
      throw new Error(`recorded ${variant} installed behavior transcript binding mismatch`);
    }
    const parsed = validateBehaviorTranscript(
      parseJsonStrict(raw, `recorded ${variant} installed behavior transcript`),
      variant,
    );
    if (!Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8").equals(raw)) {
      throw new Error(`recorded ${variant} installed behavior transcript is not canonical JSON`);
    }
  }
  return recorded;
}

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
    "--pull=never",
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
    "--pull=never",
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
    // Fork ghim CỨNG /run/secrets/openclaw_zalo_bridge_hmac; pha 2 của probe ghi một
    // secret giả vào tmpfs ephemeral này để chứng minh đường đăng ký khi đã cấu hình.
    "--tmpfs",
    "/run/secrets:rw,noexec,nosuid,size=1m,uid=1000,gid=1000,mode=0700",
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
      "unconfiguredStartupDenied",
      "unconfiguredErrorCode",
      "deniedWithoutAuthenticatedClient",
      "errorCode",
      "providerFrameCount",
    ],
    "private bridge RPC probe",
  );
  if (
    parsed.schema !== 2 ||
    parsed.method !== "zalouser.bridge.send" ||
    parsed.scope !== "operator.write" ||
    parsed.registeredMethodCount !== 1 ||
    parsed.unconfiguredStartupDenied !== true ||
    parsed.unconfiguredErrorCode !== "BRIDGE_CONFIGURATION_INVALID" ||
    parsed.deniedWithoutAuthenticatedClient !== true ||
    parsed.errorCode !== "PRIVATE_BRIDGE_CLIENT_DENIED" ||
    parsed.providerFrameCount !== 0
  ) {
    throw new Error("private bridge RPC probe result mismatch");
  }
  return {
    method: parsed.method,
    scope: parsed.scope,
    registered_method_count: parsed.registeredMethodCount,
    unconfigured_startup_denied: parsed.unconfiguredStartupDenied,
    unconfigured_error_code: parsed.unconfiguredErrorCode,
    denied_without_authenticated_client: parsed.deniedWithoutAuthenticatedClient,
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

function invokeNativeBounded(
  file,
  args,
  { input, environment, maxBytes = 4 * 1024 * 1024, timeoutMs = 180_000 } = {},
) {
  if (input !== undefined && !Buffer.isBuffer(input)) throw new TypeError("native command input must be a Buffer");
  if (input?.length > 1024 * 1024) throw new Error("native command input exceeded 1048576 bytes");
  if (!environment || typeof environment !== "object") {
    throw new Error("native command requires an explicit sanitized environment");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      env: environment,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
    if (input !== undefined) {
      child.stdin.once("error", fail);
      child.stdin.end(input);
    }
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
  stockArchivePath,
  baseImage,
  dockerPath,
  dockerHost,
  dockerSha256,
  expectedDockerVersion,
  manifestDigest,
  stockManifestDigest,
  nonce,
  fork,
  behaviorRunnerPath,
  behaviorRunnerSha256,
  invoke = invokeNativeBounded,
}) {
  if (!isAbsolute(archivePath)) throw new Error("runtime probe OCI archive path must be absolute");
  if (!isAbsolute(stockArchivePath)) throw new Error("runtime stock OCI archive path must be absolute");
  if (!isAbsolute(dockerPath)) throw new Error("runtime probe Docker path must be absolute");
  const dockerEnvironment = buildTrustedDockerEnvironment(dockerHost);
  if (!isAbsolute(behaviorRunnerPath)) throw new Error("runtime behavior runner path must be absolute");
  if (baseImage !== BASE_IMAGE) throw new Error("runtime probe base image is not pinned");
  if (!HEX_64.test(dockerSha256 ?? "")) throw new Error("runtime probe Docker SHA-256 is invalid");
  if (!HEX_64.test(behaviorRunnerSha256 ?? "")) throw new Error("runtime behavior runner SHA-256 is invalid");
  if (expectedDockerVersion !== "29.1.3") throw new Error("runtime probe Docker version is not pinned");
  if (!/^sha256:[0-9a-f]{64}$/u.test(manifestDigest ?? "")) {
    throw new Error("runtime probe manifest digest is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(stockManifestDigest ?? "")) {
    throw new Error("runtime stock manifest digest is invalid");
  }
  if (!/^[0-9a-f]{32}$/u.test(nonce ?? "")) throw new Error("runtime probe nonce is invalid");
  const scenarioPlan = runtimeScenarioPlan(fork);
  for (const [path, label] of [
    [archivePath, "runtime probe OCI archive"],
    [stockArchivePath, "runtime stock OCI archive"],
    [dockerPath, "runtime probe Docker CLI"],
    [behaviorRunnerPath, "runtime behavior runner"],
  ]) {
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
  }
  if (resolve(archivePath) === resolve(stockArchivePath)) {
    throw new Error("runtime fork and stock OCI archives must be distinct paths");
  }
  const [forkIdentity, stockIdentity] = await Promise.all([
    stat(archivePath, { bigint: true }),
    stat(stockArchivePath, { bigint: true }),
  ]);
  if (forkIdentity.dev === stockIdentity.dev && forkIdentity.ino === stockIdentity.ino) {
    throw new Error("runtime fork and stock OCI archives must not be hardlinked");
  }
  if ((await hashFile(dockerPath)).sha256 !== dockerSha256) {
    throw new Error("runtime probe Docker CLI hash mismatch");
  }
  const archiveBinding = await hashFile(archivePath);
  const stockArchiveBinding = await hashFile(stockArchivePath);
  const behaviorRunnerBytes = await readFile(behaviorRunnerPath);
  if (sha256(behaviorRunnerBytes) !== behaviorRunnerSha256) {
    throw new Error("runtime behavior runner hash mismatch");
  }

  const call = async (args, label, allowedExitCodes = [0], invokeOptions) =>
    assertNativeResult(
      await invoke(dockerPath, args, { ...(invokeOptions ?? {}), environment: dockerEnvironment }),
      label,
      allowedExitCodes,
    );
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
    await call(["load", "--input", stockArchivePath], "Docker stock OCI load");
    await call(["tag", stockManifestDigest, stockTag], "Docker stock tag");
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
      [0],
    );
    const privateRpcProbe = await call(
      dockerPrivateRpcProbeArguments({ image: forkTag }),
      "installed private bridge RPC probe",
    );
    const forkBehaviorProbe = await call(
      dockerBehaviorProbeArguments({ image: forkTag, variant: "fork" }),
      "installed fork behavior probe",
      [0],
      { input: behaviorRunnerBytes },
    );
    const stockBehaviorProbe = await call(
      dockerBehaviorProbeArguments({ image: stockTag, variant: "stock" }),
      "installed stock behavior probe",
      [0],
      { input: behaviorRunnerBytes },
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
    const pluginResults = validatePluginProbeResults({ forkList, forkInspect, stockList, stockInspect });
    const forkBehavior = validateBehaviorProbeProcess(forkBehaviorProbe, "fork");
    const stockBehavior = validateBehaviorProbeProcess(stockBehaviorProbe, "stock");
    result = {
      ...pluginResults,
      private_rpc: validatePrivateRpcProbeResult(privateRpcProbe),
      behavior: {
        runner: {
          path: "scripts/behavior-probe-runner.mjs",
          size: behaviorRunnerBytes.length,
          sha256: behaviorRunnerSha256,
        },
        fork_oci: {
          archive_sha256: archiveBinding.sha256,
          manifest_digest: manifestDigest,
        },
        stock_oci: {
          archive_sha256: stockArchiveBinding.sha256,
          manifest_digest: stockManifestDigest,
        },
        fork: forkBehavior,
        stock: stockBehavior,
      },
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
  if (
    (await hashFile(dockerPath)).sha256 !== dockerSha256 ||
    (await hashFile(behaviorRunnerPath)).sha256 !== behaviorRunnerSha256 ||
    (await hashFile(archivePath)).sha256 !== archiveBinding.sha256 ||
    (await hashFile(stockArchivePath)).sha256 !== stockArchiveBinding.sha256
  ) {
    throw new Error("runtime probe retained input changed during execution");
  }
  return {
    docker: {
      sha256: dockerSha256,
      client_version: expectedDockerVersion,
      server_version: expectedDockerVersion,
      server_os: "linux",
      server_arch: "amd64",
    },
    ...result,
  };
}

export async function replayRecordedBehaviorEvidence({
  recorded,
  archiveAPath,
  archiveBPath,
  stockArchivePath,
  behaviorRunnerPath,
  dockerPath,
  dockerHost,
  dockerSha256,
  expectedDockerVersion,
  nonce = randomBytes(16).toString("hex"),
  invoke = invokeNativeBounded,
}) {
  validateRecordedBehaviorEvidence(recorded);
  for (const [path, label] of [
    [archiveAPath, "behavior replay fork OCI A"],
    [archiveBPath, "behavior replay fork OCI B"],
    [stockArchivePath, "behavior replay stock OCI"],
    [behaviorRunnerPath, "behavior replay runner"],
    [dockerPath, "behavior replay Docker CLI"],
  ]) {
    if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
    await assertPathHasNoSymbolicLink(path, label);
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`${label} must be a regular non-symlink file`);
    }
  }
  if (!HEX_64.test(dockerSha256 ?? "")) throw new Error("behavior replay Docker SHA-256 is invalid");
  if (expectedDockerVersion !== "29.1.3") throw new Error("behavior replay Docker version is not pinned");
  if (!/^[0-9a-f]{32}$/u.test(nonce ?? "")) throw new Error("behavior replay nonce is invalid");
  const dockerEnvironment = buildTrustedDockerEnvironment(dockerHost);
  const [forkAIdentity, forkBIdentity, stockIdentity] = await Promise.all([
    stat(archiveAPath, { bigint: true }),
    stat(archiveBPath, { bigint: true }),
    stat(stockArchivePath, { bigint: true }),
  ]);
  const identities = [
    [archiveAPath, forkAIdentity, "fork OCI A"],
    [archiveBPath, forkBIdentity, "fork OCI B"],
    [stockArchivePath, stockIdentity, "stock OCI"],
  ];
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      const [leftPath, leftIdentity, leftLabel] = identities[left];
      const [rightPath, rightIdentity, rightLabel] = identities[right];
      if (
        resolve(leftPath) === resolve(rightPath) ||
        (leftIdentity.dev === rightIdentity.dev && leftIdentity.ino === rightIdentity.ino)
      ) {
        throw new Error(`behavior replay ${leftLabel} and ${rightLabel} must be distinct, non-hardlinked files`);
      }
    }
  }
  const [forkABinding, forkBBinding, stockBinding, runnerAuthority, dockerBinding] = await Promise.all([
    hashFile(archiveAPath),
    hashFile(archiveBPath),
    hashFile(stockArchivePath),
    readRegularFileHandleBound(behaviorRunnerPath, "behavior replay runner"),
    hashFile(dockerPath),
  ]);
  const runnerBinding = { size: runnerAuthority.size, sha256: runnerAuthority.sha256 };
  if (
    forkABinding.sha256 !== recorded.fork_oci.archive_sha256 ||
    forkBBinding.sha256 !== recorded.fork_oci.archive_sha256 ||
    forkABinding.size !== forkBBinding.size ||
    stockBinding.sha256 !== recorded.stock_oci.archive_sha256
  ) {
    throw new Error("behavior replay OCI archive binding mismatch");
  }
  if (
    runnerBinding.size !== recorded.runner.size ||
    runnerBinding.sha256 !== recorded.runner.sha256
  ) {
    throw new Error("behavior replay runner binding mismatch");
  }
  if (dockerBinding.sha256 !== dockerSha256) throw new Error("behavior replay Docker CLI hash mismatch");
  const behaviorRunnerBytes = runnerAuthority.bytes;
  const call = async (args, label, allowedExitCodes = [0], invokeOptions) =>
    assertNativeResult(
      await invoke(dockerPath, args, { ...(invokeOptions ?? {}), environment: dockerEnvironment }),
      label,
      allowedExitCodes,
    );
  const version = await call(
    ["version", "--format", "{{.Client.Version}}|{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}"],
    "behavior replay Docker version",
  );
  const expectedVersionLine = `${expectedDockerVersion}|${expectedDockerVersion}|linux|amd64`;
  if (version.stderr.length !== 0 || version.stdout.toString("utf8").trim() !== expectedVersionLine) {
    throw new Error("behavior replay Docker client/server version or platform mismatch");
  }

  const forkATag = `ihome/openclaw-fork-a-replay:${nonce}`;
  const forkBTag = `ihome/openclaw-fork-b-replay:${nonce}`;
  const stockTag = `ihome/openclaw-stock-replay:${nonce}`;
  for (const tag of [forkATag, forkBTag, stockTag]) {
    const absent = await call(["image", "inspect", tag], "behavior replay tag preflight", [1]);
    if (absent.exitCode !== 1) throw new Error(`behavior replay Docker tag already exists: ${tag}`);
  }
  let forkATagCreated = false;
  let forkBTagCreated = false;
  let stockTagCreated = false;
  let primaryError;
  let replayed;
  const cleanupErrors = [];
  const snapshotRoot = await mkdtemp(resolve(tmpdir(), "openclaw-behavior-replay-"));
  try {
    const snapshot = async (sourcePath, name, expected, label) => {
      const before = await hashFile(sourcePath);
      if (before.size !== expected.size || before.sha256 !== expected.sha256) {
        throw new Error(`${label} changed before replay snapshot`);
      }
      const destination = resolve(snapshotRoot, name);
      await copyFile(sourcePath, destination);
      const [copied, after] = await Promise.all([hashFile(destination), hashFile(sourcePath)]);
      if (
        copied.size !== before.size || copied.sha256 !== before.sha256 ||
        after.size !== before.size || after.sha256 !== before.sha256
      ) {
        throw new Error(`${label} changed while creating replay snapshot`);
      }
      return destination;
    };
    const forkASnapshot = await snapshot(archiveAPath, "fork-a.oci.tar", forkABinding, "fork OCI A");
    const forkBSnapshot = await snapshot(archiveBPath, "fork-b.oci.tar", forkBBinding, "fork OCI B");
    const stockSnapshot = await snapshot(stockArchivePath, "stock.oci.tar", stockBinding, "stock OCI");
    await call(["load", "--input", forkASnapshot], "behavior replay fork OCI A load");
    await call(["tag", recorded.fork_oci.manifest_digest, forkATag], "behavior replay fork A tag");
    forkATagCreated = true;
    await call(["load", "--input", forkBSnapshot], "behavior replay fork OCI B load");
    await call(["tag", recorded.fork_oci.manifest_digest, forkBTag], "behavior replay fork B tag");
    forkBTagCreated = true;
    await call(["load", "--input", stockSnapshot], "behavior replay stock OCI load");
    await call(["tag", recorded.stock_oci.manifest_digest, stockTag], "behavior replay stock tag");
    stockTagCreated = true;
    const forkAProcess = await call(
        dockerBehaviorProbeArguments({ image: forkATag, variant: "fork" }),
        "behavior replay fork A transcript",
        [0],
        { input: behaviorRunnerBytes },
    );
    const forkBProcess = await call(
      dockerBehaviorProbeArguments({ image: forkBTag, variant: "fork" }),
      "behavior replay fork B transcript",
      [0],
      { input: behaviorRunnerBytes },
    );
    const forkA = validateBehaviorProbeProcess(forkAProcess, "fork");
    const forkB = validateBehaviorProbeProcess(forkBProcess, "fork");
    const stock = validateBehaviorProbeProcess(
      await call(
        dockerBehaviorProbeArguments({ image: stockTag, variant: "stock" }),
        "behavior replay stock transcript",
        [0],
        { input: behaviorRunnerBytes },
      ),
      "stock",
    );
    const recordedForkBytes = Buffer.from(recorded.fork.transcript_base64, "base64");
    const recordedStockBytes = Buffer.from(recorded.stock.transcript_base64, "base64");
    if (!forkAProcess.stdout.equals(recordedForkBytes) || !forkBProcess.stdout.equals(recordedForkBytes)) {
      throw new Error("fresh fork A/B behavior transcript bytes do not match recorded evidence");
    }
    if (!forkAProcess.stdout.equals(forkBProcess.stdout)) {
      throw new Error("fresh fork A/B behavior transcript bytes differ");
    }
    if (!Buffer.from(stock.transcript_base64, "base64").equals(recordedStockBytes)) {
      throw new Error("fresh stock behavior transcript bytes do not match recorded evidence");
    }
    replayed = { fork_a: forkA, fork_b: forkB, stock };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const [tag, created] of [
      [forkATag, forkATagCreated],
      [forkBTag, forkBTagCreated],
      [stockTag, stockTagCreated],
    ]) {
      if (!created) continue;
      try {
        await call(["image", "rm", "--force", tag], `behavior replay cleanup ${tag}`);
        const absent = await call(["image", "inspect", tag], `behavior replay cleanup verification ${tag}`, [1]);
        if (absent.exitCode !== 1) throw new Error(`behavior replay Docker tag remains: ${tag}`);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await rm(snapshotRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors.map((value) => new Error(value))],
        "behavior replay and cleanup failed",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors.map((value) => new Error(value)), "behavior replay cleanup failed");
  }
  const [forkAAfter, forkBAfter, stockAfter, runnerAfter, dockerAfter] = await Promise.all([
    hashFile(archiveAPath),
    hashFile(archiveBPath),
    hashFile(stockArchivePath),
    hashFile(behaviorRunnerPath),
    hashFile(dockerPath),
  ]);
  if (
    forkAAfter.sha256 !== forkABinding.sha256 ||
    forkBAfter.sha256 !== forkBBinding.sha256 ||
    stockAfter.sha256 !== stockBinding.sha256 ||
    runnerAfter.sha256 !== runnerBinding.sha256 ||
    dockerAfter.sha256 !== dockerBinding.sha256
  ) {
    throw new Error("behavior replay retained input changed during execution");
  }
  return replayed;
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
  if (!isAbsolute(expected?.repositoryRoot ?? "")) {
    throw new Error("review report repository root must be absolute");
  }
  if (!REVIEWED_TREE.test(expected.reviewedSha ?? "")) {
    throw new Error("review report reviewed SHA is invalid");
  }
  const checkpointName = expected.checkpoint === "M" ? "m" : expected.checkpoint === "R" ? "r" : undefined;
  if (!checkpointName) throw new Error("review report checkpoint must be M or R");
  await assertPathHasNoSymbolicLink(expected.repositoryRoot, "review report repository root");
  await assertPathHasNoSymbolicLink(reportPath, `${expected?.checkpoint ?? "unknown"} review report`);
  const expectedPath = resolve(
    expected.repositoryRoot,
    "services/openclaw-zalo-cell/.release/reviews",
    `${checkpointName}-review-report-v1-${expected.reviewedSha}.json`,
  );
  if (resolve(reportPath) !== expectedPath) {
    throw new Error(`${expected.checkpoint} review report path is not the canonical SHA-bound location`);
  }
  const item = await lstat(reportPath);
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error("review report must be a regular non-symlink file");
  }
  const canonicalRoot = await realpath(expected.repositoryRoot);
  const canonicalPath = await realpath(reportPath);
  const canonicalExpectedPath = resolve(
    canonicalRoot,
    "services/openclaw-zalo-cell/.release/reviews",
    `${checkpointName}-review-report-v1-${expected.reviewedSha}.json`,
  );
  if (canonicalPath !== canonicalExpectedPath) {
    throw new Error(`${expected.checkpoint} review report canonical path mismatch`);
  }
  const bytes = await readFile(canonicalPath);
  return {
    canonicalPath,
    bytes,
    record: reviewEvidenceFromBytes(bytes, expected),
  };
}

export function authenticateEvidenceReviews(embedded, {
  expectedM,
  reviewedTree,
  mReport,
  rReport,
}) {
  exactKeys(embedded, ["M", "R"], "embedded retained reviews");
  const bindings = [
    ["M", expectedM, mReport],
    ["R", reviewedTree, rReport],
  ];
  for (const [checkpoint, reviewedSha, retained] of bindings) {
    const validated = validateEmbeddedReviewRecord(embedded[checkpoint], { checkpoint, reviewedSha });
    const embeddedBytes = Buffer.from(embedded[checkpoint].report_base64, "base64");
    if (!retained?.bytes || !Buffer.isBuffer(retained.bytes) || !embeddedBytes.equals(retained.bytes)) {
      throw new Error(`${checkpoint} embedded review bytes do not match the retained canonical report`);
    }
    assertJsonEqual(validated, retained.record, `${checkpoint} retained review record`);
  }
  return { M: mReport.record, R: rReport.record };
}

export async function validateRetainedReviewReports({
  embedded,
  expectedM,
  reviewedTree,
  repositoryRoot,
  mReviewReportPath,
  rReviewReportPath,
}) {
  const [retainedM, retainedR] = await Promise.all([
    readCanonicalReviewReport(mReviewReportPath, {
      checkpoint: "M",
      reviewedSha: expectedM,
      repositoryRoot,
    }),
    readCanonicalReviewReport(rReviewReportPath, {
      checkpoint: "R",
      reviewedSha: reviewedTree,
      repositoryRoot,
    }),
  ]);
  authenticateEvidenceReviews(embedded, {
    expectedM,
    reviewedTree,
    mReport: retainedM,
    rReport: retainedR,
  });
  return { M: retainedM.record, R: retainedR.record };
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
      "git",
      "node",
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
  exactKeys(lock.git, ["version", "linux_amd64_sha256"], "Git lock");
  if (lock.git.version !== "2.53.0") throw new Error("Git version must be 2.53.0");
  if (lock.git.linux_amd64_sha256 !== GIT_LINUX_SHA256) {
    throw new Error("wrong Linux Git digest");
  }
  exactKeys(lock.node, ["version", "linux_amd64_size", "linux_amd64_sha256"], "Node lock");
  if (lock.node.version !== "24.15.0") throw new Error("Node version must be 24.15.0");
  if (lock.node.linux_amd64_size !== NODE_LINUX_SIZE) throw new Error("wrong Linux Node size");
  if (lock.node.linux_amd64_sha256 !== NODE_LINUX_SHA256) {
    throw new Error("wrong Linux Node digest");
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
    await assertPathHasNoSymbolicLink(absolute, `image input ${input.path}`);
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
    const uid = parseTarNumber(header.subarray(108, 116), "uid");
    const gid = parseTarNumber(header.subarray(116, 124), "gid");
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
      uid,
      gid,
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
    if (
      index.schemaVersion !== 2 ||
      (index.mediaType !== undefined &&
        index.mediaType !== "application/vnd.oci.image.index.v1+json") ||
      !Array.isArray(index.manifests) || index.manifests.length !== 1
    ) {
      throw new Error("OCI index must contain exactly one manifest and a valid optional media type");
    }
    const manifestDescriptor = index.manifests[0];
    if (
      manifestDescriptor?.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
      manifestDescriptor?.platform?.architecture !== "amd64" ||
      manifestDescriptor?.platform?.os !== "linux"
    ) {
      throw new Error("OCI index manifest platform must be exactly linux/amd64");
    }
    const manifestHex = String(manifestDescriptor.digest ?? "").replace(/^sha256:/, "");
    if (!HEX_64.test(manifestHex)) throw new Error("invalid OCI manifest digest");
    const manifestEntry = entries.get(`blobs/sha256/${manifestHex}`);
    if (
      !manifestEntry || manifestEntry.sha256 !== manifestHex ||
      manifestEntry.size !== manifestDescriptor.size
    ) {
      throw new Error("OCI manifest blob mismatch");
    }
    const manifestBytes = (await hashRegion(handle, manifestEntry.offset, manifestEntry.size, true)).bytes;
    const manifest = parseJsonStrict(manifestBytes, "OCI manifest");
    if (
      manifest.schemaVersion !== 2 ||
      manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
      manifest.config?.mediaType !== "application/vnd.oci.image.config.v1+json"
    ) {
      throw new Error("OCI manifest or config media type is invalid");
    }
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

async function readOciRuntimeDelta({ archivePath, expectedDeltaLayerCount }) {
  const inspected = await inspectOciArchive(archivePath);
  const runtimeConfig = verifyOciRuntimeConfig(inspected.config);
  const layerDigests = inspected.manifest.layers.map(({ digest }) => digest);
  if (
    layerDigests.length !== BASE_AMD64_LAYER_DIGESTS.length + expectedDeltaLayerCount ||
    BASE_AMD64_LAYER_DIGESTS.some((digest, index) => layerDigests[index] !== digest)
  ) {
    throw new Error("OCI image does not preserve the exact pinned base layer prefix and delta count");
  }
  if (
    inspected.config?.architecture !== "amd64" ||
    inspected.config?.os !== "linux" ||
    inspected.config?.rootfs?.type !== "layers" ||
    !Array.isArray(inspected.config?.rootfs?.diff_ids) ||
    inspected.config.rootfs.diff_ids.length !== layerDigests.length ||
    BASE_AMD64_DIFF_IDS.some((digest, index) => inspected.config.rootfs.diff_ids[index] !== digest)
  ) {
    throw new Error("OCI image config does not preserve the pinned linux/amd64 rootfs");
  }
  const deltaLayers = inspected.manifest.layers.slice(BASE_AMD64_LAYER_DIGESTS.length);
  const finalRecords = new Map();
  const layerEvidence = [];
  const handle = await open(archivePath, "r");
  try {
    for (let offset = 0; offset < deltaLayers.length; offset += 1) {
      const descriptor = deltaLayers[offset];
      if (descriptor.mediaType !== "application/vnd.oci.image.layer.v1.tar+gzip") {
        throw new Error("runtime delta layer must use OCI gzip media type");
      }
      if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > 64 * 1024 * 1024) {
        throw new Error("runtime delta layer compressed size is invalid");
      }
      const digest = String(descriptor.digest ?? "").replace(/^sha256:/u, "");
      const archiveEntry = inspected.archiveEntries.get(`blobs/sha256/${digest}`);
      if (!archiveEntry) throw new Error("runtime delta layer blob is missing");
      const compressed = (await hashRegion(handle, archiveEntry.offset, archiveEntry.size, true)).bytes;
      let tar;
      try {
        tar = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 });
      } catch (error) {
        throw new Error(`runtime delta layer gzip is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      const diffId = `sha256:${sha256(tar)}`;
      const expectedDiffId = inspected.config.rootfs.diff_ids[BASE_AMD64_DIFF_IDS.length + offset];
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
        records_sha256: sha256(Buffer.from(records.map(
          ({ path, type, mode, uid, gid, size, sha256: digestValue, mtime }) =>
            `${path}\0${type}\0${mode}\0${uid}\0${gid}\0${size}\0${digestValue}\0${mtime}\0`,
        ).join(""), "utf8")),
      });
    }
  } finally {
    await handle.close();
  }
  return { inspected, runtimeConfig, records: [...finalRecords.values()], layerEvidence };
}

export function expectedStockRuntimeRecords({ tarballEntries, sourceDateEpoch }) {
  if (!Array.isArray(tarballEntries) || tarballEntries.length === 0) {
    throw new Error("stock upstream tarball entries are missing");
  }
  const epoch = Number(sourceDateEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("stock runtime epoch is invalid");
  const projectRoot = "home/node/.openclaw/npm/projects/zalouser";
  const packageRoot = `${projectRoot}/node_modules/@openclaw/zalouser`;
  const expected = new Map();
  const addDirectory = (path) => {
    if (!expected.has(path)) {
      expected.set(path, {
        path,
        type: "directory",
        mode: "0755",
        uid: 1000,
        gid: 1000,
        size: 0,
        sha256: sha256(Buffer.alloc(0)),
        mtime: epoch,
      });
    }
  };
  const addParents = (path) => {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) addDirectory(parts.slice(0, index).join("/"));
  };
  const projectManifest = Buffer.from(
    '{"name":"@ihome/openclaw-zalouser-stock-probe","private":true,"dependencies":{"@openclaw/zalouser":"2026.7.1"}}\n',
    "utf8",
  );
  const projectManifestPath = `${projectRoot}/package.json`;
  addParents(projectManifestPath);
  expected.set(projectManifestPath, {
    path: projectManifestPath,
    type: "file",
    mode: "0644",
    uid: 1000,
    gid: 1000,
    size: projectManifest.length,
    sha256: sha256(projectManifest),
    mtime: epoch,
  });
  for (const entry of tarballEntries) {
    if (!entry?.path?.startsWith("package/") || !Buffer.isBuffer(entry.bytes)) {
      throw new Error("stock upstream tarball entry is invalid");
    }
    const relativePath = entry.path.slice("package/".length);
    assertPortablePath(relativePath, "stock upstream package path");
    const path = `${packageRoot}/${relativePath}`;
    addParents(path);
    if (expected.has(path)) throw new Error(`duplicate stock runtime path: ${path}`);
    expected.set(path, {
      path,
      type: "file",
      mode: "0644",
      uid: 1000,
      gid: 1000,
      size: entry.bytes.length,
      sha256: sha256(entry.bytes),
      mtime: epoch,
    });
  }
  // Ba thư mục tổ tiên nằm SẴN trong base image đã pin: layer delta chỉ chép
  // lại metadata gốc của chúng (COPY vào .openclaw làm mtime của .openclaw bị
  // clamp về epoch, còn home/home/node giữ nguyên mtime nướng trong base digest).
  const pinnedStockAncestors = {
    home: { mode: "0755", uid: 0, gid: 0, mtime: PINNED_BASE_ROOTFS_MTIMES.home },
    "home/node": { mode: "0755", uid: 1000, gid: 1000, mtime: PINNED_BASE_ROOTFS_MTIMES["home/node"] },
    "home/node/.openclaw": { mode: "0700", uid: 1000, gid: 1000, mtime: epoch },
  };
  for (const [path, pinned] of Object.entries(pinnedStockAncestors)) {
    const entry = expected.get(path);
    if (!entry) throw new Error(`pinned stock ancestor is missing: ${path}`);
    Object.assign(entry, pinned);
  }
  return [...expected.values()].sort((left, right) => compareUtf8(left.path, right.path));
}

export async function verifyStockOciRuntimeImage({
  archivePath,
  upstreamTarballPath,
  upstream,
  lock,
}) {
  const { inspectTarball } = await getUpstreamVerifier();
  if (lock?.base_image !== BASE_IMAGE) throw new Error("wrong pinned stock base image");
  if (!isAbsolute(upstreamTarballPath)) throw new Error("stock upstream tarball path must be absolute");
  const tarballBytes = await readFile(upstreamTarballPath);
  const inspectedTarball = inspectTarball(tarballBytes, upstream);
  const delta = await readOciRuntimeDelta({ archivePath, expectedDeltaLayerCount: 1 });
  const expected = expectedStockRuntimeRecords({
    tarballEntries: inspectedTarball.entries,
    sourceDateEpoch: lock.source_date_epoch,
  });
  const actual = [...delta.records].sort((left, right) => compareUtf8(left.path, right.path));
  if (actual.length !== expected.length) throw new Error("stock runtime record count mismatch");
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const found = actual[index];
    if (
      found?.path !== wanted.path || found.type !== wanted.type || found.mode !== wanted.mode ||
      found.uid !== wanted.uid || found.gid !== wanted.gid || found.size !== wanted.size ||
      found.sha256 !== wanted.sha256 || found.mtime !== wanted.mtime
    ) {
      throw new Error(`stock runtime rootfs mismatch: ${wanted.path}`);
    }
  }
  const result = {
    ...delta.inspected,
    runtime_config: delta.runtimeConfig,
    upstream_tgz_sha256: sha256(tarballBytes),
    rootfs: {
      architecture: "amd64",
      os: "linux",
      base_layer_count: BASE_AMD64_LAYER_DIGESTS.length,
      delta_layer_count: 1,
      records: actual,
      records_sha256: sha256(Buffer.from(actual.map(
        ({ path, type, mode, uid, gid, size, sha256: digest, mtime }) =>
          `${path}\0${type}\0${mode}\0${uid}\0${gid}\0${size}\0${digest}\0${mtime}\0`,
      ).join(""), "utf8")),
      layers: delta.layerEvidence,
    },
  };
  Object.defineProperties(result, {
    manifest: { value: delta.inspected.manifest, enumerable: false },
    config: { value: delta.inspected.config, enumerable: false },
    archiveEntries: { value: delta.inspected.archiveEntries, enumerable: false },
  });
  return result;
}

export async function verifyOciRuntimeImage({ archivePath, fork, lock }) {
  if (lock?.base_image !== BASE_IMAGE) throw new Error("wrong pinned base image");
  if (!fork?.installedTree || !Array.isArray(fork.installedTree.entries)) {
    throw new Error("FORK installed tree is missing");
  }
  const inspected = await inspectOciArchive(archivePath);
  const runtimeConfig = verifyOciRuntimeConfig(inspected.config);
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
  if (deltaLayers.length !== REVIEWED_RUNTIME_DELTA_LAYER_COUNT) {
    throw new Error(
      `OCI image must contain exactly ${REVIEWED_RUNTIME_DELTA_LAYER_COUNT} reviewed runtime delta layers`,
    );
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
                ({ path, type, mode, uid, gid, size, sha256: digestValue, mtime }) =>
                  `${path}\0${type}\0${mode}\0${uid}\0${gid}\0${size}\0${digestValue}\0${mtime}\0`,
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
    runtime_config: runtimeConfig,
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
  const entrypointPath = "opt/openclaw-cell/entrypoint.sh";
  const expected = new Map();
  for (const entry of fork.installedTree.entries) {
    expected.set(`${forkRoot}/${entry.path}`, { ...entry, uid: 1000, gid: 1000, mtime: epoch });
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
      uid: 1000,
      gid: 1000,
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
    uid: 1000,
    gid: 1000,
    size: configInput.size,
    sha256: configInput.sha256,
    mtime: epoch,
  });
  const entrypointInput = lock.inputs.find(({ path }) => path === "scripts/entrypoint.sh");
  if (!entrypointInput) throw new Error("runtime entrypoint input is missing");
  if (entrypointInput.mode !== "100755") throw new Error("runtime entrypoint input must be executable");
  expected.set(entrypointPath, {
    path: entrypointInput.path,
    type: "file",
    // Dockerfile (input đã pin trong image-lock) COPY entrypoint với --chmod=0555,
    // nên mode trong layer tar là 0555 chứ không phải quyền git 100755→0755.
    mode: "0555",
    uid: 1000,
    gid: 1000,
    size: entrypointInput.size,
    sha256: entrypointInput.sha256,
    mtime: epoch,
  });

  const emptySha256 = sha256(Buffer.alloc(0));
  const requiredAncestors = [
    "home/node/.openclaw/npm",
    "home/node/.openclaw/npm/projects",
    forkRoot,
    "opt/openclaw-cell",
    "opt/openclaw-cell/session-crypto",
    sessionRoot,
  ];
  for (const path of requiredAncestors) {
    expected.set(path, {
      path,
      type: "directory",
      mode: "0755",
      uid: 1000,
      gid: 1000,
      size: 0,
      sha256: emptySha256,
      mtime: epoch,
      ancestor: true,
    });
  }
  const pinnedBaseAncestors = new Map([
    ["home", { mode: "0755", uid: 0, gid: 0, mtime: PINNED_BASE_ROOTFS_MTIMES.home }],
    ["home/node", { mode: "0755", uid: 1000, gid: 1000, mtime: PINNED_BASE_ROOTFS_MTIMES["home/node"] }],
    ["home/node/.openclaw", { mode: "0700", uid: 1000, gid: 1000, mtime: epoch }],
    ["opt", { mode: "0755", uid: 0, gid: 0, mtime: epoch }],
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
    if (!expected.has(record.path) && !pinnedBaseAncestors.has(record.path)) {
      throw new Error(`unexpected runtime delta path: ${record.path}`);
    }
    if (pinnedBaseAncestors.has(record.path)) {
      const pinned = pinnedBaseAncestors.get(record.path);
      if (
        record.type !== "directory" || record.mode !== pinned.mode ||
        record.uid !== pinned.uid || record.gid !== pinned.gid ||
        record.size !== 0 || record.sha256 !== emptySha256 || record.mtime !== pinned.mtime
      ) {
        throw new Error(`pinned base ancestor rootfs mismatch: ${record.path}`);
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
        : path === entrypointPath
          ? "runtime entrypoint"
          : "runtime config";
    if (
      !found ||
      found.type !== wanted.type ||
      found.mode !== wanted.mode ||
      found.uid !== wanted.uid ||
      found.gid !== wanted.gid ||
      found.size !== wanted.size ||
      found.sha256 !== wanted.sha256 ||
      found.mtime !== epoch
    ) {
      throw new Error(`${wanted.ancestor ? "runtime ancestor" : label} rootfs mismatch: ${path}`);
    }
  }
  const exactRecords = [...actual.values()].sort((left, right) => compareUtf8(left.path, right.path));
  const forkRecords = fork.installedTree.entries.map((entry) => actual.get(`${forkRoot}/${entry.path}`));
  const sessionRecords = SESSION_DIST.map((path) => actual.get(`opt/openclaw-cell/${path}`));
  const configRecord = actual.get(configPath);
  const entrypointRecord = actual.get(entrypointPath);
  return {
    config_path: configPath,
    entrypoint_path: entrypointPath,
    fork_root: forkRoot,
    record_count: exactRecords.length,
    session_paths: SESSION_DIST.map((path) => `opt/openclaw-cell/${path}`),
    records: exactRecords,
    records_sha256: sha256(
      Buffer.from(
        exactRecords
          .map(
            ({ path, type, mode, uid, gid, size, sha256: digest, mtime }) =>
              `${path}\0${type}\0${mode}\0${uid}\0${gid}\0${size}\0${digest}\0${mtime}\0`,
          )
          .join(""),
        "utf8",
      ),
    ),
    fork_records: forkRecords,
    session_records: sessionRecords,
    config_record: configRecord,
    entrypoint_record: entrypointRecord,
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

export async function compareDistinctOciArchives(leftPath, rightPath) {
  if (!isAbsolute(leftPath) || !isAbsolute(rightPath)) {
    throw new Error("OCI A/B paths must be absolute");
  }
  if (resolve(leftPath) === resolve(rightPath)) {
    throw new Error("OCI A/B must be distinct files, not the same path");
  }
  await Promise.all([
    assertPathHasNoSymbolicLink(leftPath, "OCI A"),
    assertPathHasNoSymbolicLink(rightPath, "OCI B"),
  ]);
  const [leftReal, rightReal, leftInfo, rightInfo] = await Promise.all([
    realpath(leftPath),
    realpath(rightPath),
    stat(leftPath, { bigint: true }),
    stat(rightPath, { bigint: true }),
  ]);
  if (!leftInfo.isFile() || !rightInfo.isFile()) throw new Error("OCI A/B must be regular files");
  if (leftReal === rightReal) throw new Error("OCI A/B resolve to the same file identity");
  if (leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino) {
    throw new Error("OCI A/B must not be hardlinked to the same file identity");
  }
  return await compareFiles(leftPath, rightPath);
}

const RETAINED_INPUT_FIELDS = [
  ["archive_a", "archiveAPath", "OCI A"],
  ["archive_b", "archiveBPath", "OCI B"],
  ["stock_oci", "stockArchivePath", "stock OCI"],
  ["upstream_tgz", "upstreamTarballPath", "verified upstream tgz"],
  ["behavior_runner", "behaviorRunnerPath", "behavior runner"],
];

async function captureRegularFileBinding(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  await assertPathHasNoSymbolicLink(path, label);
  const [item, canonicalPath, identity] = await Promise.all([
    lstat(path),
    realpath(path),
    stat(path, { bigint: true }),
  ]);
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const digest = await hashFile(canonicalPath);
  return {
    path: canonicalPath,
    record: { size: digest.size, sha256: digest.sha256 },
    identity,
  };
}

function assertDistinctFileIdentities(entries) {
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left];
      const b = entries[right];
      if (
        resolve(a.path) === resolve(b.path) ||
        (a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino)
      ) {
        throw new Error(`${a.label} and ${b.label} must be distinct, non-hardlinked files`);
      }
    }
  }
}

export async function captureRetainedQualificationInputs(paths) {
  exactKeys(
    paths,
    RETAINED_INPUT_FIELDS.map(([, parameter]) => parameter),
    "retained qualification input paths",
  );
  const entries = await Promise.all(
    RETAINED_INPUT_FIELDS.map(async ([key, parameter, label]) => ({
      key,
      label,
      ...(await captureRegularFileBinding(paths[parameter], label)),
    })),
  );
  assertDistinctFileIdentities(entries.filter(({ key }) => ["archive_a", "archive_b", "stock_oci"].includes(key)));
  const retained = Object.fromEntries(entries.map(({ key, record }) => [key, record]));
  if (
    retained.archive_a.size !== retained.archive_b.size ||
    retained.archive_a.sha256 !== retained.archive_b.sha256
  ) {
    throw new Error("OCI A/B archives are not byte-identical");
  }
  if (retained.archive_a.sha256 === retained.stock_oci.sha256) {
    throw new Error("stock OCI must be byte-distinct from the fork OCI A/B archives");
  }
  return retained;
}

export async function verifyRetainedQualificationInputs(recorded, suppliedPaths = {}) {
  exactKeys(
    recorded,
    RETAINED_INPUT_FIELDS.map(([key]) => key),
    "recorded retained qualification inputs",
  );
  const paths = {};
  for (const [key, parameter, label] of RETAINED_INPUT_FIELDS) {
    exactKeys(recorded[key], ["size", "sha256"], `recorded ${label}`);
    if (
      !Number.isSafeInteger(recorded[key].size) ||
      recorded[key].size < 1 ||
      !HEX_64.test(recorded[key].sha256)
    ) {
      throw new Error(`recorded ${label} binding is invalid`);
    }
    if (!isAbsolute(suppliedPaths[parameter] ?? "")) {
      throw new Error(`supplied ${label} path must be absolute`);
    }
    paths[parameter] = suppliedPaths[parameter];
  }
  const actual = await captureRetainedQualificationInputs(paths);
  for (const [key, , label] of RETAINED_INPUT_FIELDS) {
    if (
      recorded[key].size !== actual[key].size ||
      recorded[key].sha256 !== actual[key].sha256
    ) {
      throw new Error(`retained ${label} changed or does not match its evidence binding`);
    }
  }
  return actual;
}

// So sánh `const` phải theo CẤU TRÚC. Trước đây dùng `!==` nên mọi `const` kiểu
// mảng/đối tượng (entrypoint, cmd, env trong ociRuntimeConfig) LUÔN fail vì khác
// tham chiếu — schema coi như bất khả thoả ở các trường đó. Đây là sửa lỗi để
// ràng buộc thực sự có hiệu lực, không phải nới lỏng.
function equalJsonValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(right)) {
    return Array.isArray(left) && left.length === right.length &&
      right.every((item, index) => equalJsonValue(left[index], item));
  }
  if (right && typeof right === "object") {
    if (!left || typeof left !== "object" || Array.isArray(left)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index]) &&
      rightKeys.every((key) => equalJsonValue(left[key], right[key]));
  }
  return false;
}

function validateSchemaValue(value, schema, path = "$", rootSchema = schema) {
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/$defs/")) throw new Error(`${path} has unsupported schema ref`);
    const definition = rootSchema.$defs?.[schema.$ref.slice("#/$defs/".length)];
    if (!definition) throw new Error(`${path} references a missing schema definition`);
    validateSchemaValue(value, definition, path, rootSchema);
    return;
  }
  if (schema.const !== undefined && !equalJsonValue(value, schema.const)) {
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
    // Mảng chỉ ràng buộc bằng `const` (entrypoint/cmd/env) không khai `items`;
    // trước đây vòng lặp này crash khi `schema.items` undefined.
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        validateSchemaValue(item, schema.items, `${path}[${index}]`, rootSchema);
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} must be a string`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path} does not match pattern`);
    }
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} is less than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`${path} is greater than maximum ${schema.maximum}`);
    }
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
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== resolve(parent)) {
    throw new Error("release artifact destination must not traverse a link or reparse ancestor");
  }
  try {
    const destinationItem = await lstat(destination);
    if (destinationItem.isSymbolicLink()) {
      throw new Error("release artifact destination must not be a link or reparse point");
    }
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
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
    evidence?.oci?.promoted_archive_role !== "A" ||
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

export async function assertPathHasNoSymbolicLink(absolutePath, label) {
  if (!isAbsolute(absolutePath)) throw new Error(`${label} path must be absolute`);
  const chain = [];
  let cursor = resolve(absolutePath);
  while (true) {
    chain.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of chain.reverse()) {
    const item = await lstat(candidate);
    if (item.isSymbolicLink()) {
      throw new Error(`${label} must not traverse a link or reparse ancestor`);
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

function mInventoryPaths(upstream) {
  const paths = new Set([
    ".gitattributes",
    "eslint.config.js",
    "vite.config.ts",
    `${VENDOR_REPOSITORY_PATH}/SHA512SUMS`,
    `${VENDOR_REPOSITORY_PATH}/licenses/manifest.json`,
    ...upstream.rootCompliance.map((item) => `${VENDOR_REPOSITORY_PATH}/${item.outputPath}`),
    ...upstream.provenanceInputs.map((item) => `${VENDOR_REPOSITORY_PATH}/${item.path}`),
    ...upstream.sourceManifest.map((item) => `${VENDOR_REPOSITORY_PATH}/${item.outputPath}`),
    UPSTREAM_REPOSITORY_PATH,
  ]);
  const result = [...paths].sort(compareUtf8);
  if (result.length !== 87) throw new Error(`M Git-object inventory must contain 87 paths, got ${result.length}`);
  return result;
}

function assertMManifestBindings(records, upstream) {
  const byPath = new Map(records.map((record) => [record.path, record]));
  for (const item of upstream.sourceManifest) {
    const record = byPath.get(`${VENDOR_REPOSITORY_PATH}/${item.outputPath}`);
    if (
      !record || record.mode !== item.mode || record.git_object_id !== item.gitBlobOid ||
      record.size !== item.size || record.sha256 !== item.sha256
    ) {
      throw new Error(`raw M source manifest Git object mismatch: ${item.outputPath}`);
    }
  }
  for (const item of [...upstream.rootCompliance, ...upstream.provenanceInputs]) {
    const path = `${VENDOR_REPOSITORY_PATH}/${item.outputPath ?? item.path}`;
    const record = byPath.get(path);
    if (!record || record.size !== item.size || record.sha256 !== item.sha256) {
      throw new Error(`raw M reviewed input mismatch: ${item.outputPath ?? item.path}`);
    }
  }
  const license = byPath.get(`${VENDOR_REPOSITORY_PATH}/${upstream.licenseManifestPath}`);
  if (!license || license.sha256 !== upstream.licenseManifestSha256) {
    throw new Error("raw M license manifest hash mismatch");
  }
}

export async function collectRawMInputs({ gitPath, repositoryRoot, expectedM }) {
  const { computeMInputAggregate } = await getUpstreamVerifier();
  const upstreamRecord = (
    await readGitBlobRecords({
      gitPath,
      repositoryRoot,
      commit: expectedM,
      paths: [UPSTREAM_REPOSITORY_PATH],
    })
  )[0];
  const upstream = parseJsonStrict(upstreamRecord.bytes, "raw M UPSTREAM.json Git object");
  const records = await readGitBlobRecords({
    gitPath,
    repositoryRoot,
    commit: expectedM,
    paths: mInventoryPaths(upstream),
  });
  assertMManifestBindings(records, upstream);
  const aggregateRecords = records.map((record) => ({
    bytes: record.bytes,
    mode: record.mode,
    oid: record.git_object_id,
    path: record.path,
    sha256: record.sha256,
    size: record.size,
  }));
  const aggregateSha256 = computeMInputAggregate(aggregateRecords, upstream);
  if (aggregateSha256 !== upstream.mInputAggregate?.sha256) {
    throw new Error("raw M Git-object aggregate mismatch");
  }
  const byPath = new Map(records.map((record) => [record.path, record]));
  const provenance = new Map(
    upstream.provenanceInputs.map((input) => {
      const path = `${VENDOR_REPOSITORY_PATH}/${input.path}`;
      const record = byPath.get(path);
      if (!record) throw new Error(`raw M provenance Git object is missing: ${input.path}`);
      return [input.path, record];
    }),
  );
  if (provenance.size !== 4) throw new Error("raw M provenance input count must be 4");
  return { aggregateSha256, records, upstream, upstreamRecord, provenance };
}

export function sigstoreInputsFromRawM(rawM) {
  const parse = (path, label) => {
    const record = rawM?.provenance?.get(path);
    if (!record?.bytes) throw new Error(`raw M ${label} provenance bytes are missing`);
    return parseJsonStrict(record.bytes, `raw M ${label}`);
  };
  return {
    upstream: rawM.upstream,
    metadata: parse("upstream/provenance/npm-registry-metadata.json", "npm registry metadata"),
    keys: parse("upstream/provenance/npm-registry-keys.json", "npm registry keys"),
    attestations: parse("upstream/provenance/npm-attestation-bundles.json", "npm attestations"),
    trustRoot: parse("upstream/provenance/sigstore-trusted-root.json", "Sigstore trust root"),
  };
}

export async function readReviewedForkGitObjects({ gitPath, repositoryRoot, reviewedTree }) {
  const forkPath = `${VENDOR_REPOSITORY_PATH}/FORK.json`;
  const [forkRecord] = await readGitBlobRecords({
    gitPath,
    repositoryRoot,
    commit: reviewedTree,
    paths: [forkPath],
  });
  const fork = parseJsonStrict(forkRecord.bytes, "reviewed R FORK.json Git object");
  assertPortablePath(fork.artifactPath, "reviewed R fork artifact path");
  const artifactPath = `${VENDOR_REPOSITORY_PATH}/${fork.artifactPath}`;
  const [artifactRecord] = await readGitBlobRecords({
    gitPath,
    repositoryRoot,
    commit: reviewedTree,
    paths: [artifactPath],
  });
  if (
    artifactRecord.sha256 !== fork.artifactSha256 ||
    artifactRecord.sha256 !== fork.builtTgzSha256
  ) {
    throw new Error("reviewed R fork artifact Git object hash mismatch");
  }
  return { fork, forkRecord, artifactRecord };
}

async function verifyCommittedInputsWithoutAmbient(options, verifyCommittedInputs) {
  const names = [
    "OPENCLAW_REVIEWED_EXPORT_MANIFEST",
    "OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256",
    "OPENCLAW_REVIEWED_R_SHA",
  ];
  const retained = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    return await verifyCommittedInputs(options);
  } finally {
    for (const name of names) {
      const value = retained.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export async function collectSupplyChainMetadata({
  gitPath,
  sourceRoot,
  expectedM,
  repositoryRoot = sourceRoot,
  reviewedTree,
  reviewedExport,
}) {
  const { verifyCommittedInputs } = await getUpstreamVerifier();
  if (!isAbsolute(sourceRoot)) throw new Error("supply-chain source root must be absolute");
  if (!REVIEWED_TREE.test(expectedM ?? "")) throw new Error("supply-chain ExpectedM is invalid");
  if (!REVIEWED_TREE.test(reviewedTree ?? "")) throw new Error("supply-chain reviewed R is invalid");
  await Promise.all([
    assertPathHasNoSymbolicLink(sourceRoot, "supply-chain source root"),
    assertPathHasNoSymbolicLink(repositoryRoot, "supply-chain Git repository root"),
  ]);
  const gitBinding = await verifyGitLineage({
    gitPath,
    repositoryRoot,
    expectedM,
    reviewedTree,
  });
  const rawM = await collectRawMInputs({ gitPath, repositoryRoot, expectedM });
  const rawR = await readReviewedForkGitObjects({ gitPath, repositoryRoot, reviewedTree });
  if (reviewedExport !== undefined) validateRecordedReviewedExport(reviewedExport, reviewedTree);
  const vendorRelative = "services/openclaw-zalo-cell/vendor/zalouser-bridge";
  const vendorRoot = resolve(sourceRoot, ...vendorRelative.split("/"));
  const committedOptions = { repoRoot: sourceRoot, vendorRoot };
  const committed = reviewedExport
    ? await verifyCommittedInputs({
        ...committedOptions,
        reviewedExportManifestPath: reviewedExport.manifest_path,
        reviewedExportManifestSha256: reviewedExport.manifest_sha256,
        reviewedTree: reviewedExport.reviewed_tree,
      })
    : await verifyCommittedInputsWithoutAmbient(committedOptions, verifyCommittedInputs);
  const upstream = committed.upstream;
  const upstreamPath = `${vendorRelative}/UPSTREAM.json`;
  const upstreamRecord = rawM.upstreamRecord;
  const rUpstreamRecord = await committedFileRecord(sourceRoot, upstreamPath);
  if (
    rUpstreamRecord.git_object_id !== committed.upstreamBlobOid ||
    rUpstreamRecord.sha256 !== committed.upstreamSha256 ||
    upstreamRecord.git_object_id !== rUpstreamRecord.git_object_id ||
    upstreamRecord.sha256 !== rUpstreamRecord.sha256 ||
    rawM.aggregateSha256 !== committed.aggregateSha256 ||
    rawM.records.length !== committed.inputCount ||
    rawM.upstream.sourceManifest.length !== committed.sourceBlobCount ||
    JSON.stringify(rawM.upstream) !== JSON.stringify(upstream)
  ) {
    throw new Error("supply-chain raw M and reviewed R UPSTREAM.json binding mismatch");
  }
  const rawMByPath = new Map(rawM.records.map((record) => [record.path, record]));
  const provenanceInputs = [];
  for (const input of upstream.provenanceInputs) {
    const repositoryPath = `${vendorRelative}/${input.path}`;
    const record = rawMByPath.get(repositoryPath);
    const reviewedRRecord = await committedFileRecord(sourceRoot, repositoryPath);
    if (
      !record || record.size !== input.size || record.sha256 !== input.sha256 ||
      reviewedRRecord.git_object_id !== record.git_object_id ||
      reviewedRRecord.size !== record.size || reviewedRRecord.sha256 !== record.sha256
    ) {
      throw new Error(`supply-chain provenance input mismatch: ${input.path}`);
    }
    provenanceInputs.push({
      path: record.path,
      mode: record.mode,
      git_object_id: record.git_object_id,
      size: record.size,
      sha256: record.sha256,
      endpoint: input.endpoint,
      cap: input.cap,
    });
  }

  const forkPath = rawR.forkRecord.path;
  const fork = rawR.fork;
  const artifactRecord = rawR.artifactRecord;
  const licensePath = `${vendorRelative}/${upstream.licenseManifestPath}`;
  const rawLicenseRecord = rawMByPath.get(licensePath);
  const reviewedRLicenseRecord = await committedFileRecord(sourceRoot, licensePath);
  if (
    !rawLicenseRecord || rawLicenseRecord.sha256 !== upstream.licenseManifestSha256 ||
    reviewedRLicenseRecord.git_object_id !== rawLicenseRecord.git_object_id ||
    reviewedRLicenseRecord.sha256 !== rawLicenseRecord.sha256
  ) {
    throw new Error("supply-chain license manifest hash mismatch");
  }
  const licenseRecord = {
    path: rawLicenseRecord.path,
    mode: rawLicenseRecord.mode,
    git_object_id: rawLicenseRecord.git_object_id,
    size: rawLicenseRecord.size,
    sha256: rawLicenseRecord.sha256,
  };
  const npmSpkiSha256 = sha256(Buffer.from(upstream.npmSignature.spki, "base64"));

  return {
    m_reviewed_tree: expectedM,
    git_binding: gitBinding,
    committed_inputs: {
      input_count: rawM.records.length,
      source_blob_count: rawM.upstream.sourceManifest.length,
      aggregate_sha256: rawM.aggregateSha256,
      upstream_json: {
        path: upstreamRecord.path,
        mode: upstreamRecord.mode,
        git_object_id: upstreamRecord.git_object_id,
        size: upstreamRecord.size,
        sha256: upstreamRecord.sha256,
      },
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
        mode: rawR.forkRecord.mode,
        git_object_id: rawR.forkRecord.git_object_id,
        size: rawR.forkRecord.size,
        sha256: rawR.forkRecord.sha256,
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

export async function reacquireQualifyingInputs(
  { reviewedTree, reviewedExport, sourceRoot },
  verifyOnline,
) {
  validateRecordedReviewedExport(reviewedExport, reviewedTree);
  const onlineVerifier = verifyOnline ??
    (await getUpstreamVerifier({ requireQualifyingAuthority: true })).verifyOnlineInputs;
  if (typeof onlineVerifier !== "function") {
    throw new TypeError("qualifying online verifier must be a function");
  }
  if (verifyOnline === undefined && !isAbsolute(sourceRoot ?? "")) {
    throw new Error("qualifying online verifier source root must be absolute");
  }
  const online = await onlineVerifier({
    ...(verifyOnline === undefined
      ? { vendorRoot: resolve(sourceRoot, ...VENDOR_REPOSITORY_PATH.split("/")) }
      : {}),
    reviewedExportManifestPath: reviewedExport.manifest_path,
    reviewedExportManifestSha256: reviewedExport.manifest_sha256,
    reviewedTree,
  });
  if (
    online.inputCount !== 87 ||
    online.provenanceInputCount !== 4 ||
    online.sourceBlobCount !== 75 ||
    online.sigstore?.npm !== "verified" ||
    online.sigstore?.slsa !== "verified" ||
    online.sigstore?.rekorEntries !== 2
  ) {
    throw new Error("qualifying online provenance result is incomplete");
  }
  return online;
}

export async function collectQualifyingSupplyChainEvidence({
  gitPath,
  sourceRoot,
  expectedM,
  repositoryRoot = sourceRoot,
  reviewedTree,
  reviewedExport,
}) {
  const { verifySigstoreAttestations } = await getUpstreamVerifier({
    requireQualifyingAuthority: true,
  });
  const online = await reacquireQualifyingInputs({ reviewedTree, reviewedExport, sourceRoot });
  const metadata = await collectSupplyChainMetadata({
    gitPath,
    sourceRoot,
    expectedM,
    repositoryRoot,
    reviewedTree,
    reviewedExport,
  });
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
  const rawM = await collectRawMInputs({ gitPath, repositoryRoot, expectedM });
  const sigstoreInputs = sigstoreInputsFromRawM(rawM);
  const sigstore = verifySigstoreAttestations({
    vendorRoot,
    tarballBytes,
    upstream: sigstoreInputs.upstream,
    metadata: sigstoreInputs.metadata,
    keys: sigstoreInputs.keys,
    attestations: sigstoreInputs.attestations,
    trustRoot: sigstoreInputs.trustRoot,
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
      online_reacquired: true,
      online_input_count: online.inputCount,
      online_provenance_input_count: online.provenanceInputCount,
      online_source_blob_count: online.sourceBlobCount,
      verified_tarball_sha256: sha256(tarballBytes),
    },
  };
}

export async function validateRecordedSupplyChainEvidence(
  recorded,
  {
    gitPath,
    sourceRoot,
    expectedM,
    repositoryRoot = sourceRoot,
    reviewedTree,
    reviewedExport,
  },
) {
  exactKeys(recorded, ["m_reviewed_tree", "git_binding", "committed_inputs", "upstream", "fork", "proof"], "supply-chain evidence");
  const expected = await collectSupplyChainMetadata({
    gitPath,
    sourceRoot,
    expectedM,
    repositoryRoot,
    reviewedTree,
    reviewedExport,
  });
  assertJsonEqual(
    {
      m_reviewed_tree: recorded.m_reviewed_tree,
      git_binding: recorded.git_binding,
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
      "online_reacquired",
      "online_input_count",
      "online_provenance_input_count",
      "online_source_blob_count",
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
    recorded.proof.online_reacquired !== true ||
    recorded.proof.online_input_count !== 87 ||
    recorded.proof.online_provenance_input_count !== 4 ||
    recorded.proof.online_source_blob_count !== 75 ||
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
  expectedM,
  reviewedTree,
  releaseArtifactPath,
  reproductionArtifactPath,
  gitPath,
  gitRepositoryRoot,
  mReviewReportPath,
  rReviewReportPath,
  stockArchivePath,
  upstreamTarballPath,
  behaviorRunnerPath,
  dockerPath,
  dockerHost,
  dockerSha256,
  executionAuthority,
  invoke = invokeNativeBounded,
  verifierPath = fileURLToPath(import.meta.url),
}) {
  if (!isAbsolute(evidencePath)) throw new Error("evidence path must be absolute");
  if (!isAbsolute(schemaPath)) throw new Error("schema path must be absolute");
  if (!isAbsolute(releaseArtifactPath)) throw new Error("release artifact path must be absolute");
  if (!isAbsolute(reproductionArtifactPath)) throw new Error("reproduction artifact path must be absolute");
  if (!REVIEWED_TREE.test(expectedM)) throw new Error("invalid ExpectedM");
  if (!REVIEWED_TREE.test(reviewedTree)) throw new Error("invalid reviewed tree");
  if (!isAbsolute(gitPath ?? "")) throw new Error("Git path must be absolute");
  if (!isAbsolute(gitRepositoryRoot)) throw new Error("Git repository root must be absolute");
  if (!isAbsolute(mReviewReportPath) || !isAbsolute(rReviewReportPath)) {
    throw new Error("retained review report paths must be absolute");
  }
  for (const [path, label] of [
    [stockArchivePath, "retained stock OCI"],
    [upstreamTarballPath, "retained upstream tgz"],
    [behaviorRunnerPath, "retained behavior runner"],
    [dockerPath, "Docker CLI"],
    [gitPath, "Git executable"],
  ]) {
    if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  }
  if (!HEX_64.test(dockerSha256 ?? "")) throw new Error("invalid Docker sha256");
  await Promise.all([
    assertPathHasNoSymbolicLink(evidencePath, "evidence"),
    assertPathHasNoSymbolicLink(schemaPath, "evidence schema"),
    assertPathHasNoSymbolicLink(releaseArtifactPath, "release artifact"),
    assertPathHasNoSymbolicLink(reproductionArtifactPath, "reproduction artifact"),
    assertPathHasNoSymbolicLink(gitRepositoryRoot, "Git repository root"),
    assertPathHasNoSymbolicLink(mReviewReportPath, "retained M review report"),
    assertPathHasNoSymbolicLink(rReviewReportPath, "retained R review report"),
    assertPathHasNoSymbolicLink(stockArchivePath, "retained stock OCI"),
    assertPathHasNoSymbolicLink(upstreamTarballPath, "retained upstream tgz"),
    assertPathHasNoSymbolicLink(behaviorRunnerPath, "retained behavior runner"),
    assertPathHasNoSymbolicLink(dockerPath, "Docker CLI"),
    assertPathHasNoSymbolicLink(gitPath, "Git executable"),
  ]);
  const lockResult = await verifyImageLock({ root, lockPath });
  const gitAuthority = await assertTrustedGitExecutable({
    gitPath,
    expectedVersion: lockResult.lock.git.version,
    expectedSha256: lockResult.lock.git.linux_amd64_sha256,
  });
  const gitBinding = await verifyGitLineage({
    gitPath,
    repositoryRoot: gitRepositoryRoot,
    expectedM,
    reviewedTree,
  });
  const [, , , behaviorRunnerRecord] = await Promise.all([
    verifyReviewedVerifierBlob({ gitPath, repositoryRoot: gitRepositoryRoot, reviewedTree, verifierPath }),
    verifyReviewedFileBlob({
      gitPath,
      repositoryRoot: gitRepositoryRoot,
      reviewedTree,
      filePath: schemaPath,
      repositoryPath: "services/openclaw-zalo-cell/build-evidence.schema.v1.json",
      label: "reviewed evidence schema",
    }),
    verifyReviewedFileBlob({
      gitPath,
      repositoryRoot: gitRepositoryRoot,
      reviewedTree,
      filePath: lockPath,
      repositoryPath: "services/openclaw-zalo-cell/image-lock.json",
      label: "reviewed image lock",
    }),
    verifyReviewedFileBlob({
      gitPath,
      repositoryRoot: gitRepositoryRoot,
      reviewedTree,
      filePath: behaviorRunnerPath,
      repositoryPath: "services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs",
      label: "reviewed behavior runner",
    }),
  ]);
  const [mReport, rReport] = await Promise.all([
    readCanonicalReviewReport(mReviewReportPath, {
      checkpoint: "M",
      reviewedSha: expectedM,
      repositoryRoot: gitRepositoryRoot,
    }),
    readCanonicalReviewReport(rReviewReportPath, {
      checkpoint: "R",
      reviewedSha: reviewedTree,
      repositoryRoot: gitRepositoryRoot,
    }),
  ]);
  const evidenceItem = await lstat(evidencePath);
  const schemaItem = await lstat(schemaPath);
  const archiveItem = await lstat(releaseArtifactPath);
  const reproductionItem = await lstat(reproductionArtifactPath);
  for (const [item, label] of [
    [evidenceItem, "evidence"],
    [schemaItem, "evidence schema"],
    [archiveItem, "release artifact"],
    [reproductionItem, "reproduction artifact"],
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
  verifyExecutionAuthorityReplay(evidence, executionAuthority);
  if (evidence.expected_m !== expectedM) throw new Error("build evidence ExpectedM mismatch");
  if (evidence.reviewed_tree !== reviewedTree) throw new Error("build evidence reviewed tree mismatch");
  authenticateEvidenceReviews(evidence.reviews, {
    expectedM,
    reviewedTree,
    mReport,
    rReport,
  });
  validateRecordedReviewedExport(evidence.reviewed_export, reviewedTree);
  await validateRecordedSupplyChainEvidence(evidence.supply_chain, {
    gitPath,
    sourceRoot: resolve(root, "../.."),
    expectedM,
    repositoryRoot: gitRepositoryRoot,
    reviewedTree,
  });
  assertJsonEqual(evidence.supply_chain.git_binding, gitBinding, "supply-chain Git binding");

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
  const retainedInputs = await verifyRetainedQualificationInputs(evidence.retained_inputs, {
    archiveAPath: releaseArtifactPath,
    archiveBPath: reproductionArtifactPath,
    stockArchivePath,
    upstreamTarballPath,
    behaviorRunnerPath,
  });
  if (
    retainedInputs.upstream_tgz.sha256 !== evidence.supply_chain.upstream.tarball.sha256 ||
    retainedInputs.upstream_tgz.size !== evidence.supply_chain.upstream.tarball.size
  ) {
    throw new Error("retained upstream tgz does not match authenticated supply-chain evidence");
  }
  const { inspectTarball, verifySigstoreAttestations } = await getUpstreamVerifier({
    requireQualifyingAuthority: true,
  });
  const retainedTarballBytes = await readFile(upstreamTarballPath);
  const retainedRawM = await collectRawMInputs({ gitPath, repositoryRoot: gitRepositoryRoot, expectedM });
  const retainedSigstoreInputs = sigstoreInputsFromRawM(retainedRawM);
  inspectTarball(retainedTarballBytes, retainedSigstoreInputs.upstream);
  const retainedSigstore = verifySigstoreAttestations({
    vendorRoot: resolve(root, "vendor/zalouser-bridge"),
    tarballBytes: retainedTarballBytes,
    upstream: retainedSigstoreInputs.upstream,
    metadata: retainedSigstoreInputs.metadata,
    keys: retainedSigstoreInputs.keys,
    attestations: retainedSigstoreInputs.attestations,
    trustRoot: retainedSigstoreInputs.trustRoot,
  });
  if (
    retainedSigstore.npm !== "verified" ||
    retainedSigstore.slsa !== "verified" ||
    retainedSigstore.rekorEntries !== 2
  ) {
    throw new Error("retained upstream tgz Sigstore verification mismatch");
  }
  if (
    retainedInputs.behavior_runner.sha256 !== behaviorRunnerRecord.sha256 ||
    retainedInputs.behavior_runner.size !== behaviorRunnerRecord.size
  ) {
    throw new Error("retained behavior runner does not match the exact reviewed R Git blob");
  }
  validateRecordedBehaviorEvidence(evidence.plugin_probe.behavior);
  if (
    evidence.plugin_probe.behavior.runner.sha256 !== retainedInputs.behavior_runner.sha256 ||
    evidence.plugin_probe.behavior.runner.size !== retainedInputs.behavior_runner.size ||
    evidence.plugin_probe.behavior.fork_oci.archive_sha256 !== retainedInputs.archive_a.sha256 ||
    evidence.plugin_probe.behavior.stock_oci.archive_sha256 !== retainedInputs.stock_oci.sha256
  ) {
    throw new Error("recorded behavior is not bound to retained runner and OCI inputs");
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
  if (
    evidence.docker_runtime.client_version !== lockResult.lock.docker.version ||
    evidence.docker_runtime.server_version !== lockResult.lock.docker.version ||
    evidence.docker_runtime.sha256 !== lockResult.lock.docker.linux_amd64_sha256 ||
    evidence.docker_runtime.server_os !== "linux" ||
    evidence.docker_runtime.server_arch !== "amd64"
  ) {
    throw new Error("build evidence Docker runtime lock mismatch");
  }
  if (evidence.docker_runtime.sha256 !== dockerSha256) {
    throw new Error("build evidence Docker runtime authority mismatch");
  }

  const canonicalArchive = resolve(releaseArtifactPath);
  if (evidence.oci.promoted_archive_role !== "A") {
    throw new Error("build evidence promoted archive role mismatch");
  }
  const archiveHash = await hashFile(canonicalArchive);
  for (const [field, value] of [
    ["archive_a_sha256", evidence.oci.archive_a_sha256],
    ["archive_b_sha256", evidence.oci.archive_b_sha256],
    ["promoted_archive_sha256", evidence.oci.promoted_archive_sha256],
  ]) {
    if (value !== archiveHash.sha256) throw new Error(`build evidence ${field} mismatch`);
  }
  if (
    retainedInputs.archive_a.sha256 !== archiveHash.sha256 ||
    retainedInputs.archive_b.sha256 !== archiveHash.sha256 ||
    evidence.plugin_probe.behavior.fork_oci.archive_sha256 !== archiveHash.sha256
  ) {
    throw new Error("build evidence retained fork OCI identities mismatch");
  }
  const { fork } = await readReviewedForkGitObjects({
    gitPath,
    repositoryRoot: gitRepositoryRoot,
    reviewedTree,
  });
  validateRecordedRuntimeEvidence(fork, evidence.runtime_reachability);
  const expectedDiscoveryRoots = ["/home/node/.openclaw/npm/projects/zalouser", ZALOUSER_PLUGIN_ROOT];
  for (const variant of ["fork", "stock"]) {
    const probe = evidence.plugin_probe[variant];
    if (
      probe.plugin.id !== "zalouser" ||
      probe.plugin.version !== "2026.7.1" ||
      probe.plugin.root_dir !== ZALOUSER_PLUGIN_ROOT ||
      probe.inspect.root_dir !== ZALOUSER_PLUGIN_ROOT ||
      probe.inspect.install_path !== ZALOUSER_PLUGIN_ROOT ||
      JSON.stringify(probe.discovery_roots) !== JSON.stringify(expectedDiscoveryRoots)
    ) {
      throw new Error(`build evidence ${variant} plugin discovery proof mismatch`);
    }
  }
  if (
    evidence.plugin_probe.fork.plugin_count !== evidence.plugin_probe.stock.plugin_count ||
    evidence.plugin_probe.private_rpc.method !== "zalouser.bridge.send" ||
    evidence.plugin_probe.private_rpc.scope !== "operator.write" ||
    evidence.plugin_probe.private_rpc.registered_method_count !== 1 ||
    evidence.plugin_probe.private_rpc.unconfigured_startup_denied !== true ||
    evidence.plugin_probe.private_rpc.unconfigured_error_code !== "BRIDGE_CONFIGURATION_INVALID" ||
    evidence.plugin_probe.private_rpc.denied_without_authenticated_client !== true ||
    evidence.plugin_probe.private_rpc.error_code !== "PRIVATE_BRIDGE_CLIENT_DENIED" ||
    evidence.plugin_probe.private_rpc.provider_frame_count !== 0
  ) {
    throw new Error("build evidence plugin discovery/private RPC proof mismatch");
  }
  const inspectedOci = await verifyOciRuntimeImage({
    archivePath: canonicalArchive,
    fork,
    lock: lockResult.lock,
  });
  const inspectedReproductionOci = await verifyOciRuntimeImage({
    archivePath: resolve(reproductionArtifactPath),
    fork,
    lock: lockResult.lock,
  });
  assertJsonEqual(inspectedReproductionOci, inspectedOci, "retained OCI A/B inspection");
  const [rawUpstreamRecord] = await readGitBlobRecords({
    gitPath,
    repositoryRoot: gitRepositoryRoot,
    commit: expectedM,
    paths: [UPSTREAM_REPOSITORY_PATH],
  });
  const rawUpstream = parseJsonStrict(rawUpstreamRecord.bytes, "raw M UPSTREAM.json");
  const inspectedStockOci = await verifyStockOciRuntimeImage({
    archivePath: stockArchivePath,
    upstreamTarballPath,
    upstream: rawUpstream,
    lock: lockResult.lock,
  });
  if (
    inspectedStockOci.upstream_tgz_sha256 !== retainedInputs.upstream_tgz.sha256 ||
    inspectedOci.manifest_digest !== evidence.plugin_probe.behavior.fork_oci.manifest_digest ||
    inspectedStockOci.manifest_digest !== evidence.plugin_probe.behavior.stock_oci.manifest_digest
  ) {
    throw new Error("build evidence behavior OCI/upstream identity mismatch");
  }
  await replayRecordedBehaviorEvidence({
    recorded: evidence.plugin_probe.behavior,
    archiveAPath: canonicalArchive,
    archiveBPath: resolve(reproductionArtifactPath),
    stockArchivePath,
    behaviorRunnerPath,
    dockerPath,
    dockerHost,
    dockerSha256,
    expectedDockerVersion: lockResult.lock.docker.version,
    invoke,
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
  await Promise.all([
    verifyReviewedVerifierBlob({ gitPath, repositoryRoot: gitRepositoryRoot, reviewedTree, verifierPath }),
    verifyReviewedFileBlob({
      gitPath,
      repositoryRoot: gitRepositoryRoot,
      reviewedTree,
      filePath: schemaPath,
      repositoryPath: "services/openclaw-zalo-cell/build-evidence.schema.v1.json",
      label: "reviewed evidence schema",
    }),
    verifyReviewedFileBlob({
      gitPath,
      repositoryRoot: gitRepositoryRoot,
      reviewedTree,
      filePath: lockPath,
      repositoryPath: "services/openclaw-zalo-cell/image-lock.json",
      label: "reviewed image lock",
    }),
    verifyReviewedFileBlob({
      gitPath,
      repositoryRoot: gitRepositoryRoot,
      reviewedTree,
      filePath: behaviorRunnerPath,
      repositoryPath: "services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs",
      label: "reviewed behavior runner",
    }),
  ]);
  await verifyRetainedQualificationInputs(evidence.retained_inputs, {
    archiveAPath: releaseArtifactPath,
    archiveBPath: reproductionArtifactPath,
    stockArchivePath,
    upstreamTarballPath,
    behaviorRunnerPath,
  });
  await assertTrustedGitAuthorityUnchanged({
    authority: gitAuthority,
    repositoryRoot: gitRepositoryRoot,
    expectedM,
    reviewedTree,
    expectedBinding: gitBinding,
  });
  return { evidence_sha256: sha256(evidenceBytes), archive_sha256: archiveHash.sha256 };
}

const CLI_OPTIONS = new Set([
  "mode", "root", "lock", "schema", "evidence", "expected-m", "reviewed-tree",
  "release-artifact", "git-repository-root", "m-review-report", "r-review-report",
  "reviewed-source-root", "reviewed-export-manifest", "reviewed-export-manifest-sha256",
  "oci-a", "oci-b", "stock-oci", "upstream-tgz", "behavior-runner",
  "buildx-path", "buildx-sha256", "docker-path", "docker-host", "docker-sha256", "git-path",
  "approval-manifest",
]);
const CLI_MODES = new Set(["lock", "qualify", "evidence-replay-v1"]);

export function parseCliArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key}`);
    const name = key.slice(2);
    if (!CLI_OPTIONS.has(name)) throw new Error(`unknown option: --${name}`);
    if (Object.hasOwn(result, name)) throw new Error(`duplicate option: --${name}`);
    result[name] = value;
  }
  if (result.mode !== undefined && !CLI_MODES.has(result.mode)) {
    throw new Error(`unsupported verifier mode: ${result.mode}`);
  }
  return result;
}

const CLI_MODE_CONTRACTS = {
  lock: {
    allowed: [
      "mode", "root", "lock", "expected-m", "reviewed-tree", "git-repository-root",
      "m-review-report", "r-review-report", "reviewed-source-root",
      "reviewed-export-manifest", "reviewed-export-manifest-sha256",
      "git-path",
    ],
    required: [],
  },
  qualify: {
    allowed: [...CLI_OPTIONS],
    required: [
      "git-path", "schema", "evidence", "expected-m", "reviewed-tree", "git-repository-root",
      "m-review-report", "r-review-report", "reviewed-source-root",
      "reviewed-export-manifest", "reviewed-export-manifest-sha256", "oci-a", "oci-b",
      "stock-oci", "upstream-tgz", "behavior-runner", "release-artifact", "buildx-path",
      "buildx-sha256", "docker-path", "docker-host", "docker-sha256",
      "approval-manifest",
    ],
  },
  "evidence-replay-v1": {
    allowed: [
      "mode", "root", "lock", "schema", "evidence", "expected-m", "reviewed-tree",
      "git-repository-root", "m-review-report", "r-review-report", "oci-a", "oci-b",
      "stock-oci", "upstream-tgz", "behavior-runner", "docker-path", "docker-sha256",
      "docker-host", "git-path",
      "approval-manifest",
    ],
    required: [
      "evidence", "git-path", "schema", "expected-m", "reviewed-tree", "git-repository-root",
      "m-review-report", "r-review-report", "oci-a", "oci-b", "stock-oci",
      "upstream-tgz", "behavior-runner", "docker-path", "docker-sha256",
      "docker-host",
      "approval-manifest",
    ],
  },
};

export function validateCliModeArguments(args) {
  const mode = args.mode ?? "lock";
  const contract = CLI_MODE_CONTRACTS[mode];
  if (!contract) throw new Error(`unsupported verifier mode: ${mode}`);
  const allowed = new Set(contract.allowed);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`--${key} is not allowed in ${mode} mode`);
  }
  for (const key of contract.required) {
    if (!args[key]) throw new Error(`--${key} is required in ${mode} mode`);
  }
  return mode;
}

async function readReviewsFromArgs(args) {
  const required = [
    "expected-m",
    "reviewed-tree",
    "m-review-report",
    "r-review-report",
    "git-repository-root",
  ];
  const present = required.filter((key) => args[key]);
  if (present.length === 0) return undefined;
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
  if (!REVIEWED_TREE.test(args["expected-m"])) throw new Error("invalid ExpectedM");
  if (!REVIEWED_TREE.test(args["reviewed-tree"])) throw new Error("invalid reviewed tree");
  if (args["expected-m"] === args["reviewed-tree"]) {
    throw new Error("M and R reviewed trees must be distinct");
  }
  const [mReport, rReport] = await Promise.all([
    readCanonicalReviewReport(args["m-review-report"], {
      checkpoint: "M",
      reviewedSha: args["expected-m"],
      repositoryRoot: args["git-repository-root"],
    }),
    readCanonicalReviewReport(args["r-review-report"], {
      checkpoint: "R",
      reviewedSha: args["reviewed-tree"],
      repositoryRoot: args["git-repository-root"],
    }),
  ]);
  return { M: mReport.record, R: rReport.record };
}

export function createExecutionAuthorityRecord({
  manifestBytes,
  expectedM,
  reviewedTree,
  authorityRecords,
}) {
  const bytes = Buffer.from(manifestBytes);
  const manifest = parseTask2ApprovalManifest(bytes);
  if (manifest.expected_m !== expectedM || manifest.reviewed_tree !== reviewedTree) {
    throw new Error("Task 2 execution authority M/R binding mismatch");
  }
  if (!Array.isArray(authorityRecords) || authorityRecords.length !== Object.keys(manifest.authorities).length) {
    throw new Error("Task 2 execution authority raw-R record set is incomplete");
  }
  const byPath = new Map();
  for (const record of authorityRecords) {
    if (byPath.has(record?.path)) throw new Error("Task 2 execution authority raw-R record path is duplicated");
    byPath.set(record?.path, record);
  }
  for (const binding of Object.values(manifest.authorities)) {
    const record = byPath.get(binding.repository_path);
    if (
      !record ||
      record.git_object_id !== binding.blob_oid ||
      record.size !== binding.size ||
      record.sha256 !== binding.sha256
    ) {
      throw new Error(`Task 2 execution authority raw-R binding mismatch: ${binding.repository_path}`);
    }
  }
  return Object.freeze({
    approval_manifest_base64: bytes.toString("base64"),
    approval_manifest_size: bytes.length,
    approval_manifest_sha256: sha256(bytes),
    expected_m: manifest.expected_m,
    reviewed_tree: manifest.reviewed_tree,
    authorities: manifest.authorities,
    runtime: manifest.runtime,
  });
}

export function attachExecutionAuthorityToEvidence(evidence, executionAuthority) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new TypeError("qualification evidence must be an object");
  }
  if (!executionAuthority || typeof executionAuthority !== "object" || Array.isArray(executionAuthority)) {
    throw new TypeError("Task 2 execution authority record is required");
  }
  if (Object.hasOwn(evidence, "execution_authority")) {
    throw new Error("qualification evidence already contains an execution authority record");
  }
  if (!evidence.verification || typeof evidence.verification !== "object" || Array.isArray(evidence.verification)) {
    throw new TypeError("qualification evidence verification record is required");
  }
  return Object.freeze({
    ...evidence,
    execution_authority: executionAuthority,
    verification: Object.freeze({
      ...evidence.verification,
      execution_authority: true,
    }),
  });
}

export function verifyExecutionAuthorityReplay(evidence, reconstructedExecutionAuthority) {
  if (evidence?.verification?.execution_authority !== true) {
    throw new Error("build evidence execution authority verification marker is missing");
  }
  if (!reconstructedExecutionAuthority || typeof reconstructedExecutionAuthority !== "object") {
    throw new Error("reconstructed Task 2 execution authority is required");
  }
  assertJsonEqual(
    evidence.execution_authority,
    reconstructedExecutionAuthority,
    "build evidence execution authority",
  );
  return reconstructedExecutionAuthority;
}

async function readExecutionAuthorityFromArgs(args, reviews) {
  const approvalManifestPath = args["approval-manifest"];
  if (!isAbsolute(approvalManifestPath ?? "")) throw new Error("--approval-manifest path must be absolute");
  const expectedPath = resolve(
    "/opt/openclaw-tools/reviewed-task2",
    args["reviewed-tree"],
    "approval-manifest-v1.json",
  );
  if (resolve(approvalManifestPath) !== expectedPath) {
    throw new Error("Task 2 approval manifest path is not the exact installed R-bound authority");
  }
  const binding = await readRegularFileHandleBound(approvalManifestPath, "Task 2 approval manifest");
  const manifest = parseTask2ApprovalManifest(binding.bytes);
  if (
    manifest.review_reports.M.size !== reviews?.M?.report_size ||
    manifest.review_reports.M.sha256 !== reviews?.M?.report_sha256 ||
    manifest.review_reports.R.size !== reviews?.R?.report_size ||
    manifest.review_reports.R.sha256 !== reviews?.R?.report_sha256
  ) {
    throw new Error("Task 2 approval manifest review-report bindings mismatch");
  }
  if (
    manifest.runtime.git.path !== args["git-path"] ||
    manifest.runtime.docker.path !== args["docker-path"] ||
    manifest.runtime.docker.sha256 !== args["docker-sha256"] ||
    manifest.runtime.docker.host !== args["docker-host"] ||
    (args["buildx-path"] && manifest.runtime.buildx.path !== args["buildx-path"]) ||
    (args["buildx-sha256"] && manifest.runtime.buildx.sha256 !== args["buildx-sha256"])
  ) {
    throw new Error("Task 2 approval manifest runtime bindings mismatch");
  }
  const authorityRecords = await readGitBlobRecords({
    gitPath: args["git-path"],
    repositoryRoot: args["git-repository-root"],
    commit: args["reviewed-tree"],
    paths: Object.values(manifest.authorities).map(({ repository_path: path }) => path),
  });
  return createExecutionAuthorityRecord({
    manifestBytes: binding.bytes,
    expectedM: args["expected-m"],
    reviewedTree: args["reviewed-tree"],
    authorityRecords,
  });
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

export function assertAbsoluteQualifyingOperands(args) {
  const qualifying = Boolean(args["oci-a"] || args["oci-b"]);
  const keys = qualifying
    ? [
        "oci-a",
        "oci-b",
        "stock-oci",
        "upstream-tgz",
        "behavior-runner",
        "schema",
        "evidence",
        "release-artifact",
        "m-review-report",
        "r-review-report",
        "git-repository-root",
        "reviewed-source-root",
        "reviewed-export-manifest",
        "buildx-path",
        "docker-path",
        "git-path",
        "approval-manifest",
      ]
    : [
        "evidence",
        "schema",
        "release-artifact",
        "m-review-report",
        "r-review-report",
        "git-repository-root",
        "stock-oci",
        "upstream-tgz",
        "behavior-runner",
        "docker-path",
        "git-path",
        "approval-manifest",
      ];
  for (const key of keys) {
    if (args[key] && !isAbsolute(args[key])) {
      throw new Error(`--${key} path must be absolute`);
    }
  }
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const mode = validateCliModeArguments(args);
  assertAbsoluteQualifyingOperands(args);
  const scriptCellRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const root = resolve(args.root ?? (args.lock ? dirname(args.lock) : scriptCellRoot));
  const lockPath = resolve(args.lock ?? resolve(root, "image-lock.json"));
  let preauthenticatedGitAuthority;
  let preauthenticatedGitBinding;
  if (mode !== "lock") {
    for (const key of ["expected-m", "reviewed-tree", "git-repository-root", "git-path"]) {
      if (!args[key]) throw new Error(`--${key} is required before non-lock verification`);
    }
    const reviewedSourceRoot = mode === "qualify"
      ? args["reviewed-source-root"]
      : resolve(scriptCellRoot, "../..");
    if (!isAbsolute(reviewedSourceRoot ?? "")) {
      throw new Error("reviewed source root is required before non-lock verification");
    }
    preauthenticatedGitAuthority = await assertTrustedGitExecutable({
      gitPath: args["git-path"],
      expectedVersion: "2.53.0",
      expectedSha256: GIT_LINUX_SHA256,
    });
    preauthenticatedGitBinding = await verifyGitLineage({
      gitPath: args["git-path"],
      repositoryRoot: args["git-repository-root"],
      expectedM: args["expected-m"],
      reviewedTree: args["reviewed-tree"],
    });
    await loadReviewedUpstreamVerifier({
      gitPath: args["git-path"],
      repositoryRoot: args["git-repository-root"],
      reviewedTree: args["reviewed-tree"],
      reviewedSourceRoot,
      verifierPath: fileURLToPath(import.meta.url),
    });
    await assertTrustedDockerSocket(args["docker-host"]);
  }
  if (mode === "evidence-replay-v1") {
    for (const key of [
      "evidence",
      "schema",
      "expected-m",
      "reviewed-tree",
      "oci-a",
      "oci-b",
      "git-repository-root",
      "m-review-report",
      "r-review-report",
      "stock-oci",
      "upstream-tgz",
      "behavior-runner",
      "docker-path",
      "docker-host",
      "docker-sha256",
      "git-path",
      "approval-manifest",
    ]) {
      if (!args[key]) throw new Error(`--${key} is required in evidence-replay-v1 mode`);
    }
    const reviews = await readReviewsFromArgs(args);
    const executionAuthority = await readExecutionAuthorityFromArgs(args, reviews);
    const result = await verifyEvidenceFile({
      root,
      lockPath,
      evidencePath: args.evidence,
      schemaPath: args.schema,
      expectedM: args["expected-m"],
      reviewedTree: args["reviewed-tree"],
      releaseArtifactPath: args["oci-a"],
      reproductionArtifactPath: args["oci-b"],
      gitPath: args["git-path"],
      gitRepositoryRoot: args["git-repository-root"],
      mReviewReportPath: args["m-review-report"],
      rReviewReportPath: args["r-review-report"],
      stockArchivePath: args["stock-oci"],
      upstreamTarballPath: args["upstream-tgz"],
      behaviorRunnerPath: args["behavior-runner"],
      dockerPath: args["docker-path"],
      dockerHost: args["docker-host"],
      dockerSha256: args["docker-sha256"],
      executionAuthority,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (mode === "lock" && (args.evidence || args["oci-a"] || args["oci-b"])) {
    throw new Error("lock mode cannot accept evidence or OCI qualification operands");
  }
  if (mode === "qualify" && (!args["oci-a"] || !args["oci-b"])) {
    throw new Error("qualify mode requires --oci-a and --oci-b");
  }
  const lockResult = await verifyImageLock({ root, lockPath });
  const reviewAuthorityKeys = [
    "expected-m",
    "reviewed-tree",
    "m-review-report",
    "r-review-report",
    "git-repository-root",
    "git-path",
  ];
  const reviewAuthorityPresent = reviewAuthorityKeys.filter((key) => args[key]);
  let gitBinding = preauthenticatedGitBinding;
  let gitAuthority = preauthenticatedGitAuthority;
  if (reviewAuthorityPresent.length > 0) {
    for (const key of reviewAuthorityKeys) if (!args[key]) throw new Error(`--${key} is required`);
    if (
      lockResult.lock.git.version !== "2.53.0" ||
      lockResult.lock.git.linux_amd64_sha256 !== GIT_LINUX_SHA256
    ) {
      throw new Error("image lock Git authority disagrees with the pre-authenticated verifier closure");
    }
  }
  const reviews = await readReviewsFromArgs(args);
  const executionAuthority = mode === "qualify"
    ? await readExecutionAuthorityFromArgs(args, reviews)
    : undefined;
  const reviewedExport = await readReviewedExportFromArgs(args);
  const supplyChain =
    reviews && reviewedExport && gitBinding
      ? await collectQualifyingSupplyChainEvidence({
          gitPath: args["git-path"],
          sourceRoot: args["reviewed-source-root"],
          expectedM: args["expected-m"],
          repositoryRoot: args["git-repository-root"],
          reviewedTree: args["reviewed-tree"],
          reviewedExport,
        })
      : undefined;
  if (!args["oci-a"] && !args["oci-b"]) {
    if (gitAuthority) {
      await assertTrustedGitAuthorityUnchanged({
        authority: gitAuthority,
        repositoryRoot: args["git-repository-root"],
        expectedM: args["expected-m"],
        reviewedTree: args["reviewed-tree"],
        expectedBinding: gitBinding,
      });
    }
    process.stdout.write(
      `${JSON.stringify({
        ...lockResult,
        ...(reviews ? { reviews } : {}),
        ...(reviewedExport ? { reviewed_export: reviewedExport } : {}),
        ...(gitBinding ? { git_binding: gitBinding } : {}),
        ...(supplyChain ? { supply_chain: supplyChain } : {}),
      })}\n`,
    );
    return;
  }

  const required = [
    "oci-a",
    "oci-b",
    "stock-oci",
    "upstream-tgz",
    "behavior-runner",
    "expected-m",
    "reviewed-tree",
    "m-review-report",
    "r-review-report",
    "schema",
    "evidence",
    "release-artifact",
    "buildx-path",
    "buildx-sha256",
    "docker-path",
    "docker-host",
    "docker-sha256",
    "git-repository-root",
    "reviewed-source-root",
    "reviewed-export-manifest",
    "reviewed-export-manifest-sha256",
    "git-path",
  ];
  for (const key of required) if (!args[key]) throw new Error(`--${key} is required`);
  if (!reviews) throw new Error("canonical M/R review reports are required");
  if (!reviewedExport) throw new Error("reviewed export binding is required");
  if (!supplyChain) throw new Error("qualifying supply-chain evidence is required");
  if (!gitBinding) throw new Error("ExpectedM/reviewed-R Git binding is required");
  if (!REVIEWED_TREE.test(args["expected-m"])) throw new Error("invalid ExpectedM");
  if (!REVIEWED_TREE.test(args["reviewed-tree"])) throw new Error("invalid reviewed tree");
  if (!isAbsolute(args["buildx-path"])) throw new Error("buildx path must be absolute");
  if (!HEX_64.test(args["buildx-sha256"])) throw new Error("invalid buildx sha256");
  if (!isAbsolute(args["docker-path"])) throw new Error("Docker path must be absolute");
  if (!HEX_64.test(args["docker-sha256"])) throw new Error("invalid Docker sha256");

  const retainedInputs = await captureRetainedQualificationInputs({
    archiveAPath: args["oci-a"],
    archiveBPath: args["oci-b"],
    stockArchivePath: args["stock-oci"],
    upstreamTarballPath: args["upstream-tgz"],
    behaviorRunnerPath: args["behavior-runner"],
  });
  const archive = retainedInputs.archive_a;
  const { fork } = await readReviewedForkGitObjects({
    gitPath: args["git-path"],
    repositoryRoot: args["git-repository-root"],
    reviewedTree: args["reviewed-tree"],
  });
  if (!fork.installedTree || !Array.isArray(fork.installedTree.entries)) {
    throw new Error("FORK.json installedTree is missing");
  }
  const [behaviorRunnerRecord] = await readGitBlobRecords({
    gitPath: args["git-path"],
    repositoryRoot: args["git-repository-root"],
    commit: args["reviewed-tree"],
    paths: ["services/openclaw-zalo-cell/scripts/behavior-probe-runner.mjs"],
  });
  const behaviorRunnerPath = resolve(args["behavior-runner"]);
  const behaviorRunnerBytes = await readFile(behaviorRunnerPath);
  if (
    !behaviorRunnerBytes.equals(behaviorRunnerRecord.bytes) ||
    retainedInputs.behavior_runner.sha256 !== behaviorRunnerRecord.sha256 ||
    retainedInputs.behavior_runner.size !== behaviorRunnerRecord.size
  ) {
    throw new Error("retained behavior runner does not match the exact reviewed R Git blob");
  }
  const oci = await verifyOciRuntimeImage({
    archivePath: args["oci-a"],
    fork,
    lock: lockResult.lock,
  });
  const [rawUpstreamRecord] = await readGitBlobRecords({
    gitPath: args["git-path"],
    repositoryRoot: args["git-repository-root"],
    commit: args["expected-m"],
    paths: [UPSTREAM_REPOSITORY_PATH],
  });
  const rawUpstream = parseJsonStrict(rawUpstreamRecord.bytes, "raw M UPSTREAM.json");
  const upstreamTarballPath = resolve(args["upstream-tgz"]);
  const stockOci = await verifyStockOciRuntimeImage({
    archivePath: args["stock-oci"],
    upstreamTarballPath,
    upstream: rawUpstream,
    lock: lockResult.lock,
  });
  if (stockOci.upstream_tgz_sha256 !== retainedInputs.upstream_tgz.sha256) {
    throw new Error("retained upstream tgz does not match the authenticated stock OCI input");
  }
  const runtimeProbe = await probeOpenClawRuntimeImages({
    archivePath: resolve(args["oci-a"]),
    stockArchivePath: resolve(args["stock-oci"]),
    baseImage: lockResult.lock.base_image,
    dockerPath: args["docker-path"],
    dockerHost: args["docker-host"],
    dockerSha256: args["docker-sha256"],
    expectedDockerVersion: lockResult.lock.docker.version,
    manifestDigest: oci.manifest_digest,
    stockManifestDigest: stockOci.manifest_digest,
    nonce: randomBytes(16).toString("hex"),
    fork,
    behaviorRunnerPath,
    behaviorRunnerSha256: behaviorRunnerRecord.sha256,
  });

  const evidence = attachExecutionAuthorityToEvidence({
    schema_version: 1,
    expected_m: args["expected-m"],
    reviewed_tree: args["reviewed-tree"],
    reviews,
    reviewed_export: reviewedExport,
    supply_chain: supplyChain,
    retained_inputs: retainedInputs,
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
      promoted_archive_role: "A",
      promoted_archive_sha256: archive.sha256,
      ...oci,
    },
    plugin_probe: {
      fork: runtimeProbe.fork,
      stock: runtimeProbe.stock,
      private_rpc: runtimeProbe.private_rpc,
      behavior: runtimeProbe.behavior,
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
      installed_behavior: true,
      runtime_reachability: true,
      reviewed_export: true,
      supply_chain: true,
      rootfs: true,
      private_rpc: true,
    },
  }, executionAuthority);
  validateRecordedBehaviorEvidence(evidence.plugin_probe.behavior);
  if (
    evidence.plugin_probe.behavior.runner.sha256 !== retainedInputs.behavior_runner.sha256 ||
    evidence.plugin_probe.behavior.runner.size !== retainedInputs.behavior_runner.size ||
    evidence.plugin_probe.behavior.fork_oci.archive_sha256 !== retainedInputs.archive_a.sha256 ||
    evidence.plugin_probe.behavior.fork_oci.manifest_digest !== oci.manifest_digest ||
    evidence.plugin_probe.behavior.stock_oci.archive_sha256 !== retainedInputs.stock_oci.sha256 ||
    evidence.plugin_probe.behavior.stock_oci.manifest_digest !== stockOci.manifest_digest
  ) {
    throw new Error("installed behavior evidence is not bound to the retained runner and OCI identities");
  }
  await replayRecordedBehaviorEvidence({
    recorded: evidence.plugin_probe.behavior,
    archiveAPath: resolve(args["oci-a"]),
    archiveBPath: resolve(args["oci-b"]),
    stockArchivePath: resolve(args["stock-oci"]),
    behaviorRunnerPath,
    dockerPath: args["docker-path"],
    dockerHost: args["docker-host"],
    dockerSha256: args["docker-sha256"],
    expectedDockerVersion: lockResult.lock.docker.version,
  });
  await verifyRetainedQualificationInputs(retainedInputs, {
    archiveAPath: args["oci-a"],
    archiveBPath: args["oci-b"],
    stockArchivePath: args["stock-oci"],
    upstreamTarballPath,
    behaviorRunnerPath,
  });
  const schema = JSON.parse(await readFile(args.schema, "utf8"));
  validateJsonSchema(evidence, schema);
  await assertTrustedGitAuthorityUnchanged({
    authority: gitAuthority,
    repositoryRoot: args["git-repository-root"],
    expectedM: args["expected-m"],
    reviewedTree: args["reviewed-tree"],
    expectedBinding: gitBinding,
  });
  await publishVerifiedRelease({
    archivePath: resolve(args["oci-a"]),
    evidence,
    evidencePath: resolve(args.evidence),
    releaseArtifactPath: args["release-artifact"],
    schema,
  });
  await verifyRetainedQualificationInputs(retainedInputs, {
    archiveAPath: args["oci-a"],
    archiveBPath: args["oci-b"],
    stockArchivePath: args["stock-oci"],
    upstreamTarballPath,
    behaviorRunnerPath,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
