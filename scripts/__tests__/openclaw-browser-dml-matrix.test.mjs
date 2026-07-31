import { describe, expect, it } from "vitest";

const EXPECTED_BROWSER_DML_MATRIX = Object.freeze([
  Object.freeze({ role: "anon", privilege: "INSERT" }),
  Object.freeze({ role: "anon", privilege: "UPDATE" }),
  Object.freeze({ role: "anon", privilege: "DELETE" }),
  Object.freeze({ role: "authenticated", privilege: "INSERT" }),
  Object.freeze({ role: "authenticated", privilege: "UPDATE" }),
  Object.freeze({ role: "authenticated", privilege: "DELETE" }),
]);

describe("OpenClaw browser DML denial matrix", () => {
  it("enumerates every browser role and write privilege combination", async () => {
    const harness = await import("../test-openclaw-migrations.mjs");
    expect(harness.BROWSER_DML_PRIVILEGE_MATRIX).toEqual(
      EXPECTED_BROWSER_DML_MATRIX,
    );
  });

  it("detects each individual privilege leak through the real catalog", async () => {
    const harness = await import("../test-openclaw-migrations.mjs");
    expect(typeof harness.assertNoOpenClawBrowserDml).toBe("function");
    const database = await harness.createDisposableOpenClawDatabase();
    try {
      await database.exec(`
        create table public.openclaw_browser_dml_probe (
          organization_id uuid not null,
          id uuid not null,
          primary key (organization_id,id)
        );
        revoke all on public.openclaw_browser_dml_probe from anon,authenticated;
      `);
      await expect(harness.assertNoOpenClawBrowserDml(database)).resolves.toBeUndefined();

      for (const { role, privilege } of EXPECTED_BROWSER_DML_MATRIX) {
        await database.exec(
          `grant ${privilege} on public.openclaw_browser_dml_probe to ${role}`,
        );
        await expect(
          harness.assertNoOpenClawBrowserDml(database),
          `${role} ${privilege}`,
        ).rejects.toThrow(new RegExp(`${role}.*${privilege}`, "i"));
        await database.exec(
          `revoke ${privilege} on public.openclaw_browser_dml_probe from ${role}`,
        );
      }
    } finally {
      await database.close();
    }
  }, 30_000);
});
