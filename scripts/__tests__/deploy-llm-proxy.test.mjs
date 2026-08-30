import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  LLM_PROXY_RELEASE_MANIFEST,
  buildLlmProxyRelease,
  collectLlmProxyBundle,
  deployLlmProxy,
  parseDeployArgs,
  validateLlmProxyManifest,
} from "../deploy-llm-proxy.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

describe("standalone llm-proxy deployment", () => {
  it("pins the production project, reviewed SHA, entrypoint digest, bundle digest, and JWT mode", () => {
    expect(LLM_PROXY_RELEASE_MANIFEST.projectRef).toBe("tryymsxyyckgbrmmvozx");
    expect(LLM_PROXY_RELEASE_MANIFEST.reviewedGitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(LLM_PROXY_RELEASE_MANIFEST.function).toEqual(expect.objectContaining({
      slug: "llm-proxy",
      entrypoint: "index.ts",
      verifyJwt: true,
    }));
    expect(LLM_PROXY_RELEASE_MANIFEST.function.files).toEqual([
      expect.objectContaining({ path: "index.ts", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    expect(LLM_PROXY_RELEASE_MANIFEST.function.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("parses only an explicit release SHA", () => {
    expect(parseDeployArgs(["--release-sha", "a".repeat(40)])).toEqual({ releaseSha: "a".repeat(40) });
    expect(() => parseDeployArgs([])).toThrow(/release-sha/i);
    expect(() => parseDeployArgs(["--release-sha", "not-a-sha"])).toThrow(/release-sha/i);
  });

  it("collects exactly index.ts and computes the pinned release attestation", async () => {
    const root = await mkdtemp(join(tmpdir(), "llm-proxy-deploy-"));
    try {
      const functionRoot = join(root, "supabase", "functions", "llm-proxy");
      await mkdir(functionRoot, { recursive: true });
      const source = "export default () => new Response('ok');\n";
      await writeFile(join(functionRoot, "index.ts"), source, "utf8");
      await writeFile(join(functionRoot, "ignored.test.ts"), "throw new Error('no');\n", "utf8");

      const fileDigest = sha256(Buffer.from(source));
      const manifest = {
        ...LLM_PROXY_RELEASE_MANIFEST,
        function: {
          ...LLM_PROXY_RELEASE_MANIFEST.function,
          files: [{ path: "index.ts", sha256: fileDigest }],
          bundleSha256: sha256(JSON.stringify([{ path: "index.ts", sha256: fileDigest }])),
        },
      };
      const release = await buildLlmProxyRelease({ repoRoot: root, manifest, releaseSha: "b".repeat(40) });
      expect(release.files.map((file) => file.path)).toEqual(["index.ts"]);
      expect(release.indexSha256).toBe(fileDigest);
      expect(release.bundleSha256).toBe(manifest.function.bundleSha256);
      expect(release.reviewedGitSha).toBe(manifest.reviewedGitSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uploads only after local attestation and verifies the deployed JWT mode by readback", async () => {
    const source = Buffer.from("export default () => new Response('ok');\n");
    const fileDigest = sha256(source);
    const manifest = {
      projectRef: "tryymsxyyckgbrmmvozx",
      reviewedGitSha: "a".repeat(40),
      function: {
        slug: "llm-proxy",
        entrypoint: "index.ts",
        verifyJwt: true,
        files: [{ path: "index.ts", sha256: fileDigest }],
        bundleSha256: sha256(JSON.stringify([{ path: "index.ts", sha256: fileDigest }])),
      },
    };
    const root = await mkdtemp(join(tmpdir(), "llm-proxy-deploy-"));
    try {
      const functionRoot = join(root, "supabase", "functions", "llm-proxy");
      await mkdir(functionRoot, { recursive: true });
      await writeFile(join(functionRoot, "index.ts"), source);
      const calls = [];
      const fetchImpl = vi.fn(async (url, init = {}) => {
        calls.push({ url, init });
        if (init.method === "POST") {
          const metadata = JSON.parse(init.body.get("metadata"));
          expect(metadata).toEqual({ name: "llm-proxy", entrypoint_path: "index.ts", verify_jwt: true });
          expect([...init.body.entries()].filter(([name]) => name === "file").map(([, value]) => value.name)).toEqual(["index.ts"]);
          return new Response(JSON.stringify({ slug: "llm-proxy", version: 7, verify_jwt: true }), { status: 200 });
        }
        return new Response(JSON.stringify([{ slug: "llm-proxy", verify_jwt: true, version: 7 }]), { status: 200 });
      });
      const result = await deployLlmProxy({
        repoRoot: root,
        manifest,
        config: { projectRef: manifest.projectRef, pat: "sbp_test_llm_proxy_pat" },
        releaseSha: "b".repeat(40),
        fetchImpl,
      });
      expect(result).toMatchObject({
        projectRef: manifest.projectRef,
        reviewedGitSha: manifest.reviewedGitSha,
        releaseSha: "b".repeat(40),
        slug: "llm-proxy",
        verifyJwt: true,
        version: 7,
        indexSha256: fileDigest,
        bundleSha256: manifest.function.bundleSha256,
      });
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toContain("/projects/tryymsxyyckgbrmmvozx/functions/deploy?slug=llm-proxy");
      expect(calls[1].url).toContain("/projects/tryymsxyyckgbrmmvozx/functions");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a project mismatch and never calls the Management API", async () => {
    const fetchImpl = vi.fn();
    await expect(deployLlmProxy({
      manifest: { ...LLM_PROXY_RELEASE_MANIFEST, projectRef: "wrongprojectref00000" },
      config: { projectRef: "tryymsxyyckgbrmmvozx", pat: "sbp_test_llm_proxy_pat" },
      releaseSha: "b".repeat(40),
      fetchImpl,
    })).rejects.toThrow(/project/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects readback that turns JWT verification off", async () => {
    const source = Buffer.from("export default () => new Response('ok');\n");
    const fileDigest = sha256(source);
    const manifest = {
      projectRef: "tryymsxyyckgbrmmvozx",
      reviewedGitSha: "a".repeat(40),
      function: {
        slug: "llm-proxy",
        entrypoint: "index.ts",
        verifyJwt: true,
        files: [{ path: "index.ts", sha256: fileDigest }],
        bundleSha256: sha256(JSON.stringify([{ path: "index.ts", sha256: fileDigest }])),
      },
    };
    const root = await mkdtemp(join(tmpdir(), "llm-proxy-deploy-"));
    try {
      const functionRoot = join(root, "supabase", "functions", "llm-proxy");
      await mkdir(functionRoot, { recursive: true });
      await writeFile(join(functionRoot, "index.ts"), source);
      const fetchImpl = vi.fn(async (_url, init = {}) => init.method === "POST"
        ? new Response(JSON.stringify({ slug: "llm-proxy", verify_jwt: true, version: 7 }), { status: 200 })
        : new Response(JSON.stringify([{ slug: "llm-proxy", verify_jwt: false, version: 7 }]), { status: 200 }));
      await expect(deployLlmProxy({
        repoRoot: root,
        manifest,
        config: { projectRef: manifest.projectRef, pat: "sbp_test_llm_proxy_pat" },
        releaseSha: "b".repeat(40),
        fetchImpl,
      })).rejects.toThrow(/verify_jwt|readback/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
