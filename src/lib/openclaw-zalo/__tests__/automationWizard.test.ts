import { describe, expect, it } from "vitest";

import {
  AUTOMATION_WIZARD_STEPS,
  classifyPublishFailure,
  dryRunClaim,
  publishGate,
  wizardStepFromConfiguration,
  WIZARD_STEP_CONFIG_KEY,
} from "../automationWizard";
import type { OpenClawControlState } from "../types";

const control: OpenClawControlState = {
  globalStop: false,
  featureEnabled: true,
  limitedAutoReplyEnabled: true,
  proactiveEnabled: true,
  salesGroupsEnabled: true,
  controlVersion: 3,
};

const base = {
  canManageAutomation: true,
  control,
  mode: "LIMITED_AUTO_REPLY" as const,
  dryRunHash: "a".repeat(64),
};

describe("wizard steps", () => {
  it("keeps the plan's eight steps, and records which ones the server backs", () => {
    expect(AUTOMATION_WIZARD_STEPS).toHaveLength(8);
    const unbacked = AUTOMATION_WIZARD_STEPS.filter(step => !step.serverBacked)
      .map(step => step.key);
    // Consent and hours/caps have no server home writable from a browser: consent
    // lives in openclaw_consents, hours and caps in openclaw_policy_versions. The
    // first step is explanatory. Anything else claiming to be unbacked would mean
    // the table drifted from the SQL.
    expect(unbacked).toEqual(["explain", "consent", "hours"]);
  });

  it("marks the fields a draft freezes at create time", () => {
    // knowledgeVersionIds, allowedCrmFields, policyVersionId and the rendering limits
    // are accepted by create and IGNORED by save_step, so an edit form offering them
    // later would silently discard the operator's change.
    expect(AUTOMATION_WIZARD_STEPS.filter(step => step.createTimeOnly).map(step => step.key))
      .toEqual(["recipients", "template"]);
  });
});

describe("wizard progress marker", () => {
  it("reads the step the wizard wrote into the configuration", () => {
    // No server column holds wizard progress and only the current version is
    // readable, so the marker rides inside `configuration`.
    expect(wizardStepFromConfiguration({ [WIZARD_STEP_CONFIG_KEY]: 5 })).toBe(5);
  });

  it("falls back to step 1 rather than trapping the operator on a step that is not there", () => {
    for (const configuration of [
      null, undefined, "nope", {}, { [WIZARD_STEP_CONFIG_KEY]: 0 },
      { [WIZARD_STEP_CONFIG_KEY]: 99 }, { [WIZARD_STEP_CONFIG_KEY]: 2.5 },
      { [WIZARD_STEP_CONFIG_KEY]: "5" },
    ]) {
      expect(wizardStepFromConfiguration(configuration), JSON.stringify(configuration)).toBe(1);
    }
  });
});

describe("publish gate", () => {
  it("requires a dry run against this version", () => {
    expect(publishGate({ ...base, dryRunHash: null }).blockedBy).toBe("NO_DRY_RUN");
    expect(publishGate(base).canPublish).toBe(true);
  });

  it("maps each mode to the control flag that actually governs it", () => {
    expect(publishGate({
      ...base, mode: "PROACTIVE", control: { ...control, proactiveEnabled: false },
    }).blockedBy).toBe("MODE_DISABLED");
    expect(publishGate({
      ...base, mode: "SALES_GROUPS", control: { ...control, salesGroupsEnabled: false },
    }).blockedBy).toBe("MODE_DISABLED");
    // DRAFT_ONLY and MANUAL_SEND send nothing without a human, so no automation flag
    // governs them.
    for (const mode of ["DRAFT_ONLY", "MANUAL_SEND"] as const) {
      expect(publishGate({
        ...base,
        mode,
        control: { ...control, limitedAutoReplyEnabled: false, proactiveEnabled: false },
      }).blockedBy, mode).toBeNull();
    }
  });

  it("puts the feature flag and GLOBAL_STOP ahead of the mode flag", () => {
    // With everything off, naming the mode flag would send the operator to turn on a
    // switch that still would not help.
    expect(publishGate({
      ...base,
      control: { ...control, featureEnabled: false, limitedAutoReplyEnabled: false },
    }).blockedBy).toBe("FEATURE_DISABLED");
    expect(publishGate({
      ...base,
      control: { ...control, globalStop: true, limitedAutoReplyEnabled: false },
    }).blockedBy).toBe("GLOBAL_STOP");
  });

  it("has no disclosure gate, because publish never checks one", () => {
    // The disclosure acknowledgement guards QR login only. A badge on publish would
    // be a lie, and a GATE would block a publish the server would have accepted.
    const gate = publishGate(base);
    expect(Object.keys(gate).sort()).toEqual(["blockedBy", "canPublish"]);
    expect(gate.canPublish).toBe(true);
  });
});

describe("publish failure classification", () => {
  it("tells apart the three different 42501s", () => {
    // The activation trigger reuses the permission errcode. An operator told "you
    // lack permission" will go and ask for a role they already have.
    expect(classifyPublishFailure({
      code: "42501", message: "unresolved UNKNOWN blocks releasing or enabling OpenClaw",
    })).toBe("UNRESOLVED_UNKNOWN");
    expect(classifyPublishFailure({
      code: "42501", message: "canonical rollout stage does not permit activation",
    })).toBe("ROLLOUT_STAGE");
    expect(classifyPublishFailure({
      code: "42501", message: "Bạn không có quyền xuất bản tự động hóa OpenClaw Zalo",
    })).toBe("PERMISSION_DENIED");
  });

  it("keeps a version conflict separate, since the fix is to reload", () => {
    expect(classifyPublishFailure({ code: "40001" })).toBe("VERSION_CONFLICT");
    expect(classifyPublishFailure({ code: "XX000" })).toBe("UNKNOWN");
  });
});

describe("dry run claim", () => {
  it("never claims more than the server established", () => {
    // The RPC renders nothing and evaluates no policy - it confirms the version row
    // exists and hashes the sample inputs. "Safe to send" is not in evidence.
    expect(dryRunClaim(null)).toBe("NOT_RUN");
    expect(dryRunClaim({ eligible: true })).toBe("VERSION_ADDRESSABLE");
    expect(dryRunClaim({ eligible: false })).toBe("VERSION_NOT_ELIGIBLE");
  });
});
