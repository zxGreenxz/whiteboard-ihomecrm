import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const migration = new URL(
  "../../supabase/migrations/20260729135000_network_center_transition_forward_fix.sql",
  import.meta.url,
);

test("v2 transition uses a private completion helper while direct legacy completion stays denied", () => {
  assert.equal(existsSync(migration), true, "additive transition forward-fix migration missing");
  const source = readFileSync(migration, "utf8");
  assert.match(
    source,
    /CREATE OR REPLACE FUNCTION app_private\.network_center_complete_command_internal_v2\(/i,
  );
  assert.match(
    source,
    /current_setting\('app\.network_center_transition_authority',[\s\S]*?p_command_id::text/i,
  );
  assert.match(
    source,
    /RETURN app_private\.network_center_complete_command_internal_v2\(/i,
  );
  assert.match(
    source,
    /REVOKE ALL ON FUNCTION app_private\.network_center_complete_command_internal_v2\([\s\S]*?service_role/i,
  );
  assert.match(
    source,
    /REVOKE ALL ON FUNCTION public\.network_center_worker_complete_v1\([\s\S]*?authenticated/i,
  );
  assert.doesNotMatch(
    source,
    /GRANT EXECUTE ON FUNCTION public\.network_center_worker_complete_v1\([\s\S]*?TO (?:anon|authenticated)/i,
  );
});
