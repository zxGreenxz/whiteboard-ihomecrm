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

function importFailure(device: FakeRouterOsDevice, script: string): RouterOsImportError {
  try {
    importRouterOsScript(device, script);
  } catch (error) {
    if (error instanceof RouterOsImportError) return error;
    throw error;
  }
  throw new Error("expected the import to fail");
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
    const overrides: RouterOsRow[] = [
      { chain: "forward" },
      { action: "drop" },
      { protocol: "udp" },
      { "dst-port": "2200" },
      { "src-address": "192.168.88.0/24" },
      { "in-interface": "ether5" },
      { disabled: "true" },
    ];
    for (const override of overrides) {
      const device = stockHexDevice({ extraFirewallRows: [{ ...correct, ...override }] });

      const failure = importFailure(
        device,
        generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
      );

      expect({ override, message: failure.message })
        .toEqual({ override, message: "NETWORK_CENTER_FIREWALL_CONFLICT" });
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
    for (const row of [{ ...handshake, "dst-port": "51821" }, { ...management, action: "drop" }]) {
      const device = stockHexDevice({ extraFirewallRows: [row] });
      expect(importFailure(
        device,
        generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
      ).message).toBe("NETWORK_CENTER_FIREWALL_CONFLICT");
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

    expect(failure.message).toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID");
    expect(device.mutations).toHaveLength(0);
  });

  it("refuses a recovery address that only exists as a DHCP lease", () => {
    const device = stockHexDevice({ bridgeAddressDynamic: true });

    const failure = importFailure(
      device,
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    );

    expect(failure.message).toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID");
    expect(device.mutations).toHaveLength(0);
  });

  it("refuses a disabled recovery interface and an ether port still in the bridge", () => {
    expect(importFailure(
      stockHexDevice({ disabledInterface: "bridge" }),
      generateBootstrap(bootstrapFixture)["router-bootstrap.rsc"],
    ).message).toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID");

    // ether5 keeps its bridge membership, so it has no L3 edge of its own.
    expect(importFailure(
      stockHexDevice({}),
      generateBootstrap(dedicatedPortFixture)["router-bootstrap.rsc"],
    ).message).toBe("NETWORK_CENTER_RECOVERY_INTERFACE_INVALID");
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
});
