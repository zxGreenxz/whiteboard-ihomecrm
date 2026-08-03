import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// CRLF-normalised. `core.autocrlf=true` in the SYSTEM gitconfig gives the checkout
// CRLF while these assertions are written with LF, so any check that spans a line
// boundary fails on Windows and passes on CI for byte-identical SQL. A sibling gate
// file hit exactly that on an `alter function ...()` / `owner to ...` pair.
const read = (name: string) =>
  readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8")
    .replace(/\r\n/gu, "\n");

const inbox = () => read("20260727020000_openclaw_inbox_schema.sql");
const automation = () => read("20260727025000_openclaw_inbound_automation.sql");

const inboxTables = [
  "openclaw_contacts",
  "openclaw_sales_groups",
  "openclaw_targets",
  "openclaw_conversations",
  "openclaw_conversation_members",
  "openclaw_messages",
  "openclaw_message_media",
  "openclaw_inbound_events",
  "openclaw_inbound_provider_identities",
] as const;

describe("OpenClaw inbox schema migrations", () => {
  it("creates the tenant/account-scoped inbox tables with deny-by-default RLS", () => {
    const sql = inbox();
    for (const table of inboxTables) {
      expect(sql).toMatch(new RegExp(`create table public\\.${table}\\b`, "i"));
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} force row level security`, "i"));
      expect(sql).toMatch(new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role`, "i"));
      expect(sql).toMatch(new RegExp(`unique \\(organization_id, id\\)`, "i"));
    }
    expect(sql).toMatch(/foreign key \(organization_id, account_id\)/i);
    expect(sql).toMatch(/foreign key \(organization_id, account_id, target_id\)/i);
    expect(sql).toMatch(/foreign key \(organization_id, account_id, conversation_id\)/i);
  });

  it("enforces exact peer/sales-group target identity without name matching", () => {
    const sql = inbox();
    expect(sql).toContain("kind IN ('PEER','SALES_GROUP')");
    expect(sql).toContain("(kind = 'PEER' and contact_id is not null and sales_group_id is null)");
    expect(sql).toContain("(kind = 'SALES_GROUP' and sales_group_id is not null and contact_id is null)");
    expect(sql).toContain("unique (organization_id, account_id, kind, provider_id)");
    expect(sql).not.toMatch(/lower\s*\(.*(?:group|target).*name/i);
  });

  it("uses received_at/id keyset order and keeps provider time display-only", () => {
    const sql = inbox();
    expect(sql).toContain("openclaw_messages_thread_cursor_idx");
    expect(sql).toMatch(/\(organization_id, account_id, conversation_id, received_at desc, id desc\)/i);
    expect(sql).toContain("provider_timestamp timestamptz");
    expect(sql).not.toMatch(/openclaw_messages_thread_cursor_idx[^;]*provider_timestamp/is);
    expect(sql).not.toMatch(/\boffset\b/i);
  });

  it("models stable provider IDs, reciprocal pairing and fallback-only fingerprints", () => {
    const sql = inbox();
    expect(sql).toContain("stable_id_kind IN ('PROVIDER_EVENT_ID','PROVIDER_MESSAGE_ID')");
    expect(sql).toContain("unique (organization_id, account_id, event_kind, stable_id_kind, stable_id_value)");
    expect(sql).toContain("openclaw_inbound_identity_cross_kind_guard_uidx");
    expect(sql).toContain("paired_stable_id_kind");
    expect(sql).toContain("paired_stable_id_value");
    expect(sql).toContain("openclaw_inbound_fallback_uidx");
    expect(sql).toMatch(/where provider_event_id is null\s+and provider_message_id is null\s+and fallback_fingerprint is not null/i);
    expect(sql).toContain("quarantine_reason");
    expect(sql).toContain("payload_hash ~ '^[0-9a-f]{64}$'");
  });

  it("stores private R2 media metadata only", () => {
    const sql = inbox();
    expect(sql).toContain("object_key text");
    expect(sql).toContain("object_key like 'v1/org/%'");
    expect(sql).toContain("byte_state IN ('PENDING','CACHED','AVAILABLE','QUARANTINED','DELETED')");
    expect(sql).not.toMatch(/\b(?:data_url|base64|public_url|bucket_name)\b/i);
    expect(sql).toContain("openclaw_message_media_retention_idx");
  });

  it("adds immutable decision and AI-draft storage without early delivery references", () => {
    const sql = automation();
    expect(sql).toMatch(/create table public\.openclaw_inbound_automation_decisions\b/i);
    expect(sql).toMatch(/create table public\.openclaw_ai_drafts\b/i);
    expect(sql).toContain("decision_kind IN ('NO_SEND','HUMAN_DRAFT','WORK_ELIGIBLE','RECOVERY_REQUIRED')");
    expect(sql).toContain("no_send_reason IN ('HISTORY_SYNC','SALES_GROUP_CHATTER','MODE_DISABLED','DUPLICATE','TARGET_INELIGIBLE','POLICY_BLOCKED')");
    expect(sql).toContain("result_schema_version");
    expect(sql).toContain("dlp_decision IN ('PASS','BLOCK','REVIEW')");
    expect(sql).toContain("knowledge_version_ids uuid[]");
    expect(sql).not.toMatch(/openclaw_(?:outbox|send_work|delivery|dead_letter)/i);
  });
});
