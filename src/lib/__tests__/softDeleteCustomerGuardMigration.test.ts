import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function liveDefinitionOf(name: string): string {
  const dir = join(process.cwd(), "supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().reverse()) {
    const sql = readFileSync(join(dir, file), "utf8");
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public." + name + "(");
    if (start < 0) continue;
    const body = sql.slice(start);
    const tag = body.match(/AS\s+(\$\w*\$)/i)?.[1];
    if (tag) return body.slice(0, body.indexOf(tag, body.indexOf(tag) + tag.length) + tag.length);
  }
  throw new Error("Missing live function " + name);
}
const sql = liveDefinitionOf("soft_delete_customer");

describe("soft_delete_customer: authorization precedes active-contract guard and mutation", () => {
  it("locks the customer and authorizes the customer organization before inspecting links", () => {
    expect(sql).toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/search_path\s*=\s*pg_catalog,public,app_private/i);
    expect(sql).toMatch(/FOR UPDATE/i);
    expect(sql).toContain("auth.uid(),c.organization_id,'customers.delete'");
    expect(sql.indexOf("authorize_tenant_action_v3")).toBeLessThan(sql.indexOf("contract_customers"));
  });
  it("rejects active, undeleted contracts before soft deletion", () => {
    expect(sql).toMatch(/ct.status='ACTIVE' AND ct.deleted_at IS NULL/);
    expect(sql).toContain("CUSTOMER_HAS_ACTIVE_CONTRACT");
    expect(sql.indexOf("CUSTOMER_HAS_ACTIVE_CONTRACT")).toBeLessThan(sql.indexOf("UPDATE public.customers"));
  });
});
