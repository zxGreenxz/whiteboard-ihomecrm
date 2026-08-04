import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  classifyLegalHoldFailure,
  classifyReplayResult,
  LEGAL_HOLD_TARGET_KINDS,
  legalHoldGate,
  legalHoldReleaseGate,
} from "../legalHold";

/** The migrations are the authority on what the server accepts and raises. */
const MAINTENANCE_SQL = readFileSync(
  "supabase/migrations/20260727090000_openclaw_maintenance_jobs.sql",
  "utf8",
);
const RPC_SQL = readFileSync(
  "supabase/migrations/20260727060000_openclaw_rpc_surface.sql",
  "utf8",
);

const base = {
  canAudit: true,
  canManageOperations: true,
  isActiveOwner: true,
  targetId: "dddd8000-0000-4000-8000-000000000001",
  reason: "Tranh chấp hợp đồng",
};

describe("legal hold gate", () => {
  it("requires BOTH permissions and names which one is missing", () => {
    // A hold stops evidence from being deleted: an operational act and an audit act
    // at once. Reporting one generic "no permission" would send the operator to ask
    // for the wrong role.
    expect(legalHoldGate({ ...base, canAudit: false }).blockedBy).toBe("PERMISSION_AUDIT");
    expect(legalHoldGate({ ...base, canManageOperations: false }).blockedBy)
      .toBe("PERMISSION_OPERATIONS");
    expect(legalHoldGate(base).canCreate).toBe(true);
  });

  it("refuses an empty target or reason, including whitespace-only", () => {
    expect(legalHoldGate({ ...base, targetId: "   " }).blockedBy).toBe("NO_TARGET");
    expect(legalHoldGate({ ...base, reason: "\n" }).blockedBy).toBe("NO_REASON");
  });

  it("refuses a target that is not a UUID, and says so before the write", () => {
    // The contract types targetId as a UUID and the client parses the request
    // BEFORE calling the RPC, so a mistyped id dies on a ZodError - which has no
    // SQLSTATE, so the failure classifier called it "unknown, try again later".
    // Retrying a typo fails identically; the operator has to be told what is wrong.
    for (const bad of ["khong-phai-uuid", "12345", "dddd8000-0000-4000-8000", `${"d".repeat(32)}`]) {
      expect(legalHoldGate({ ...base, targetId: bad }).blockedBy, bad).toBe("BAD_TARGET");
    }
    // Surrounding whitespace is forgiven, exactly as the write trims it.
    expect(legalHoldGate({ ...base, targetId: `  ${base.targetId}  ` }).canCreate).toBe(true);
  });

  it("puts the permission checks ahead of the field checks", () => {
    // Otherwise a member without the permission fills the form, gets an enabled
    // button, and meets a server refusal.
    expect(legalHoldGate({
      ...base, canAudit: false, targetId: "", reason: "",
    }).blockedBy).toBe("PERMISSION_AUDIT");
  });

  it("carries exactly the target kinds the server's check constraint allows", () => {
    // Read from the constraint rather than counted by hand: a list that drifts from
    // it either hides a kind an operator needs or offers one every insert rejects.
    const constraint = /openclaw_retention_holds_target_kind_check\s*\n?\s*check \(target_kind in \(([\s\S]*?)\)\)/u
      .exec(MAINTENANCE_SQL);
    expect(constraint, "target-kind constraint not found in the migration").not.toBeNull();
    const allowed = [...constraint![1].matchAll(/'([A-Z_]+)'/gu)].map(match => match[1]);
    expect(allowed.length).toBeGreaterThan(0);
    expect([...LEGAL_HOLD_TARGET_KINDS].sort()).toEqual([...allowed].sort());
    // ORGANIZATION is first because it is the widest and the easiest to pick by
    // accident; a list that buried it alphabetically would make that likelier.
    expect(LEGAL_HOLD_TARGET_KINDS[0]).toBe("ORGANIZATION");
  });

  it("requires an active owner membership, which permissions alone do not give", () => {
    // openclaw_create_legal_hold_v1 checks organization_memberships for
    // status='ACTIVE' and member_type='OWNER' AFTER both permission checks pass, and
    // raises 42501 without one. A gate that stopped at the permissions would hand a
    // fully-permitted member an enabled button and a server refusal.
    expect(RPC_SQL).toContain("active organization owner required");
    expect(legalHoldGate({ ...base, isActiveOwner: false }).blockedBy).toBe("NOT_OWNER");
    expect(legalHoldGate({ ...base, isActiveOwner: false }).canCreate).toBe(false);
  });
});

describe("legal hold release gate", () => {
  const releaseBase = {
    canAudit: true,
    canManageOperations: true,
    isActiveOwner: true,
    releasedAt: null as string | null,
    releaseReason: "Vụ việc đã khép",
  };

  it("carries the same three-way authorisation as creating one", () => {
    expect(legalHoldReleaseGate({ ...releaseBase, canAudit: false }).blockedBy)
      .toBe("PERMISSION_AUDIT");
    expect(legalHoldReleaseGate({ ...releaseBase, canManageOperations: false }).blockedBy)
      .toBe("PERMISSION_OPERATIONS");
    expect(legalHoldReleaseGate({ ...releaseBase, isActiveOwner: false }).blockedBy)
      .toBe("NOT_OWNER");
    expect(legalHoldReleaseGate(releaseBase).canRelease).toBe(true);
  });

  it("does not offer to release a hold that is already released", () => {
    // The server answers a second release with 40001, which reads as a conflict the
    // operator caused rather than as "this was already done".
    expect(legalHoldReleaseGate({ ...releaseBase, releasedAt: "2026-08-03T10:00:00Z" }).blockedBy)
      .toBe("ALREADY_RELEASED");
  });

  it("requires a reason, because the release stores one", () => {
    expect(legalHoldReleaseGate({ ...releaseBase, releaseReason: "  " }).blockedBy)
      .toBe("NO_REASON");
  });
});

describe("legal hold failure classification", () => {
  it("maps each code the server raises to something the operator can act on", () => {
    // 23505 is not a failure to fix: a hold already covers this target, so there is
    // nothing left to create. Calling it a generic error sends someone looking for a
    // problem that does not exist.
    expect(classifyLegalHoldFailure({ code: "23505" })).toBe("ALREADY_HELD");
    expect(classifyLegalHoldFailure({ code: "42501" })).toBe("PERMISSION_DENIED");
    expect(classifyLegalHoldFailure({ code: "40001" })).toBe("VERSION_CONFLICT");
    expect(classifyLegalHoldFailure({ code: "P0002" })).toBe("NOT_FOUND");
    expect(classifyLegalHoldFailure(new Error("boom"))).toBe("UNKNOWN");
    expect(classifyLegalHoldFailure(null)).toBe("UNKNOWN");
  });

  it("covers the codes the two legal-hold RPCs actually raise", () => {
    // Derived from the migration, so a new raise added server-side shows up here as
    // an unmapped code rather than reaching an operator as "thử lại sau".
    const bodies = ["openclaw_create_legal_hold_v1", "openclaw_release_legal_hold_v1"]
      .map(name => new RegExp(
        `create or replace function public\\.${name}[\\s\\S]*?\\n\\$function\\$;`, "u",
      ).exec(RPC_SQL))
      .map(match => {
        expect(match, "legal hold RPC not found").not.toBeNull();
        return match![0];
      });
    const codes = new Set(bodies.flatMap(body =>
      [...body.matchAll(/using errcode='([0-9A-Z]+)'/gu)].map(match => match[1])));
    expect(codes.size).toBeGreaterThan(0);
    for (const code of codes) {
      expect(classifyLegalHoldFailure({ code }), code).not.toBe("UNKNOWN");
    }
  });
});

describe("dead-letter replay outcome", () => {
  it("tells a queued work item apart from a new outbound message", () => {
    // These mean different things: one is "the system will retry", the other is
    // "a new message now exists addressed to a customer".
    expect(classifyReplayResult({ version: 1, sendWorkItemId: "w1", state: "QUEUED" }))
      .toEqual({ kind: "WORK_ITEM", workItemId: "w1" });
    expect(classifyReplayResult({ version: 1, newOutboxId: "o1", state: "QUEUED" }))
      .toEqual({ kind: "NEW_OUTBOX", outboxId: "o1" });
  });

  it("returns null rather than guessing on a shape it does not recognise", () => {
    for (const value of [null, undefined, "queued", {}, { version: 1 }]) {
      expect(classifyReplayResult(value)).toBeNull();
    }
  });
});
