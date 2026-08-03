import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260727060000_openclaw_rpc_surface.sql",
);
const sql = readFileSync(migrationPath, "utf8");

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function functionDefinition(schema: "public" | "app_private", name: string) {
  const match = sql.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${schema}\\.${escapeRegex(name)}\\s*\\([\\s\\S]*?\\)\\s*returns\\s+jsonb([\\s\\S]*?)\\$function\\$;`,
    "i",
  ));
  expect(match, `missing ${schema}.${name}`).not.toBeNull();
  return match![1];
}

describe("OpenClaw Task 21 account-bounded server contracts", () => {
  it("adds compatible account-scoped reads without removing the org-wide v1 surface", () => {
    for (const legacy of [
      "openclaw_list_unknown_v1",
      "openclaw_list_dead_letters_v1",
      "openclaw_list_health_events_v1",
    ]) {
      expect(sql).toMatch(new RegExp(`function public\\.${legacy}\\s*\\(`, "i"));
    }

    const contracts = [
      {
        name: "openclaw_list_unknown_by_account_v1",
        cursorAt: "cursorTerminalAt",
        tableAlias: "outbox",
        accountPredicate: "outbox.account_id = v_account",
        order: "outbox.terminal_at desc, outbox.id desc",
      },
      {
        name: "openclaw_list_dead_letters_by_account_v1",
        cursorAt: "cursorCreatedAt",
        tableAlias: "dead_letter",
        accountPredicate: "dead_letter.account_id = v_account",
        order: "dead_letter.created_at desc, dead_letter.id desc",
      },
      {
        name: "openclaw_list_health_events_by_account_v1",
        cursorAt: "cursorObservedAt",
        tableAlias: "event",
        accountPredicate: "event.account_id = v_account or event.account_id is null",
        order: "event.observed_at desc, event.id desc",
      },
    ] as const;

    for (const contract of contracts) {
      const body = functionDefinition("public", contract.name);
      expect(body).toContain("array['version','organizationId','accountId'");
      expect(body).toContain("array['version','organizationId','accountId']");
      expect(body).toContain(contract.cursorAt);
      expect(body).toContain("cursorId");
      expect(body).toContain(contract.accountPredicate);
      expect(body.indexOf(contract.accountPredicate)).toBeLessThan(body.indexOf("limit v_limit"));
      expect(body).toContain(`order by ${contract.order}`);
      expect(body).toMatch(/\(v_cursor_at is null\) <> \(v_cursor_id is null\)/i);
      expect(body).toMatch(/\([^)]*\.(?:terminal_at|created_at|observed_at), [^)]*\.id\) < \(v_cursor_at, v_cursor_id\)/i);
    }
  });

  it("reloads only the exact immutable UNKNOWN resolution winner", () => {
    const body = functionDefinition("public", "openclaw_get_unknown_resolution_v1");
    expect(body).toContain("array['version','organizationId','accountId','outboxId']");
    expect(body).toContain("openclaw_zalo.manage_operations");
    expect(body).toContain("outbox.organization_id = v_org");
    expect(body).toContain("outbox.account_id = v_account");
    expect(body).toContain("outbox.id = v_outbox");
    expect(body).toContain("outbox.state = 'UNKNOWN'");
    expect(body).toContain("outbox.resolution_version = 1");
    expect(body).not.toMatch(/update\s+public\.openclaw_outbox/i);
    for (const field of [
      "resolutionId", "organizationId", "accountId", "outboxId",
      "resolutionVersion", "outcome", "newOutboxId",
      "authoritativeEvidenceDomain", "authoritativeEvidenceHash",
      "reasonCode", "resolvedBy", "resolvedAt",
    ]) {
      expect(body).toContain(`'${field}'`);
    }
  });

  it("keeps account validation and browser permissions fail-closed", () => {
    const helper = functionDefinition("app_private", "openclaw_browser_account_context_v1");
    expect(helper).toContain("app_private.openclaw_browser_context_v1");
    expect(helper).toContain("account.organization_id = v_org");
    expect(helper).toContain("account.id = v_account");
    expect(helper).toContain("errcode = 'P0002'");

    const permissionByRpc = new Map([
      ["openclaw_list_unknown_by_account_v1", "openclaw_zalo.manage_operations"],
      ["openclaw_list_dead_letters_by_account_v1", "openclaw_zalo.manage_operations"],
      ["openclaw_list_health_events_by_account_v1", "openclaw_zalo.audit"],
      ["openclaw_get_unknown_resolution_v1", "openclaw_zalo.manage_operations"],
    ]);
    for (const [rpc, permission] of permissionByRpc) {
      expect(functionDefinition("public", rpc)).toContain(permission);
      expect(sql).toMatch(new RegExp(
        `alter function public\\.${rpc}\\(jsonb\\) owner to openclaw_function_owner`,
        "i",
      ));
      expect(sql).toMatch(new RegExp(
        `revoke all on function public\\.${rpc}\\(jsonb\\) from public, anon, authenticated, service_role`,
        "i",
      ));
      expect(sql).toMatch(new RegExp(
        `grant execute on function public\\.${rpc}\\(jsonb\\) to authenticated`,
        "i",
      ));
    }
  });
});
