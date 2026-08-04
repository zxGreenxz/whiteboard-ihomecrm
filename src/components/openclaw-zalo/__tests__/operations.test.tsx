import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawOverview from "../overview/OpenClawOverview";
import type { AuditChainVerdict } from "@/lib/openclaw-zalo/auditChain";
import type { OpenClawAccountSummary, OpenClawControlState } from "@/lib/openclaw-zalo/types";

const noop = vi.fn();

const account: OpenClawAccountSummary = {
  accountId: "dddd1000-0000-4000-8000-00000000000a",
  displayName: "Zalo bán hàng",
  connectionState: "CONNECTED",
  sessionRiskState: "HEALTHY",
  configuredMode: "MANUAL_SEND",
  effectiveMode: "MANUAL_SEND",
  connectionGeneration: 3,
  sessionGeneration: 4,
  disclosureVersion: 2,
  disclosureAcknowledgedVersion: 2,
  currentCellId: "dddd2000-0000-4000-8000-000000000010",
};

const control: OpenClawControlState = {
  globalStop: false,
  featureEnabled: true,
  limitedAutoReplyEnabled: false,
  proactiveEnabled: false,
  salesGroupsEnabled: false,
  controlVersion: 9,
};

const props = {
  account,
  control,
  counts: {
    conversationCount: 12,
    unreadCount: 3,
    unresolvedUnknownCount: 0,
    resolvedUnknownCount: 5,
    deadLetterCount: 0,
  },
  incidents: [],
  incidentsUnavailable: false,
  loading: false,
  canManageOperations: true,
  canAudit: true,
  auditChain: null as AuditChainVerdict | null,
  onOpenGlobalStop: noop,
};

const render = (overrides: Partial<typeof props> = {}) =>
  renderToStaticMarkup(createElement(OpenClawOverview, { ...props, ...overrides }));

describe("operational overview", () => {
  it("gives every status an icon AND text, never colour alone", () => {
    const html = render();
    for (const name of ["connection", "session-risk", "mode", "global-stop"]) {
      expect(html, name).toContain(`data-openclaw-status="${name}"`);
    }
    // The tone is an attribute for styling; the label carries the meaning.
    expect(html).toContain("Đang kết nối");
    expect(html).toContain("Phiên bình thường");
  });

  it("shows the configured and effective mode separately when they diverge", () => {
    // Acknowledging a risk and beginning a QR login both force DRAFT_ONLY. An
    // operator who set PROACTIVE and is getting DRAFT_ONLY must see both.
    const html = render({
      account: { ...account, configuredMode: "PROACTIVE", effectiveMode: "DRAFT_ONLY" },
    });
    expect(html).toContain("Đặt PROACTIVE, đang chạy DRAFT_ONLY");
    expect(html).toContain('data-openclaw-tone="WARN"');
  });

  it("keeps unresolved and resolved UNKNOWN as separate figures", () => {
    // One combined number would hide the only one that needs action.
    const html = render({
      counts: { ...props.counts, unresolvedUnknownCount: 4, resolvedUnknownCount: 11 },
    });
    expect(html).toContain("4 tin cần đối chiếu");
    expect(html).toContain('data-openclaw-overview="resolved-unknown"');
    expect(html).toContain("11");
  });

  it("says GLOBAL_STOP is on rather than showing a healthy queue", () => {
    const html = render({ control: { ...control, globalStop: true } });
    expect(html).toContain("GLOBAL_STOP đang bật");
    expect(html).toContain('data-openclaw-tone="STOP"');
  });

  it("does not claim a healthy control state it could not read", () => {
    const html = render({ control: null });
    expect(html).toContain("Chưa đọc được trạng thái điều khiển");
    expect(html).toContain('data-openclaw-tone="UNKNOWN"');
  });

  it("lists what it cannot measure instead of rendering zeros", () => {
    // A tile reading "0 ms p95" when nothing measures p95 invites the operator to
    // conclude the system is fast.
    const html = render();
    for (const key of ["queueLagP95", "transferQuota", "lastRestoreDrill"]) {
      expect(html, key).toContain(`data-openclaw-unavailable="${key}"`);
    }
    expect(html).toContain("sẽ khiến bạn");
  });

  it("no longer calls the audit chain unmeasurable, because it is measurable", () => {
    // openclaw_list_audit_events_v1 returns all four inputs to the event hash, so
    // the chain is recomputable here. Leaving it on the "cannot measure" list would
    // hide a check an auditor can actually run.
    expect(render()).not.toContain('data-openclaw-unavailable="auditVerification"');
  });

  it("separates an unread audit chain from a verified one", () => {
    // Null means nobody checked. Rendering that as a tick would be the worst
    // possible lie on this particular tile.
    const unread = render({ auditChain: null });
    expect(unread).toContain('data-openclaw-audit-chain="unavailable"');
    expect(unread).not.toContain('data-openclaw-audit-chain="INTACT"');
    // And a member without `audit` is told why, rather than shown a failure.
    expect(render({ auditChain: null, canAudit: false })).toContain("Cần quyền kiểm toán");
  });

  it("does not report an empty page as an intact chain", () => {
    const html = render({
      auditChain: {
        checkedCount: 0, linkedCount: 0, fromSequence: null, toSequence: null,
        findings: [], intact: true,
      },
    });
    expect(html).toContain('data-openclaw-audit-chain="empty"');
    expect(html).not.toContain('data-openclaw-audit-chain="INTACT"');
  });

  it("states what recomputing the chain does NOT prove", () => {
    // Without this the tick reads as "the audit log is trustworthy", which is more
    // than a browser can establish: it never sees the evidence behind evidenceHash.
    const html = render({
      auditChain: {
        checkedCount: 3, linkedCount: 2, fromSequence: 1, toSequence: 3,
        findings: [], intact: true,
      },
    });
    expect(html).toContain('data-openclaw-audit-chain="INTACT"');
    expect(html).toContain('data-openclaw-audit-chain="limitation"');
    expect(html).toContain("KHÔNG chứng minh");
  });

  it("names where a broken chain broke", () => {
    const html = render({
      auditChain: {
        checkedCount: 3, linkedCount: 2, fromSequence: 1, toSequence: 3,
        findings: [
          { kind: "HASH_MISMATCH", auditEventId: "ev-2", organizationSequence: 2 },
          { kind: "SEQUENCE_GAP", fromSequence: 3, toSequence: 7 },
        ],
        intact: false,
      },
    });
    expect(html).toContain('data-openclaw-audit-chain="BROKEN"');
    expect(html).toContain('data-openclaw-audit-finding="HASH_MISMATCH"');
    expect(html).toContain('data-openclaw-audit-finding="SEQUENCE_GAP"');
    expect(html).toContain("Thiếu sự kiện giữa bản 3 và 7");
  });

  it("renders incident metrics by whatever key arrived", () => {
    // contentFreeMetrics names no keys in its schema, so a fixed set of named gauges
    // would show zeros for metrics the cell never reported.
    const html = render({
      incidents: [{
        healthEventId: "h1",
        severity: "WARN",
        healthKind: "SPOOL_PRESSURE",
        status: "OPEN",
        observedAt: "2026-08-03T10:00:00Z",
        contentFreeMetrics: { spoolBytes: 1024, cpuPercent: 71, note: "x", nested: { a: 1 } },
      }],
    });
    expect(html).toContain('data-openclaw-incident="h1"');
    expect(html).toContain("spoolBytes: 1024");
    expect(html).toContain("cpuPercent: 71");
    // Nested objects are skipped rather than stringified into noise.
    expect(html).not.toContain("nested:");
  });

  it("distinguishes loading from unreadable counts", () => {
    expect(render({ counts: null, loading: true })).toContain("Đang tải số liệu");
    expect(render({ counts: null, loading: false })).toContain("Chưa đọc được số liệu");
  });

  it("offers the emergency stop only to a member who may operate", () => {
    expect(render()).toContain('data-openclaw-action="open-global-stop"');
    expect(render({ canManageOperations: false }))
      .not.toContain('data-openclaw-action="open-global-stop"');
  });
});
