import type { OpenClawControlState, OpenClawMode } from "./types";

/**
 * The eight steps the plan prescribes, and - just as important - which of them the
 * SERVER actually backs.
 *
 * `serverBacked: false` does not mean "skip it". It means the screen must not imply
 * the answer was checked or stored anywhere that enforces it: consent lives in
 * `openclaw_consents` and hours/caps in `openclaw_policy_versions`, and neither is
 * writable from the browser. Those steps collect a declaration, and say so.
 *
 * `createTimeOnly` marks fields the draft freezes: `knowledgeVersionIds`,
 * `allowedCrmFields`, `policyVersionId` and the rendering limits are accepted by
 * `openclaw_create_automation_draft_v1` and ignored by `save_step`, so an edit form
 * offering them later would silently discard the change.
 */
export const AUTOMATION_WIZARD_STEPS = [
  { id: 1, key: "explain", serverBacked: false, createTimeOnly: false },
  { id: 2, key: "recipients", serverBacked: true, createTimeOnly: true },
  { id: 3, key: "consent", serverBacked: false, createTimeOnly: false },
  { id: 4, key: "hours", serverBacked: false, createTimeOnly: false },
  { id: 5, key: "template", serverBacked: true, createTimeOnly: true },
  { id: 6, key: "mode", serverBacked: true, createTimeOnly: false },
  { id: 7, key: "dryRun", serverBacked: true, createTimeOnly: false },
  { id: 8, key: "publish", serverBacked: true, createTimeOnly: false },
] as const;

export type AutomationWizardStepKey = (typeof AUTOMATION_WIZARD_STEPS)[number]["key"];

/** Where the wizard stores its own progress, since no server column holds it. */
export const WIZARD_STEP_CONFIG_KEY = "wizardStep";

/**
 * Reads the current step out of a draft's `configuration`.
 *
 * There is no step column and no version history a browser can read - only the
 * current version, via `openclaw_get_automation_v1`. So the marker rides inside
 * `configuration`, which the draft RPCs do persist. An unreadable or out-of-range
 * marker resets to step 1 rather than trapping the operator on a step that does not
 * exist.
 */
export function wizardStepFromConfiguration(configuration: unknown): number {
  if (configuration === null || typeof configuration !== "object") return 1;
  const raw = (configuration as Record<string, unknown>)[WIZARD_STEP_CONFIG_KEY];
  if (typeof raw !== "number" || !Number.isInteger(raw)) return 1;
  return raw >= 1 && raw <= AUTOMATION_WIZARD_STEPS.length ? raw : 1;
}

export type PublishBlockedBy =
  | "PERMISSION"
  | "FEATURE_DISABLED"
  | "GLOBAL_STOP"
  | "MODE_DISABLED"
  | "NO_DRY_RUN";

export interface PublishGateInput {
  canManageAutomation: boolean;
  control: OpenClawControlState | null;
  mode: OpenClawMode;
  /** Non-null once a dry run has been recorded against THIS version. */
  dryRunHash: string | null;
}

export interface PublishGate {
  canPublish: boolean;
  blockedBy: PublishBlockedBy | null;
}

/**
 * Which control-state flag governs a mode.
 *
 * DRAFT_ONLY and MANUAL_SEND need no automation flag - nothing sends without a
 * human - so they ride on the feature flag alone.
 */
function modeFlag(control: OpenClawControlState, mode: OpenClawMode): boolean {
  switch (mode) {
    case "LIMITED_AUTO_REPLY":
      return control.limitedAutoReplyEnabled;
    case "PROACTIVE":
      return control.proactiveEnabled;
    case "SALES_GROUPS":
      return control.salesGroupsEnabled;
    default:
      return true;
  }
}

/**
 * The publish refusals the browser can PROVE, in the order that makes the reason
 * true rather than merely first.
 *
 * Deliberately absent: a "disclosure acknowledged" gate. That check guards QR login
 * only; publish never looks at it, so a badge claiming otherwise would be a lie.
 *
 * Also absent: any claim that mode-specific fields were validated. The server
 * validates none of them - not the inbound conversation scope, not the proactive
 * recipient set, not the sales-group caps - so the wizard collects them and says so.
 */
export function publishGate(input: PublishGateInput): PublishGate {
  const blockedBy: PublishBlockedBy | null = !input.canManageAutomation
    ? "PERMISSION"
    : input.control === null || input.control.featureEnabled === false
      ? "FEATURE_DISABLED"
      : input.control.globalStop
        ? "GLOBAL_STOP"
        : !modeFlag(input.control, input.mode)
          ? "MODE_DISABLED"
          : input.dryRunHash === null
            ? "NO_DRY_RUN"
            : null;
  return { canPublish: blockedBy === null, blockedBy };
}

export type PublishFailure =
  | "PERMISSION_DENIED"
  | "UNRESOLVED_UNKNOWN"
  | "ROLLOUT_STAGE"
  | "VERSION_CONFLICT"
  | "UNKNOWN";

/**
 * Tells apart the three different 42501s a publish can raise.
 *
 * All three arrive as "permission denied" and only one of them is: the activation
 * trigger uses the same errcode for an unresolved UNKNOWN and for a rollout stage
 * that does not yet permit activation. An operator told "you lack permission" when
 * the real problem is an unresolved UNKNOWN will go and ask for a role they already
 * have.
 */
export function classifyPublishFailure(error: unknown): PublishFailure {
  if (error !== null && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    const message = String((error as { message?: unknown }).message ?? "");
    if (code === "40001") return "VERSION_CONFLICT";
    if (code === "42501") {
      if (/unresolved UNKNOWN/iu.test(message)) return "UNRESOLVED_UNKNOWN";
      if (/rollout stage/iu.test(message)) return "ROLLOUT_STAGE";
      return "PERMISSION_DENIED";
    }
  }
  return "UNKNOWN";
}

/**
 * What a dry run actually establishes.
 *
 * `openclaw_dry_run_automation_v1` renders nothing and evaluates no policy: it
 * confirms a version row with that id exists in DRAFT or PUBLISHED, and returns a
 * hash of the sample inputs. So "dry run passed" must never be shown as "this
 * message is safe to send" - it is closer to "this version is addressable".
 */
export function dryRunClaim(result: { eligible: boolean } | null) {
  if (result === null) return "NOT_RUN" as const;
  return result.eligible ? "VERSION_ADDRESSABLE" : "VERSION_NOT_ELIGIBLE" as const;
}
