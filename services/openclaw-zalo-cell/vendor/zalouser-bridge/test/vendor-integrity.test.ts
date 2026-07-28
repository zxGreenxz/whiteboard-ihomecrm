import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportReviewedTree } from "../../../scripts/export-reviewed-tree.mjs";
import {
  fetchBoundedJson,
  fetchTarballWithRedirects,
  verifyCommittedInputs,
  verifyExternalSourceMembership,
  verifySigstoreAttestations,
} from "../scripts/verify-upstream.mjs";

const vendorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(vendorRoot, "../../../..");

describe("reviewed upstream and legal inputs", () => {
  it("follows at most three HTTPS redirects within the npm registry", async () => {
    const calls: string[] = [];
    const result = await fetchTarballWithRedirects(
      "https://registry.npmjs.org/@openclaw/zalouser/-/zalouser-2026.7.1.tgz",
      64,
      async (input) => {
        const url = String(input);
        calls.push(url);
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn.registry.npmjs.org/zalouser.tgz" },
          });
        }
        return new Response(Buffer.from("tgz"), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      },
    );

    if (!result) throw new Error("tarball acquisition returned no result");
    expect(result.finalUrl).toBe("https://cdn.registry.npmjs.org/zalouser.tgz");
    expect(result.bytes).toEqual(Buffer.from("tgz"));
    expect(calls).toEqual([
      "https://registry.npmjs.org/@openclaw/zalouser/-/zalouser-2026.7.1.tgz",
      "https://cdn.registry.npmjs.org/zalouser.tgz",
    ]);
  });

  it("rejects a redirect that leaves the registry organization", async () => {
    await expect(
      fetchTarballWithRedirects(
        "https://registry.npmjs.org/@openclaw/zalouser/-/zalouser-2026.7.1.tgz",
        64,
        async () => new Response(null, {
          status: 302,
          headers: { location: "https://example.com/zalouser.tgz" },
        }),
      ),
    ).rejects.toThrow(/registry|redirect|host/i);
  });

  it("reacquires JSON with identity encoding, no redirects, and a hard byte cap", async () => {
    const body = Buffer.from('{"ok":true}', "utf8");
    const calls: Array<{ url: string; redirect: string; headers: Record<string, string> }> = [];
    const result = await fetchBoundedJson(
      "https://registry.npmjs.org/example",
      64,
      async (input, init) => {
        calls.push({
          url: String(input),
          redirect: String(init?.redirect),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      },
    );

    expect(result).toEqual({ bytes: body, contentType: "application/json; charset=utf-8" });
    expect(calls).toEqual([
      {
        url: "https://registry.npmjs.org/example",
        redirect: "manual",
        headers: { accept: "application/json", "accept-encoding": "identity" },
      },
    ]);
  });

  it("cryptographically verifies both committed npm and SLSA Sigstore bundles", () => {
    const result = verifySigstoreAttestations({
      vendorRoot,
      upstream: JSON.parse(readFileSync(resolve(vendorRoot, "UPSTREAM.json"), "utf8")),
      tarballBytes: readFileSync(resolve(vendorRoot, ".work/verified-upstream.tgz")),
    });

    expect(result).toMatchObject({ npm: "verified", slsa: "verified", rekorEntries: 2 });
  });

  it("rejects a tampered Sigstore payload before any positive result", () => {
    const upstream = JSON.parse(readFileSync(resolve(vendorRoot, "UPSTREAM.json"), "utf8"));
    const tampered = JSON.parse(
      readFileSync(resolve(vendorRoot, "upstream/provenance/npm-attestation-bundles.json"), "utf8"),
    );
    tampered.attestations[1].bundle.dsseEnvelope.payload = `${tampered.attestations[1].bundle.dsseEnvelope.payload.slice(0, -1)}A`;

    expect(() =>
      verifySigstoreAttestations({
        vendorRoot,
        upstream,
        tarballBytes: readFileSync(resolve(vendorRoot, ".work/verified-upstream.tgz")),
        attestations: tampered,
      }),
    ).toThrow(/DSSE|payload|signature/i);
  });

  it("verifies the exact 75-blob GitHub subtree with four bounded requests", async () => {
    const upstream = JSON.parse(readFileSync(resolve(vendorRoot, "UPSTREAM.json"), "utf8"));
    const commitTree = "1".repeat(40);
    const extensionsTree = "2".repeat(40);
    const zalouserTree = "3".repeat(40);
    const responses = new Map<string, unknown>([
      [
        `https://api.github.com/repos/openclaw/openclaw/git/commits/${upstream.sourceCommit}`,
        { sha: upstream.sourceCommit, tree: { sha: commitTree } },
      ],
      [
        `https://api.github.com/repos/openclaw/openclaw/git/trees/${commitTree}`,
        {
          truncated: false,
          tree: [
            ...upstream.rootCompliance.map((item: { sourcePath: string; mode: string; gitBlobOid: string; size: number }) => ({
              path: item.sourcePath,
              mode: item.mode,
              type: "blob",
              sha: item.gitBlobOid,
              size: item.size,
            })),
            { path: "extensions", mode: "040000", type: "tree", sha: extensionsTree },
          ],
        },
      ],
      [
        `https://api.github.com/repos/openclaw/openclaw/git/trees/${extensionsTree}`,
        { truncated: false, tree: [{ path: "zalouser", mode: "040000", type: "tree", sha: zalouserTree }] },
      ],
      [
        `https://api.github.com/repos/openclaw/openclaw/git/trees/${zalouserTree}?recursive=1`,
        {
          truncated: false,
          tree: upstream.sourceManifest.map((item: { sourcePath: string; mode: string; gitBlobOid: string; size: number }) => ({
            path: item.sourcePath.slice("extensions/zalouser/".length),
            mode: item.mode,
            type: "blob",
            sha: item.gitBlobOid,
            size: item.size,
          })),
        },
      ],
    ]);
    const calls: string[] = [];

    const result = await verifyExternalSourceMembership({
      upstream,
      fetchImpl: async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        const body = responses.get(url);
        if (!body) return new Response(null, { status: 404 });
        return new Response(Buffer.from(JSON.stringify(body)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(result).toEqual({ requestCount: 4, sourceBlobCount: 75 });
    expect(calls).toEqual([...responses.keys()]);
  });

  it("rechecks every exact M Git object, aggregate, provenance blob, and final UPSTREAM blob", async () => {
    const result = await verifyCommittedInputs({ repoRoot, vendorRoot });

    expect(result).toMatchObject({
      aggregateSha256: "72470cdd84ed7d0cbb06152f57f0e4d1439891cf1909f164c8ece4485fc31a6b",
      inputCount: 87,
      sourceBlobCount: 75,
      upstreamBlobOid: "1feb5726487a162aab7310f702e036ecac09bda1",
      upstreamSha256: "989902dd5a1873025b1fef4864c4a6b9874fbaa15216201dc1c75ad053ce31ea",
    });
  });

  it("rechecks M inputs from a verified exact-R export without relying on a .git directory", async () => {
    const suppliedManifest = process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST;
    const suppliedTree = process.env.OPENCLAW_REVIEWED_R_SHA;
    let detachedVendorRoot = vendorRoot;
    let manifestPath = suppliedManifest;
    let reviewedTree = suppliedTree;
    let temporaryRoot: string | undefined;

    if (!manifestPath || !reviewedTree) {
      reviewedTree = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      temporaryRoot = mkdtempSync(join(tmpdir(), "ihome-reviewed-export-"));
      const outputRoot = join(temporaryRoot, "root");
      manifestPath = join(temporaryRoot, "reviewed-tree-manifest.json");
      exportReviewedTree({ reviewedTree, outputRoot, manifestPath });
      detachedVendorRoot = resolve(outputRoot, relative(repoRoot, vendorRoot));
    }

    try {
      const manifestSha256 = createHash("sha256")
        .update(readFileSync(manifestPath))
        .digest("hex");
      const previousManifestSha256 = process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256;
      process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256 = manifestSha256;
      try {
        await expect(
          verifyCommittedInputs({
            vendorRoot: detachedVendorRoot,
            reviewedExportManifestPath: manifestPath,
            reviewedTree,
          }),
        ).rejects.toThrow(/manifest SHA-256 is required/i);
      } finally {
        if (previousManifestSha256 === undefined) {
          delete process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256;
        } else {
          process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256 = previousManifestSha256;
        }
      }
      const previousBindingEnvironment = {
        manifestPath: process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST,
        manifestSha256: process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256,
        reviewedTree: process.env.OPENCLAW_REVIEWED_R_SHA,
      };
      process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST = manifestPath;
      process.env.OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256 = manifestSha256;
      process.env.OPENCLAW_REVIEWED_R_SHA = reviewedTree;
      try {
        const invalidExplicitBindings = [
          {
            label: "missing manifest path",
            options: {
              reviewedExportManifestPath: undefined,
              reviewedExportManifestSha256: manifestSha256,
              reviewedTree,
            },
            expected: /reviewed export manifest path is required/i,
          },
          {
            label: "missing reviewed tree",
            options: {
              reviewedExportManifestPath: manifestPath,
              reviewedExportManifestSha256: manifestSha256,
              reviewedTree: undefined,
            },
            expected: /reviewed export tree is required/i,
          },
          {
            label: "missing manifest SHA-256",
            options: {
              reviewedExportManifestPath: manifestPath,
              reviewedExportManifestSha256: undefined,
              reviewedTree,
            },
            expected: /reviewed export manifest SHA-256 is required/i,
          },
          {
            label: "empty manifest path",
            options: {
              reviewedExportManifestPath: "",
              reviewedExportManifestSha256: manifestSha256,
              reviewedTree,
            },
            expected: /reviewed export manifest path is required/i,
          },
          {
            label: "empty reviewed tree",
            options: {
              reviewedExportManifestPath: manifestPath,
              reviewedExportManifestSha256: manifestSha256,
              reviewedTree: "",
            },
            expected: /reviewed export tree is required/i,
          },
          {
            label: "empty manifest SHA-256",
            options: {
              reviewedExportManifestPath: manifestPath,
              reviewedExportManifestSha256: "",
              reviewedTree,
            },
            expected: /reviewed export manifest SHA-256 is required/i,
          },
        ] as const;
        for (const testCase of invalidExplicitBindings) {
          await expect(
            verifyCommittedInputs({
              vendorRoot: detachedVendorRoot,
              ...testCase.options,
            }),
            testCase.label,
          ).rejects.toThrow(testCase.expected);
        }
      } finally {
        const restore = (key: string, value: string | undefined) => {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        };
        restore("OPENCLAW_REVIEWED_EXPORT_MANIFEST", previousBindingEnvironment.manifestPath);
        restore(
          "OPENCLAW_REVIEWED_EXPORT_MANIFEST_SHA256",
          previousBindingEnvironment.manifestSha256,
        );
        restore("OPENCLAW_REVIEWED_R_SHA", previousBindingEnvironment.reviewedTree);
      }
      const result = await verifyCommittedInputs({
        vendorRoot: detachedVendorRoot,
        reviewedExportManifestPath: manifestPath,
        reviewedExportManifestSha256: manifestSha256,
        reviewedTree,
      });
      expect(result).toMatchObject({
        aggregateSha256: "72470cdd84ed7d0cbb06152f57f0e4d1439891cf1909f164c8ece4485fc31a6b",
        inputCount: 87,
        sourceBlobCount: 75,
        upstreamBlobOid: "1feb5726487a162aab7310f702e036ecac09bda1",
        upstreamSha256: "989902dd5a1873025b1fef4864c4a6b9874fbaa15216201dc1c75ad053ce31ea",
      });
    } finally {
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps the reviewed manifest as the sole legal carrier inventory", () => {
    const upstream = JSON.parse(readFileSync(resolve(vendorRoot, "UPSTREAM.json"), "utf8"));
    const manifestBytes = readFileSync(resolve(vendorRoot, "licenses/manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));

    expect(manifest.packages).toHaveLength(38);
    expect(manifest.carriers).toHaveLength(39);
    expect(manifest.carriers.filter((item: { package: string }) => item.package === "pako@2.2.0"))
      .toHaveLength(2);
    expect(manifest.packages.find((item: { package: string }) => item.package === "spark-md5@3.0.2"))
      .toMatchObject({ declaredExpression: "WTFPL OR MIT", selectedSpdx: "WTFPL" });
    expect(upstream.licenseManifestSha256).toBe(
      "d1c0f4462e31f03195fe0a21870c35a69fe98337e173d26d1934bdb40c39e158",
    );
  });

  it("renders the root notice and all 39 carrier files only from the reviewed manifest", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(vendorRoot, "licenses/manifest.json"), "utf8"),
    );
    const upstreamLicense = readFileSync(resolve(vendorRoot, "upstream/LICENSE.openclaw"));
    const upstreamNotice = readFileSync(
      resolve(vendorRoot, "upstream/THIRD_PARTY_NOTICES.openclaw.md"),
      "utf8",
    );
    const internalNotice = readFileSync(resolve(vendorRoot, "THIRD_PARTY_NOTICES.md"), "utf8");

    expect(readFileSync(resolve(vendorRoot, "LICENSE"))).toEqual(upstreamLicense);
    expect(internalNotice).toContain(upstreamNotice);
    expect(internalNotice).toContain("pako@2.2.0 has two required carriers");
    expect(internalNotice).toContain("spark-md5@3.0.2 selects the bundled WTFPL carrier");
    for (const item of manifest.packages) {
      expect(internalNotice).toContain(`${item.package} | ${item.selectedSpdx}`);
    }
    for (const item of manifest.carriers) {
      const bytes = readFileSync(resolve(vendorRoot, item.outputPath));
      expect(bytes).toHaveLength(item.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
      expect(internalNotice).toContain(item.outputPath);
    }
  });

  it("uses an explicit vendor preparation command and a complete verification pipeline", () => {
    const packageJson = JSON.parse(readFileSync(resolve(vendorRoot, "package.json"), "utf8"));

    expect(packageJson.private).toBe(true);
    expect(packageJson.packageManager).toBe("npm@11.12.1");
    expect(packageJson.scripts.preflight).toContain("npm_config_user_agent");
    expect(packageJson.scripts.preflight).toContain("npm 11.12.1 is required");
    expect(packageJson.scripts.prepare).toBeUndefined();
    expect(packageJson.scripts["vendor:prepare"]).toContain("scripts/prepare.mjs");
    expect(packageJson.scripts.verify).toContain("verify:upstream");
    expect(packageJson.scripts.verify).toContain("vendor:prepare");
    expect(packageJson.scripts.verify).toContain("typecheck");
    expect(packageJson.scripts.verify).toContain("test");
    expect(packageJson.scripts.verify).toContain("build");
    expect(packageJson.scripts.verify).toContain("pack");
    expect(packageJson.scripts.verify).toContain("verify:artifact");
  });
});
