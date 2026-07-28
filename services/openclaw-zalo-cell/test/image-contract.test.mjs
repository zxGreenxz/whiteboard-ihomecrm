import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

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

async function readCell(relativePath) {
  return readFile(join(cellRoot, relativePath), "utf8");
}

async function loadScript(relativePath) {
  return import(pathToFileURL(join(cellRoot, relativePath)).href);
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
  assert.equal(schema.properties.reviews.properties.M.$ref, "#/$defs/reviewRecord");
  assert.equal(schema.properties.reviews.properties.R.$ref, "#/$defs/reviewRecord");

  const reviewSchema = schema.$defs.reviewRecord;
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
  const fixture = await mkdtemp(join(tmpdir(), "openclaw-review-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
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
  const reportPath = join(fixture, "m-review.json");
  await writeFile(reportPath, canonicalBytes);

  const embedded = await readCanonicalReviewReport(reportPath, {
    checkpoint: "M",
    reviewedSha,
  });
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
    readCanonicalReviewReport(reportPath, { checkpoint: "M", reviewedSha }),
    /duplicate JSON key/i,
  );
  await writeFile(
    reportPath,
    `${JSON.stringify({ schema: 1, ...report })}\n`,
  );
  await assert.rejects(
    readCanonicalReviewReport(reportPath, { checkpoint: "M", reviewedSha }),
    /not canonical/i,
  );
});

test("PowerShell helper pins builders and makes the verifier the promotion gate", async () => {
  const script = await readCell("scripts/build-reproducible-image.ps1");

  assert.match(script, /^#Requires -Version 7\.3/m);
  assert.match(script, /\[IO\.Path\]::IsPathFullyQualified\(\$BuildxPath\)/);
  assert.match(script, /\[string\]\$DockerPath/);
  assert.match(script, /\[IO\.Path\]::IsPathFullyQualified\(\$DockerPath\)/);
  assert.match(script, new RegExp(DOCKER_LINUX_SHA256));
  assert.match(script, /'--docker-path', \$resolvedDocker/);
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
  assert.match(script, /'--release-artifact', \$ReleaseArtifactPath/);
  assert.match(script, /\[string\]\$MReviewReportPath/);
  assert.match(script, /\[string\]\$RReviewReportPath/);
  assert.match(script, /'--m-review-report', \$resolvedMReviewReport/);
  assert.match(script, /'--r-review-report', \$resolvedRReviewReport/);
  assert.doesNotMatch(script, /Invoke-Expression|cmd\s+\/c|Start-Process/);
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

test("plugin probe requires stock-fail and exact fork list/inspect discovery", async () => {
  const { validatePluginProbeResults } = await loadScript(
    "scripts/verify-image-lock.mjs",
  );
  const pluginRoot =
    "/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser";
  const stockList = { plugins: [{ id: "active-memory" }] };
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
  const forkList = { plugins: [...stockList.plugins, forkPlugin] };
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
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("Plugin not found: zalouser\n"),
    },
  });

  assert.equal(result.fork.plugin_count, 2);
  assert.equal(result.stock.plugin_count, 1);
  assert.equal(result.fork.plugin.root_dir, pluginRoot);
  assert.equal(result.fork.inspect.install_path, pluginRoot);
  assert.deepEqual(result.differential, {
    fork_pass: true,
    stock_fail: true,
    plugin_delta: 1,
  });
  assert.throws(
    () =>
      validatePluginProbeResults({
        forkList: { exitCode: 0, stdout: Buffer.from(JSON.stringify(stockList)), stderr: Buffer.alloc(0) },
        forkInspect: { exitCode: 0, stdout: Buffer.from(JSON.stringify(forkInspect)), stderr: Buffer.alloc(0) },
        stockList: { exitCode: 0, stdout: Buffer.from(JSON.stringify(stockList)), stderr: Buffer.alloc(0) },
        stockInspect: { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("Plugin not found: zalouser\n") },
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
  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
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
  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
  assert.ok(args.includes("none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("--eval"));
  assert.equal(args.some((value) => /(?:^|[\\/])host|docker\.sock/i.test(value)), false);
  const privateRpcArgs = dockerPrivateRpcProbeArguments({
    image: "ihome/openclaw-probe:0123456789abcdef0123456789abcdef",
  });
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
  const archivePath = join(fixture, "runtime.oci.tar");
  const dockerBytes = Buffer.from("reviewed docker cli\n");
  await writeFile(dockerPath, dockerBytes);
  await writeFile(archivePath, "oci\n");
  const nonce = "a".repeat(32);
  const forkTag = `ihome/openclaw-fork-probe:${nonce}`;
  const stockTag = `ihome/openclaw-stock-probe:${nonce}`;
  const pluginRoot =
    "/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser";
  const stockList = { plugins: [{ id: "active-memory" }] };
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
  const forkList = { plugins: [...stockList.plugins, plugin] };
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
  const invoke = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (args[0] === "version") {
      return { exitCode: 0, stdout: Buffer.from("29.1.3|29.1.3|linux|amd64\n"), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("not found\n") };
    }
    if (["load", "tag", "pull"].includes(args[0]) || (args[0] === "image" && args[1] === "rm")) {
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args[0] === "run") {
      const image = args[args.indexOf("--entrypoint") + 2];
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
        return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("Plugin not found: zalouser\n") };
      }
    }
    throw new Error(`unexpected fake Docker call: ${args.join(" ")}`);
  };

  const result = await probeOpenClawRuntimeImages({
    archivePath,
    baseImage: BASE_IMAGE,
    dockerPath,
    dockerSha256: sha256(dockerBytes),
    expectedDockerVersion: "29.1.3",
    manifestDigest: `sha256:${"b".repeat(64)}`,
    nonce,
    fork,
    invoke,
  });

  assert.deepEqual(result.differential, { fork_pass: true, stock_fail: true, plugin_delta: 1 });
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
  assert.equal(
    calls.filter(({ args }) => args[0] === "run").every(({ args }) => args.includes("--network") && args.includes("none")),
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
    collectSupplyChainMetadata,
    validateRecordedSupplyChainEvidence,
  } = await loadScript("scripts/verify-image-lock.mjs");
  const sourceRoot = resolve(cellRoot, "../..");
  const mReviewedTree = "0650187981ad9728d295fae34eff92b508e36bc8";
  const metadata = await collectSupplyChainMetadata({ sourceRoot, mReviewedTree });
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
    validateRecordedSupplyChainEvidence(recorded, { sourceRoot, mReviewedTree }),
  );
  assert.equal(recorded.committed_inputs.input_count, 87);
  assert.equal(recorded.committed_inputs.provenance_inputs.length, 4);
  assert.equal(recorded.upstream.source_manifest_count, 75);
  assert.equal(recorded.upstream.license_carrier_count, 39);
  assert.equal(recorded.fork.artifact_member_count, 71);
  assert.equal(recorded.fork.artifact_sha256, "b489752ac0e114e5b068b19d58a438744fd141158dd1ff4ce72a7d8d7c51f919");
  await assert.rejects(
    validateRecordedSupplyChainEvidence(
      {
        ...recorded,
        fork: { ...recorded.fork, artifact_sha256: "0".repeat(64) },
      },
      { sourceRoot, mReviewedTree },
    ),
    /supply-chain|fork artifact/i,
  );

  const source = await readCell("scripts/verify-image-lock.mjs");
  const mainStart = source.indexOf("async function main()");
  assert.match(source.slice(mainStart), /await collectQualifyingSupplyChainEvidence/);
  assert.match(source.slice(mainStart), /supply_chain:\s*supplyChain/);
  const schema = JSON.parse(await readCell("build-evidence.schema.v1.json"));
  assert.ok(schema.required.includes("supply_chain"));
  assert.equal(schema.$defs.supplyChain.additionalProperties, false);
  assert.ok(schema.properties.verification.required.includes("supply_chain"));
});
