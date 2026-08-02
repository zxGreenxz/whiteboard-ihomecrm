import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  generateBootstrap,
  renderRouterOsTemplate,
  routerOsBareValue,
  routerOsQuotedValue,
  routerOsScriptBlock,
  routerOsScriptDiagnostics,
  routerOsTemplatePlaceholders,
} from "../scripts/generate-router-bootstrap.mjs";
import { bootstrapFixture } from "./support/routerBootstrapFixture.js";

/**
 * # Why this file exists
 *
 * The `.rsc` assets were executed by a simulator (`fakeRouterOsImport.ts`) and
 * asserted as text, and both checks passed while the files were NOT VALID
 * RouterOS. The first `/import ... dry-run` ever run on the demo hEX
 * (RouterOS 7.20.8, 2026-08-03) reported:
 *
 * | file                   | verdict                                        |
 * |------------------------|------------------------------------------------|
 * | `router-bootstrap.rsc` | `Script Error: found 22 error(s) in import file`|
 * | `router-lockdown.rsc`  | `found 2 error(s)`                             |
 * | `router-rollback.rsc`  | `No syntax errors found in the import file`     |
 *
 * The simulator could not see any of it: it has no parser. So the rules below
 * are DERIVED FROM THAT OUTPUT, not from a grammar somebody invented:
 *
 *  - `syntax error (line 15 column 27)` on a 26-character line — i.e. the
 *    newline itself — from `router-lockdown.rsc`, whose `:if` condition spans
 *    lines 15-17. A parenthesised condition may not span lines. A `do={ ... }`
 *    BODY may, and does, all over these files;
 *  - `expected command name (line 17 column 6)`, the second and last error of
 *    that same 3-line condition;
 *  - `Script Error: cannot invert string`, exit 1, for `"ether5" !~ "abc"`.
 *    `!~` is not an operator; `!("ether5" ~ "abc")` is the working form and was
 *    measured working;
 *  - `syntax error (line 1 column 77)` for a `$` immediately before a closing
 *    quote; `~ "...\$"` was measured working.
 *
 * The counting model is pinned by two independent totals. RouterOS reports one
 * `syntax error` at the newline that breaks the condition, then one
 * `expected command name` for every continuation line EXCEPT the first:
 *
 *  - lockdown, one condition over lines 15-17 -> 1 + 1 = **2** (measured: 2),
 *    and the second error lands on line 17 column 6 (measured: 17, 6);
 *  - bootstrap, three conditions over lines 88-96, 97-104, 105-111 ->
 *    (1+7) + (1+6) + (1+5) = 21, plus the unescaped `$` on line 61 = **22**
 *    (measured: 22).
 *
 * Two totals and one exact (line, column) pair from a model with no free
 * parameters. What is NOT verified: the message text of errors after the first
 * of a block, and the column RouterOS reports for the `$` case (only its
 * existence and its line are pinned).
 *
 * The frozen templates under `hardware-dry-run-2026-08-03/` are the exact
 * bytes that produced the table above. THEY MUST NEVER BE "FIXED" — they are a
 * measurement, and repairing them would delete the only evidence that this
 * checker reports what RouterOS reported.
 */
const MEASURED = resolve(import.meta.dirname, "support/hardware-dry-run-2026-08-03");

/**
 * Placeholder text in the shape the generator emits. Values cannot move any of
 * the assertions below: every diagnostic column is either the length of a line
 * that carries no placeholder, or the indentation of a continuation line.
 */
const MEASURED_PLACEHOLDERS: Record<string, string> = {
  ROUTER_USER: '"ihome-nc-worker"',
  ROUTER_PASSWORD: '"temporary-random-password-1234567890"',
  ROUTER_WG_PRIVATE_KEY: '"dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo="',
  VPS_WG_PUBLIC_KEY: '"3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08="',
  VPS_ENDPOINT: '"203.0.113.10"',
  WG_PORT: "51820",
  VPS_PEER_ADDRESS: "10.77.0.1/32",
  ROUTER_ADDRESS: "10.77.0.2/24",
  RECOVERY_CIDR: "192.168.88.10/32",
  RECOVERY_GATEWAY_ADDRESS: "192.168.88.1/24",
  RECOVERY_INTERFACE: '"bridge"',
  WAN_INTERFACE: '"ether1"',
  OWNERSHIP_MARKER: '"ihomecrm-network-center:v1:demo-router-20260730"',
  SERVICE_ROLLBACK_COMMANDS:
    '/ip/service set [find where name="ssh" and !dynamic] disabled=no port=22 address="192.168.88.0/24"',
  SSH_STRONG_CRYPTO_ROLLBACK: "no",
};

/** Deliberately NOT the generator's renderer: this text predates its checks. */
function renderMeasured(name: string): string {
  let output = readFileSync(resolve(MEASURED, name), "utf8").replace(/\r/gu, "");
  for (const [key, value] of Object.entries(MEASURED_PLACEHOLDERS)) {
    output = output.replaceAll(`@@${key}@@`, value);
  }
  if (/@@[A-Z0-9_]+@@/u.test(output)) throw new Error("unresolved placeholder in measured corpus");
  return output;
}

function parseErrors(script: string) {
  return routerOsScriptDiagnostics(script).filter((entry) => entry.kind === "parse");
}

describe("RouterOS syntax checker against the 2026-08-03 dry-run measurement", () => {
  it("reproduces the error totals /import reported for the exact bytes it rejected", () => {
    const bootstrap = renderMeasured("router-bootstrap.rsc.tmpl");
    const lockdown = renderMeasured("router-lockdown.rsc.tmpl");
    const rollback = renderMeasured("router-rollback.rsc.tmpl");

    expect(parseErrors(bootstrap)).toHaveLength(22);
    expect(parseErrors(lockdown)).toHaveLength(2);
    expect(parseErrors(rollback)).toHaveLength(0);
  });

  it("puts the two lockdown errors where RouterOS put them", () => {
    const lockdown = renderMeasured("router-lockdown.rsc.tmpl");
    // The anchor for the column: RouterOS pointed at column 27 of a line that
    // is 26 characters long, which is the newline.
    expect(lockdown.split("\n")[14]).toBe(":if ([:len $ncGroups] != 1");

    expect(parseErrors(lockdown).map(({ line, column, message }) => ({ line, column, message })))
      .toEqual([
        { line: 15, column: 27, message: "syntax error" },
        { line: 17, column: 6, message: "expected command name" },
      ]);
  });

  it("attributes the bootstrap errors to the three conditions and the bare $", () => {
    const errors = parseErrors(renderMeasured("router-bootstrap.rsc.tmpl"));
    const conditionErrors = errors.filter((entry) => entry.rule === "condition-spans-lines");
    const dollarErrors = errors.filter((entry) => entry.rule === "unescaped-dollar-in-string");

    expect(conditionErrors).toHaveLength(21);
    expect(conditionErrors.filter((entry) => entry.message === "syntax error")
      .map((entry) => entry.line)).toEqual([88, 97, 105]);
    expect(dollarErrors.map((entry) => entry.line)).toEqual([61]);
    // 21 of 22 errors sat on the FIREWALL_CONFLICT guards, so those guards had
    // never run on any router.
    expect(conditionErrors).toHaveLength(errors.length - 1);
  });

  it("reports the measured runtime defect that dry-run cannot see", () => {
    const bootstrap = renderMeasured("router-bootstrap.rsc.tmpl");
    const inverted = routerOsScriptDiagnostics(bootstrap)
      .filter((entry) => entry.rule === "invert-string-operator");

    // `/import ... dry-run` PARSED this line and reported nothing for it; the
    // failure is `Script Error: cannot invert string` at run time, exit 1.
    expect(inverted.map((entry) => entry.line)).toEqual([61]);
    expect(inverted[0]?.kind).toBe("runtime");
  });
});

describe("RouterOS syntax rules in isolation", () => {
  it("accepts a multi-line do={} body and rejects a multi-line condition", () => {
    const body = ':if ([:len $x] = 1) do={\n  :error "BOOM"\n}\n';
    expect(routerOsScriptDiagnostics(body)).toEqual([]);

    const condition = ':if ([:len $x] = 1\n    || [:len $y] = 2) do={\n  :error "BOOM"\n}\n';
    expect(parseErrors(condition).map((entry) => entry.line)).toEqual([1]);
  });

  it("counts one further error per continuation line beyond the first", () => {
    const three = ':if ([:len $x] = 1\n  || [:len $y] = 2\n  || [:len $z] = 3) do={ :error "BOOM" }\n';
    expect(parseErrors(three).map((entry) => ({ line: entry.line, column: entry.column })))
      .toEqual([{ line: 1, column: 19 }, { line: 3, column: 3 }]);
  });

  it("rejects `!~` and accepts the measured `!(x ~ y)` form", () => {
    const inverted = routerOsScriptDiagnostics(':if ($a !~ "^ether") do={ :error "BOOM" }\n');
    expect(inverted).toHaveLength(1);
    expect(inverted[0]?.rule).toBe("invert-string-operator");
    expect(inverted[0]?.message).toContain("cannot invert string");

    expect(routerOsScriptDiagnostics(':if (!($a ~ "^ether")) do={ :error "BOOM" }\n')).toEqual([]);
    // `!=` and `!dynamic` must not be mistaken for it.
    expect(routerOsScriptDiagnostics(':if ($a != "x") do={ :error "BOOM" }\n')).toEqual([]);
    expect(routerOsScriptDiagnostics('/ip/service set [find where name="ssh" and !dynamic] port=22\n'))
      .toEqual([]);
  });

  it("rejects an unescaped $ before a closing quote and accepts the escaped form", () => {
    const bare = routerOsScriptDiagnostics(':if (!($a ~ "^ether([2-9])$")) do={ :error "BOOM" }\n');
    expect(bare).toHaveLength(1);
    expect(bare[0]?.rule).toBe("unescaped-dollar-in-string");
    expect(bare[0]?.line).toBe(1);

    expect(routerOsScriptDiagnostics(':if (!($a ~ "^ether([2-9])\\$")) do={ :error "BOOM" }\n'))
      .toEqual([]);
    // A `$` that really does open a variable reference inside a string is fine.
    expect(routerOsScriptDiagnostics(':put "value $ncMarker done"\n')).toEqual([]);
    // A `#` line is a comment, so nothing in it is parsed.
    expect(routerOsScriptDiagnostics('# regex "^ether$" explained\n')).toEqual([]);
  });

  it("rejects an unquoted value in a find-where selector", () => {
    // Measured on the hardware against the live config:
    //   find where ... address=192.168.88.1/24   -> 0 rows
    //   find where ... address="192.168.88.1/24" -> 1 row
    // Dry-run cannot see this: it parses, it just selects nothing, so the
    // preflight takes its own error branch and the bootstrap can never start.
    const unquoted = routerOsScriptDiagnostics(
      "/ip/address remove [find where interface=$i and address=192.168.88.1/24]\n",
    );
    expect(unquoted).toHaveLength(1);
    expect(unquoted[0]?.rule).toBe("unquoted-selector-value");
    expect(unquoted[0]?.kind).toBe("selector");
    expect(unquoted[0]?.message).toContain("address");

    for (const selector of [
      '/ip/address remove [find where interface=$i and address="192.168.88.1/24"]',
      "/ip/address remove [find where interface=$i and address=$a]",
      "/ip/address remove [find where interface=$i and disabled=no and !dynamic]",
      "/ip/firewall/filter remove [find where interface=$i and dst-port=22]",
    ]) {
      expect(routerOsScriptDiagnostics(`${selector}\n`)).toEqual([]);
    }
    // Outside a selector, a bare CIDR is an assignment and is correct.
    expect(routerOsScriptDiagnostics("/ip/address add address=192.168.88.1/24 interface=$i\n"))
      .toEqual([]);
  });
});

describe("generated artifacts", () => {
  it("emits three scripts with no diagnostic of any kind", () => {
    const files = generateBootstrap(bootstrapFixture);
    for (const name of ["router-bootstrap.rsc", "router-lockdown.rsc", "router-rollback.rsc"] as const) {
      expect({ name, diagnostics: routerOsScriptDiagnostics(files[name]) })
        .toEqual({ name, diagnostics: [] });
    }
  });

  it("keeps every parenthesised condition on the line it opens on", () => {
    const files = generateBootstrap(bootstrapFixture);
    let conditions = 0;
    for (const name of ["router-bootstrap.rsc", "router-lockdown.rsc", "router-rollback.rsc"] as const) {
      for (const line of files[name].split("\n")) {
        if (!/^\s*:if\b/u.test(line)) continue;
        conditions += 1;
        const opened = [...line].filter((character) => character === "(").length;
        const closed = [...line].filter((character) => character === ")").length;
        expect({ name, line, balanced: opened === closed }).toMatchObject({ balanced: true });
      }
    }
    // The scan has to be seen finding something.
    expect(conditions).toBeGreaterThanOrEqual(20);
  });
});

describe("selector interpolation is structurally quoted", () => {
  const SELECTOR = "/ip/address remove [find where interface=$i and address=@@VALUE@@]\n";

  it("refuses to interpolate a bare value into a selector", () => {
    expect(() => renderRouterOsTemplate(SELECTOR, {
      VALUE: routerOsBareValue("192.168.88.1/24"),
    })).toThrow(/selector.*VALUE|VALUE.*selector/iu);

    expect(renderRouterOsTemplate(SELECTOR, {
      VALUE: routerOsQuotedValue("192.168.88.1/24"),
    })).toContain('address="192.168.88.1/24"');
  });

  it("refuses a quoted value where the template already supplies the quotes", () => {
    const template = ':if ([:tostr [/x get $r a]] != "@@VALUE@@") do={ :error "BOOM" }\n';
    expect(() => renderRouterOsTemplate(template, {
      VALUE: routerOsQuotedValue("192.168.88.10/32"),
    })).toThrow(/quoted/iu);

    expect(renderRouterOsTemplate(template, { VALUE: routerOsBareValue("192.168.88.10/32") }))
      .toContain('!= "192.168.88.10/32"');
  });

  it("escapes what a quoted value can contain", () => {
    const rendered = renderRouterOsTemplate("/x add name=@@VALUE@@\n", {
      VALUE: routerOsQuotedValue('a"b\\c;d$e'),
    });
    expect(rendered).toBe("/x add name=\"a\\\"b\\\\c\\;d\\$e\"\n");
  });

  it("refuses an unresolved placeholder and a script block inside a selector", () => {
    expect(() => renderRouterOsTemplate("/x add name=@@MISSING@@\n", {}))
      .toThrow(/placeholder/iu);
    expect(() => renderRouterOsTemplate(SELECTOR, { VALUE: routerOsScriptBlock("/x remove") }))
      .toThrow(/selector/iu);
  });

  it("classifies every placeholder occurrence in the real templates", () => {
    // Without this the rule above could be enforced over an empty set: the whole
    // defect was ONE placeholder in ONE selector, and an author adding the next
    // one has to be stopped by the classifier, not by review.
    const templates = resolve(import.meta.dirname, "../templates");
    const occurrences = ["router-bootstrap.rsc.tmpl", "router-lockdown.rsc.tmpl",
      "router-rollback.rsc.tmpl"].flatMap((name) => {
      const template = readFileSync(resolve(templates, name), "utf8").replace(/\r/gu, "");
      return routerOsTemplatePlaceholders(template)
        .map((entry) => ({ name, ...entry }));
    });

    expect(occurrences.filter((entry) => entry.context === "selector")
      .map(({ name, placeholder, line }) => ({ name, placeholder, line })))
      .toEqual([
        {
          name: "router-bootstrap.rsc.tmpl",
          placeholder: "RECOVERY_GATEWAY_ADDRESS",
          line: 79,
        },
      ]);
    expect(occurrences.filter((entry) => entry.context === "string").length)
      .toBeGreaterThanOrEqual(3);
    expect(occurrences.filter((entry) => entry.context === "statement").length)
      .toBeGreaterThanOrEqual(10);
  });
});
