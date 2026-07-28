import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("worker container hardening", () => {
  it("runs as non-root with a healthcheck on Node 20", () => {
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/FROM node:20(?:[.-])/);
    expect(dockerfile).toMatch(/USER 10001:10001/);
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).not.toMatch(/FROM\s+.*:latest/i);
  });

  it("uses a read-only root filesystem, bounded resources, and no Docker socket", () => {
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/read_only:\s*true/);
    expect(compose).toMatch(/cap_drop:[\s\S]*- ALL/);
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose).toMatch(/mem_limit:/);
    expect(compose).toMatch(/cpus:/);
    expect(compose).toMatch(/pids_limit:/);
    expect(compose).not.toContain("/var/run/docker.sock");
    expect(compose).not.toMatch(/9router|zalo/i);
  });

  it("documents only secret file paths, never inline secret values", () => {
    const example = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(example).toContain("NETWORK_CENTER_WORKER_SECRET_FILE=");
    expect(example).toContain("NETWORK_CENTER_CREDENTIALS_FILE=");
    expect(example).not.toMatch(/^NETWORK_CENTER_WORKER_SECRET=/m);
    expect(example).not.toMatch(/^SUPABASE_SERVICE_ROLE_KEY=/m);
  });
});
