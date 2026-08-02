import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  generateBootstrap,
  generateWireGuardKeypair,
  wireGuardPublicKeyFromPrivate,
} from "../scripts/generate-router-bootstrap.mjs";
import {
  bootstrapFixture as fixture,
  dedicatedPortFixture,
  RFC7748_ALICE_PRIVATE,
  RFC7748_ALICE_PUBLIC,
  RFC7748_BOB_PRIVATE,
  RFC7748_BOB_PUBLIC,
} from "./support/routerBootstrapFixture.js";

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
    expect(files["router-bootstrap.rsc"]).toContain('in-interface="bridge"');
    expect(generateBootstrap(dedicatedPortFixture)["router-bootstrap.rsc"])
      .toContain('in-interface="ether5"');
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
    // Quoted, and that is the whole point: measured on the demo hEX, the bare
    // form `address=192.168.88.1/24` matched 0 rows and the quoted form matched
    // 1, so the preflight could only ever take its own error branch. The old
    // version of this assertion pinned the bare form and therefore pinned the
    // defect. `routerOsSyntax.test.ts` is what keeps the next one from landing.
    expect(bootstrap).toContain(
      "/ip/address find where interface=$ncRecoveryName and address=\"192.168.88.1/24\""
      + " and disabled=no and !dynamic",
    );
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
    // The real import is `verbose=no`, and the ORDER still has to hold: dry-run
    // first. `verbose=yes` on the apply step would make every `:if` guard in the
    // file evaluate against empty variables (measured, see §3.0.1), so there is
    // no `verbose=yes` apply left to look for.
    const apply = runbook.indexOf("/import file-name=router-bootstrap.rsc verbose=no", dryRun + 1);

    expect(dryRun).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(dryRun);
    expect(runbook).not.toMatch(/\/import file-name=[a-z-]+\.rsc verbose=yes(?! dry-run)/u);
    expect(runbook).toContain('/file/remove [find where name="router-bootstrap.rsc"]');
    expect(runbook).toContain("NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF");
    expect(runbook).toContain("mở một phiên SSH LAN recovery mới");
  });

  it("shows the operator what a partial run looks like and what to do about it", () => {
    // With `verbose=no` there is no per-line echo, so the runbook has to teach
    // the two channels that remain: the unique `:error` identity and the
    // ordered NC_STEP trace. A table of steps is not decoration here — the
    // rollback removes by ownership marker and `/user/group` carries none, so
    // "run the rollback" is NOT the complete answer past step 04.
    const runbook = readFileSync(
      resolve(import.meta.dirname, "../docs/DEMO-ROUTER-RUNBOOK.md"),
      "utf8",
    );
    const files = generateBootstrap(fixture);

    expect(runbook).toContain("NC_STEP:09:ssh-service-allowlist");
    expect(runbook).toContain("grep -rn \"<slug>\" infra/network-center-worker/templates/");
    expect(runbook).toContain('/user/group remove [find where name="network-center-worker"]');
    // Every step the runbook's table names must be a step the script emits, or
    // the table is telling the operator about a run that cannot happen.
    for (const match of runbook.matchAll(/NC_STEP:\d{2}:[a-z][a-z0-9-]*/gu)) {
      expect({ step: match[0], present: Object.values(files).some((file) => file.includes(match[0])) })
        .toEqual({ step: match[0], present: true });
    }
  });

  it("gates all three artifacts on hardware, and probes what dry-run cannot evaluate", () => {
    // Dry-run is a PARSE check. It reported "No syntax errors" for a selector
    // that matched zero rows, and it had never been run against the lockdown or
    // the rollback at all — the rollback being the one that has to work when
    // everything else has failed.
    const runbook = readFileSync(
      resolve(import.meta.dirname, "../docs/DEMO-ROUTER-RUNBOOK.md"),
      "utf8",
    );
    for (const name of ["router-bootstrap.rsc", "router-lockdown.rsc", "router-rollback.rsc"]) {
      expect(runbook).toContain(`/import file-name=${name} verbose=yes dry-run`);
    }
    expect(runbook).toContain("No syntax errors found in the import file");
    expect(runbook).toContain("npm --prefix infra/network-center-worker test");
    // The live selector probe, and the reason it has to be wrapped in `:put`.
    expect(runbook).toContain(
      ':put [:len [/ip/address find where interface="bridge"'
      + ' and address="192.168.88.1/24" and disabled=no and !dynamic]]',
    );
  });

  it("tells the operator when a /32 recovery range is the wrong choice", () => {
    // The demo workstation's 192.168.88.254 is a DHCP lease, so a /32 ties the
    // only recovery path to an address that can move — and after stage 2 there
    // is no other management channel.
    const runbook = readFileSync(
      resolve(import.meta.dirname, "../docs/DEMO-ROUTER-RUNBOOK.md"),
      "utf8",
    );
    expect(runbook).not.toContain("prefer laptop /32");
    expect(runbook).toContain("192.168.88.240/28");
    expect(runbook).toContain("lease DHCP động");
    // The /28 the runbook recommends has to be one the generator accepts.
    expect(() => generateBootstrap({ ...fixture, recoveryCidr: "192.168.88.240/28" }))
      .not.toThrow();
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

  it("requires the recovery source range to be reachable through the router's own address", () => {
    // Without this the `:lan-recovery` rule is decorative: it can accept a source
    // address the router has no interface route to, on an interface that never
    // sees it.
    const withoutAddress: Partial<typeof fixture> = { ...fixture };
    delete withoutAddress.recoveryInterfaceAddress;
    expect(() => generateBootstrap(withoutAddress as typeof fixture))
      .toThrow(/bootstrap input/i);
    for (const recoveryInterfaceAddress of [
      // operator on 192.168.88.10, router answering on a different subnet
      "192.168.77.1/24",
      // the network address and the broadcast address are not host addresses
      "192.168.88.0/24",
      "192.168.88.255/24",
      // a /32 gateway cannot contain the recovery range
      "192.168.88.1/32",
      // public space is never a LAN recovery path
      "203.0.113.1/24",
      // overlapping the WireGuard management network defeats the independence the
      // recovery path exists to provide
      "10.77.0.9/24",
    ]) {
      expect(() => generateBootstrap({ ...fixture, recoveryInterfaceAddress }))
        .toThrow(/bootstrap network/i);
    }
    expect(() => generateBootstrap({
      ...fixture,
      recoveryInterfaceAddress: "192.168.88.1/24",
      recoveryCidr: "192.168.88.0/28",
    })).not.toThrow();
  });
});

describe("WireGuard key material", () => {
  it("derives public keys the way `wg pubkey` does", () => {
    // Pinned to the published RFC 7748 §6.1 vectors, not to this implementation.
    expect(wireGuardPublicKeyFromPrivate(RFC7748_ALICE_PRIVATE)).toBe(RFC7748_ALICE_PUBLIC);
    expect(wireGuardPublicKeyFromPrivate(RFC7748_BOB_PRIVATE)).toBe(RFC7748_BOB_PUBLIC);
    const minted = generateWireGuardKeypair();
    expect(minted.publicKey).toBe(wireGuardPublicKeyFromPrivate(minted.privateKey));
    expect(minted.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(minted.privateKey).not.toBe(generateWireGuardKeypair().privateKey);
  });

  it("closes the loop between the router's private key and the hub's peer entry", () => {
    // The observed production state was a hub peer reserved with a router public
    // key whose private half existed nowhere, so the tunnel could never come up.
    // These two assertions make that state ungeneratable.
    const files = generateBootstrap(fixture);
    const routerPrivateKey = /private-key="([^"]+)"/u
      .exec(files["router-bootstrap.rsc"])?.[1] ?? "";
    const peerPublicKey = /^PublicKey = (.+)$/mu.exec(files["wg0.conf"])?.[1] ?? "";
    const hubPrivateKey = /^PrivateKey = (.+)$/mu.exec(files["wg0.conf"])?.[1] ?? "";
    const routerPeerPublicKey = /public-key="([^"]+)"/u
      .exec(files["router-bootstrap.rsc"])?.[1] ?? "";

    expect(routerPrivateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(wireGuardPublicKeyFromPrivate(routerPrivateKey)).toBe(peerPublicKey);
    expect(wireGuardPublicKeyFromPrivate(hubPrivateKey)).toBe(routerPeerPublicKey);
  });

  it("refuses a declared public key that is not the half of its private key", () => {
    expect(() => generateBootstrap({
      ...fixture,
      routerWireGuardPublicKey: RFC7748_BOB_PUBLIC,
    })).toThrow(/public key does not match/i);
    expect(() => generateBootstrap({
      ...fixture,
      vpsWireGuardPublicKey: RFC7748_ALICE_PUBLIC,
    })).toThrow(/public key does not match/i);
    expect(() => generateBootstrap({
      ...fixture,
      vpsWireGuardPrivateKey: RFC7748_ALICE_PRIVATE,
      vpsWireGuardPublicKey: RFC7748_ALICE_PUBLIC,
    })).toThrow(/must not share a WireGuard key/i);
  });

  it("mints both keypairs into one owner-only file and never onto a stream", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "network-bootstrap-keys-"));
    const keypairPath = resolve(directory, "wireguard-keys.json");
    const result = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../scripts/generate-router-bootstrap.mjs")],
      {
        env: { ...process.env, NETWORK_BOOTSTRAP_KEYPAIR_FILE: keypairPath },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const keys = JSON.parse(readFileSync(keypairPath, "utf8"));
    expect(wireGuardPublicKeyFromPrivate(keys.routerWireGuardPrivateKey))
      .toBe(keys.routerWireGuardPublicKey);
    expect(wireGuardPublicKeyFromPrivate(keys.vpsWireGuardPrivateKey))
      .toBe(keys.vpsWireGuardPublicKey);
    expect(keys.routerWireGuardPrivateKey).not.toBe(keys.vpsWireGuardPrivateKey);
    if (process.platform !== "win32") {
      expect(statSync(keypairPath).mode & 0o777).toBe(0o600);
    }
    // The generated bundle accepts them, so the operator's only manual step is a
    // copy, and a mistyped copy is caught by the keypair assertion above.
    expect(() => generateBootstrap({ ...fixture, ...keys })).not.toThrow();
    // Never overwrites an existing keypair file.
    const second = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../scripts/generate-router-bootstrap.mjs")],
      {
        env: { ...process.env, NETWORK_BOOTSTRAP_KEYPAIR_FILE: keypairPath },
        encoding: "utf8",
      },
    );
    expect(second.status).toBe(1);
  });
});
