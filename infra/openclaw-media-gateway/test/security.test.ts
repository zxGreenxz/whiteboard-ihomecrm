import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { evaluateMediaPolicy, MAX_OBJECT_BYTES } from "../src/media-policy";
import { png } from "./fixtures";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const PNG = png();

function policyInput(overrides: Record<string, unknown> = {}) {
  return {
    bytes: PNG,
    declaredContentType: "image/png",
    declaredContentLength: PNG.byteLength,
    declaredSha256: sha256Hex(PNG),
    actualSha256: sha256Hex(PNG),
    ...overrides,
  } as Parameters<typeof evaluateMediaPolicy>[0];
}

describe("OpenClaw media upload policy", () => {
  it("accepts a well-formed declared object", () => {
    expect(evaluateMediaPolicy(policyInput())).toEqual({ ok: true });
  });

  it("rejects a MIME type outside the allowlist", () => {
    expect(
      evaluateMediaPolicy(policyInput({ declaredContentType: "text/html" })),
    ).toEqual({ ok: false, failure: "TYPE_NOT_ALLOWED" });
  });

  it("rejects a declared type whose magic bytes disagree", () => {
    expect(
      evaluateMediaPolicy(policyInput({ declaredContentType: "application/pdf" })),
    ).toEqual({ ok: false, failure: "TYPE_NOT_ALLOWED" });
  });

  it("rejects a partial upload where the declared length disagrees", () => {
    expect(
      evaluateMediaPolicy(policyInput({ declaredContentLength: PNG.byteLength + 10 })),
    ).toEqual({ ok: false, failure: "LENGTH_MISMATCH" });
  });

  it("rejects a digest mismatch", () => {
    expect(
      evaluateMediaPolicy(policyInput({ declaredSha256: "a".repeat(64) })),
    ).toEqual({ ok: false, failure: "DIGEST_MISMATCH" });
  });

  it("rejects an object above the hard byte ceiling", () => {
    const big = new Uint8Array(MAX_OBJECT_BYTES + 1);
    big.set(PNG, 0);
    expect(
      evaluateMediaPolicy({
        bytes: big,
        declaredContentType: "image/png",
        declaredContentLength: big.byteLength,
        declaredSha256: sha256Hex(big),
        actualSha256: sha256Hex(big),
      }),
    ).toEqual({ ok: false, failure: "TOO_LARGE" });
  });

  it("quarantines active content even when the declared type is allowed", () => {
    const marker = new TextEncoder().encode("<script>alert(1)</script>");
    const active = new Uint8Array(PNG.byteLength + marker.byteLength);
    active.set(PNG);
    active.set(marker, PNG.byteLength);
    expect(
      evaluateMediaPolicy({
        bytes: active,
        declaredContentType: "image/png",
        declaredContentLength: active.byteLength,
        declaredSha256: sha256Hex(active),
        actualSha256: sha256Hex(active),
      }),
    ).toEqual({ ok: false, failure: "ACTIVE_CONTENT" });
  });

  it("finds active content after a padded prefix instead of scanning only the first kilobyte", () => {
    const prefix = new Uint8Array(2_048);
    prefix.set([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]);
    const marker = new TextEncoder().encode("<script>alert(1)</script>");
    const active = new Uint8Array(prefix.byteLength + marker.byteLength);
    active.set(prefix);
    active.set(marker, prefix.byteLength);
    expect(evaluateMediaPolicy({
      bytes: active,
      declaredContentType: "video/mp4",
      declaredContentLength: active.byteLength,
      declaredSha256: sha256Hex(active),
      actualSha256: sha256Hex(active),
    })).toEqual({ ok: false, failure: "ACTIVE_CONTENT" });
  });

  it("allows canonical JSON audit anchors", () => {
    const anchor = new TextEncoder().encode('{"version":1,"root":"abc"}');
    expect(
      evaluateMediaPolicy({
        bytes: anchor,
        declaredContentType: "application/json",
        declaredContentLength: anchor.byteLength,
        declaredSha256: sha256Hex(anchor),
        actualSha256: sha256Hex(anchor),
      }),
    ).toEqual({ ok: true });
  });
});

describe("OpenClaw media gateway Wrangler contract", () => {
  const wrangler = readFileSync(
    resolve(import.meta.dirname, "..", "wrangler.toml"),
    "utf8",
  );

  it("binds the private bucket and never exposes a public endpoint", () => {
    expect(wrangler).toContain('bucket_name = "ihome-openclaw-media-private"');
    expect(wrangler).toContain("workers_dev = false");
    expect(wrangler).toContain("preview_urls = false");
    expect(wrangler).not.toContain("workers_dev = true");
    expect(wrangler).not.toContain("preview_urls = true");
    expect(wrangler).not.toContain("custom_domain");
    expect(wrangler).not.toMatch(/r2\.dev/);
    expect(wrangler).not.toMatch(/public_bucket/);
  });

  it("pins the exact zone route", () => {
    expect(wrangler).toContain(
      'routes = [\n  { pattern = "openclaw-media.chillhome.io.vn/*", zone_name = "chillhome.io.vn" }\n]',
    );
  });

  it("declares the TicketState durable object", () => {
    expect(wrangler).toContain('class_name = "TicketState"');
  });
});

describe("OpenClaw media gateway package contract", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as {
    engines: { node: string };
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it("defines exact build, test, typecheck, and deploy scripts", () => {
    for (const script of ["build", "test", "typecheck", "deploy"]) {
      expect(packageJson.scripts[script], script).toBeTruthy();
    }
  });

  it("gates deploy behind build, test, and typecheck", () => {
    const deploy = packageJson.scripts.deploy;
    expect(deploy).toContain("build");
    expect(deploy).toContain("test");
    expect(deploy).toContain("typecheck");
  });

  it("pins the official Node runtime and a reproducible Wrangler deploy helper", () => {
    expect(packageJson.engines.node).toBe(">=24.15.0 <25");
    expect(packageJson.devDependencies.wrangler).toMatch(/^\d+\.\d+\.\d+$/u);

    const deployHelper = readFileSync(
      resolve(import.meta.dirname, "..", "scripts", "deploy.mjs"),
      "utf8",
    ) + readFileSync(
      resolve(import.meta.dirname, "..", "scripts", "deploy-lib.mjs"),
      "utf8",
    );
    expect(deployHelper).toContain("--minify");
    expect(deployHelper).toContain("--keep-vars");
    expect(deployHelper).toContain("bundleSha256");
    expect(deployHelper).toContain("workerVersion");
    expect(deployHelper).toContain("process.versions.node");
    expect(deployHelper).toContain("wranglerTimeoutMs");
    expect(deployHelper).toContain('"--no-bundle"');
    expect(deployHelper).toContain('"deploy", bundlePath');
    expect(deployHelper).toContain('args[0] === "--dry-run"');
    expect(deployHelper).toContain("--expected-config-sha256");
    expect(deployHelper).toContain("configSha256");
    expect(deployHelper).toContain("process.kill(posixProcessGroupId");
    expect(deployHelper).toContain("dryRun");
    expect(deployHelper).not.toContain("workers.dev");
  });
});
