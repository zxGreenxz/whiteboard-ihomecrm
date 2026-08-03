import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawAutomation from "../automation/OpenClawAutomation";
import OpenClawSchedulesAndGroups from "../schedules/OpenClawSchedulesAndGroups";
import type { SalesGroupView } from "@/lib/openclaw-zalo/schedules";
import type { OpenClawControlState, OpenClawMode } from "@/lib/openclaw-zalo/types";

const noop = vi.fn();

const control: OpenClawControlState = {
  globalStop: false,
  featureEnabled: true,
  limitedAutoReplyEnabled: true,
  proactiveEnabled: true,
  salesGroupsEnabled: true,
  controlVersion: 3,
};

const automationProps = {
  automationName: "Trả lời khách mới",
  mode: "LIMITED_AUTO_REPLY" as OpenClawMode,
  currentStep: 7,
  control,
  canManageAutomation: true,
  dryRunHash: "a".repeat(64),
  dryRunResult: { eligible: true },
  busy: false,
  onGoToStep: noop,
  onRunDryRun: noop,
  onPublish: noop,
};

const renderAutomation = (overrides: Partial<typeof automationProps> = {}) =>
  renderToStaticMarkup(createElement(OpenClawAutomation, { ...automationProps, ...overrides }));

describe("automation wizard", () => {
  it("shows all eight steps", () => {
    const html = renderAutomation();
    for (const key of ["explain", "recipients", "consent", "hours", "template", "mode", "dryRun", "publish"]) {
      expect(html, key).toContain(`data-openclaw-step="${key}"`);
    }
  });

  it("marks the steps the server does not enforce", () => {
    // Consent and hours/caps have no server home writable from a browser. Presenting
    // them as checked would be the dishonest version of this screen.
    const html = renderAutomation();
    expect(html).toContain('data-openclaw-step-unbacked="consent"');
    expect(html).toContain('data-openclaw-step-unbacked="hours"');
    expect(html).not.toContain('data-openclaw-step-unbacked="mode"');
  });

  it("warns that create-time fields cannot be changed later", () => {
    // save_step ignores knowledgeVersionIds/allowedCrmFields/policyVersionId, so an
    // edit that looks accepted would be silently discarded.
    const html = renderAutomation();
    expect(html).toContain('data-openclaw-step-frozen="recipients"');
    expect(html).toContain('data-openclaw-step-frozen="template"');
  });

  it("describes the dry run as what it establishes, not as a safety check", () => {
    // The RPC renders nothing and evaluates no policy.
    const html = renderAutomation();
    expect(html).toContain('data-openclaw-dry-run="VERSION_ADDRESSABLE"');
    expect(html).toContain("KHÔNG phải kiểm tra nội dung");
  });

  it("blocks publish without a dry run for this version", () => {
    const html = renderAutomation({ dryRunHash: null, dryRunResult: null });
    expect(html).toContain('data-openclaw-publish-blocked="NO_DRY_RUN"');
    expect(html).not.toContain('data-openclaw-action="automation-publish"');
  });

  it("names the control flag that governs the chosen mode", () => {
    const html = renderAutomation({
      mode: "PROACTIVE", control: { ...control, proactiveEnabled: false },
    });
    expect(html).toContain('data-openclaw-publish-blocked="MODE_DISABLED"');
  });

  it("never claims the disclosure was acknowledged, because publish does not check it", () => {
    const html = renderAutomation();
    expect(html).not.toContain("công bố");
    expect(html).toContain("không kiểm các trường theo từng chế độ");
  });
});

const group: SalesGroupView = {
  targetId: "t1",
  displayName: "Nhóm khách VIP",
  memberCount: 12,
  directoryVersion: 4,
  directoryRefreshedAt: "2026-08-03T06:00:00.000Z",
  directoryExpiresAt: "2026-08-04T06:00:00.000Z",
  isAllowed: true,
  allowlistVersion: 2,
};

const scheduleProps = {
  groups: [group],
  schedules: [{
    scheduleId: "sc1",
    status: "PAUSED" as const,
    timezone: "Asia/Bangkok",
    localRecurrenceRule: "FREQ=DAILY",
    nextRunAt: "2026-08-04T02:00:00.000Z",
    missedOccurrencePolicy: "SKIPPED_MISSED",
  }],
  loading: false,
  canManage: true,
  now: "2026-08-03T12:00:00.000Z",
  busy: false,
  onToggleAllowlist: noop,
  onRequestDirectorySync: noop,
  onScheduleAction: noop,
};

const renderSchedules = (overrides: Partial<typeof scheduleProps> = {}) =>
  renderToStaticMarkup(createElement(OpenClawSchedulesAndGroups, { ...scheduleProps, ...overrides }));

describe("schedules and groups", () => {
  it("offers no Activate or Resume anywhere", () => {
    // No function in the migration set performs that transition.
    const html = renderSchedules({
      schedules: [{ ...scheduleProps.schedules[0], status: "PAUSED" }],
    });
    expect(html).not.toContain("schedule-activate");
    expect(html).not.toContain("schedule-resume");
    expect(html).toContain('data-openclaw-action="schedule-cancel"');
  });

  it("shows the server's next occurrence rather than computing one", () => {
    // DST gap and fold resolution live in columns the browser cannot read, so a local
    // computation would disagree exactly on the days it matters.
    expect(renderSchedules()).toContain("2026-08-04T02:00:00.000Z");
  });

  it("labels directory freshness as advisory", () => {
    const html = renderSchedules();
    expect(html).toContain('data-openclaw-freshness="FRESH"');
    expect(html).toContain("chỉ mang tính tham khảo");
  });

  it("presents the directory sync as fire-and-forget", () => {
    // No status read path and no realtime for it, so a determinate progress bar
    // would be invented.
    expect(renderSchedules()).toContain("không có đường theo dõi tiến độ");
  });

  it("says the provider group id is not available", () => {
    expect(renderSchedules()).toContain("không trả về mã nhóm phía Zalo");
  });

  it("lists the three CRM event types with their canonical sources", () => {
    const html = renderSchedules();
    for (const event of ["lead_created_or_assigned", "room_became_available", "sales_task_due"]) {
      expect(html, event).toContain(`data-openclaw-crm-event="${event}"`);
    }
    expect(html).toContain("public.leads");
  });
});
