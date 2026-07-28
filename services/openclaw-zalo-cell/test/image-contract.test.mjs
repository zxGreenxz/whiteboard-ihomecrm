import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const cellRoot = resolve(testDir, "..");

const BASE_IMAGE =
  "ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f";
const BUILDKIT_IMAGE =
  "moby/buildkit:v0.13.2@sha256:9194b5ec1be368f41c516df7f93f7f540630ea06136056b2ffebb62226ed4ad6";
const SOURCE_DATE_EPOCH = "1785062400";
const CONTEXT_GOLDEN =
  "925be74a4fe381076871348887a653659ada468fa21333d5d22585be9e381f4e";
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
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b|https:\/\//i);
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
