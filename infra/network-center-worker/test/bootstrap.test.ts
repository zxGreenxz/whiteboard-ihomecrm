import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { generateBootstrap } from "../scripts/generate-router-bootstrap.mjs";

const fixture = {
  routerIdentity: "MikroTik Demo",
  routerUser: "network-center",
  routerPassword: "temporary-random-password-1234567890",
  routerWireGuardPrivateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  routerWireGuardPublicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
  vpsWireGuardPrivateKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
  vpsWireGuardPublicKey: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=",
  workerSshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeWorkerPublicKeyOnly network-center",
  vpsEndpointHost: "203.0.113.10",
  wireGuardPort: 51820,
  managementCidr: "10.77.0.0/24",
  vpsAddress: "10.77.0.1/24",
  vpsPeerAddress: "10.77.0.1/32",
  routerAddress: "10.77.0.2/24",
  routerPeerAddress: "10.77.0.2/32",
  recoveryCidr: "192.168.88.0/24",
  wanInterface: "ether1",
};

describe("demo router bootstrap generator", () => {
  it("generates deterministic staged, lockdown, rollback, and VPS configs", () => {
    const first = generateBootstrap(fixture);
    const second = generateBootstrap(fixture);
    expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([
      "router-bootstrap.rsc",
      "router-lockdown.rsc",
      "router-rollback.rsc",
      "wg0.conf",
      "worker-ssh-key.pub",
    ]);
    for (const content of Object.values(first)) {
      expect(content).not.toMatch(/\{\{[^}]+\}\}|@@[A-Z0-9_]+@@/);
    }
  });

  it("keeps LAN recovery in stage one and restricts management only in explicit lockdown", () => {
    const files = generateBootstrap(fixture);
    expect(files["router-bootstrap.rsc"]).toContain("192.168.88.0/24");
    expect(files["router-bootstrap.rsc"]).toContain("10.77.0.1/32");
    expect(files["router-bootstrap.rsc"]).toContain("network-center-worker.pub");
    expect(files["router-bootstrap.rsc"]).toContain("strong-crypto=yes");
    expect(files["router-lockdown.rsc"]).not.toContain("192.168.88.0/24");
    expect(files["router-lockdown.rsc"]).toContain("address=10.77.0.1/32");
    expect(files["router-rollback.rsc"]).toContain("192.168.88.0/24");
    expect(files["wg0.conf"]).toContain("AllowedIPs = 10.77.0.2/32");
  });

  it("writes secret-bearing output only to a selected directory and never stdout", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "network-bootstrap-"));
    const inputPath = resolve(directory, "input.json");
    const outputPath = resolve(directory, "generated");
    writeFileSync(inputPath, JSON.stringify(fixture), { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../scripts/generate-router-bootstrap.mjs")],
      {
        env: {
          ...process.env,
          NETWORK_BOOTSTRAP_INPUT_FILE: inputPath,
          NETWORK_BOOTSTRAP_OUTPUT_DIR: outputPath,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const routerConfig = readFileSync(resolve(outputPath, "router-bootstrap.rsc"), "utf8");
    expect(routerConfig).toContain(fixture.routerWireGuardPrivateKey);
    if (process.platform !== "win32") {
      expect(statSync(resolve(outputPath, "router-bootstrap.rsc")).mode & 0o777).toBe(0o600);
    }
  });

  it("requires a dry run before apply and removes the secret-bearing router script", () => {
    const runbook = readFileSync(
      resolve(import.meta.dirname, "../docs/DEMO-ROUTER-RUNBOOK.md"),
      "utf8",
    );
    const dryRun = runbook.indexOf(
      "/import file-name=router-bootstrap.rsc verbose=yes dry-run",
    );
    const apply = runbook.indexOf(
      "/import file-name=router-bootstrap.rsc verbose=yes",
      dryRun + 1,
    );

    expect(dryRun).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(dryRun);
    expect(runbook).toContain('/file/remove [find where name="router-bootstrap.rsc"]');
  });

  it("rejects unsafe controls and inconsistent WireGuard peer addressing", () => {
    expect(() => generateBootstrap({
      ...fixture,
      routerPassword: "temporary-random-password\t1234567890",
    })).toThrow(/bootstrap input/i);
    expect(() => generateBootstrap({
      ...fixture,
      vpsPeerAddress: "10.77.0.1/24",
    })).toThrow(/bootstrap network/i);
    expect(() => generateBootstrap({
      ...fixture,
      routerPeerAddress: "10.77.0.3/32",
    })).toThrow(/bootstrap network/i);
    expect(() => generateBootstrap({
      ...fixture,
      recoveryCidr: fixture.managementCidr,
    })).toThrow(/bootstrap network/i);
    expect(() => generateBootstrap({
      ...fixture,
      vpsAddress: "10.77.0.0/24",
      vpsPeerAddress: "10.77.0.0/32",
    })).toThrow(/bootstrap network/i);
  });
});
