import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { generateBootstrap } from "../scripts/generate-router-bootstrap.mjs";

const fixture = {
  routerIdentity: "MikroTik Demo",
  deploymentId: "demo-router-20260730",
  routerUser: "ihome-nc-worker",
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
  recoveryCidr: "192.168.88.10/32",
  recoveryInterface: "ether2",
  wanInterface: "ether1",
  sshStrongCrypto: false,
  managementServices: {
    ssh: { disabled: false, address: "192.168.88.0/24", port: 22 },
    winbox: { disabled: false, address: "192.168.88.0/24", port: 8291 },
    telnet: { disabled: true, address: "", port: 23 },
    ftp: { disabled: true, address: "", port: 21 },
    www: { disabled: true, address: "", port: 80 },
    "www-ssl": { disabled: true, address: "", port: 443 },
    api: { disabled: true, address: "", port: 8728 },
    "api-ssl": { disabled: true, address: "", port: 8729 },
  },
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
    expect(files["router-bootstrap.rsc"]).toContain(
      "NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF",
    );
    expect(files["router-bootstrap.rsc"]).not.toContain("NETWORK_CENTER_STAGE1_READY");
    expect(files["router-bootstrap.rsc"]).toContain("192.168.88.10/32");
    expect(files["router-bootstrap.rsc"]).toContain("10.77.0.1/32");
    expect(files["router-bootstrap.rsc"]).toContain('in-interface="ether2"');
    expect(files["router-bootstrap.rsc"]).toContain("ihome-nc-worker");
    expect(files["router-bootstrap.rsc"]).toContain(
      "ihomecrm-network-center:v1:demo-router-20260730",
    );
    expect(files["router-bootstrap.rsc"]).toContain('public-key-file="worker-ssh-key.pub"');
    expect(files["router-bootstrap.rsc"]).toContain("strong-crypto=yes");
    expect(files["router-lockdown.rsc"]).not.toContain("192.168.88.10/32");
    expect(files["router-lockdown.rsc"]).toContain("address=10.77.0.1/32");
    expect(files["router-lockdown.rsc"]).not.toContain("address=10.77.0.0/24");
    expect(files["router-rollback.rsc"]).toContain('address="192.168.88.0/24"');
    expect(files["wg0.conf"]).toContain("AllowedIPs = 10.77.0.2/32");
  });

  it("guards ownership before mutation and rolls back only the exact marked user", () => {
    const files = generateBootstrap(fixture);
    const bootstrap = files["router-bootstrap.rsc"];
    const ownershipGuard = bootstrap.indexOf("NETWORK_CENTER_OWNERSHIP_CONFLICT");
    const firstMutation = Math.min(
      bootstrap.indexOf("/interface/wireguard add"),
      bootstrap.indexOf("/user add"),
    );
    const groupPolicyGuard = bootstrap.indexOf("/user/group get $ncGroups policy");
    const recoveryGuard = bootstrap.indexOf("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID");
    const firewallGuard = bootstrap.indexOf("NETWORK_CENTER_FIREWALL_CONFLICT");
    expect(ownershipGuard).toBeGreaterThan(-1);
    expect(groupPolicyGuard).toBeGreaterThan(-1);
    expect(groupPolicyGuard).toBeLessThan(firstMutation);
    expect(recoveryGuard).toBeGreaterThan(-1);
    expect(recoveryGuard).toBeLessThan(firstMutation);
    expect(firewallGuard).toBeGreaterThan(-1);
    expect(firewallGuard).toBeLessThan(firstMutation);
    expect(firstMutation).toBeGreaterThan(ownershipGuard);
    expect(bootstrap).toContain(
      ':local ncExpectedPolicy "ssh,ftp,reboot,read,write,test,sensitive"',
    );
    expect(bootstrap).not.toContain(
      '[:len $ncUsers] = 0) do={ :error "NETWORK_CENTER_GROUP_CONFLICT"',
    );
    expect(bootstrap).not.toContain('comment="iHomeCRM Network Center worker"');
    expect(bootstrap).toContain("[/interface get $ncRecovery type]");
    expect(bootstrap).toContain("[/interface get $ncRecovery default-name]");
    expect(bootstrap).toContain("[/interface get $ncRecovery disabled]");
    expect(bootstrap).toContain("/interface/bridge/port find where interface=$ncRecoveryName");
    expect(bootstrap).toContain("/ip/address find where interface=$ncRecoveryName and disabled=no");
    expect(bootstrap).toContain("/ip/firewall/filter get $ncRecoveryRules src-address");
    expect(bootstrap).toContain("/ip/firewall/filter get $ncHandshakeRules in-interface");
    expect(bootstrap).toContain("/ip/firewall/filter get $ncManagementRules src-address");

    const rollback = files["router-rollback.rsc"];
    expect(rollback).toContain("ihomecrm-network-center:v1:demo-router-20260730");
    expect(rollback).toContain("NETWORK_CENTER_USER_NOT_OWNED");
    expect(rollback).not.toMatch(/^\/user remove/m);
  });

  it("restores the captured disabled, address, and port state for every service", () => {
    const rollback = generateBootstrap(fixture)["router-rollback.rsc"];
    for (const [name, state] of Object.entries(fixture.managementServices)) {
      expect(rollback).toContain(`name=\"${name}\"`);
      expect(rollback).toContain(`disabled=${state.disabled ? "yes" : "no"}`);
      expect(rollback).toContain(`port=${state.port}`);
      expect(rollback).toContain(`address=\"${state.address}\"`);
    }
    expect(rollback).toContain("/ip/ssh set strong-crypto=no");
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
    expect(runbook).toContain("NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF");
    expect(runbook).toContain("mở một phiên SSH LAN recovery mới");
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

  it("rejects broad or non-private recovery and arbitrary managed identity", () => {
    for (const recoveryCidr of [
      "203.0.113.9/32",
      "100.64.0.1/32",
      "192.168.88.0/23",
      "127.0.0.1/32",
    ]) {
      expect(() => generateBootstrap({ ...fixture, recoveryCidr }))
        .toThrow(/bootstrap network/i);
    }
    expect(() => generateBootstrap({ ...fixture, recoveryInterface: "" }))
      .toThrow(/bootstrap input|RouterOS name/i);
    expect(() => generateBootstrap({ ...fixture, recoveryInterface: "ether1" }))
      .toThrow(/recovery interface|RouterOS name/i);
    expect(() => generateBootstrap({ ...fixture, recoveryInterface: "wan-backup" }))
      .toThrow(/recovery interface|RouterOS name/i);
    expect(() => generateBootstrap({ ...fixture, recoveryInterface: "uplink-backup" }))
      .toThrow(/recovery interface|RouterOS name/i);
    expect(() => generateBootstrap({ ...fixture, routerUser: "admin" }))
      .toThrow(/managed RouterOS user/i);
  });

  it("accepts an explicit non-WAN ether10 recovery interface", () => {
    expect(() => generateBootstrap({ ...fixture, recoveryInterface: "ether10" }))
      .not.toThrow();
  });
});
