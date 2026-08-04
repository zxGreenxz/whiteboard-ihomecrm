import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { generateBootstrap } from "../scripts/generate-router-bootstrap.mjs";
import {
  routerOsOwnershipMarker,
  routerOsRecoveryInterfaceNames,
} from "../src/routeros/sshConnector.js";
import {
  FakeRouterOsDevice,
  importRouterOsScript,
  RouterOsImportError,
  type RouterOsRow,
  routerOsStatements,
  RouterOsSyntaxError,
} from "./support/fakeRouterOsImport.js";
import {
  bootstrapFixture,
  dedicatedPortFixture,
  HARDENED_WORKER_POLICIES,
  LEGACY_WORKER_POLICIES,
  MANAGEMENT_SERVICE_STATE,
  OWNERSHIP_MARKER,
  stockHexDevice,
} from "./support/routerBootstrapFixture.js";

/**
 * Menus where RouterOS can list a DYNAMIC row beside a managed one. A dynamic row
 * is not modifiable, so a selector that matches one makes the whole `set`/`remove`
 * fail — and `/import` stops at that statement without undoing anything.
 *
 * `/interface`, `/user`, `/user/group`, `/user/ssh-keys`, `/interface/wireguard`
 * and `/interface/wireguard/peers` are deliberately NOT in this set:
 *  - `/interface` names are unique, and nothing in these scripts mutates an
 *    interface, so a dynamic row can neither duplicate a selector key nor be fed
 *    to a mutating verb. Requiring `!dynamic` there would also reject a legitimate
 *    dynamic WAN (a PPPoE/LTE uplink), i.e. it would block buildings for nothing;
 *  - `/user*` has no dynamic rows at all;
 *  - `/interface/wireguard*` rows here are created by this script, on an interface
 *    this script owns, and every selector is scoped by our ownership comment, so a
 *    dynamic sibling cannot exist by construction. Whether the `dynamic` property
 *    is even queryable on `/interface/wireguard/peers` in 7.20.8 is unverified on
 *    hardware, and an unverified selector term in a file that half-bricks a gateway
 *    is a worse trade than a documented non-exposure.
 */
const DYNAMIC_CAPABLE_MENUS = ["/ip/service", "/ip/address", "/ip/firewall/filter"];

const FIND_SELECTOR = /\[\s*(\/[a-z0-9/-]+?)?\s*find where ([^\]]+)\]/gu;

function selectors(script: string): Array<{ menu: string; selector: string; line: number }> {
  const found: Array<{ menu: string; selector: string; line: number }> = [];
  for (const statement of routerOsStatements(script)) {
    const statementMenu = /^(\/[a-z0-9/-]+?)\s+(?:add|set|remove|import)\b/u
      .exec(statement.text)?.[1] ?? "";
    for (const match of statement.text.matchAll(FIND_SELECTOR)) {
      found.push({
        menu: match[1] ?? statementMenu,
        selector: match[2] ?? "",
        line: statement.line,
      });
    }
  }
  return found;
}

function importFailure(
  device: FakeRouterOsDevice,
  script: string,
  options: { verbose?: boolean } = {},
): RouterOsImportError {
  try {
    importRouterOsScript(device, script, options);
  } catch (error) {
    if (error instanceof RouterOsImportError) return error;
    throw error;
  }
  throw new Error("expected the import to fail");
}

const RUNBOOK = resolve(import.meta.dirname, "../docs/DEMO-ROUTER-RUNBOOK.md");

/**
 * The `verbose=` flag the runbook prescribes for the REAL import of a file, i.e.
 * the one occurrence that is not a `dry-run`. Throws rather than defaulting: a
 * runbook that stopped naming the flag would otherwise silently pass.
 */
function runbookImportFlag(file: string): boolean {
  const pattern = new RegExp(
    `/import file-name=${file.replace(/\./gu, "\\.")} verbose=(yes|no)( dry-run)?`,
    "gu",
  );
  const applies = [...readFileSync(RUNBOOK, "utf8").matchAll(pattern)]
    .filter((match) => !match[2])
    .map((match) => match[1]);
  if (applies.length !== 1) {
    throw new Error(`runbook names ${applies.length} real imports of ${file}, expected exactly 1`);
  }
  return applies[0] === "yes";
}

function serviceRow(device: FakeRouterOsDevice, name: string, dynamic: boolean) {
  const row = device.rows("/ip/service")
    .find((candidate) => candidate.name === name && (candidate.dynamic === "true") === dynamic);
  if (!row) throw new Error(`no ${dynamic ? "dynamic" : "static"} ${name} service row`);
  return row;
}

describe("generated RouterOS scripts against the measured hardware topology", () => {
  it("bootstraps a stock defconf hEX end to end while an SSH session is live", () => {
    const device = stockHexDevice();
    const files = generateBootstrap(bootstrapFixture);

    const result = importRouterOsScript(device, files["router-bootstrap.rsc"]);

    expect(result.output).toContain("NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF");
    // The static service is retargeted; the dynamic connection entry is untouched.
    expect(serviceRow(device, "ssh", false)).toMatchObject({
      disabled: "no",
      port: "22",
      address: "192.168.88.10/32,10.77.0.1/32",
    });
    expect(serviceRow(device, "ssh", true).address).toBe("");
    expect(device.rows("/interface/wireguard")).toHaveLength(1);
    expect(device.rows("/interface/wireguard/peers")).toHaveLength(1);
    expect(device.rows("/user").filter((row) => row.comment === OWNERSHIP_MARKER))
      .toHaveLength(1);
    expect(
      device.rows("/ip/firewall/filter")
        .filter((row) => (row.comment ?? "").startsWith(OWNERSHIP_MARKER)),
    ).toHaveLength(3);
  });

  it("runs the rollback to completion instead of aborting on its first mutating line", () => {
    const device = stockHexDevice();
    const files = generateBootstrap(bootstrapFixture);
    importRouterOsScript(device, files["router-bootstrap.rsc"]);
    const mutationsAfterBootstrap = device.mutations.length;

    const result = importRouterOsScript(device, files["router-rollback.rsc"]);

    expect(result.output).toContain("NETWORK_CENTER_ROLLBACK_APPLIED");
    expect(device.mutations.length).toBeGreaterThan(mutationsAfterBootstrap);
    for (const [name, state] of Object.entries(MANAGEMENT_SERVICE_STATE)) {
      expect(serviceRow(device, name, false)).toMatchObject({
        disabled: state.disabled ? "yes" : "no",
        port: String(state.port),
        address: state.address,
      });
    }
    expect(device.rows("/interface/wireguard")).toHaveLength(0);
    expect(device.rows("/interface/wireguard/peers")).toHaveLength(0);
    expect(device.rows("/user").some((row) => row.comment === OWNERSHIP_MARKER)).toBe(false);
    expect(
      device.rows("/ip/firewall/filter")
        .some((row) => (row.comment ?? "").startsWith(OWNERSHIP_MARKER)),
    ).toBe(false);
  });

  it("proves the harness catches a selector that matches a dynamic sibling", () => {
    // The control for the two tests above: the SAME device, the SAME statement,
    // with and without the exclusion. Without it the command is refused and
    // nothing is written, which is exactly the measured `count=2 -> ERROR`.
    const device = stockHexDevice();
    const failure = importFailure(
      device,
      "/ip/service set [find where name=\"ssh\"] port=2200",
    );

    expect(failure.message).toContain("matched 2");
    expect(serviceRow(device, "ssh", false).port).toBe("22");
    expect(device.mutations).toHaveLength(0);

    importRouterOsScript(device, "/ip/service set [find where name=\"ssh\" and !dynamic] port=2200");
    expect(serviceRow(device, "ssh", false).port).toBe("2200");
    expect(serviceRow(device, "ssh", true).port).toBe("22");
  });

  it("excludes dynamic rows in every selector on a dynamic-capable menu", () => {
    const files = generateBootstrap(bootstrapFixture);
    const offenders: string[] = [];
    for (const name of ["router-bootstrap.rsc", "router-lockdown.rsc", "router-rollback.rsc"] as const) {
      for (const entry of selectors(files[name])) {
        if (!DYNAMIC_CAPABLE_MENUS.includes(entry.menu)) continue;
        if (!/(^|\s)!dynamic(\s|$)/u.test(entry.selector)) {
          offenders.push(`${name}:${entry.line} ${entry.menu} find where ${entry.selector}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // The scan must be seen to find something, or an empty result proves nothing.
    const scanned = ["router-bootstrap.rsc", "router-lockdown.rsc", "router-rollback.rsc"]
      .flatMap((name) => selectors(files[name as keyof typeof files]))
      .filter((entry) => DYNAMIC_CAPABLE_MENUS.includes(entry.menu));
    expect(scanned.length).toBeGreaterThanOrEqual(20);
  });

  it("refuses a script RouterOS itself would refuse, before executing anything", () => {
    // The simulator used to have no parser, which is exactly how 22 syntax
    // errors reached the hardware. A file that cannot be imported must not be
    // able to pass through here either.
    const device = stockHexDevice();
    expect(() => importRouterOsScript(
      device,
      ':if ([:len $x] = 1\n    || [:len $y] = 2) do={ :put "no" }\n',
    )).toThrow(RouterOsSyntaxError);
    expect(device.mutations).toHaveLength(0);
  });

  it("runs the firewall ownership guards that the syntax defect had switched off", () => {
    // These three blocks carried 21 of the 22 errors `/import` reported, so on
    // real hardware they never ran at all: a conflicting rule would have been
    // accepted. Each property now has its own reachable `:if`, and each one is
    // driven here from a rule that differs in exactly that property.
    const correct: RouterOsRow = {
      chain: "input",
      action: "accept",
      protocol: "tcp",
      "dst-port": "22",
      "src-address": "192.168.88.10/32",
      "in-interface": "bridge",
      disabled: "false",
      dynamic: "false",
      comment: `${OWNERSHIP_MARKER}:lan-recovery`,
    };
    // Each override names the identity it must produce. Before the identities
    // existed all seven raised the same string, so this loop could not tell the
    // guard that fired from any other one — it only proved that *something*
    // rejected the rule.
    const overrides: Array<[RouterOsRow, string]> = [
      [{ chain: "forward" }, "NETWORK_CENTER_FIREWALL_CONFLICT/recovery-rule-chain"],
      [{ action: "drop" }, "NETWORK_CENTER_FIREWALL_CONFLICT/recovery-rule-action"],
      [{ protocol: "udp" }, "NETWORK_CENTER_FIREWALL_CONFLICT/recovery-rule-protocol"],
      [{ "dst-port": "2200" }, "NETWORK_CENTER_FIREWALL_CONFLICT/recovery-rule-dst-port"],
      [
        { "src-address": "192.168.88.0/24" },
        "NETWORK_CENTER_FIREWALL_CONFLICT/recovery-rule-src-address",
      ],
      [{ "in-interface": "ether5" }, "NETWORK_CENTER_FIREWALL_CONFLICT/recovery-rule-in-interface"],
      [{ disabled: "true" }, "NETWORK_CENTER_FIREWALL_CONFLICT/recovery-rule-disabled"],
    ];
    for (const [override, identity] of overrides) {
      const device = stockHexDevice({ extraFirewallRows: [{ ...correct, ...override }] });

      const failure = importFailure(
        device,
        generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
      );

      expect({ override, message: failure.message }).toEqual({ override, message: identity });
      expect(device.mutations).toHaveLength(0);
    }

    // The control: an identical rule is our own, so the bootstrap is a re-run
    // and adds no second copy of it.
    const device = stockHexDevice({ extraFirewallRows: [correct] });
    importRouterOsScript(device, generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"]);
    expect(
      device.rows("/ip/firewall/filter")
        .filter((row) => row.comment === `${OWNERSHIP_MARKER}:lan-recovery`),
    ).toHaveLength(1);
  });

  it("guards the handshake and management rules the same way", () => {
    const handshake: RouterOsRow = {
      chain: "input",
      action: "accept",
      protocol: "udp",
      "dst-port": "51820",
      "in-interface": "ether1",
      disabled: "false",
      dynamic: "false",
      comment: `${OWNERSHIP_MARKER}:wg-handshake`,
    };
    const management: RouterOsRow = {
      chain: "input",
      action: "accept",
      "in-interface": "wg-ihome-mgmt",
      "src-address": "10.77.0.1/32",
      disabled: "false",
      dynamic: "false",
      comment: `${OWNERSHIP_MARKER}:wg-management`,
    };
    const cases: Array<[RouterOsRow, string]> = [
      [
        { ...handshake, "dst-port": "51821" },
        "NETWORK_CENTER_FIREWALL_CONFLICT/handshake-rule-dst-port",
      ],
      [{ ...management, action: "drop" }, "NETWORK_CENTER_FIREWALL_CONFLICT/management-rule-action"],
    ];
    for (const [row, identity] of cases) {
      const device = stockHexDevice({ extraFirewallRows: [row] });
      expect(importFailure(
        device,
        generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
      ).message).toBe(identity);
      expect(device.mutations).toHaveLength(0);
    }

    const device = stockHexDevice({ extraFirewallRows: [handshake, management] });
    expect(() => importRouterOsScript(
      device,
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    )).not.toThrow();
  });

  it("keeps preflight and mutation on the same rows for every management service", () => {
    // A rollback whose selector differed from the state it captured would restore
    // a row it never inspected. Both sides are the same text by construction.
    const files = generateBootstrap(bootstrapFixture);
    for (const name of Object.keys(MANAGEMENT_SERVICE_STATE)) {
      expect(files["router-rollback.rsc"])
        .toContain(`/ip/service set [find where name="${name}" and !dynamic]`);
    }
    expect(files["router-lockdown.rsc"])
      .toContain('/ip/service set [find where name="ssh" and !dynamic]');
    expect(files["router-bootstrap.rsc"])
      .toContain('/ip/service set [find where name="ssh" and !dynamic]');
  });
});

/**
 * `/import … verbose=yes` makes a `:local` read as EMPTY inside an `:if`
 * CONDITION on RouterOS 7.20.8. Measured on the demo hEX 2026-08-03; the model
 * lives on `RouterOsImportOptions.verbose` together with the raw measurement.
 *
 * This is modelled because EVERY guard in these files, including the ones that
 * stand between the preflight and a mutation, is `:if ([:len $ncX] …)`. Under
 * that flag they all evaluate against empty variables, and the file stops being
 * a guarded bootstrap.
 */
describe("verbose=yes empties :local inside :if conditions", () => {
  const MINIMAL_REPRO = [
    ':local a [/interface find where name="bridge"]',
    ':local b [/interface find where name="ether1"]',
    ':put ("LEN_A=" . [:len $a] . " LEN_B=" . [:len $b])',
    ':if ([:len $a] != 1 || [:len $b] != 1) do={ :put "FIRED_UNEXPECTEDLY" }',
    ':if ([:len $a] != 1) do={ :put "FIRED_SINGLELINE" }',
    ':put "END"',
    "",
  ].join("\n");

  it("reproduces the measured minimal repro under both flags", () => {
    // verbose=no: `LEN_A=1 LEN_B=1` … `END`, neither :if fires.
    expect(importRouterOsScript(stockHexDevice(), MINIMAL_REPRO).output)
      .toEqual(["LEN_A=1 LEN_B=1", "END"]);

    // verbose=yes: the SAME `:put` still prints 1 and 1 — which is what rules
    // out a scoping explanation — yet BOTH conditions fire, the single-line one
    // included, which is what rules out the multi-line parse defect.
    expect(importRouterOsScript(stockHexDevice(), MINIMAL_REPRO, { verbose: true }).output)
      .toEqual(["LEN_A=1 LEN_B=1", "FIRED_UNEXPECTEDLY", "FIRED_SINGLELINE", "END"]);
  });

  it("stops the real bootstrap where the hardware stopped it, before any mutation", () => {
    const device = stockHexDevice();
    const bootstrap = generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"];

    const failure = importFailure(device, bootstrap, { verbose: true });

    // The hardware reported exactly this check (`#line 43..45`) for a condition
    // that is FALSE on that router — `R_LEN=1 W_LEN=1 R_VAL=*7 W_VAL=*2`.
    expect(failure.message)
      .toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID/recovery-or-wan-not-unique");
    // Fail-closed is the only reason the demo gateway survived the attempt.
    expect(device.mutations).toEqual([]);
    // …and it is the guard the hardware named, not merely one of the same
    // class: the reported statement is the `ncRecovery`/`ncWan` length test,
    // which is FALSE on a stock hEX.
    expect(bootstrap.split("\n")[failure.line - 1])
      .toBe(":if ([:len $ncRecovery] != 1 || [:len $ncWan] != 1) do={");

    // The control: the same bytes, the same device, the other flag.
    const healthy = stockHexDevice();
    expect(importRouterOsScript(healthy, bootstrap).output)
      .toContain("NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF");
    expect(healthy.mutations.length).toBeGreaterThan(0);
  });

  it("would let a mutation guard through if the preflight ever stopped catching it", () => {
    // Why the flag is dangerous rather than merely wrong, stated as a test: the
    // add/set guards have the same shape as the preflight guards, so under
    // verbose=yes an EXISTING interface is re-added instead of updated. Run
    // against a device that already carries this deployment's WireGuard.
    const owned = {
      name: "wg-ihome-mgmt",
      comment: `${OWNERSHIP_MARKER}:wireguard`,
      "listen-port": "51820",
      disabled: "false",
      dynamic: "false",
    };
    const script = ':local ncWgs [/interface/wireguard find where name="wg-ihome-mgmt"]\n'
      + ':if ([:len $ncWgs] = 0) do={\n'
      + '  /interface/wireguard add name="wg-ihome-mgmt" listen-port=51820\n'
      + '} else={\n'
      + '  /interface/wireguard set $ncWgs listen-port=51820 disabled=no\n'
      + '}\n';

    const device = stockHexDevice();
    device.rows("/interface/wireguard").push({ ".id": device.mintId(), ...owned });
    importRouterOsScript(device, script, { verbose: true });

    expect(device.rows("/interface/wireguard")).toHaveLength(2);
    expect(device.mutations).toEqual(["add /interface/wireguard"]);

    const correct = stockHexDevice();
    correct.rows("/interface/wireguard").push({ ".id": correct.mintId(), ...owned });
    importRouterOsScript(correct, script);
    expect(correct.rows("/interface/wireguard")).toHaveLength(1);
    expect(correct.mutations).toEqual(["set /interface/wireguard x1"]);
  });

  it("runs every artifact under exactly the flag its runbook step prescribes", () => {
    // This is what stops the runbook drifting back: the flag is READ from the
    // runbook and used to drive the simulator, so restoring `verbose=yes` to a
    // real-import step turns this green test red instead of turning a gateway
    // into a half-bootstrapped one.
    const files = generateBootstrap(bootstrapFixture);
    const device = stockHexDevice();

    expect(runbookImportFlag("router-bootstrap.rsc")).toBe(false);
    expect(importRouterOsScript(device, files["router-bootstrap.rsc"], {
      verbose: runbookImportFlag("router-bootstrap.rsc"),
    }).output).toContain("NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF");

    expect(importRouterOsScript(device, files["router-lockdown.rsc"], {
      verbose: runbookImportFlag("router-lockdown.rsc"),
    }).output).toContain("NETWORK_CENTER_LOCKDOWN_APPLIED");

    expect(importRouterOsScript(device, files["router-rollback.rsc"], {
      verbose: runbookImportFlag("router-rollback.rsc"),
    }).output).toContain("NETWORK_CENTER_ROLLBACK_APPLIED");
  });

  it("keeps dry-run on verbose=yes, where it is parse-only and safe", () => {
    // All three artifacts parsed clean under `verbose=yes dry-run` on the
    // hardware, and dry-run never evaluates a condition, so the quirk cannot
    // reach it. Losing that flag would lose the per-line echo that made the 22
    // syntax errors readable in the first place.
    const runbook = readFileSync(RUNBOOK, "utf8");
    for (const name of ["router-bootstrap.rsc", "router-lockdown.rsc", "router-rollback.rsc"]) {
      expect(runbook).toContain(`/import file-name=${name} verbose=yes dry-run`);
    }
  });
});

describe("a partial run says how far it got", () => {
  /**
   * Breaks step 09 the way the hardware breaks it: a `/ip/service` selector that
   * also matches the DYNAMIC `ssh` row RouterOS lists beside the static one is
   * refused outright. That is a real, measured mid-mutation failure, not an
   * invented one — it is the defect the `and !dynamic` exclusion exists for.
   */
  function bootstrapFailingAtStep09(): string {
    return generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"]
      .replace('/ip/service set [find where name="ssh" and !dynamic]',
        '/ip/service set [find where name="ssh"]');
  }

  it("leaves an ordered trace whose last breadcrumb is the mutation that failed", () => {
    const device = stockHexDevice();

    const failure = importFailure(device, bootstrapFailingAtStep09());

    expect(failure.message).toContain("matched 2");
    expect(failure.output).toEqual([
      "NC_STEP:01:wireguard-interface",
      "NC_STEP:02:management-address",
      "NC_STEP:03:wireguard-peer",
      "NC_STEP:04:worker-group",
      "NC_STEP:05:worker-user",
      "NC_STEP:06:worker-ssh-key-clear",
      "NC_STEP:07:worker-ssh-key-import",
      "NC_STEP:08:ssh-strong-crypto",
      "NC_STEP:09:ssh-service-allowlist",
    ]);
    // Eight mutations completed and the ninth did not: the trace's claim is
    // checked against what the device actually holds, so a breadcrumb printed
    // before a block cannot overstate progress by more than that one block.
    expect(device.mutations).toEqual([
      "add /interface/wireguard",
      "add /ip/address",
      "add /interface/wireguard/peers",
      "add /user/group",
      "add /user",
      "remove /user/ssh-keys x0",
      "import /user/ssh-keys",
      "set /ip/ssh",
    ]);
    expect(device.rows("/ip/firewall/filter")
      .filter((row) => (row.comment ?? "").startsWith(OWNERSHIP_MARKER))).toHaveLength(0);
  });

  it("says the run finished, with the same trace, when nothing failed", () => {
    const result = importRouterOsScript(
      stockHexDevice(),
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    );

    expect(result.output).toHaveLength(13);
    expect(result.output.at(-1)).toBe("NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF");
    expect(result.output.slice(0, 12).map((line) => line.split(":")[1]))
      .toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
  });

  it("traces the rollback too, including the half generated with its commands", () => {
    const device = stockHexDevice();
    const files = generateBootstrap(bootstrapFixture);
    importRouterOsScript(device, files["router-bootstrap.rsc"]);

    const result = importRouterOsScript(device, files["router-rollback.rsc"]);

    expect(result.output.slice(0, 3)).toEqual([
      "NC_STEP:01:rollback-service-ssh",
      "NC_STEP:02:rollback-service-winbox",
      "NC_STEP:03:rollback-service-telnet",
    ]);
    expect(result.output.at(-2)).toBe("NC_STEP:16:rollback-worker-user");
    expect(result.output.at(-1)).toBe("NETWORK_CENTER_ROLLBACK_APPLIED");
  });
});

describe("recovery-interface contract", () => {
  it("accepts the LAN bridge, which is the interface that actually carries the LAN IP", () => {
    const device = stockHexDevice();
    const files = generateBootstrap(bootstrapFixture);

    expect(() => importRouterOsScript(device, files["router-bootstrap.rsc"])).not.toThrow();

    const rule = device.rows("/ip/firewall/filter")
      .find((row) => row.comment === `${OWNERSHIP_MARKER}:lan-recovery`);
    expect(rule).toMatchObject({
      chain: "input",
      action: "accept",
      protocol: "tcp",
      "dst-port": "22",
      "src-address": "192.168.88.10/32",
      "in-interface": "bridge",
    });
  });

  it("still accepts a dedicated out-of-band port that carries its own address", () => {
    const device = stockHexDevice({
      dedicatedRecoveryPort: { name: "ether5", address: "192.168.99.1/24" },
    });

    expect(() => importRouterOsScript(
      device,
      generateBootstrap(dedicatedPortFixture)["router-bootstrap.rsc"],
    )).not.toThrow();
  });

  it("refuses an interface that does not carry the declared recovery address", () => {
    const files = generateBootstrap({
      ...bootstrapFixture,
      recoveryInterfaceAddress: "192.168.88.2/24",
      recoveryCidr: "192.168.88.10/32",
    });
    const device = stockHexDevice();

    const failure = importFailure(device, files["router-bootstrap.rsc"]);

    expect(failure.message)
      .toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID/recovery-address-not-static");
    expect(device.mutations).toHaveLength(0);
  });

  it("refuses a recovery address that only exists as a DHCP lease", () => {
    const device = stockHexDevice({ bridgeAddressDynamic: true });

    const failure = importFailure(
      device,
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    );

    // Same class as the test above, DIFFERENT identity — which is the point of
    // giving each check one: `…/recovery-address-not-static` covers both "no
    // such address" and "the address is a lease", and the two are told apart by
    // the state, not the string. The two below are told apart by the string.
    expect(failure.message)
      .toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID/recovery-address-not-static");
    expect(device.mutations).toHaveLength(0);
  });

  it("refuses a disabled recovery interface and an ether port still in the bridge", () => {
    expect(importFailure(
      stockHexDevice({ disabledInterface: "bridge" }),
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    ).message).toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID/recovery-interface-disabled");

    // ether5 keeps its bridge membership, so it has no L3 edge of its own.
    expect(importFailure(
      stockHexDevice({}),
      generateBootstrap(dedicatedPortFixture)["router-bootstrap.rsc"],
    ).message).toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID/recovery-is-bridge-port");
  });

  it("leaves the marker meaning something the worker can act on", () => {
    // The dead-man switch refuses to cycle a port without this marker, and marks
    // the named interface protected. Feeding the resulting firewall table through
    // the worker's own parser is what makes the rule load-bearing instead of
    // decorative.
    const device = stockHexDevice();
    importRouterOsScript(device, generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"]);
    const records = device.rows("/ip/firewall/filter");

    expect(routerOsOwnershipMarker(records)).toBe(OWNERSHIP_MARKER);
    expect([...routerOsRecoveryInterfaceNames(records)]).toEqual(["bridge"]);
  });

  it("removes the recovery rule only in the explicit lockdown stage", () => {
    const device = stockHexDevice();
    const files = generateBootstrap(bootstrapFixture);
    importRouterOsScript(device, files["router-bootstrap.rsc"]);

    importRouterOsScript(device, files["router-lockdown.rsc"]);

    expect(
      device.rows("/ip/firewall/filter")
        .some((row) => row.comment === `${OWNERSHIP_MARKER}:lan-recovery`),
    ).toBe(false);
    expect(serviceRow(device, "ssh", false).address).toBe("10.77.0.1/32");
    expect(serviceRow(device, "winbox", false).disabled).toBe("yes");
  });

  // -------------------------------------------------------------------------
  // The already-provisioned router
  //
  // Every test above starts from a VIRGIN router, so `[:len $ncGroups] = 1` was
  // false and the entire group-policy preflight branch never executed. On the
  // real demo router that branch is the one that runs, and it was measured
  // read-only on 2026-08-03 to reject the router outright:
  //
  //   CHK23_group_unique=PASS
  //   CHK24_user_group=PASS
  //   WOULD_ERROR=lockdown-group-policy-mismatch   <-- fires
  //
  // i.e. stage 2 was unimportable on every building that had completed stage 1.
  // -------------------------------------------------------------------------
  it("re-imports stage 1 onto a router it has already hardened", () => {
    const device = stockHexDevice({ provisionedWorkerGroup: HARDENED_WORKER_POLICIES });

    const result = importRouterOsScript(
      device,
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    );

    expect(result.output).toContain("NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF");
    // Idempotent: the existing group is accepted, not duplicated.
    expect(device.rows("/user/group").filter((row) => row.name === "network-center-worker"))
      .toHaveLength(1);
    expect(device.mutations).not.toContain("add /user/group");
  });

  it("applies lockdown to a router hardened at stage 1", () => {
    const device = stockHexDevice({ provisionedWorkerGroup: HARDENED_WORKER_POLICIES });

    const result = importRouterOsScript(
      device,
      generateBootstrap(bootstrapFixture)["router-lockdown.rsc"],
    );

    expect(result.output).toContain("NETWORK_CENTER_LOCKDOWN_APPLIED");
    expect(serviceRow(device, "ssh", false).address).toBe("10.77.0.1/32");
  });

  it("refuses both stages while the managed group still grants `sensitive`", () => {
    // Exactly the demo router's live state: `sensitive` granted, so the worker's
    // credential can read the overlay tunnel's private key with one command.
    const files = generateBootstrap(bootstrapFixture);

    const bootstrap = importFailure(
      stockHexDevice({ provisionedWorkerGroup: LEGACY_WORKER_POLICIES }),
      files["router-bootstrap.rsc"],
    );
    const lockdown = importFailure(
      stockHexDevice({ provisionedWorkerGroup: LEGACY_WORKER_POLICIES }),
      files["router-lockdown.rsc"],
    );

    expect(bootstrap.message).toBe("NETWORK_CENTER_GROUP_CONFLICT/group-policy-grants-sensitive");
    expect(lockdown.message)
      .toBe("NETWORK_CENTER_GROUP_CONFLICT/lockdown-group-policy-grants-sensitive");
    // Refused in the PREFLIGHT: nothing was written before the check fired.
    expect(bootstrap.output).toEqual([]);
    expect(lockdown.output).toEqual([]);
  });

  it("names the exact policy that is missing from an under-provisioned group", () => {
    // `verbose=no` means the identity is the whole diagnosis, so a group short of
    // one policy must not report the same thing as a group short of another.
    for (const missing of HARDENED_WORKER_POLICIES) {
      const failure = importFailure(
        stockHexDevice({
          provisionedWorkerGroup: HARDENED_WORKER_POLICIES.filter((name) => name !== missing),
        }),
        generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
      );

      expect(failure.message)
        .toBe(`NETWORK_CENTER_GROUP_CONFLICT/group-policy-missing-${missing}`);
    }
  });

  it("rejects a group that has been widened to `policy`, which could re-grant sensitive", () => {
    const failure = importFailure(
      stockHexDevice({ provisionedWorkerGroup: [...HARDENED_WORKER_POLICIES, "policy"] }),
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    );

    expect(failure.message).toBe("NETWORK_CENTER_GROUP_CONFLICT/group-policy-grants-policy");
  });

  it("names ftp and test as over-grants, on a group that is otherwise clean", () => {
    // `ftp` and `test` left the minimum on 2026-08-03 with the binary backup
    // they served: measured on the demo hEX, `:execute` runs under `ssh,read`
    // and `/export terse hide-sensitive` reads off stdout, so neither policy
    // gates a command the worker still sends.
    //
    // Deliberately WITHOUT `sensitive`. A fixture that carried it would be
    // refused for `sensitive` first and would pass no matter what the denied
    // list said about `ftp`/`test` — which is precisely how an earlier version
    // of this suite failed to notice the two had been dropped from it.
    for (const surplus of ["ftp", "test"]) {
      const failure = importFailure(
        stockHexDevice({ provisionedWorkerGroup: [...HARDENED_WORKER_POLICIES, surplus] }),
        generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
      );

      expect(failure.message)
        .toBe(`NETWORK_CENTER_GROUP_CONFLICT/group-policy-grants-${surplus}`);
      // Refused in the PREFLIGHT: nothing was written before the check fired.
      expect(failure.output).toEqual([]);
    }
  });

  it("accepts exactly the re-derived minimum and nothing wider", () => {
    expect(HARDENED_WORKER_POLICIES).toEqual(["ssh", "reboot", "read", "write"]);
    const device = stockHexDevice({ provisionedWorkerGroup: HARDENED_WORKER_POLICIES });

    const result = importRouterOsScript(
      device,
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    );

    expect(result.output).toContain("NETWORK_CENTER_STAGE1_PENDING_RECOVERY_PROOF");
  });
});
