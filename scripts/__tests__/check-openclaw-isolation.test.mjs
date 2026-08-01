import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanOpenClawFiles } from "../check-openclaw-isolation.mjs";

const roots = [];

function createMigration(source) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-isolation-"));
  roots.push(root);
  const migrations = join(root, "supabase", "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, "20260727000000_openclaw_test.sql"), source);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("OpenClaw isolation fallback scanner", () => {
  it("allows internal hash-domain names containing openclaw-send", () => {
    const root = createMigration(
      "select 'ihome-openclaw-send-work-completion-v1';\n",
    );
    expect(scanOpenClawFiles(root)).toEqual([]);
  });

  it("still rejects the stock generic OpenClaw send command", () => {
    const root = createMigration("select 'openclaw send';\n");
    expect(scanOpenClawFiles(root)).toEqual([
      expect.objectContaining({ rule: "stock-generic-send", match: "openclaw send" }),
    ]);
  });
});
