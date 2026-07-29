import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";

const testDir = dirname(fileURLToPath(import.meta.url));
const cellRoot = resolve(testDir, "..");

const BASE_IMAGE =
  "ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f";
const BUILDKIT_IMAGE =
  "moby/buildkit:v0.13.2@sha256:9194b5ec1be368f41c516df7f93f7f540630ea06136056b2ffebb62226ed4ad6";
const SOURCE_DATE_EPOCH = "1785062400";
const CONTEXT_GOLDEN =
  "925be74a4fe381076871348887a653659ada468fa21333d5d22585be9e381f4e";
const DOCKER_LINUX_SHA256 =
  "40cdaf7fd0f21089dd9e15b0c3a7dd7f2399027f010e366dac6304ae0615954a";
const GIT_LINUX_SHA256 =
  "5516c9f362c29376ab9a499a33082f9f611941d8c75930c880e30ad109e39c9a";
const NODE_LINUX_SHA256 =
  "d1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c";
const SESSION_DIST = [
  "session-crypto/dist/crypto.js",
  "session-crypto/dist/daemon.js",
  "session-crypto/dist/package.json",
];
const CONTEXT_INPUTS = [
  ".dockerignore",
  "Dockerfile",
  "config/openclaw.json.tmpl",
  "scripts/install-vendored-zalouser.sh",
  "scripts/normalize-openclaw-install.mjs",
  ...SESSION_DIST,
  "vendor/zalouser-bridge/FORK.json",
  "vendor/zalouser-bridge/artifacts/openclaw-zalouser-2026.7.1.tgz",
];

test("root traversal excludes immutable vendor payloads without hiding owned tests", async () => {
  const repoRoot = resolve(cellRoot, "../..");
  const viteSource = await readFile(join(repoRoot, "vite.config.ts"), "utf8");
  const eslintSource = await readFile(join(repoRoot, "eslint.config.js"), "utf8");
  const exclusions = [
    "services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/package/**",
    "services/openclaw-zalo-cell/vendor/zalouser-bridge/artifacts/**",
    "services/openclaw-zalo-cell/vendor/zalouser-bridge/.work/**",
  ];
  for (const exclusion of exclusions) {
    assert.match(viteSource, new RegExp(exclusion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(eslintSource, new RegExp(exclusion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(viteSource, /vendor\/zalouser-bridge\/\*\*['"]?/);
  assert.doesNotMatch(eslintSource, /vendor\/zalouser-bridge\/\*\*['"]?/);
  assert.doesNotMatch(viteSource, /vendor\/zalouser-bridge\/test\//);
  assert.doesNotMatch(eslintSource, /vendor\/zalouser-bridge\/test\//);
});

async function readCell(relativePath) {
  return readFile(join(cellRoot, relativePath), "utf8");
}

async function loadScript(relativePath) {
  return import(pathToFileURL(join(cellRoot, relativePath)).href);
}

function localGitPath() {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return execFileSync(locator, ["git"], { encoding: "utf8" }).split(/\r?\n/u).find(Boolean);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tarBytes(entries) {
  const blocks = [];
  const writeString = (header, offset, length, value) => {
    const bytes = Buffer.from(value, "utf8");
    assert.ok(bytes.length <= length);
    bytes.copy(header, offset);
  };
  const writeOctal = (header, offset, length, value) => {
    const encoded = value.toString(8).padStart(length - 1, "0");
    writeString(header, offset, length - 1, encoded);
    header[offset + length - 1] = 0;
  };
  for (const entry of entries) {
    const body = Buffer.from(entry.bytes ?? Buffer.alloc(0));
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, entry.mtime ?? 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 6, checksum.toString(8).padStart(6, "0"));
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function scratchOciBytes() {
  const layerTar = tarBytes([
    { path: "payload", bytes: Buffer.from("definitely-not-openclaw\n"), mtime: 0 },
  ]);
  const layer = gzipSync(layerTar, { level: 9, mtime: 0 });
  const layerDigest = sha256(layer);
  const config = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [`sha256:${sha256(layerTar)}`] },
      history: [{ created: "1970-01-01T00:00:00Z", created_by: "fixture" }],
    }),
  );
  const configDigest = sha256(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: `sha256:${configDigest}`,
        size: config.length,
      },
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          digest: `sha256:${layerDigest}`,
          size: layer.length,
        },
      ],
    }),
  );
  const manifestDigest = sha256(manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: `sha256:${manifestDigest}`,
          size: manifest.length,
          platform: { architecture: "amd64", os: "linux" },
        },
      ],
    }),
  );
  return tarBytes([
    { path: "blobs/sha256/" + configDigest, bytes: config },
    { path: "blobs/sha256/" + layerDigest, bytes: layer },
    { path: "blobs/sha256/" + manifestDigest, bytes: manifest },
    { path: "index.json", bytes: index },
    { path: "oci-layout", bytes: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
  ]);
}

function passingBehaviorProbe() {
  return {
    schema: 1,
    implementation: "fork",
    status: "PASS",
    checks: {
      inbound: {
        commit_before_dispatch: true,
        error_zero_dispatch: true,
        timeout_zero_dispatch: true,
        corrupt_ack_zero_dispatch: true,
      },
      outbound: {
        text_sent: true,
        media_sent: true,
        unsupported_zero_provider_frames: true,
        authorization_zero_provider_frames: true,
        unknown_after_handoff: true,
        unknown_provider_calls: 1,
        retry_count: 0,
      },
      control: {
        authorized: true,
        rate_limited_zero_provider_frames: true,
        provider_timeout: true,
      },
      session: { restore: true, offline_restart: true },
    },
  };
}

function passingBehaviorTranscript(variant) {
  const makeEvents = (entries) => entries.map((entry, seq) => ({ seq, ...entry }));
  const response = (ok, { code, value = null } = {}) => ({
    kind: "return",
    value: {
      ok,
      value,
      error: code === undefined ? null : { code },
    },
  });
  const delivery = ({ ids, prefix, reasonCode, status, total }) => ({
    knownProviderMessageIds: ids,
    possibleHandoffPrefixLength: prefix,
    reasonCode,
    receipts: ids.map((providerMessageId) => ({ providerMessageId })),
    status,
    totalPartCount: total,
  });
  const base = {
    schema: 3,
    contract: "ihome.zalouser.business.v1",
    implementation: variant,
    package: { name: "@openclaw/zalouser", version: "2026.7.1" },
  };
  if (variant === "stock") {
    return {
      ...base,
      registered_methods: [],
      cases: [{
        id: "outbound-text-authorized",
        outcome: { kind: "error", code: "METHOD_NOT_REGISTERED" },
        events: [],
      }],
    };
  }
  return {
    ...base,
    registered_methods: ["zalouser.bridge.send"],
    cases: [
      {
        id: "inbound-committed",
        outcome: { kind: "return", value: { status: "dispatched" } },
        events: makeEvents([
          { actor: "bridge", operation: "inbound.ready" },
          { actor: "bridge", operation: "inbound.commit" },
          { actor: "plugin", operation: "dispatch-inbound" },
        ]),
      },
      {
        id: "inbound-duplicate",
        outcome: { kind: "return", value: { status: "duplicate" } },
        events: makeEvents([{ actor: "bridge", operation: "inbound.commit" }]),
      },
      {
        id: "inbound-corrupt",
        outcome: { kind: "error", code: "INBOUND_BRIDGE_INVALID_ACK" },
        events: makeEvents([{ actor: "bridge", operation: "inbound.commit" }]),
      },
      {
        id: "outbound-group-text-authorized",
        outcome: response(true, { value: delivery({
          ids: ["provider-0"],
          prefix: 1,
          reasonCode: "ALL_PARTS_ACKNOWLEDGED",
          status: "SENT",
          total: 1,
        }) }),
        events: makeEvents([
          { actor: "bridge", operation: "outbox.authorize-send" },
          {
            actor: "provider", operation: "send-message", callIndex: 0, messageKind: "text",
            text: "probe", threadId: "group-a", type: 1,
          },
        ]),
      },
      {
        id: "outbound-peer-media-authorized",
        outcome: response(true, { value: delivery({
          ids: ["provider-0"],
          prefix: 1,
          reasonCode: "ALL_PARTS_ACKNOWLEDGED",
          status: "SENT",
          total: 1,
        }) }),
        events: makeEvents([
          { actor: "bridge", operation: "media.materialize" },
          { actor: "bridge", operation: "outbox.authorize-send" },
          {
            actor: "provider", operation: "send-message", callIndex: 0, messageKind: "media",
            attachmentBytes: 19,
            attachmentSha256: "c3741084a5f5129dfce6049b9e21c8af58cfa9174265000a63d35f6ad0d3e120",
            threadId: "peer-a",
            type: 0,
          },
        ]),
      },
      { id: "outbound-link-rejected", outcome: response(false, { code: "UNSUPPORTED_BUSINESS_PART" }), events: [] },
      { id: "outbound-reaction-rejected", outcome: response(false, { code: "UNSUPPORTED_BUSINESS_PART" }), events: [] },
      {
        id: "outbound-authorization-denied",
        outcome: response(false, { code: "AUTHORIZATION_DENIED" }),
        events: makeEvents([{ actor: "bridge", operation: "outbox.authorize-send" }]),
      },
      {
        id: "outbound-partial-handoff-unknown",
        outcome: response(true, { value: delivery({
          ids: ["provider-0"],
          prefix: 2,
          reasonCode: "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF",
          status: "UNKNOWN",
          total: 2,
        }) }),
        events: makeEvents([
          { actor: "bridge", operation: "outbox.authorize-send" },
          {
            actor: "provider", operation: "send-message", callIndex: 0, messageKind: "text",
            text: "first", threadId: "peer-a", type: 0,
          },
          {
            actor: "provider", operation: "send-message", callIndex: 1, messageKind: "text",
            text: "second", threadId: "peer-a", type: 0,
          },
        ]),
      },
      {
        id: "control-authorized",
        outcome: { kind: "return", value: null },
        events: makeEvents([
          { actor: "bridge", operation: "control.authorize" },
          { actor: "provider", operation: "typing", threadId: "thread-a", type: 0 },
        ]),
      },
      {
        id: "control-denied",
        outcome: { kind: "error", code: "CONTROL_AUTHORIZATION_DENIED" },
        events: makeEvents([{ actor: "bridge", operation: "control.authorize" }]),
      },
    ],
  };
}

function rawBehaviorRecord(variant) {
  const bytes = Buffer.from(`${JSON.stringify(passingBehaviorTranscript(variant))}\n`, "utf8");
  return {
    transcript_base64: bytes.toString("base64"),
    transcript_size: bytes.length,
    transcript_sha256: sha256(bytes),
  };
}

function recordedBehaviorEvidence({ runnerBytes, forkArchiveBytes, stockArchiveBytes }) {
  return {
    runner: {
      path: "scripts/behavior-probe-runner.mjs",
      size: runnerBytes.length,
      sha256: sha256(runnerBytes),
    },
    fork_oci: {
      archive_sha256: sha256(forkArchiveBytes),
      manifest_digest: `sha256:${"b".repeat(64)}`,
    },
    stock_oci: {
      archive_sha256: sha256(stockArchiveBytes),
      manifest_digest: `sha256:${"c".repeat(64)}`,
    },
    fork: rawBehaviorRecord("fork"),
    stock: rawBehaviorRecord("stock"),
  };
}

function collectObjects(value, path = "$") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return [[path, value]].concat(
    Object.entries(value).flatMap(([key, child]) =>
      collectObjects(child, `${path}.${key}`),
    ),
  );
}

test("Dockerfile is an exact two-stage pinned offline image assembly", async () => {
  const dockerfile = await readCell("Dockerfile");
  const fromLines = dockerfile.match(/^FROM\s+.+$/gim) ?? [];

  assert.deepEqual(fromLines, [
    `FROM ${BASE_IMAGE} AS install`,
    `FROM ${BASE_IMAGE} AS runtime`,
  ]);
  assert.equal((dockerfile.match(/RUN --network=none/g) ?? []).length, 1);
  assert.match(
    dockerfile,
    /RUN --network=none node -e ['"]const m=\/\^v24\\\.\(0\|\[1-9\]\\d\*\)\\\.\(0\|\[1-9\]\\d\*\)\$\//,
  );
  assert.ok(
    dockerfile.indexOf("node -e") <
      dockerfile.indexOf("install-vendored-zalouser.sh --offline"),
  );
  assert.match(dockerfile, /test ! -e \/tmp\/npm-empty/);
  assert.match(dockerfile, /find \/tmp\/npm-empty -mindepth 1/);
  assert.doesNotMatch(dockerfile, /npm\s+ci|npm\s+run\s+build|\btsc\b/);

  for (const distPath of SESSION_DIST) {
    assert.equal(
      (dockerfile.match(new RegExp(distPath.replaceAll(".", "\\."), "g")) ?? [])
        .length,
      2,
      `${distPath} must appear once as COPY source and once as destination`,
    );
  }
  assert.doesNotMatch(
    dockerfile,
    /session-crypto\/(src|package-lock\.json|tsconfig|node_modules|dist\/.*\.d\.ts)/,
  );
});

test("stock behavior control installs the authenticated upstream ZaloUser offline", async () => {
  const dockerfile = await readCell("Dockerfile.stock-probe");
  const installer = await readCell("scripts/install-stock-zalouser-probe.sh");
  const fromLines = dockerfile.match(/^FROM\s+.+$/gim) ?? [];
  assert.deepEqual(fromLines, [
    `FROM ${BASE_IMAGE} AS install`,
    `FROM ${BASE_IMAGE} AS runtime`,
  ]);
  assert.match(dockerfile, /RUN --network=none/);
  assert.match(dockerfile, /verified-upstream\.tgz/);
  assert.match(dockerfile, /install-stock-zalouser-probe\.sh --offline --cache \/tmp\/npm-empty --no-fallback/);
  assert.doesNotMatch(dockerfile, /curl|wget|npm\s+(?:ci|view)|https?:\/\//i);
  assert.match(installer, /e4022d5dc39009460523b796445c089caedce7e875a816d0e4cd18e8a48a0089/);
  assert.match(installer, /NPM_CONFIG_OFFLINE=true/);
  assert.match(installer, /NPM_CONFIG_REGISTRY=http:\/\/127\.0\.0\.1:9/);
  assert.match(installer, /--offline/);
  assert.match(installer, /--ignore-scripts/);
  assert.doesNotMatch(installer, /curl|wget|https:\/\//i);
});

test("docker context is deny-by-default and admits only reviewed runtime inputs", async () => {
  const rules = (await readCell(".dockerignore"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  assert.deepEqual(rules, [
    "**",
    "!Dockerfile",
    "!.dockerignore",
    "!image-lock.json",
    "!config/",
    "!config/openclaw.json.tmpl",
    "!scripts/",
    "!scripts/install-vendored-zalouser.sh",
    "!scripts/normalize-openclaw-install.mjs",
    "!vendor/",
    "!vendor/zalouser-bridge/",
    "!vendor/zalouser-bridge/FORK.json",
    "!vendor/zalouser-bridge/artifacts/",
    "!vendor/zalouser-bridge/artifacts/openclaw-zalouser-2026.7.1.tgz",
    "!session-crypto/",
    "!session-crypto/dist/",
    "!session-crypto/dist/package.json",
    "!session-crypto/dist/crypto.js",
    "!session-crypto/dist/daemon.js",
  ]);
});

test("context-root v2 matches the approved independent golden vector", async () => {
  const { computeContextRootV2 } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const lockSha256 = sha256(Buffer.alloc(0));
  const inputs = [
    {
      path: "Dockerfile",
      type: "blob",
      mode: "100644",
      size: Buffer.byteLength("FROM scratch\n"),
      sha256: sha256(Buffer.from("FROM scratch\n")),
    },
    {
      path: "scripts/install.sh",
      type: "blob",
      mode: "100755",
      size: Buffer.byteLength("#!/bin/sh\nexit 0\n"),
      sha256: sha256(Buffer.from("#!/bin/sh\nexit 0\n")),
    },
  ];

  assert.equal(computeContextRootV2(lockSha256, inputs), CONTEXT_GOLDEN);
});

test("image lock binds every admitted file and the exact session dist closure", async () => {
  const { verifyImageLock } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const result = await verifyImageLock({
    root: cellRoot,
    lockPath: join(cellRoot, "image-lock.json"),
  });

  assert.equal(result.lock.schema_version, 2);
  assert.equal(result.lock.source_date_epoch, SOURCE_DATE_EPOCH);
  assert.equal(result.lock.platform, "linux/amd64");
  assert.equal(result.lock.base_image, BASE_IMAGE);
  assert.equal(result.lock.buildkit_image, BUILDKIT_IMAGE);
  assert.deepEqual(result.lock.docker, {
    version: "29.1.3",
    linux_amd64_sha256: DOCKER_LINUX_SHA256,
  });
  assert.deepEqual(result.lock.git, {
    version: "2.53.0",
    linux_amd64_sha256: GIT_LINUX_SHA256,
  });
  assert.deepEqual(result.lock.node, {
    version: "24.15.0",
    linux_amd64_size: 122889056,
    linux_amd64_sha256: NODE_LINUX_SHA256,
  });
  assert.deepEqual(
    result.lock.inputs.map(({ path }) => path),
    CONTEXT_INPUTS,
  );
  assert.deepEqual(
    result.lock.inputs
      .filter(({ path }) => path.startsWith("session-crypto/dist/"))
      .map(({ path }) => path),
    SESSION_DIST,
  );
  assert.match(result.contextRootSha256, /^[0-9a-f]{64}$/);
});

test("vendored installer verifies the local artifact before a no-network npm install", async () => {
  const script = await readCell("scripts/install-vendored-zalouser.sh");
  const verifyOffset = script.indexOf("artifact sha256 mismatch");
  const installOffset = script.indexOf("npm install");

  assert.match(script, /^#!\/bin\/sh\nset -eu\n/);
  assert.ok(verifyOffset >= 0 && verifyOffset < installOffset);
  assert.match(script, /--offline/);
  assert.match(script, /--ignore-scripts/);
  assert.match(script, /--no-audit/);
  assert.match(script, /--no-fund/);
  assert.match(script, /--package-lock=false/);
  assert.match(script, /NPM_CONFIG_REGISTRY=http:\/\/127\.0\.0\.1:9/);
  assert.match(script, /node_modules\/\.package-lock\.json/);
  assert.match(script, /lockfileVersion/);
  assert.match(script, /node_modules\/@openclaw\/zalouser/);
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b|https:\/\//i);
});

test("vendored install is a recoverable managed npm project without mutable lock state", async () => {
  const script = await readCell("scripts/install-vendored-zalouser.sh");
  const fork = JSON.parse(
    await readCell("vendor/zalouser-bridge/FORK.json"),
  );
  const entries = new Map(
    fork.installedTree.entries.map((entry) => [entry.path, entry]),
  );
  const projectManifest = Buffer.from(
    '{"name":"@ihome/openclaw-zalouser-install","private":true,"dependencies":{"@openclaw/zalouser":"2026.7.1"}}\n',
    "utf8",
  );

  assert.deepEqual(entries.get("package.json"), {
    path: "package.json",
    type: "file",
    mode: "0644",
    size: projectManifest.length,
    sha256: sha256(projectManifest),
  });
  for (const path of [
    "node_modules",
    "node_modules/@openclaw",
    "node_modules/@openclaw/zalouser",
  ]) {
    assert.equal(entries.get(path)?.type, "directory", `${path} must be installed`);
  }
  assert.equal(
    entries.get("node_modules/@openclaw/zalouser/package.json")?.type,
    "file",
  );
  assert.equal(
    [...entries.keys()].some((path) => path.endsWith(".package-lock.json")),
    false,
  );
  assert.match(
    script,
    /rm -f (?:-- )?"\$staging\/node_modules\/\.package-lock\.json"/,
  );
  assert.match(script, /mv "\$staging" "\$project"/);
  assert.doesNotMatch(script, /mv "\$installed" "\$project"/);
});

test("normalizer creates a deterministic regular-file inventory and rejects links", async (t) => {
  const { normalizeInstallTree } = await loadScript(
    "scripts/normalize-openclaw-install.mjs",
  );
  const root = await mkdtemp(join(tmpdir(), "openclaw-normalize-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "z.txt"), "z\n");
  await writeFile(join(root, "nested", "a.txt"), "a\n");

  const first = await normalizeInstallTree({
    root,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
  });
  const second = await normalizeInstallTree({
    root,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
  });

  const expectedEntries = [
    {
      path: "nested",
      type: "directory",
      mode: "0755",
      size: 0,
      sha256: sha256(Buffer.alloc(0)),
    },
    {
      path: "nested/a.txt",
      type: "file",
      mode: "0644",
      size: 2,
      sha256: sha256(Buffer.from("a\n")),
    },
    {
      path: "z.txt",
      type: "file",
      mode: "0644",
      size: 2,
      sha256: sha256(Buffer.from("z\n")),
    },
  ];
  const installedTreeHash = createHash("sha256");
  installedTreeHash.update("ihome-zalouser-installed-tree-v1\0", "utf8");
  for (const entry of expectedEntries) {
    installedTreeHash.update(
      `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.size}\0${entry.sha256}\0`,
      "utf8",
    );
  }

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    entries: expectedEntries,
    fileCount: 2,
    directoryCount: 1,
    sha256: installedTreeHash.digest("hex"),
  });
  assert.equal(
    Math.trunc((await stat(join(root, "z.txt"))).mtimeMs / 1000),
    Number(SOURCE_DATE_EPOCH),
  );
});

test("runtime config template is valid JSON and contains no tenant or secret material", async () => {
  const raw = await readCell("config/openclaw.json.tmpl");
  const config = JSON.parse(raw);

  assert.equal(config.plugins.entries.zalouser.enabled, true);
  assert.equal(config.channels.zalouser.enabled, true);
  assert.doesNotMatch(
    raw,
    /organization(?:Id)?|account(?:Id)?|customer|phone|token|secret|password|cookie|imei|api[_-]?key|provider/i,
  );
});

test("build evidence schema is closed at every object level", async () => {
  const schema = JSON.parse(await readCell("build-evidence.schema.v1.json"));
  const objects = collectObjects(schema).filter(
    ([, value]) => value.type === "object" || value.properties,
  );

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.const, undefined);
  assert.ok(objects.length > 8);
  for (const [path, value] of objects) {
    assert.equal(
      value.additionalProperties,
      false,
      `${path} must reject unknown properties`,
    );
  }
});

test("build evidence binds exact canonical M and R approval reports", async (t) => {
  const schema = JSON.parse(await readCell("build-evidence.schema.v1.json"));
  assert.ok(schema.required.includes("reviews"));
  assert.deepEqual(schema.properties.reviews.required, ["M", "R"]);
  assert.equal(schema.properties.reviews.additionalProperties, false);
  assert.equal(schema.properties.reviews.properties.M.$ref, "#/$defs/mReviewRecord");
  assert.equal(schema.properties.reviews.properties.R.$ref, "#/$defs/rReviewRecord");

  const reviewSchema = schema.$defs.mReviewRecord;
  assert.equal(reviewSchema.additionalProperties, false);
  assert.deepEqual(reviewSchema.required, [
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
  ]);
  assert.equal(reviewSchema.properties.checkpoint.const, "M");
  assert.equal(schema.$defs.rReviewRecord.properties.checkpoint.const, "R");
  assert.equal(reviewSchema.properties.decision.const, "APPROVED");
  assert.equal(reviewSchema.properties.findings.maxItems, 0);

  const {
    readCanonicalReviewReport,
    validateEmbeddedReviewRecord,
    validateJsonSchema,
  } = await loadScript("scripts/verify-image-lock.mjs");
  assert.throws(
    () =>
      validateJsonSchema(["tampered finding"], {
        type: "array",
        maxItems: 0,
        items: {},
      }),
    /at most 0 items/i,
  );
  const repositoryRoot = await mkdtemp(join(tmpdir(), "openclaw-review-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const reviewedSha = "a".repeat(40);
  const report = {
    checkpoint: "M",
    decision: "APPROVED",
    findings: [],
    reviewedSha,
    reviewerIdentity: "/root/review-m",
    reviewerRole: "reviewer",
    reviewerRunId: "M-review-run",
    schema: 1,
  };
  const canonicalBytes = Buffer.from(`${JSON.stringify(report)}\n`);
  const reportsRoot = join(
    repositoryRoot,
    "services",
    "openclaw-zalo-cell",
    ".release",
    "reviews",
  );
  await mkdir(reportsRoot, { recursive: true });
  const reportPath = join(reportsRoot, `m-review-report-v1-${reviewedSha}.json`);
  await writeFile(reportPath, canonicalBytes);

  const retained = await readCanonicalReviewReport(reportPath, {
    checkpoint: "M",
    reviewedSha,
    repositoryRoot,
  });
  assert.equal(retained.canonicalPath, await realpath(reportPath));
  assert.deepEqual(retained.bytes, canonicalBytes);
  const embedded = retained.record;
  assert.deepEqual(
    embedded,
    {
      checkpoint: "M",
      report_base64: canonicalBytes.toString("base64"),
      report_size: canonicalBytes.length,
      report_sha256: sha256(canonicalBytes),
      reviewed_sha: reviewedSha,
      reviewer_role: "reviewer",
      reviewer_identity: "/root/review-m",
      reviewer_run_id: "M-review-run",
      decision: "APPROVED",
      findings: [],
    },
  );
  assert.deepEqual(
    validateEmbeddedReviewRecord(embedded, {
      checkpoint: "M",
      reviewedSha,
    }),
    {
      checkpoint: "M",
      report_base64: canonicalBytes.toString("base64"),
      report_size: canonicalBytes.length,
      report_sha256: sha256(canonicalBytes),
      reviewed_sha: reviewedSha,
      reviewer_role: "reviewer",
      reviewer_identity: "/root/review-m",
      reviewer_run_id: "M-review-run",
      decision: "APPROVED",
      findings: [],
    },
  );
  assert.throws(
    () =>
      validateEmbeddedReviewRecord(
        { ...embedded, report_sha256: "0".repeat(64) },
        { checkpoint: "M", reviewedSha },
      ),
    /report_sha256 mismatch/i,
  );

  await writeFile(
    reportPath,
    `{"checkpoint":"M","decision":"REJECTED","decision":"APPROVED","findings":[],"reviewedSha":"${reviewedSha}","reviewerIdentity":"/root/review-m","reviewerRole":"reviewer","reviewerRunId":"M-review-run","schema":1}\n`,
  );
  await assert.rejects(
    readCanonicalReviewReport(reportPath, { checkpoint: "M", reviewedSha, repositoryRoot }),
    /duplicate JSON key/i,
  );
  await writeFile(
    reportPath,
    `${JSON.stringify({ schema: 1, ...report })}\n`,
  );
  await assert.rejects(
    readCanonicalReviewReport(reportPath, { checkpoint: "M", reviewedSha, repositoryRoot }),
    /not canonical/i,
  );
  const arbitraryPath = join(reportsRoot, "m-review.json");
  await writeFile(arbitraryPath, canonicalBytes);
  await assert.rejects(
    readCanonicalReviewReport(arbitraryPath, { checkpoint: "M", reviewedSha, repositoryRoot }),
    /canonical|SHA-bound|report path/i,
  );
});

test("qualifying gates require exact Git lineage, reviewed verifier bytes, and raw M inputs", async (t) => {
  const source = await readCell("scripts/verify-image-lock.mjs");
  assert.match(source, /ExpectedM|expected-m/);
  assert.match(source, /git[\s\S]+cat-file[\s\S]+--batch/);
  assert.match(source, /authenticateCommitLineage/);
  assert.match(source, /readAuthenticatedGitObjects/);
  assert.match(source, /createHash\("sha1"\)/);

  const {
    collectRawMInputs,
    readGitBlobRecords,
    verifyGitLineage,
    verifyReviewedVerifierBlob,
  } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const repositoryRoot = resolve(cellRoot, "../..");
  const gitPath = localGitPath();
  const expectedM = "0650187981ad9728d295fae34eff92b508e36bc8";
  const reviewedTree = (await import("node:child_process")).execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repositoryRoot, encoding: "ascii" },
  ).trim();
  await assert.doesNotReject(() =>
    verifyGitLineage({ gitPath, repositoryRoot, expectedM, reviewedTree }),
  );
  const records = await readGitBlobRecords({
    gitPath,
    repositoryRoot,
    commit: expectedM,
    paths: ["services/openclaw-zalo-cell/vendor/zalouser-bridge/UPSTREAM.json"],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].source, "git-object");
  assert.match(records[0].git_object_id, /^[0-9a-f]{40}$/);
  assert.match(records[0].sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(
    verifyGitLineage({ gitPath, repositoryRoot, expectedM: "0".repeat(40), reviewedTree }),
    /Git|ancestor|commit/i,
  );
  const rawM = await collectRawMInputs({ gitPath, repositoryRoot, expectedM });
  assert.equal(rawM.records.length, 87);
  assert.equal(rawM.provenance.size, 4);

  const verifierRelative = "services/openclaw-zalo-cell/scripts/verify-image-lock.mjs";
  const [reviewedVerifier] = await readGitBlobRecords({
    gitPath,
    repositoryRoot,
    commit: reviewedTree,
    paths: [verifierRelative],
  });
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-reviewed-verifier-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const verifierPath = join(fixture, "verify-image-lock.mjs");
  await writeFile(verifierPath, reviewedVerifier.bytes);
  await assert.doesNotReject(() =>
    verifyReviewedVerifierBlob({ gitPath, repositoryRoot, reviewedTree, verifierPath }),
  );
  await writeFile(verifierPath, Buffer.concat([reviewedVerifier.bytes, Buffer.from("// tampered\n")]));
  await assert.rejects(
    verifyReviewedVerifierBlob({ gitPath, repositoryRoot, reviewedTree, verifierPath }),
    /reviewed R|verifier|Git blob/i,
  );
});

test("detached evidence reauthenticates retained canonical M/R reports byte-for-byte", async (t) => {
  const {
    authenticateEvidenceReviews,
    readCanonicalReviewReport,
    validateRetainedReviewReports,
  } = await loadScript("scripts/verify-image-lock.mjs");
  const repositoryRoot = await mkdtemp(join(tmpdir(), "openclaw-retained-reviews-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const mSha = "a".repeat(40);
  const rSha = "b".repeat(40);
  const makeReport = (checkpoint, reviewedSha) => Buffer.from(
    `${JSON.stringify({
      checkpoint,
      decision: "APPROVED",
      findings: [],
      reviewedSha,
      reviewerIdentity: `/review/${checkpoint}`,
      reviewerRole: "reviewer",
      reviewerRunId: `${checkpoint}-run`,
      schema: 1,
    })}\n`,
    "utf8",
  );
  const reportsRoot = join(repositoryRoot, "services", "openclaw-zalo-cell", ".release", "reviews");
  await mkdir(reportsRoot, { recursive: true });
  const mPath = join(reportsRoot, `m-review-report-v1-${mSha}.json`);
  const rPath = join(reportsRoot, `r-review-report-v1-${rSha}.json`);
  const mBytes = makeReport("M", mSha);
  const rBytes = makeReport("R", rSha);
  await writeFile(mPath, mBytes);
  await writeFile(rPath, rBytes);
  const mReport = await readCanonicalReviewReport(mPath, {
    checkpoint: "M", reviewedSha: mSha, repositoryRoot,
  });
  const rReport = await readCanonicalReviewReport(rPath, {
    checkpoint: "R", reviewedSha: rSha, repositoryRoot,
  });
  const embedded = { M: mReport.record, R: rReport.record };
  assert.doesNotThrow(() => authenticateEvidenceReviews(embedded, {
    expectedM: mSha,
    reviewedTree: rSha,
    mReport,
    rReport,
  }));
  const forgedMBytes = makeReport("M", mSha).toString("utf8").replace(
    '"reviewerIdentity":"/review/M"',
    '"reviewerIdentity":"/attacker/forged-M"',
  );
  const forgedMBuffer = Buffer.from(forgedMBytes, "utf8");
  const forgedEmbedded = {
    ...embedded,
    M: {
      ...embedded.M,
      report_base64: forgedMBuffer.toString("base64"),
      report_size: forgedMBuffer.length,
      report_sha256: sha256(forgedMBuffer),
      reviewer_identity: "/attacker/forged-M",
    },
  };
  assert.throws(
    () => authenticateEvidenceReviews(forgedEmbedded, {
      expectedM: mSha,
      reviewedTree: rSha,
      mReport,
      rReport,
    }),
    /bytes|retained canonical report/i,
  );
  await assert.doesNotReject(() =>
    validateRetainedReviewReports({
      embedded,
      expectedM: mSha,
      reviewedTree: rSha,
      repositoryRoot,
      mReviewReportPath: mPath,
      rReviewReportPath: rPath,
    }),
  );
  await writeFile(rPath, Buffer.from(`${rBytes}tampered`, "utf8"));
  await assert.rejects(
    validateRetainedReviewReports({
      embedded,
      expectedM: mSha,
      reviewedTree: rSha,
      repositoryRoot,
      mReviewReportPath: mPath,
      rReviewReportPath: rPath,
    }),
    /byte|canonical|report/i,
  );
});

test("path validation rejects a symlink or reparse ancestor, not only a linked leaf", async (t) => {
  const { assertPathHasNoSymbolicLink } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-reparse-chain-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const real = join(fixture, "real");
  const linked = join(fixture, "linked");
  await mkdir(real);
  await writeFile(join(real, "report.json"), "{}\n");
  try {
    await symlink(real, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symlink creation is unavailable in this Windows environment");
      return;
    }
    throw error;
  }
  await assert.rejects(
    assertPathHasNoSymbolicLink(join(linked, "report.json"), "retained report"),
    /link|reparse/i,
  );
});

test("OCI A/B comparison accepts distinct byte-identical files but rejects same-file and hardlink reuse", async (t) => {
  const { compareDistinctOciArchives } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-oci-identity-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const a = join(fixture, "a.oci.tar");
  const b = join(fixture, "b.oci.tar");
  const hardlink = join(fixture, "hardlink.oci.tar");
  await writeFile(a, "same archive bytes\n");
  await writeFile(b, "same archive bytes\n");
  await link(a, hardlink);
  await assert.doesNotReject(() => compareDistinctOciArchives(a, b));
  await assert.rejects(compareDistinctOciArchives(a, a), /distinct|same/i);
  await assert.rejects(compareDistinctOciArchives(a, hardlink), /hardlink|identity|distinct/i);
});

test("qualification retains distinct A/B/stock archives, upstream tgz, and runner identities", async (t) => {
  const {
    captureRetainedQualificationInputs,
    verifyRetainedQualificationInputs,
  } = await loadScript("scripts/verify-image-lock.mjs");
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-retained-inputs-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const paths = {
    archiveAPath: join(fixture, "a.oci.tar"),
    archiveBPath: join(fixture, "b.oci.tar"),
    stockArchivePath: join(fixture, "stock.oci.tar"),
    upstreamTarballPath: join(fixture, "verified-upstream.tgz"),
    behaviorRunnerPath: join(fixture, "behavior-probe-runner.mjs"),
  };
  await writeFile(paths.archiveAPath, "fork oci\n");
  await writeFile(paths.archiveBPath, "fork oci\n");
  await writeFile(paths.stockArchivePath, "stock oci\n");
  await writeFile(paths.upstreamTarballPath, "upstream tgz\n");
  await writeFile(paths.behaviorRunnerPath, "runner\n");

  const retained = await captureRetainedQualificationInputs(paths);
  assert.equal("path" in retained.archive_a, false);
  assert.equal(retained.archive_a.sha256, retained.archive_b.sha256);
  assert.notEqual(retained.archive_a.sha256, retained.stock_oci.sha256);
  await assert.doesNotReject(() => verifyRetainedQualificationInputs(retained, paths));

  await writeFile(paths.stockArchivePath, "tampered stock oci\n");
  await assert.rejects(
    verifyRetainedQualificationInputs(retained, paths),
    /stock.*(?:changed|hash|binding)|retained/i,
  );

  await writeFile(paths.stockArchivePath, "stock oci\n");
  await writeFile(paths.archiveBPath, "different fork oci\n");
  await assert.rejects(
    captureRetainedQualificationInputs(paths),
    /A\/B|byte-identical|mismatch/i,
  );
});

test("retained qualification inputs reject pairwise path and hardlink reuse", async (t) => {
  const { captureRetainedQualificationInputs } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-retained-distinct-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const a = join(fixture, "a.oci.tar");
  const b = join(fixture, "b.oci.tar");
  const stock = join(fixture, "stock.oci.tar");
  const upstream = join(fixture, "verified-upstream.tgz");
  const runner = join(fixture, "behavior-probe-runner.mjs");
  await writeFile(a, "same\n");
  await writeFile(b, "same\n");
  await link(a, stock);
  await writeFile(upstream, "tgz\n");
  await writeFile(runner, "runner\n");
  await assert.rejects(
    captureRetainedQualificationInputs({
      archiveAPath: a,
      archiveBPath: b,
      stockArchivePath: stock,
      upstreamTarballPath: upstream,
      behaviorRunnerPath: runner,
    }),
    /hardlink|identity|distinct/i,
  );
});

test("behavioral installed-image probe runs the reviewed contract without rewriting installed dist", async () => {
  const source = await readCell("scripts/verify-image-lock.mjs");
  const runner = await readCell("scripts/behavior-probe-runner.mjs");
  assert.doesNotMatch(source, /appendFileSync\(path[\s\S]*export \{/);
  assert.doesNotMatch(source, /cpSync\(root, probeRoot/);
  assert.match(runner, /dist\/behavior-contract-api\.js/);
  assert.match(runner, /installInstalledBehaviorContractRuntimeV1/);
  assert.match(runner, /zalouser\.bridge\.send/);
  assert.match(runner, /commitInboundAndDispatch/);
  assert.match(runner, /invokeInstalledBehaviorTypingV1/);
  assert.match(runner, /outbound-peer-media-authorized/);
  assert.match(runner, /outbound-partial-handoff-unknown/);
  assert.doesNotMatch(runner, /providerRuntime\s*:/);
  assert.doesNotMatch(runner, /fork_pass|stock_fail|observed_behavior|status:\s*["']PASS/);
  const schema = JSON.parse(await readCell("build-evidence.schema.v1.json"));
  assert.ok(schema.required.includes("expected_m"));
  assert.ok(schema.$defs.supplyChain.required.includes("git_binding"));
  assert.ok(schema.$defs.pluginProbe.required.includes("behavior"));
  assert.ok(schema.properties.verification.required.includes("installed_behavior"));
  const { validateBehaviorTranscript, dockerBehaviorProbeArguments } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fork = {
    schema: 3,
    contract: "ihome.zalouser.business.v1",
    implementation: "fork",
    package: { name: "@openclaw/zalouser", version: "2026.7.1" },
    registered_methods: ["zalouser.bridge.send"],
    cases: [],
  };
  assert.throws(
    () => validateBehaviorTranscript({ ...fork, registered_methods: [] }, "fork"),
    /registered|behavior/i,
  );
  const args = dockerBehaviorProbeArguments({
    image: "ihome/openclaw-behavior:0123456789abcdef0123456789abcdef",
    variant: "fork",
  });
  assert.deepEqual(args.slice(0, 6), ["run", "--pull=never", "--rm", "-i", "--network", "none"]);
  assert.equal(args.includes("--eval"), false);
  assert.deepEqual(args.slice(-1), ["--input-type=module"]);
});

test("behavior evidence contains only raw canonical transcripts bound to runner and OCI identities", async () => {
  const { validateJsonSchema, validateRecordedBehaviorEvidence } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const schema = JSON.parse(await readCell("build-evidence.schema.v1.json"));
  const runnerBytes = Buffer.from("runner\n");
  const forkArchiveBytes = Buffer.from("fork oci\n");
  const stockArchiveBytes = Buffer.from("stock oci\n");
  const recorded = recordedBehaviorEvidence({ runnerBytes, forkArchiveBytes, stockArchiveBytes });

  assert.doesNotThrow(() => validateRecordedBehaviorEvidence(recorded));
  assert.doesNotThrow(() =>
    validateJsonSchema(recorded, {
      ...schema.$defs.behaviorEvidence,
      $defs: schema.$defs,
    }),
  );
  assert.equal("transcript" in recorded.fork, false);
  assert.equal("fork_pass" in recorded, false);
  assert.equal("stock_fail" in recorded, false);
  assert.equal("observed_behavior" in recorded, false);
  assert.equal("observed_check_count" in recorded, false);
  assert.equal(schema.$defs.pluginProbe.required.includes("differential"), false);
  assert.equal(schema.$defs.behaviorProbeFork, undefined);
  assert.equal(schema.$defs.behaviorProbeStock, undefined);
  assert.ok(schema.required.includes("retained_inputs"));
  assert.deepEqual(schema.properties.retained_inputs.required, [
    "archive_a",
    "archive_b",
    "stock_oci",
    "upstream_tgz",
    "behavior_runner",
  ]);
  assert.deepEqual(schema.$defs.retainedFileBinding.required, ["size", "sha256"]);
  assert.equal("path" in schema.$defs.retainedFileBinding.properties, false);

  const forgedTranscript = structuredClone(recorded);
  forgedTranscript.fork.transcript_base64 = Buffer.from(
    `${JSON.stringify({ ...passingBehaviorTranscript("fork"), implementation: "stock" })}\n`,
    "utf8",
  ).toString("base64");
  assert.throws(
    () => validateRecordedBehaviorEvidence(forgedTranscript),
    /transcript.*(?:size|sha|identity|binding)|behavior/i,
  );

  const forgedClaim = structuredClone(recorded);
  forgedClaim.fork_pass = true;
  assert.throws(
    () => validateRecordedBehaviorEvidence(forgedClaim),
    /unknown|missing|properties/i,
  );
});

test("evidence schema accepts the exhaustive classified runtime-site inventory", async () => {
  const { validateJsonSchema } = await loadScript("scripts/verify-image-lock.mjs");
  const schema = JSON.parse(await readCell("build-evidence.schema.v1.json"));
  const fork = JSON.parse(await readCell("vendor/zalouser-bridge/FORK.json"));
  assert.doesNotThrow(() =>
    validateJsonSchema(fork.runtimeDynamicSiteInventory, {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/runtimeDynamicSite" },
      $defs: schema.$defs,
    }),
  );
});

test("custom schema validation enforces numeric bounds", async () => {
  const { validateJsonSchema } = await loadScript("scripts/verify-image-lock.mjs");
  assert.throws(
    () => validateJsonSchema(0, { type: "integer", minimum: 1 }),
    /minimum|less than/i,
  );
  assert.throws(
    () => validateJsonSchema(2, { type: "integer", maximum: 1 }),
    /maximum|greater than/i,
  );
});

test("offline behavior replay reruns fork A, fork B, and stock from immutable snapshots", async (t) => {
  const { replayRecordedBehaviorEvidence } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-offline-behavior-replay-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const dockerPath = join(fixture, "docker");
  const dockerHost = "unix:///run/ihome-openclaw-test/docker.sock";
  const archiveAPath = join(fixture, "fork-a.oci.tar");
  const archiveBPath = join(fixture, "fork-b.oci.tar");
  const stockArchivePath = join(fixture, "stock.oci.tar");
  const behaviorRunnerPath = join(fixture, "behavior-probe-runner.mjs");
  const dockerBytes = Buffer.from("docker\n");
  const runnerBytes = Buffer.from("runner\n");
  const forkBytes = Buffer.from("fork oci\n");
  const stockBytes = Buffer.from("stock oci\n");
  await writeFile(dockerPath, dockerBytes);
  await writeFile(archiveAPath, forkBytes);
  await writeFile(archiveBPath, forkBytes);
  await writeFile(stockArchivePath, stockBytes);
  await writeFile(behaviorRunnerPath, runnerBytes);
  const recorded = recordedBehaviorEvidence({
    runnerBytes,
    forkArchiveBytes: forkBytes,
    stockArchiveBytes: stockBytes,
  });
  const calls = [];
  const invoke = async (file, args, options) => {
    assert.equal(options?.environment?.DOCKER_HOST, dockerHost);
    assert.equal("DOCKER_CONTEXT" in options.environment, false);
    assert.equal("DOCKER_TLS_VERIFY" in options.environment, false);
    assert.equal("DOCKER_CERT_PATH" in options.environment, false);
    calls.push({ file, args: [...args], input: options?.input });
    if (args[0] === "version") {
      return { exitCode: 0, stdout: Buffer.from("29.1.3|29.1.3|linux|amd64\n"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("not found\n") };
    }
    if (args[0] === "load") {
      assert.notEqual(args[2], archiveAPath);
      assert.notEqual(args[2], archiveBPath);
      assert.notEqual(args[2], stockArchivePath);
      assert.ok([forkBytes.toString("utf8"), stockBytes.toString("utf8")].includes((await readFile(args[2])).toString("utf8")));
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "tag" || (args[0] === "image" && args[1] === "rm")) {
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "run") {
      const variant = args.find((value) => value.startsWith("IHOME_BEHAVIOR_VARIANT="))?.split("=")[1];
      assert.ok(variant === "fork" || variant === "stock");
      assert.deepEqual(options?.input, runnerBytes);
      const transcript = passingBehaviorTranscript(variant);
      return { exitCode: 0, stdout: Buffer.from(`${JSON.stringify(transcript)}\n`), stderr: Buffer.alloc(0) };
    }
    throw new Error(`unexpected fake Docker call: ${args.join(" ")}`);
  };

  await assert.doesNotReject(() =>
    replayRecordedBehaviorEvidence({
      recorded,
      archiveAPath,
      archiveBPath,
      stockArchivePath,
      behaviorRunnerPath,
      dockerPath,
      dockerHost,
      dockerSha256: sha256(dockerBytes),
      expectedDockerVersion: "29.1.3",
      nonce: "d".repeat(32),
      invoke,
    }),
  );
  assert.equal(calls.some(({ args }) => ["pull", "build", "login"].includes(args[0])), false);
  assert.equal(calls.filter(({ args }) => args[0] === "run").length, 3);
  assert.equal(calls.filter(({ args }) => args[0] === "run").every(({ args }) => args.includes("--pull=never") && args.includes("none")), true);

  const forged = structuredClone(recorded);
  forged.stock.transcript_sha256 = "0".repeat(64);
  await assert.rejects(
    replayRecordedBehaviorEvidence({
      recorded: forged,
      archiveAPath,
      archiveBPath,
      stockArchivePath,
      behaviorRunnerPath,
      dockerPath,
      dockerHost,
      dockerSha256: sha256(dockerBytes),
      expectedDockerVersion: "29.1.3",
      nonce: "e".repeat(32),
      invoke,
    }),
    /transcript|sha|behavior/i,
  );

  await writeFile(stockArchivePath, "tampered stock\n");
  await assert.rejects(
    replayRecordedBehaviorEvidence({
      recorded,
      archiveAPath,
      archiveBPath,
      stockArchivePath,
      behaviorRunnerPath,
      dockerPath,
      dockerHost,
      dockerSha256: sha256(dockerBytes),
      expectedDockerVersion: "29.1.3",
      nonce: "f".repeat(32),
      invoke,
    }),
    /stock|retained|hash|binding/i,
  );
});

test("behavior replay binds the exact runner bytes read from a nofollow file handle", async () => {
  const source = await readCell("scripts/verify-image-lock.mjs");
  const replayStart = source.indexOf("export async function replayRecordedBehaviorEvidence");
  const replayEnd = source.indexOf("export async function", replayStart + 1);
  const replay = source.slice(replayStart, replayEnd);

  assert.match(source, /async function readRegularFileHandleBound/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(replay, /readRegularFileHandleBound\(behaviorRunnerPath/);
  assert.match(replay, /behaviorRunnerBytes\s*=\s*runnerAuthority\.bytes/);
  assert.doesNotMatch(replay, /hashFile\(behaviorRunnerPath\)[\s\S]*readFile\(behaviorRunnerPath\)/);
});

test("Docker execution strips hostile ambient routing and rejects a non-socket authority", async (t) => {
  const { buildTrustedDockerEnvironment, assertTrustedDockerSocket } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const dockerHost = "unix:///run/ihome-openclaw-test/docker.sock";
  const environment = buildTrustedDockerEnvironment(dockerHost, {
    PATH: "/trusted/bin",
    HOME: "/trusted/home",
    DOCKER_HOST: "tcp://attacker.invalid:2375",
    DOCKER_CONTEXT: "attacker",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/attacker/certs",
    BUILDKIT_HOST: "tcp://attacker.invalid:1234",
  });
  assert.equal(environment.DOCKER_HOST, dockerHost);
  assert.equal(environment.PATH, "/trusted/bin");
  assert.equal(environment.HOME, "/trusted/home");
  for (const key of ["DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "BUILDKIT_HOST"]) {
    assert.equal(key in environment, false);
  }

  const fixture = await mkdtemp(join(tmpdir(), "openclaw-docker-host-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const regular = join(fixture, "docker.sock");
  await writeFile(regular, "not a socket\n");
  await assert.rejects(assertTrustedDockerSocket(`unix://${regular}`), /socket/i);
});

test("PowerShell helper pins builders and makes the verifier the promotion gate", async () => {
  const script = await readCell("scripts/build-reproducible-image.ps1");

  assert.match(script, /^#Requires -Version 7\.3/m);
  assert.match(script, /\[IO\.Path\]::IsPathFullyQualified\(\$BuildxPath\)/);
  assert.match(script, /\[string\]\$DockerPath/);
  assert.match(script, /\[string\]\$DockerHost/);
  assert.match(script, /\[IO\.Path\]::IsPathFullyQualified\(\$DockerPath\)/);
  assert.match(script, new RegExp(DOCKER_LINUX_SHA256));
  assert.match(script, /'--docker-path', \$resolvedDocker/);
  assert.match(script, /'--docker-host', \$DockerHost/);
  assert.match(script, /'--docker-sha256', \$actualDockerSha256/);
  assert.match(script, /\[string\]\$ReviewedSourceRoot/);
  assert.match(script, /\[string\]\$ReviewedExportManifestPath/);
  assert.match(script, /\[string\]\$ReviewedExportManifestSha256/);
  assert.match(script, /export-reviewed-tree\.mjs/);
  assert.match(script, /'verify', '--reviewed-tree', \$ReviewedTree/);
  assert.match(script, /'--reviewed-source-root', \$resolvedReviewedSourceRoot/);
  assert.match(script, /'--reviewed-export-manifest', \$resolvedReviewedExportManifest/);
  assert.match(script, /'--reviewed-export-manifest-sha256', \$actualReviewedExportManifestSha256/);
  assert.match(script, /0\.13\.1/);
  assert.match(
    script,
    /6b113e84cbc3cd645646aa82f00a7f7d3737cc10375b4341e0aca0de0c997c75/,
  );
  assert.match(
    script,
    /3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c/,
  );
  assert.match(script, new RegExp(BUILDKIT_IMAGE.replaceAll("/", "\\/")));
  assert.match(script, /ihome-openclaw-gate-a-/);
  assert.match(script, /ihome-openclaw-gate-b-/);
  assert.match(script, /--no-cache/);
  assert.match(script, /--pull/);
  assert.match(script, /rewrite-timestamp=true/);
  assert.match(script, /verify-image-lock\.mjs/);
  assert.match(script, /'--mode', 'qualify'/);
  assert.match(script, /normalize-openclaw-install\.mjs/);
  assert.doesNotMatch(script, /normalize-oci-layout\.mjs/);
  assert.match(script, /'--release-artifact', \$ReleaseArtifactPath/);
  assert.match(script, /\[string\]\$MReviewReportPath/);
  assert.match(script, /\[string\]\$RReviewReportPath/);
  assert.match(script, /\[string\]\$ExpectedM/);
  assert.match(script, /\[string\]\$GitRepositoryRoot/);
  assert.match(script, /merge-base['"],?\s*['"]--is-ancestor/);
  assert.match(script, /m-review-report-v1-['" ]*\+?\s*\$ExpectedM|m-review-report-v1-\$ExpectedM/);
  assert.match(script, /r-review-report-v1-['" ]*\+?\s*\$ReviewedTree|r-review-report-v1-\$ReviewedTree/);
  assert.match(script, /'--m-review-report', \$resolvedMReviewReport/);
  assert.match(script, /'--r-review-report', \$resolvedRReviewReport/);
  assert.match(script, /'--expected-m', \$ExpectedM/);
  assert.match(script, /'--git-repository-root', \$resolvedGitRepositoryRoot/);
  assert.match(script, /\[string\]\$RetainedUpstreamTarballPath/);
  assert.match(script, /IsPathFullyQualified\(\$RetainedUpstreamTarballPath\)/);
  assert.match(script, /Publish-RetainedArchive[\s\S]*\$upstreamTarballPath[\s\S]*\$resolvedRetainedUpstreamTarball/);
  assert.match(script, /'--upstream-tgz', \$resolvedRetainedUpstreamTarball/);
  assert.doesNotMatch(script, /Invoke-Expression|cmd\s+\/c|Start-Process/);
});

test("PowerShell helper runs lock preflight before an explicit qualifying verifier", async () => {
  const script = await readCell("scripts/build-reproducible-image.ps1");
  const verifierCall = "    $verifierPath,";
  const firstVerifier = script.indexOf(verifierCall);
  const firstBuilder = script.indexOf("$builderACreated = $true");
  const finalVerifier = script.indexOf(verifierCall, firstVerifier + verifierCall.length);
  const finalRehash = script.indexOf("Assert-HashUnchanged", finalVerifier);

  assert.ok(firstVerifier > 0 && firstBuilder > firstVerifier);
  assert.ok(finalVerifier > firstBuilder && finalRehash > finalVerifier);
  assert.match(script.slice(firstVerifier, firstBuilder), /'--mode', 'lock'/);
  assert.doesNotMatch(script.slice(firstVerifier, firstBuilder), /'--mode', 'qualify'/);
  assert.match(script.slice(finalVerifier, finalRehash), /'--mode', 'qualify'/);
  assert.match(script.slice(finalVerifier, finalRehash), /'--oci-a', \$resolvedReleaseArtifact/);
  assert.match(script.slice(finalVerifier, finalRehash), /'--oci-b', \$resolvedReproductionArtifact/);
});

test("PowerShell helper arms cleanup before either builder create can partially fail", async () => {
  const script = await readCell("scripts/build-reproducible-image.ps1");
  const createA = script.indexOf("'create', '--name', $builderA");
  const createB = script.indexOf("'create', '--name', $builderB");
  const armA = script.indexOf("$builderACreated = $true");
  const armB = script.indexOf("$builderBCreated = $true");
  const cleanup = script.indexOf("foreach ($builderState in @(");

  assert.ok(createA > 0 && createB > createA);
  assert.ok(armA > 0 && armA < createA);
  assert.ok(armB > createA && armB < createB);
  assert.ok(cleanup > createB);
  assert.match(script.slice(cleanup), /if \(\$builderState\.Created\)/);
  assert.match(script.slice(cleanup), /'rm', '--force', \[string\]\$builderState\.Name/);
});

test("evidence-child helper uses absolute verified candidates and exact R to E lifecycle", async () => {
  const script = await readCell("scripts/create-evidence-child.ps1");
  const nodeGate = script.indexOf("Official stable Node >=24.15.0 <25 is required");
  const firstWork = script.indexOf("$sourceRoot =");

  assert.match(script, /^#Requires -Version 7\.3/m);
  assert.ok(nodeGate > 0 && nodeGate < firstWork);
  assert.match(script, /\[ValidatePattern\('\^\[0-9a-f\]\{40\}\$'\)\][\s\S]*\$ReviewedTree/);
  assert.match(script, /\$ExpectedM/);
  assert.match(script, /\$MReviewReportPath/);
  assert.match(script, /\$RReviewReportPath/);
  assert.match(script, /IsPathFullyQualified\(\$CandidateEvidencePath\)/);
  assert.match(script, /IsPathFullyQualified\(\$CandidateArchivePath\)/);
  assert.match(script, /IsPathFullyQualified\(\$CandidateArchiveBPath\)/);
  assert.match(script, /IsPathFullyQualified\(\$CandidateStockOciPath\)/);
  assert.match(script, /IsPathFullyQualified\(\$UpstreamTarballPath\)/);
  assert.match(script, /IsPathFullyQualified\(\$DockerPath\)/);
  assert.match(script, /\$DockerHost/);
  assert.match(script, /GetRelativePath\(\$releaseRoot, \$candidateEvidence\)/);
  assert.match(script, /GetRelativePath\(\$releaseRoot, \$candidateArchive\)/);
  assert.match(script, /FileAttributes\]::ReparsePoint/);
  assert.match(script, /'--evidence', \$eDestination/);
  assert.match(script, /'--mode', 'evidence-replay-v1'/);
  assert.match(script, /'--schema', \$eSchema/);
  assert.match(script, /'--oci-a', \$candidateArchive/);
  assert.match(script, /'--oci-b', \$candidateArchiveB/);
  assert.match(script, /'--stock-oci', \$candidateStockOci/);
  assert.match(script, /'--upstream-tgz', \$upstreamTarball/);
  assert.match(script, /'--behavior-runner', \$eBehaviorRunner/);
  assert.match(script, /'--docker-path', \$dockerPath/);
  assert.match(script, /'--docker-host', \$DockerHost/);
  assert.match(script, /'--docker-sha256', \$dockerSha256/);
  assert.match(script, /'--expected-m', \$ExpectedM/);
  assert.match(script, /'--git-repository-root', \$sourceRoot/);
  assert.match(script, /Assert-EvidenceOnlyWorktreeStatus/);
  assert.match(script, /hash-object[\s\S]*verify-image-lock\.mjs/);
  assert.match(script, /hash-object[\s\S]*build-evidence\.schema\.v1\.json/);
  assert.match(script, /hash-object[\s\S]*image-lock\.json/);
  assert.match(script, /hash-object[\s\S]*behavior-probe-runner\.mjs/);
  assert.match(script, /rev-list[\s\S]*--parents[\s\S]*-n[\s\S]*1/);
  const commitIndex = script.indexOf("Invoke-Git @('commit', '-m', 'chore(openclaw-zalo): record verified evidence E'");
  assert.ok(commitIndex > 0);
  const postCommit = script.slice(commitIndex);
  assert.match(postCommit, /rev-parse[\s\S]*\$E`?:services\/openclaw-zalo-cell\/build-evidence\.json/);
  assert.match(postCommit, /cat-file[\s\S]*blob[\s\S]*committedEvidence/i);
  assert.match(postCommit, /candidateEvidenceSha256/);
  assert.match(script, /function Assert-SourceWorktreeState/);
  assert.match(script, /function Assert-RetainedAuthorityBindings/);
  const retainedBindingHelper = script.slice(
    script.indexOf("function Assert-RetainedAuthorityBindings"),
    script.indexOf("$nodePath ="),
  );
  assert.match(retainedBindingHelper, /candidateArchiveSha256/);
  assert.match(retainedBindingHelper, /retainedMReviewSha256/);
  assert.match(retainedBindingHelper, /retainedRReviewSha256/);
  assert.match(script, /Invoke-Git[\s\S]*'worktree'[\s\S]*'add'[\s\S]*'--detach'/);
  assert.match(script, /Invoke-Git[\s\S]*'worktree'[\s\S]*'remove'[\s\S]*'--force'/);
  assert.match(script, /rev-parse[\s\S]*\$E\^/);
  assert.match(script, /services\/openclaw-zalo-cell\/build-evidence\.json/);
  const fastForwardIndex = script.indexOf("Invoke-Git @('-C', $sourceRoot, 'update-ref', '--no-deref', $sourceBranchRef, $E, $ReviewedTree)");
  assert.ok(fastForwardIndex > commitIndex);
  assert.match(script, /symbolic-ref[\s\S]*--quiet[\s\S]*HEAD/);
  assert.match(script, /update-ref[\s\S]*\$sourceBranchRef[\s\S]*\$E[\s\S]*\$ReviewedTree/);
  assert.match(script, /read-tree[\s\S]*--reset[\s\S]*-u[\s\S]*\$E/);
  const beforeFastForward = script.slice(commitIndex, fastForwardIndex);
  assert.match(
    beforeFastForward,
    /Assert-SourceWorktreeState\s+-ExpectedHead\s+\$ReviewedTree\s+-Context\s+'before E fast-forward'/,
  );
  assert.match(
    beforeFastForward,
    /Assert-RetainedAuthorityBindings\s+-Context\s+'before E fast-forward'/,
  );
  const afterFastForward = script.slice(fastForwardIndex);
  assert.match(
    afterFastForward,
    /Assert-SourceWorktreeState\s+-ExpectedHead\s+\$E\s+-Context\s+'after E fast-forward'/,
  );
  assert.match(
    afterFastForward,
    /Assert-RetainedAuthorityBindings\s+-Context\s+'after E fast-forward'/,
  );
  assert.match(afterFastForward, /Assert-NoReparseChain\s+-Path\s+\$fastForwardedEvidence/);
  assert.doesNotMatch(script, /--evidence['"],?\s*['"]services\//);
  assert.doesNotMatch(script, /--schema['"],?\s*['"]services\//);
});

test("evidence verifier rejects relative evidence and schema operands", async (t) => {
  const { verifyEvidenceFile } = await loadScript("scripts/verify-image-lock.mjs");
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-evidence-absolute-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const evidencePath = join(fixture, "evidence.json");
  const schemaPath = join(fixture, "schema.json");
  const archivePath = join(fixture, "candidate.oci.tar");
  await writeFile(evidencePath, "{}\n");
  await writeFile(schemaPath, "{}\n");
  await writeFile(archivePath, "archive\n");

  await assert.rejects(
    verifyEvidenceFile({
      root: fixture,
      lockPath: join(fixture, "image-lock.json"),
      evidencePath: "relative-evidence.json",
      schemaPath,
      reviewedTree: "a".repeat(40),
      releaseArtifactPath: archivePath,
    }),
    /evidence path must be absolute/i,
  );
  await assert.rejects(
    verifyEvidenceFile({
      root: fixture,
      lockPath: join(fixture, "image-lock.json"),
      evidencePath,
      schemaPath: "relative-schema.json",
      reviewedTree: "a".repeat(40),
      releaseArtifactPath: archivePath,
    }),
    /schema path must be absolute/i,
  );
});

test("qualifying verifier operands reject relative OCI and review paths", async () => {
  const { assertAbsoluteQualifyingOperands } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const absolute = resolve("C:/tmp/openclaw-operand");
  const args = {
    "oci-a": "relative-a.oci.tar",
    "oci-b": join(absolute, "b.oci.tar"),
    "stock-oci": join(absolute, "stock.oci.tar"),
    "upstream-tgz": join(absolute, "verified-upstream.tgz"),
    "behavior-runner": join(absolute, "behavior-probe-runner.mjs"),
    schema: join(absolute, "schema.json"),
    evidence: join(absolute, "evidence.json"),
    "release-artifact": join(absolute, "release.oci.tar"),
  };
  assert.throws(
    () => assertAbsoluteQualifyingOperands(args),
    /--oci-a path must be absolute/i,
  );
  assert.doesNotThrow(() =>
    assertAbsoluteQualifyingOperands({ ...args, "oci-a": join(absolute, "a.oci.tar") }),
  );
  assert.throws(
    () => assertAbsoluteQualifyingOperands({
      ...args,
      "oci-a": join(absolute, "a.oci.tar"),
      "git-repository-root": "relative-repository",
    }),
    /--git-repository-root path must be absolute/i,
  );
  assert.throws(
    () => assertAbsoluteQualifyingOperands({
      ...args,
      "oci-a": join(absolute, "a.oci.tar"),
      "m-review-report": "relative-M.json",
    }),
    /--m-review-report path must be absolute/i,
  );
  for (const key of ["stock-oci", "upstream-tgz", "behavior-runner"]) {
    assert.throws(
      () =>
        assertAbsoluteQualifyingOperands({
          ...args,
          "oci-a": join(absolute, "a.oci.tar"),
          [key]: `relative-${key}`,
        }),
      new RegExp(`--${key} path must be absolute`, "i"),
    );
  }
});

test("verifier CLI rejects duplicate, unknown, and unsupported mode options", async () => {
  const { parseCliArguments, validateCliModeArguments } = await loadScript("scripts/verify-image-lock.mjs");
  assert.throws(
    () => parseCliArguments(["--mode", "lock", "--mode", "lock"]),
    /duplicate/i,
  );
  assert.throws(
    () => parseCliArguments(["--mode", "lock", "--unexpected", "value"]),
    /unknown/i,
  );
  assert.throws(
    () => parseCliArguments(["--mode", "legacy-evidence"]),
    /mode/i,
  );
  assert.throws(
    () => validateCliModeArguments({ mode: "evidence-replay-v1", schema: resolve("schema.json") }),
    /--evidence is required/i,
  );
  assert.throws(
    () => validateCliModeArguments({ mode: "evidence-replay-v1", evidence: resolve("evidence.json"), "buildx-path": resolve("buildx") }),
    /--buildx-path.*not allowed/i,
  );
});

test("Git authority is absolute, pinned, replacement-free, and ambient-independent", async () => {
  const verifierSource = await readCell("scripts/verify-image-lock.mjs");
  const exporterSource = await readCell("scripts/export-reviewed-tree.mjs");
  const buildHelper = await readCell("scripts/build-reproducible-image.ps1");
  const evidenceHelper = await readCell("scripts/create-evidence-child.ps1");
  const { buildTrustedGitEnvironment, parseCliArguments, validateCliModeArguments } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const environment = buildTrustedGitEnvironment({
    PATH: "attacker-path",
    HOME: "attacker-home",
    GIT_DIR: "attacker-dir",
    GIT_CONFIG_GLOBAL: "attacker-config",
    GIT_OBJECT_DIRECTORY: "attacker-objects",
    GIT_REPLACE_REF_BASE: "refs/evil",
    DOCKER_HOST: "unix:///safe/docker.sock",
  });
  assert.equal("GIT_DIR" in environment, false);
  assert.equal("GIT_OBJECT_DIRECTORY" in environment, false);
  assert.equal("GIT_REPLACE_REF_BASE" in environment, false);
  assert.equal(environment.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
  assert.match(verifierSource, /--no-replace-objects/);
  assert.match(verifierSource, /refs\/replace/);
  assert.match(verifierSource, /info[\\/]grafts/);
  assert.match(verifierSource, /objects[\\/]info[\\/]alternates/);
  assert.doesNotMatch(verifierSource, /spawnSync\(["']git["']/);
  assert.match(exporterSource, /--git-path/);
  assert.match(exporterSource, /--no-replace-objects/);
  assert.doesNotMatch(exporterSource, /execFileSync\(["']git["']/);
  for (const helper of [buildHelper, evidenceHelper]) {
    assert.match(helper, /\[string\]\$NodePath/);
    assert.match(helper, new RegExp(NODE_LINUX_SHA256));
    assert.match(helper, /122889056/);
    assert.doesNotMatch(helper, /Get-Command\s+node/);
    assert.match(helper, /\[string\]\$GitPath/);
    assert.match(helper, /2\.53\.0/);
    assert.match(helper, new RegExp(GIT_LINUX_SHA256));
    assert.match(helper, /--no-replace-objects/);
    assert.doesNotMatch(helper, /Get-Command\s+git/);
    assert.doesNotMatch(helper, /^\s*git\s/m);
  }
  assert.equal(parseCliArguments(["--mode", "qualify", "--git-path", resolve("git")])["git-path"], resolve("git"));
  assert.throws(
    () => validateCliModeArguments({ mode: "qualify", schema: resolve("schema.json") }),
    /--git-path is required/i,
  );
});

test("Git object verification rejects forged loose commit and tree bytes under approved object IDs", async (t) => {
  const { readGitBlobRecords, verifyGitLineage } = await loadScript("scripts/verify-image-lock.mjs");
  const gitPath = localGitPath();
  const createRepository = async (label) => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), `openclaw-git-object-${label}-`));
    t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
    execFileSync(gitPath, ["init", "--quiet"], { cwd: repositoryRoot });
    await writeFile(join(repositoryRoot, "a.txt"), "one\n");
    execFileSync(gitPath, ["add", "--", "a.txt"], { cwd: repositoryRoot });
    execFileSync(
      gitPath,
      ["-c", "user.name=Codex", "-c", "user.email=noreply@openai.com", "commit", "--quiet", "-m", "M"],
      { cwd: repositoryRoot },
    );
    const expectedM = execFileSync(gitPath, ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "ascii",
    }).trim();
    await writeFile(join(repositoryRoot, "a.txt"), "two\n");
    execFileSync(gitPath, ["add", "--", "a.txt"], { cwd: repositoryRoot });
    execFileSync(
      gitPath,
      ["-c", "user.name=Codex", "-c", "user.email=noreply@openai.com", "commit", "--quiet", "-m", "R"],
      { cwd: repositoryRoot },
    );
    const reviewedTree = execFileSync(gitPath, ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "ascii",
    }).trim();
    const writeForgedLooseObject = async (oid, type, bytes) => {
      const objectDirectory = join(repositoryRoot, ".git", "objects", oid.slice(0, 2));
      await mkdir(objectDirectory, { recursive: true });
      const objectPath = join(objectDirectory, oid.slice(2));
      await rm(objectPath, { force: true });
      await writeFile(
        objectPath,
        deflateSync(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`, "ascii"), bytes])),
      );
    };
    return { repositoryRoot, expectedM, reviewedTree, writeForgedLooseObject };
  };

  const commitFixture = await createRepository("commit");
  const commitBytes = execFileSync(gitPath, ["cat-file", "commit", commitFixture.reviewedTree], {
    cwd: commitFixture.repositoryRoot,
    encoding: null,
  });
  const forgedCommit = Buffer.concat([commitBytes, Buffer.from("forged-message\n", "utf8")]);
  await commitFixture.writeForgedLooseObject(commitFixture.reviewedTree, "commit", forgedCommit);
  await assert.rejects(
    verifyGitLineage({
      gitPath,
      repositoryRoot: commitFixture.repositoryRoot,
      expectedM: commitFixture.expectedM,
      reviewedTree: commitFixture.reviewedTree,
    }),
    /Git.*(?:hash|object)|(?:hash|object).*Git/i,
  );

  const treeFixture = await createRepository("tree");
  const rootTree = execFileSync(gitPath, ["rev-parse", `${treeFixture.reviewedTree}^{tree}`], {
    cwd: treeFixture.repositoryRoot,
    encoding: "ascii",
  }).trim();
  const treeBytes = execFileSync(gitPath, ["cat-file", "tree", rootTree], {
    cwd: treeFixture.repositoryRoot,
    encoding: null,
  });
  const forgedTree = Buffer.from(treeBytes);
  const modeOffset = forgedTree.indexOf(Buffer.from("100644", "ascii"));
  assert.notEqual(modeOffset, -1);
  Buffer.from("100755", "ascii").copy(forgedTree, modeOffset);
  await treeFixture.writeForgedLooseObject(rootTree, "tree", forgedTree);
  await assert.rejects(
    readGitBlobRecords({
      gitPath,
      repositoryRoot: treeFixture.repositoryRoot,
      commit: treeFixture.reviewedTree,
      paths: ["a.txt"],
    }),
    /Git.*(?:hash|object)|(?:hash|object).*Git/i,
  );
});

test("verifier rejects a context mutation without Docker or network", async (t) => {
  const { verifyImageLock } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-lock-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "scripts"));
  await mkdir(join(fixture, "session-crypto", "dist"), { recursive: true });
  await writeFile(join(fixture, "Dockerfile"), "FROM scratch\n");
  await writeFile(join(fixture, "scripts", "install.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(fixture, "session-crypto", "dist", "crypto.js"), "crypto\n");
  await writeFile(join(fixture, "session-crypto", "dist", "daemon.js"), "daemon\n");
  await writeFile(join(fixture, "session-crypto", "dist", "package.json"), "{}\n");

  const lock = {
    schema_version: 2,
    algorithm: "ihome-openclaw-context-root-v2",
    source_date_epoch: SOURCE_DATE_EPOCH,
    platform: "linux/amd64",
    base_image: BASE_IMAGE,
    buildkit_image: BUILDKIT_IMAGE,
    buildx: {
      version: "0.13.1",
      windows_amd64_sha256:
        "6b113e84cbc3cd645646aa82f00a7f7d3737cc10375b4341e0aca0de0c997c75",
      linux_amd64_sha256:
        "3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c",
    },
    docker: {
      version: "29.1.3",
      linux_amd64_sha256: DOCKER_LINUX_SHA256,
    },
    git: {
      version: "2.53.0",
      linux_amd64_sha256: GIT_LINUX_SHA256,
    },
    node: {
      version: "24.15.0",
      linux_amd64_size: 122889056,
      linux_amd64_sha256: NODE_LINUX_SHA256,
    },
    inputs: [
      {
        path: "Dockerfile",
        type: "blob",
        mode: "100644",
        size: 13,
        sha256: sha256(Buffer.from("FROM scratch\n")),
      },
      {
        path: "scripts/install.sh",
        type: "blob",
        mode: "100755",
        size: 17,
        sha256: sha256(Buffer.from("#!/bin/sh\nexit 0\n")),
      },
      {
        path: "session-crypto/dist/crypto.js",
        type: "blob",
        mode: "100644",
        size: 7,
        sha256: sha256(Buffer.from("crypto\n")),
      },
      {
        path: "session-crypto/dist/daemon.js",
        type: "blob",
        mode: "100644",
        size: 7,
        sha256: sha256(Buffer.from("daemon\n")),
      },
      {
        path: "session-crypto/dist/package.json",
        type: "blob",
        mode: "100644",
        size: 3,
        sha256: sha256(Buffer.from("{}\n")),
      },
    ],
  };
  const lockPath = join(fixture, "image-lock.json");
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await verifyImageLock({ root: fixture, lockPath });
  await writeFile(join(fixture, "Dockerfile"), "FROM busybox\n");

  await assert.rejects(
    verifyImageLock({ root: fixture, lockPath }),
    /Dockerfile sha256 mismatch/,
  );
});

test("verifier rejects an OCI that omits the pinned base, fork, and session files", async (t) => {
  const { verifyOciRuntimeImage } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-oci-bypass-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const archivePath = join(fixture, "scratch.oci.tar");
  await writeFile(archivePath, scratchOciBytes());
  const lock = JSON.parse(await readCell("image-lock.json"));
  const fork = JSON.parse(
    await readCell("vendor/zalouser-bridge/FORK.json"),
  );

  await assert.rejects(
    () => verifyOciRuntimeImage({ archivePath, fork, lock }),
    /pinned base|base layer|installed fork|session/i,
  );
});

test("plugin probe requires authentic stock and fork list/inspect discovery", async () => {
  const { validatePluginProbeResults } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const pluginRoot =
    "/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser";
  const baseList = { plugins: [{ id: "active-memory" }] };
  const forkPlugin = {
    id: "zalouser",
    name: "Zalo Personal",
    version: "2026.7.1",
    source: `${pluginRoot}/dist/index.js`,
    rootDir: pluginRoot,
    origin: "global",
    enabled: true,
    status: "loaded",
    channelIds: ["zalouser"],
    contracts: { tools: ["zalouser"] },
    dependencyStatus: {
      hasDependencies: false,
      installed: true,
      requiredInstalled: true,
      optionalInstalled: true,
      missing: [],
      missingOptional: [],
      dependencies: [],
      optionalDependencies: [],
    },
  };
  const forkList = { plugins: [...baseList.plugins, forkPlugin] };
  const stockList = { plugins: [...baseList.plugins, forkPlugin] };
  const forkInspect = {
    plugin: {
      ...forkPlugin,
      packageName: "@openclaw/zalouser",
      imported: true,
    },
    install: {
      source: "npm",
      spec: "@openclaw/zalouser@2026.7.1",
      installPath: pluginRoot,
      version: "2026.7.1",
      resolvedName: "@openclaw/zalouser",
      resolvedVersion: "2026.7.1",
      resolvedSpec: "@openclaw/zalouser@2026.7.1",
    },
  };
  const result = validatePluginProbeResults({
    forkList: {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(forkList)),
      stderr: Buffer.alloc(0),
    },
    forkInspect: {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(forkInspect)),
      stderr: Buffer.alloc(0),
    },
    stockList: {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(stockList)),
      stderr: Buffer.alloc(0),
    },
    stockInspect: {
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify(forkInspect)),
      stderr: Buffer.alloc(0),
    },
  });

  assert.equal(result.fork.plugin_count, 2);
  assert.equal(result.stock.plugin_count, 2);
  assert.equal(result.stock.plugin.root_dir, pluginRoot);
  assert.equal(result.fork.plugin.root_dir, pluginRoot);
  assert.equal(result.fork.inspect.install_path, pluginRoot);
  assert.equal("differential" in result, false);
  assert.throws(
    () =>
      validatePluginProbeResults({
        forkList: { exitCode: 0, stdout: Buffer.from(JSON.stringify(baseList)), stderr: Buffer.alloc(0) },
        forkInspect: { exitCode: 0, stdout: Buffer.from(JSON.stringify(forkInspect)), stderr: Buffer.alloc(0) },
        stockList: { exitCode: 0, stdout: Buffer.from(JSON.stringify(stockList)), stderr: Buffer.alloc(0) },
        stockInspect: { exitCode: 0, stdout: Buffer.from(JSON.stringify(forkInspect)), stderr: Buffer.alloc(0) },
      }),
    /fork.*zalouser/i,
  );
});

test("Docker probe arguments isolate plugin inspection from network and host state", async () => {
  const { dockerProbeRunArguments } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const args = dockerProbeRunArguments({
    image: "ihome/openclaw-probe:0123456789abcdef0123456789abcdef",
    cliArguments: ["plugins", "inspect", "zalouser", "--runtime", "--json"],
  });
  assert.deepEqual(args.slice(0, 3), ["run", "--pull=never", "--rm"]);
  assert.ok(args.includes("none"));
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2), [
    "--cap-drop",
    "ALL",
  ]);
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("/home/node/.openclaw/state:rw,noexec,nosuid,size=16m,uid=1000,gid=1000,mode=0700"));
  assert.ok(args.includes("/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000,mode=0700"));
  assert.deepEqual(args.slice(-6), [
    "openclaw.mjs",
    "plugins",
    "inspect",
    "zalouser",
    "--runtime",
    "--json",
  ]);
});

test("installed runtime scenarios are finite, complete, and run in the hardened container", async () => {
  const { dockerPrivateRpcProbeArguments, dockerRuntimeScenarioArguments, runtimeScenarioPlan } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fork = JSON.parse(
    await readCell("vendor/zalouser-bridge/FORK.json"),
  );
  const plan = runtimeScenarioPlan(fork);
  assert.deepEqual(
    plan.map(({ scenario }) => scenario),
    [
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
    ],
  );
  assert.equal(plan.every(({ targetMembers }) => targetMembers.length > 0), true);
  const args = dockerRuntimeScenarioArguments({
    image: "ihome/openclaw-probe:0123456789abcdef0123456789abcdef",
    scenario: plan[0],
  });
  assert.deepEqual(args.slice(0, 3), ["run", "--pull=never", "--rm"]);
  assert.ok(args.includes("none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("--eval"));
  assert.equal(args.some((value) => /(?:^|[\\/])host|docker\.sock/i.test(value)), false);
  const privateRpcArgs = dockerPrivateRpcProbeArguments({
    image: "ihome/openclaw-probe:0123456789abcdef0123456789abcdef",
  });
  assert.ok(privateRpcArgs.includes("--pull=never"));
  assert.ok(privateRpcArgs.includes("--eval"));
  assert.ok(privateRpcArgs.includes("none"));
  assert.equal(privateRpcArgs.some((value) => /docker\.sock|--privileged/i.test(value)), false);
});

test("runtime Docker probe validates outputs and removes only its unique tags", async (t) => {
  const { probeOpenClawRuntimeImages } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-docker-probe-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const dockerPath = join(fixture, "docker");
  const dockerHost = "unix:///run/ihome-openclaw-test/docker.sock";
  const archivePath = join(fixture, "runtime.oci.tar");
  const stockArchivePath = join(fixture, "stock.oci.tar");
  const behaviorRunnerPath = join(fixture, "behavior-probe-runner.mjs");
  const dockerBytes = Buffer.from("reviewed docker cli\n");
  const behaviorRunnerBytes = Buffer.from(await readCell("scripts/behavior-probe-runner.mjs"));
  await writeFile(dockerPath, dockerBytes);
  await writeFile(archivePath, "oci\n");
  await writeFile(stockArchivePath, "stock oci\n");
  await writeFile(behaviorRunnerPath, behaviorRunnerBytes);
  const nonce = "a".repeat(32);
  const forkTag = `ihome/openclaw-fork-probe:${nonce}`;
  const stockTag = `ihome/openclaw-stock-probe:${nonce}`;
  const pluginRoot =
    "/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser";
  const baseList = { plugins: [{ id: "active-memory" }] };
  const plugin = {
    id: "zalouser",
    name: "Zalo Personal",
    version: "2026.7.1",
    source: `${pluginRoot}/dist/index.js`,
    rootDir: pluginRoot,
    origin: "global",
    enabled: true,
    status: "loaded",
    channelIds: ["zalouser"],
    contracts: { tools: ["zalouser"] },
    dependencyStatus: {
      installed: true,
      requiredInstalled: true,
      optionalInstalled: true,
      missing: [],
      missingOptional: [],
    },
  };
  const forkList = { plugins: [...baseList.plugins, plugin] };
  const stockList = { plugins: [...baseList.plugins, plugin] };
  const forkInspect = {
    plugin: { ...plugin, packageName: "@openclaw/zalouser", imported: true },
    install: {
      source: "npm",
      spec: "@openclaw/zalouser@2026.7.1",
      installPath: pluginRoot,
      version: "2026.7.1",
      resolvedName: "@openclaw/zalouser",
      resolvedVersion: "2026.7.1",
      resolvedSpec: "@openclaw/zalouser@2026.7.1",
    },
  };
  const fork = JSON.parse(
    await readCell("vendor/zalouser-bridge/FORK.json"),
  );
  const calls = [];
  const invoke = async (file, args, options) => {
    assert.equal(options?.environment?.DOCKER_HOST, dockerHost);
    calls.push({ file, args: [...args], input: options?.input });
    if (args[0] === "version") {
      return { exitCode: 0, stdout: Buffer.from("29.1.3|29.1.3|linux|amd64\n"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("not found\n") };
    }
    if (["load", "tag"].includes(args[0]) || (args[0] === "image" && args[1] === "rm")) {
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "run") {
      const image = args[args.indexOf("--entrypoint") + 2];
      const behaviorVariant = args
        .find((value) => value.startsWith("IHOME_BEHAVIOR_VARIANT="))
        ?.slice("IHOME_BEHAVIOR_VARIANT=".length);
      if (behaviorVariant) {
        assert.deepEqual(options?.input, behaviorRunnerBytes);
        return {
          exitCode: 0,
          stdout: Buffer.from(`${JSON.stringify(passingBehaviorTranscript(behaviorVariant))}\n`),
          stderr: Buffer.alloc(0),
        };
      }
      if (args.includes("--eval")) {
        const encoded = args
          .find((value) => value.startsWith("IHOME_RUNTIME_SCENARIO="))
          ?.slice("IHOME_RUNTIME_SCENARIO=".length);
        if (!encoded) {
          return {
            exitCode: 0,
            stdout: Buffer.from(
              `${JSON.stringify({
                schema: 1,
                method: "zalouser.bridge.send",
                scope: "operator.write",
                registeredMethodCount: 1,
                deniedWithoutRuntime: true,
                errorCode: "PRIVATE_RPC_REQUIRED",
                providerFrameCount: 0,
              })}\n`,
            ),
            stderr: Buffer.alloc(0),
          };
        }
        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        return {
          exitCode: 0,
          stdout: Buffer.from(
            `${JSON.stringify({
              schema: 1,
              scenario: payload.scenario,
              traceKind: "instrumented-installed-runtime",
              resolvedMembers: payload.targetMembers,
            })}\n`,
          ),
          stderr: Buffer.alloc(0),
        };
      }
      const isInspect = args.includes("inspect");
      if (image === forkTag) {
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify(isInspect ? forkInspect : forkList)),
          stderr: Buffer.alloc(0),
        };
      }
      if (image === stockTag && !isInspect) {
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify(stockList)), stderr: Buffer.alloc(0) };
      }
      if (image === stockTag && isInspect) {
        return { exitCode: 0, stdout: Buffer.from(JSON.stringify(forkInspect)), stderr: Buffer.alloc(0) };
      }
    }
    throw new Error(`unexpected fake Docker call: ${args.join(" ")}`);
  };

  const result = await probeOpenClawRuntimeImages({
    archivePath,
    stockArchivePath,
    baseImage: BASE_IMAGE,
    dockerPath,
    dockerHost,
    dockerSha256: sha256(dockerBytes),
    expectedDockerVersion: "29.1.3",
    manifestDigest: `sha256:${"b".repeat(64)}`,
    stockManifestDigest: `sha256:${"c".repeat(64)}`,
    nonce,
    fork,
    behaviorRunnerPath,
    behaviorRunnerSha256: sha256(behaviorRunnerBytes),
    invoke,
  });

  assert.equal("differential" in result, false);
  assert.equal(
    JSON.parse(Buffer.from(result.behavior.fork.transcript_base64, "base64").toString("utf8")).schema,
    3,
  );
  assert.equal(
    JSON.parse(Buffer.from(result.behavior.stock.transcript_base64, "base64").toString("utf8")).implementation,
    "stock",
  );
  assert.equal(result.behavior.runner.sha256, sha256(behaviorRunnerBytes));
  assert.equal(result.behavior.fork_oci.archive_sha256, sha256(Buffer.from("oci\n")));
  assert.equal(result.behavior.stock_oci.archive_sha256, sha256(Buffer.from("stock oci\n")));
  assert.equal(result.runtime_scenarios.traces.length, 16);
  assert.deepEqual(result.private_rpc, {
    method: "zalouser.bridge.send",
    scope: "operator.write",
    registered_method_count: 1,
    denied_without_runtime: true,
    error_code: "PRIVATE_RPC_REQUIRED",
    provider_frame_count: 0,
    stdout_size: result.private_rpc.stdout_size,
    stdout_sha256: result.private_rpc.stdout_sha256,
  });
  assert.match(result.private_rpc.stdout_sha256, /^[0-9a-f]{64}$/);
  assert.ok(result.runtime_scenarios.resolved_runtime_set.length > 0);
  assert.equal(
    result.runtime_scenarios.resolved_runtime_set.every((member) =>
      fork.runtimeReachabilityAllowlist.includes(member),
    ),
    true,
  );
  assert.equal(
    calls.filter(({ args }) => args[0] === "image" && args[1] === "rm").length,
    2,
  );
  assert.equal(calls.filter(({ args }) => args[0] === "load").length, 2);
  assert.equal(calls.some(({ args }) => args[0] === "pull"), false);
  assert.equal(
    calls.filter(({ args }) => args[0] === "run").every(({ args }) => args.includes("--network") && args.includes("none")),
    true,
  );
  assert.equal(
    calls.filter(({ args }) => args.includes("IHOME_BEHAVIOR_VARIANT=fork") || args.includes("IHOME_BEHAVIOR_VARIANT=stock"))
      .every(({ input }) => Buffer.isBuffer(input) && input.equals(behaviorRunnerBytes)),
    true,
  );
});

test("private RPC probe resolves the OpenClaw SDK before importing the installed plugin", async () => {
  const { dockerPrivateRpcProbeArguments } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const args = dockerPrivateRpcProbeArguments({
    image: "ihome/openclaw-zalo-probe:0123456789abcdef0123456789abcdef",
  });
  const evalIndex = args.indexOf("--eval");
  assert.notEqual(evalIndex, -1);
  const source = args[evalIndex + 1];
  const hookIndex = source.indexOf("registerHooks({");
  const pluginImportIndex = source.indexOf(
    'await import(pathToFileURL(root + "/dist/index.js").href)',
  );

  assert.ok(hookIndex >= 0, "private RPC probe must install a module-resolution hook");
  assert.ok(
    pluginImportIndex > hookIndex,
    "private RPC probe must install the hook before importing the plugin",
  );
  assert.match(source, /specifier === "openclaw" \|\| specifier\.startsWith\("openclaw\/"\)/);
  assert.match(source, /parentURL: "file:\/\/\/app\/openclaw\.mjs"/);
});

test("schema or probe evidence failure cannot promote an OCI archive", async (t) => {
  const { publishVerifiedRelease } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-promotion-order-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const archivePath = join(fixture, "candidate.oci.tar");
  const releasePath = join(fixture, "release.oci.tar");
  const evidencePath = join(fixture, "evidence.json");
  await writeFile(archivePath, "candidate\n");
  let promoteCalls = 0;
  await assert.rejects(
    publishVerifiedRelease({
      archivePath,
      evidence: { schema_version: 1 },
      evidencePath,
      releaseArtifactPath: releasePath,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["schema_version", "runtime_probe"],
        properties: {
          schema_version: { type: "integer", const: 1 },
          runtime_probe: { type: "object" },
        },
      },
      promote: async () => {
        promoteCalls += 1;
        return { size: 10, sha256: "0".repeat(64) };
      },
    }),
    /runtime_probe|missing/i,
  );
  assert.equal(promoteCalls, 0);
  await assert.rejects(stat(releasePath), /ENOENT/);
  await assert.rejects(stat(evidencePath), /ENOENT/);
});

test("release promotion rejects a symlinked destination ancestor", async (t) => {
  const { publishVerifiedRelease } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-promotion-link-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const outside = join(fixture, "outside");
  const linked = join(fixture, "linked");
  await mkdir(outside);
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  const archivePath = join(fixture, "candidate.oci.tar");
  const releasePath = join(linked, "release.oci.tar");
  const evidencePath = join(fixture, "evidence.json");
  const archiveBytes = Buffer.from("candidate\n");
  await writeFile(archivePath, archiveBytes);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const evidence = {
    oci: {
      promoted_archive_role: "A",
      promoted_archive_sha256: archiveSha256,
    },
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["oci"],
    properties: {
      oci: {
        type: "object",
        additionalProperties: false,
        required: ["promoted_archive_role", "promoted_archive_sha256"],
        properties: {
          promoted_archive_role: { type: "string", const: "A" },
          promoted_archive_sha256: { type: "string" },
        },
      },
    },
  };

  await assert.rejects(
    publishVerifiedRelease({
      archivePath,
      evidence,
      evidencePath,
      releaseArtifactPath: releasePath,
      schema,
    }),
    /link|reparse|ancestor/i,
  );
  await assert.rejects(stat(join(outside, "release.oci.tar")), /ENOENT/);
});

test("qualifying main probes Docker before schema validation and promotion", async () => {
  const source = await readCell("scripts/verify-image-lock.mjs");
  const mainStart = source.indexOf("async function main()");
  const reviewedExport = source.indexOf("await readReviewedExportFromArgs(args)", mainStart);
  const probe = source.indexOf("await probeOpenClawRuntimeImages", mainStart);
  const schema = source.indexOf("validateJsonSchema(evidence, schema)", mainStart);
  const promote = source.indexOf("publishVerifiedRelease", mainStart);
  assert.ok(mainStart >= 0 && reviewedExport > mainStart);
  assert.ok(probe > reviewedExport);
  assert.ok(schema > probe);
  assert.ok(promote > schema);
  assert.match(source.slice(mainStart), /"docker-path"/);
  assert.match(source.slice(mainStart), /"docker-sha256"/);
  assert.match(source.slice(mainStart), /"reviewed-source-root"/);
  assert.match(source.slice(mainStart), /"reviewed-export-manifest"/);
  assert.match(source.slice(mainStart), /"reviewed-export-manifest-sha256"/);
  assert.match(source.slice(mainStart), /assertAbsoluteQualifyingOperands\(args\)/);
  assert.ok(
    source.indexOf("assertAbsoluteQualifyingOperands(args)", mainStart) <
      source.indexOf("const retainedInputs = await captureRetainedQualificationInputs", mainStart),
  );
  assert.match(source.slice(mainStart), /reviewed_export:\s*reviewedExport/);
});

test("evidence-only runtime validation rebinds derived, allowlisted, and traced members", async () => {
  const { runtimeScenarioPlan, validateRecordedRuntimeEvidence } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const committedFork = JSON.parse(
    await readCell("vendor/zalouser-bridge/FORK.json"),
  );
  const fork = {
    ...committedFork,
    derivedRuntimeSet: committedFork.runtimeReachabilityAllowlist,
  };
  const scenarioPlan = runtimeScenarioPlan(fork);
  const scenarioTraces = scenarioPlan.map(({ scenario, targetMembers }) => ({
    scenario,
    trace_kind: "instrumented-installed-runtime",
    target_members: targetMembers,
    resolved_members: targetMembers,
    stdout_size: 123,
    stdout_sha256: "a".repeat(64),
  }));
  const resolvedRuntimeSet = [
    ...new Set(scenarioTraces.flatMap(({ resolved_members }) => resolved_members)),
  ].sort();
  const recorded = {
    dynamic_site_inventory: fork.runtimeDynamicSiteInventory,
    derived_runtime_set: fork.derivedRuntimeSet,
    runtime_reachability_allowlist: fork.runtimeReachabilityAllowlist,
    scenario_traces: scenarioTraces,
    resolved_runtime_set: resolvedRuntimeSet,
  };
  assert.doesNotThrow(() => validateRecordedRuntimeEvidence(fork, recorded));
  assert.throws(
    () =>
      validateRecordedRuntimeEvidence(fork, {
        ...recorded,
        resolved_runtime_set: [...recorded.resolved_runtime_set, "package/dist/not-allowlisted.js"],
      }),
    /resolved runtime set|allowlist/i,
  );
});

test("runtime delta requires the exact installed fork, session closure, and config", async () => {
  const { verifyRuntimeDeltaRecords } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const lock = JSON.parse(await readCell("image-lock.json"));
  const fork = JSON.parse(
    await readCell("vendor/zalouser-bridge/FORK.json"),
  );
  const epoch = Number(lock.source_date_epoch);
  const forkRoot = "home/node/.openclaw/npm/projects/zalouser";
  const records = fork.installedTree.entries.map((entry) => ({
    ...entry,
    path: `${forkRoot}/${entry.path}`,
    mtime: epoch,
  }));
  for (const input of lock.inputs.filter(({ path }) =>
    SESSION_DIST.includes(path),
  )) {
    records.push({
      ...input,
      path: `opt/openclaw-cell/${input.path}`,
      type: "file",
      mode: input.mode === "100755" ? "0755" : "0644",
      mtime: epoch,
    });
  }
  const config = lock.inputs.find(
    ({ path }) => path === "config/openclaw.json.tmpl",
  );
  records.push({
    ...config,
    path: "opt/openclaw-cell/openclaw.json.tmpl",
    type: "file",
    mode: config.mode === "100755" ? "0755" : "0644",
    mtime: epoch,
  });

  const delta = verifyRuntimeDeltaRecords({ fork, lock, records });
  assert.equal(delta.records.length, records.length);
  assert.match(delta.records_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    delta.session_records.map(({ path }) => path),
    SESSION_DIST.map((path) => `opt/openclaw-cell/${path}`),
  );
  assert.equal(delta.fork_records.length, fork.installedTree.entries.length);
  assert.equal(delta.config_record.path, "opt/openclaw-cell/openclaw.json.tmpl");
  assert.throws(
    () =>
      verifyRuntimeDeltaRecords({
        fork,
        lock,
        records: records.map((entry) =>
          entry.path.endsWith("session-crypto/dist/crypto.js")
            ? { ...entry, sha256: "0".repeat(64) }
            : entry,
        ),
      }),
    /session.*mismatch/i,
  );
  assert.throws(
    () =>
      verifyRuntimeDeltaRecords({
        fork,
        lock,
        records: records.concat({
          path: "opt/openclaw-cell/session-crypto/dist/debug.js",
          type: "file",
          mode: "0644",
          size: 0,
          sha256: sha256(Buffer.alloc(0)),
          mtime: epoch,
        }),
      }),
    /unexpected runtime delta path/i,
  );
  assert.throws(
    () =>
      verifyRuntimeDeltaRecords({
        fork,
        lock,
        records: records.slice(1),
      }),
    /installed fork.*mismatch/i,
  );
});

test("OCI layer parser hashes regular files and rejects unsafe archive structure", async () => {
  const { parseRuntimeLayerTar } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const epoch = Number(SOURCE_DATE_EPOCH);
  const bytes = Buffer.from("crypto\n");
  const records = parseRuntimeLayerTar(
    tarBytes([
      {
        path: "opt/openclaw-cell/session-crypto/dist",
        type: "5",
        mode: 0o755,
        mtime: epoch,
      },
      {
        path: "opt/openclaw-cell/session-crypto/dist/crypto.js",
        bytes,
        mode: 0o644,
        mtime: epoch,
      },
    ]),
  );
  assert.deepEqual(records, [
    {
      path: "opt/openclaw-cell/session-crypto/dist",
      type: "directory",
      mode: "0755",
      size: 0,
      sha256: sha256(Buffer.alloc(0)),
      mtime: epoch,
    },
    {
      path: "opt/openclaw-cell/session-crypto/dist/crypto.js",
      type: "file",
      mode: "0644",
      size: bytes.length,
      sha256: sha256(bytes),
      mtime: epoch,
    },
  ]);
  assert.throws(
    () =>
      parseRuntimeLayerTar(
        tarBytes([{ path: "../escape", bytes: Buffer.from("bad") }]),
      ),
    /portable|unsafe|path/i,
  );
  assert.throws(
    () =>
      parseRuntimeLayerTar(
        tarBytes([
          { path: "safe", bytes: Buffer.from("one") },
          { path: "SAFE", bytes: Buffer.from("two") },
        ]),
      ),
    /duplicate|collision/i,
  );
});

test("reviewed-tree exporter consumes raw Git blobs and rehashes its complete output", async () => {
  const exporter = await loadScript("scripts/export-reviewed-tree.mjs");
  const source = await readCell("scripts/export-reviewed-tree.mjs");
  const records = exporter.parseLsTreeRecords(
    Buffer.from(
      "100644 blob 1111111111111111111111111111111111111111\tDockerfile\0" +
        "100755 blob 2222222222222222222222222222222222222222\tscripts/install.sh\0",
      "utf8",
    ),
  );

  assert.deepEqual(records, [
    {
      mode: "100644",
      type: "blob",
      oid: "1111111111111111111111111111111111111111",
      path: "Dockerfile",
    },
    {
      mode: "100755",
      type: "blob",
      oid: "2222222222222222222222222222222222222222",
      path: "scripts/install.sh",
    },
  ]);
  assert.match(source, /"ls-tree", "-rz", "--full-tree"/);
  assert.match(source, /"cat-file", "--batch"/);
  assert.doesNotMatch(source, /"(?:archive|checkout|restore)"/);
});

test("reviewed export binding rehashes every manifest entry and rejects checkout drift", async (t) => {
  const { verifyReviewedExportBinding } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-reviewed-export-binding-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const sourceRoot = join(fixture, "source");
  await mkdir(sourceRoot);
  const bytes = Buffer.from("reviewed\n", "utf8");
  await writeFile(join(sourceRoot, "a.txt"), bytes);
  const oid = createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
  const reviewedTree = "1".repeat(40);
  const manifest = {
    schema_version: 1,
    git_object_format: "sha1",
    reviewed_tree: reviewedTree,
    entries: [
      {
        path: "a.txt",
        type: "blob",
        mode: "100644",
        git_object_id: oid,
        git_object_size: bytes.length,
        content_size: bytes.length,
        content_sha256: sha256(bytes),
      },
    ],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestPath = join(fixture, "reviewed-tree-manifest.json");
  await writeFile(manifestPath, manifestBytes);
  const binding = await verifyReviewedExportBinding({
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    reviewedTree,
    sourceRoot,
  });
  assert.equal(binding.entry_count, 1);
  assert.equal(binding.manifest_sha256, sha256(manifestBytes));

  await writeFile(join(sourceRoot, "a.txt"), "drift\n");
  await assert.rejects(
    verifyReviewedExportBinding({
      manifestPath,
      manifestSha256: sha256(manifestBytes),
      reviewedTree,
      sourceRoot,
    }),
    /a\.txt.*(?:size|sha|Git object)|reviewed export/i,
  );
});

test("recorded reviewed export evidence is exact, closed, and bound to R", async () => {
  const { validateRecordedReviewedExport } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const reviewedTree = "2".repeat(40);
  const recorded = {
    manifest_path: resolve("C:/tmp/reviewed-tree-manifest.json"),
    manifest_sha256: "a".repeat(64),
    manifest_size: 123,
    reviewed_tree: reviewedTree,
    entry_count: 87,
    entries_sha256: "b".repeat(64),
  };
  assert.doesNotThrow(() => validateRecordedReviewedExport(recorded, reviewedTree));
  assert.throws(
    () => validateRecordedReviewedExport({ ...recorded, reviewed_tree: "3".repeat(40) }, reviewedTree),
    /reviewed export.*tree/i,
  );
  assert.throws(
    () => validateRecordedReviewedExport({ ...recorded, unexpected: true }, reviewedTree),
    /unknown|missing|unexpected/i,
  );

  const schema = JSON.parse(await readCell("build-evidence.schema.v1.json"));
  assert.ok(schema.required.includes("reviewed_export"));
  assert.equal(schema.properties.reviewed_export.additionalProperties, false);
  assert.ok(schema.properties.verification.required.includes("reviewed_export"));
});

test("supply-chain evidence binds committed M inputs, signatures, and the exact fork artifact", async () => {
  const {
    collectRawMInputs,
    collectSupplyChainMetadata,
    readReviewedForkGitObjects,
    sigstoreInputsFromRawM,
    validateRecordedSupplyChainEvidence,
  } = await loadScript("scripts/verify-image-lock.mjs");
  const sourceRoot = resolve(cellRoot, "../..");
  const gitPath = localGitPath();
  const expectedM = "0650187981ad9728d295fae34eff92b508e36bc8";
  const reviewedTree = (await import("node:child_process")).execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: sourceRoot, encoding: "ascii" },
  ).trim();
  const metadata = await collectSupplyChainMetadata({
    gitPath,
    sourceRoot,
    repositoryRoot: sourceRoot,
    expectedM,
    reviewedTree,
  });
  const rawR = await readReviewedForkGitObjects({ gitPath, repositoryRoot: sourceRoot, reviewedTree });
  assert.equal(rawR.forkRecord.source, "git-object");
  assert.equal(rawR.artifactRecord.source, "git-object");
  assert.equal(rawR.artifactRecord.sha256, metadata.fork.artifact_sha256);
  const rawM = await collectRawMInputs({
    gitPath,
    repositoryRoot: sourceRoot,
    expectedM,
  });
  assert.deepEqual(Object.keys(sigstoreInputsFromRawM(rawM)).sort(), [
    "attestations",
    "keys",
    "metadata",
    "trustRoot",
    "upstream",
  ]);
  const recorded = {
    ...metadata,
    proof: {
      npm_signature: "verified",
      slsa: "verified",
      rekor_entries: 2,
      dsse_pae_verified: true,
      set_verified: true,
      inclusion_proof_verified: true,
      checkpoint_verified: true,
      certificate_chain_verified: true,
      body_binding_verified: true,
      verified_tarball_sha256: metadata.upstream.tarball.sha256,
    },
  };
  await assert.doesNotReject(
    validateRecordedSupplyChainEvidence(recorded, {
      gitPath,
      sourceRoot,
      repositoryRoot: sourceRoot,
      expectedM,
      reviewedTree,
    }),
  );
  assert.equal(recorded.committed_inputs.input_count, 87);
  assert.equal(recorded.committed_inputs.provenance_inputs.length, 4);
  assert.equal(recorded.upstream.source_manifest_count, 75);
  assert.equal(recorded.upstream.license_carrier_count, 39);
  assert.equal(recorded.fork.artifact_member_count, rawR.fork.artifactMembers.length);
  assert.equal(recorded.fork.artifact_sha256, rawR.artifactRecord.sha256);
  await assert.rejects(
    validateRecordedSupplyChainEvidence(
      {
        ...recorded,
        fork: { ...recorded.fork, artifact_sha256: "0".repeat(64) },
      },
      { gitPath, sourceRoot, repositoryRoot: sourceRoot, expectedM, reviewedTree },
    ),
    /supply-chain|fork artifact/i,
  );

  const source = await readCell("scripts/verify-image-lock.mjs");
  const mainStart = source.indexOf("async function main()");
  assert.match(source.slice(mainStart), /await collectQualifyingSupplyChainEvidence/);
  assert.match(source.slice(mainStart), /supply_chain:\s*supplyChain/);
  assert.doesNotMatch(source, /reviewedSha:\s*evidence\.reviews\.M\.reviewed_sha/);
  assert.doesNotMatch(source, /readFile\(resolve\(root,\s*"vendor\/zalouser-bridge\/FORK\.json"\)\)/);
  assert.match(source, /verifySigstoreAttestations\(\{[\s\S]*metadata[\s\S]*keys[\s\S]*attestations[\s\S]*trustRoot/);
  const schema = JSON.parse(await readCell("build-evidence.schema.v1.json"));
  assert.ok(schema.required.includes("supply_chain"));
  assert.equal(schema.$defs.supplyChain.additionalProperties, false);
  assert.ok(schema.properties.verification.required.includes("supply_chain"));
});
