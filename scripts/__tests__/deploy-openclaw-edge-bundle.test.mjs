import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  OPENCLAW_EDGE_FUNCTIONS,
  buildEdgeFunctionBundle,
  deployEdgeFunction,
  parseDeployArgs,
} from "../deploy-edge-fn.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openclaw-edge-bundle-"));
  const shared = join(root, "_shared", "openclaw");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "types.ts"), "export const việt = '✓';\n", "utf8");
  await writeFile(
    join(shared, "runtime-auth.test.ts"),
    "throw new Error('tests must not deploy');\n",
    "utf8",
  );
  for (const slug of Object.keys(OPENCLAW_EDGE_FUNCTIONS)) {
    const directory = join(root, slug);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "index.ts"),
      `import "../_shared/openclaw/types.ts";\nexport const slug = "${slug}";\n`,
      "utf8",
    );
    await writeFile(join(directory, "handler.ts"), "export const handler = true;\n", "utf8");
  }
  await mkdir(join(root, "unrelated-function"), { recursive: true });
  await writeFile(join(root, "unrelated-function", "index.ts"), "throw new Error('exclude');\n");
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("OpenClaw Edge multipart bundle", () => {
  it("has the exact five entrypoints and JWT modes", () => {
    expect(OPENCLAW_EDGE_FUNCTIONS).toEqual({
      "openclaw-control": { verifyJwt: true },
      "openclaw-qr": { verifyJwt: true },
      "openclaw-object-tickets": { verifyJwt: true },
      "openclaw-runtime-token": { verifyJwt: false },
      "openclaw-runtime": { verifyJwt: false },
    });
  });

  it("version-controls every OpenClaw JWT mode in Supabase config", async () => {
    const config = await readFile(join(process.cwd(), "supabase", "config.toml"), "utf8");
    for (const [slug, settings] of Object.entries(OPENCLAW_EDGE_FUNCTIONS)) {
      const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(config).toMatch(new RegExp(
        `\\[functions\\.${escaped}\\]\\s+verify_jwt\\s*=\\s*${settings.verifyJwt}`,
      ));
    }
  });

  it("documents the exact OpenClaw auth, deploy, secret, and deny contract", async () => {
    const readme = await readFile(
      join(process.cwd(), "supabase", "functions", "README.md"),
      "utf8",
    );
    for (const slug of Object.keys(OPENCLAW_EDGE_FUNCTIONS)) {
      expect(readme).toContain(`\`${slug}\``);
    }
    for (const required of [
      "--include-shared openclaw",
      "OPENCLAW_RUNTIME_TOKEN_SIGNING_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "reject browser `Origin`",
      "cross-organization",
      "replay",
      "QR",
      "session",
      "model",
      "R2",
    ]) {
      expect(readme).toContain(required);
    }
  });

  it("bundles only the target plus _shared/openclaw with UTF-8 bytes", async () => {
    const prepared = await fixture();
    try {
      for (const [slug, settings] of Object.entries(OPENCLAW_EDGE_FUNCTIONS)) {
        const bundle = await buildEdgeFunctionBundle({
          functionsRoot: prepared.root,
          slug,
          includeShared: "openclaw",
        });
        expect(bundle.metadata).toEqual({
          name: slug,
          entrypoint_path: `${slug}/index.ts`,
          verify_jwt: settings.verifyJwt,
        });
        expect(bundle.files.map((file) => file.path)).toEqual([
          "_shared/openclaw/types.ts",
          `${slug}/handler.ts`,
          `${slug}/index.ts`,
        ]);
        expect(bundle.files.some((file) => file.path.includes("unrelated-function")))
          .toBe(false);
        const shared = bundle.files.find((file) => file.path.endsWith("types.ts"));
        expect(new TextDecoder().decode(shared.bytes)).toContain("việt");
        const entrypoint = bundle.files.find((file) => file.path === `${slug}/index.ts`);
        expect(new TextDecoder().decode(entrypoint.bytes))
          .toContain('import "../_shared/openclaw/types.ts"');
      }
    } finally {
      await prepared.cleanup();
    }
  });

  it("rejects sensitive dotfiles from an OpenClaw bundle", async () => {
    const prepared = await fixture();
    try {
      await writeFile(
        join(prepared.root, "_shared", "openclaw", ".env"),
        "OPENCLAW_SECRET=must-not-deploy\n",
        "utf8",
      );
      await expect(buildEdgeFunctionBundle({
        functionsRoot: prepared.root,
        slug: "openclaw-runtime",
        includeShared: "openclaw",
      })).rejects.toThrow(/forbidden|sensitive|dotfile/i);
    } finally {
      await prepared.cleanup();
    }
  });

  it("parses the shared mode strictly and rejects JWT overrides", () => {
    expect(parseDeployArgs([
      "openclaw-runtime",
      "--include-shared",
      "openclaw",
    ])).toEqual({ slug: "openclaw-runtime", includeShared: "openclaw" });
    expect(parseDeployArgs([
      "openclaw-runtime-token",
      "--no-verify-jwt",
      "--include-shared",
      "openclaw",
    ])).toEqual({ slug: "openclaw-runtime-token", includeShared: "openclaw" });
    expect(() => parseDeployArgs([
      "openclaw-control",
      "--include-shared",
      "openclaw",
      "--no-verify-jwt",
    ])).toThrow(/JWT mode/i);
    expect(() => parseDeployArgs(["other", "--include-shared", "openclaw"]))
      .toThrow(/entrypoint/i);
    expect(() => parseDeployArgs(["openclaw-runtime", "--include-shared", "other"]))
      .toThrow(/shared/i);
  });

  it("builds multipart metadata and redacts PATs from deployment failures", async () => {
    const prepared = await fixture();
    try {
      const bundle = await buildEdgeFunctionBundle({
        functionsRoot: prepared.root,
        slug: "openclaw-runtime",
        includeShared: "openclaw",
      });
      const fetchImpl = vi.fn(async (_url, init) => {
        expect(init.method).toBe("POST");
        expect(init.headers.Authorization).toBe("Bearer sbp_synthetic_pat_value");
        const metadata = JSON.parse(init.body.get("metadata"));
        expect(metadata.entrypoint_path).toBe("openclaw-runtime/index.ts");
        expect(metadata.verify_jwt).toBe(false);
        const fileNames = [...init.body.entries()]
          .filter(([name]) => name === "file")
          .map(([, value]) => value.name)
          .sort();
        expect(fileNames).toEqual(bundle.files.map((file) => file.path));
        return new Response("failure token=sbp_synthetic_pat_value", { status: 500 });
      });

      await expect(deployEdgeFunction({
        bundle,
        projectRef: "tryymsxyyckgbrmmvozx",
        accessToken: "sbp_synthetic_pat_value",
        fetchImpl,
      })).rejects.toThrow(/\[REDACTED/);
      await expect(deployEdgeFunction({
        bundle,
        projectRef: "tryymsxyyckgbrmmvozx",
        accessToken: "sbp_synthetic_pat_value",
        fetchImpl,
      })).rejects.not.toThrow(/sbp_synthetic_pat_value/);
    } finally {
      await prepared.cleanup();
    }
  });

  it("keeps legacy single-function mode rooted at the function directory", async () => {
    const prepared = await fixture();
    try {
      const bundle = await buildEdgeFunctionBundle({
        functionsRoot: prepared.root,
        slug: "openclaw-control",
        verifyJwt: true,
      });
      expect(bundle.metadata.entrypoint_path).toBe("index.ts");
      expect(bundle.files.map((file) => file.path)).toEqual(["handler.ts", "index.ts"]);
      expect(await readFile(join(prepared.root, "openclaw-control", "index.ts"), "utf8"))
        .toContain("openclaw-control");
    } finally {
      await prepared.cleanup();
    }
  });
});
