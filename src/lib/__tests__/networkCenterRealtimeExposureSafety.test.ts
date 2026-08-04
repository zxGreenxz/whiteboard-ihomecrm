import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../supabase/migrations/20260729040000_network_center_rls_rpcs_realtime.sql",
);
const operationsMigrationPath = resolve(
  import.meta.dirname,
  "../../../supabase/migrations/20260729030000_network_center_operations.sql",
);
const hardeningMigrationPath = resolve(
  import.meta.dirname,
  "../../../supabase/migrations/20260729133000_network_center_hardening_rpcs.sql",
);
const sql = readFileSync(migrationPath, "utf8");
const hardeningSql = existsSync(hardeningMigrationPath)
  ? readFileSync(hardeningMigrationPath, "utf8")
  : "";
const allSql = `${readFileSync(operationsMigrationPath, "utf8")}\n${sql}\n${hardeningSql}`;

function functionDefinition(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = allSql.match(
    new RegExp(
      `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public|app_private)\\.${escaped}\\b[\\s\\S]*?\\$fn\\$;`,
      "i",
    ),
  );

  expect(match, `Missing SQL function ${name}`).not.toBeNull();
  return match![0];
}

describe("Network Center browser and kill-switch safety", () => {
  it("never exposes command lease credentials through direct SELECT or Realtime", () => {
    expect(sql).not.toMatch(
      /GRANT\s+SELECT\s+ON\s+TABLE\s+public\.network_commands\s+TO\s+authenticated/i,
    );
    expect(sql).not.toMatch(
      /ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE\s+public\.network_commands/i,
    );
    expect(sql).toMatch(
      /ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE\s+public\.network_command_events/i,
    );
  });

  it("replaces fleet-global heartbeat exposure with an RLS-scoped building projection", () => {
    expect(
      existsSync(hardeningMigrationPath),
      `Missing migration: ${hardeningMigrationPath}`,
    ).toBe(true);
    expect(hardeningSql).toMatch(
      /REVOKE ALL ON TABLE public\.network_worker_heartbeats\s+FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(hardeningSql).not.toMatch(
      /GRANT SELECT ON TABLE public\.network_worker_heartbeats TO authenticated/i,
    );
    expect(hardeningSql).toMatch(
      /ALTER PUBLICATION supabase_realtime\s+DROP TABLE public\.network_worker_heartbeats/i,
    );
    expect(hardeningSql).toMatch(
      /ALTER PUBLICATION supabase_realtime\s+ADD TABLE public\.network_worker_building_status/i,
    );
    expect(hardeningSql).toMatch(
      /CREATE POLICY[\s\S]{0,500}ON public\.network_worker_building_status[\s\S]{0,500}can_do_on_building\(\s*'network_center',\s*'view',\s*building_id\s*\)/i,
    );
    expect(hardeningSql).toMatch(
      /GRANT SELECT ON TABLE public\.network_worker_building_status TO authenticated/i,
    );
  });

  it("enforces the per-building changes-paused kill switch before enqueue and claim", () => {
    const executeAction = functionDefinition(
      "network_center_execute_action_v1",
    );
    const enqueueCommand = functionDefinition(
      "network_center_enqueue_command_v1",
    );
    const claimCommands = functionDefinition(
      "network_center_claim_commands_v1",
    );

    expect(executeAction).toMatch(
      /network_site_settings[\s\S]*?changes_paused/i,
    );
    expect(enqueueCommand).toMatch(
      /p_action_type\s*<>\s*'CAPTURE_SNAPSHOT'[\s\S]*?network_site_settings[\s\S]*?changes_paused/i,
    );
    expect(claimCommands).toMatch(
      /network_site_settings[\s\S]*?changes_paused/i,
    );
  });

  it("locks the MikroTik target before accepting an action or snapshot", () => {
    for (const name of [
      "network_center_execute_action_v1",
      "network_center_request_snapshot_v1",
    ]) {
      const definition = functionDefinition(name);
      expect(definition).toMatch(
        /SELECT\s+device\.\*\s+INTO\s+v_device\s+FROM\s+public\.network_devices\s+device[^;]*?FOR\s+UPDATE\s*;/i,
      );
    }
  });
});
