# Integrated MikroTik Center UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen, high-contrast MikroTik Center route to iHomeCRM with real building integration, exactly two employee permissions, complete fleet/building UI, and safe interactive demo operations.

**Architecture:** The root React app lazily loads a route outside `MainLayout` while retaining the existing provider/auth stack. `useBuildings()` supplies tenant-scoped sites; a typed service and deterministic demo generator supply network state until VPS worker endpoints exist. Permission catalog data gates route visibility and every execute control.

**Tech Stack:** React 18, TypeScript, Vite, React Router, TanStack Query, Supabase, shadcn/Radix, Tailwind plus scoped CSS, Recharts, Vitest, Playwright.

---

### Task 1: Register The Two Permissions

**Files:**
- Modify: `src/lib/permissions.ts`
- Modify: `src/lib/permissionPages.ts`
- Modify: `src/lib/__tests__/permissionPages.test.ts`
- Create: `src/lib/__tests__/networkCenterPermissions.test.ts`

- [ ] Write failing tests asserting that `network_center` has exactly `view` and
  `execute`, both keys exist in the page catalog, `setPageViewOnly` disables
  execute, and the normal manage preset does not grant execute.
- [ ] Run
  `npx vitest run src/lib/__tests__/networkCenterPermissions.test.ts src/lib/__tests__/permissionPages.test.ts`
  and confirm the new assertions fail because the module/action do not exist.
- [ ] Add `execute` to `ActionKey` and `ACTION_LABELS`, add the module under the
  operations permission group, and add its two page features (`view` tier view,
  `execute` tier elevated).
- [ ] Keep the global manage preset from granting `network_center.execute`.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Define Network Types, Deterministic Data, And Filtering

**Files:**
- Create: `src/lib/network-center/contracts.ts`
- Create: `src/lib/network-center/demoRepository.ts`
- Create: `src/lib/network-center/model.ts`
- Create: `src/lib/__tests__/networkCenterModel.test.ts`

- [ ] Write failing tests for stable per-building generation, 1 MikroTik per
  site, 4-10 display-only Aruba nodes, summary counts, health/severity/search
  filters, incident acknowledgement, config capture, and job-stage transitions.
- [ ] Run `npx vitest run src/lib/__tests__/networkCenterModel.test.ts` and verify
  failures are caused by missing exports.
- [ ] Define focused types for fleet/site state, interfaces, clients, Aruba,
  incidents/SLA, revisions/diffs, jobs/audit, settings, typed actions, and the
  `NetworkCenterService` contract.
- [ ] Implement a seeded hash-based generator from iHomeCRM building IDs and pure
  reducers/selectors for filters and demo mutations.
- [ ] Re-run the model test and refactor only while it stays green.

### Task 3: Build The Data Hook And Independent Route Shell

**Files:**
- Create: `src/hooks/network-center/useNetworkCenter.ts`
- Create: `src/pages/network-center/NetworkCenterApp.tsx`
- Create: `src/pages/network-center/networkCenter.css`
- Create: `src/components/network-center/NetworkCenterShell.tsx`
- Create: `src/components/network-center/NetworkCenterHeader.tsx`
- Create: `src/components/network-center/NetworkCenterStates.tsx`
- Modify: `src/App.tsx`
- Modify: `src/copilot/CopilotLauncher.tsx`

- [ ] Add a route smoke test or Playwright skeleton that expects protected
  `/network-center` and `/network-center/buildings/:buildingId` surfaces; run it
  first and record the missing-route failure.
- [ ] Implement one lazy `/network-center/*` route component outside `MainLayout`,
  wrapped by `ProtectedRoute` and `RequirePermission network_center.view`; let the
  Network Center app own its overview, building detail, and local-not-found routes.
- [ ] Compose real `useBuildings()` data with the demo service, expose URL-backed
  site selection, and handle loading, query error, empty fleet, and bad IDs.
- [ ] Implement the scoped true-white, near-black, 2px-border, no-shadow tokens
  without changing global iHomeCRM theme variables.
- [ ] Add the independent header with status, building selector, demo-mode label,
  execute/view-only state, and `Ve iHomeCRM` action.
- [ ] Hide the floating Copilot launcher on `/network-center` so no CRM chrome or
  shadowed overlay leaks into the independent workspace.

### Task 4: Build The Fleet Overview

**Files:**
- Create: `src/components/network-center/FleetOverview.tsx`
- Create: `src/components/network-center/NetworkMetricStrip.tsx`
- Create: `src/components/network-center/FleetFilters.tsx`
- Create: `src/components/network-center/FleetTable.tsx`
- Create: `src/components/network-center/IncidentRail.tsx`

- [ ] Write a failing Playwright expectation for KPI labels, filters, building
  selection, result count, and incident navigation.
- [ ] Implement the six-KPI strip, table-first desktop fleet, complete mobile
  site cards, search/filter controls, filter reset, and explicit no-results state.
- [ ] Implement the incident rail and ensure row/card/incident selection opens
  `/network-center/buildings/:buildingId`.
- [ ] Verify keyboard focus, 44px mobile controls, semantic table markup, and no
  page-level horizontal overflow.

### Task 5: Build All Ten Building Tabs

**Files:**
- Create: `src/components/network-center/BuildingWorkspace.tsx`
- Create: `src/components/network-center/BuildingTabs.tsx`
- Create: `src/components/network-center/tabs/OverviewTab.tsx`
- Create: `src/components/network-center/tabs/InterfacesTab.tsx`
- Create: `src/components/network-center/tabs/ClientsTab.tsx`
- Create: `src/components/network-center/tabs/TopologyTab.tsx`
- Create: `src/components/network-center/tabs/IncidentsTab.tsx`
- Create: `src/components/network-center/tabs/ConfigurationTab.tsx`
- Create: `src/components/network-center/tabs/BackupsTab.tsx`
- Create: `src/components/network-center/tabs/ChangesTab.tsx`
- Create: `src/components/network-center/tabs/AuditTab.tsx`
- Create: `src/components/network-center/tabs/SettingsTab.tsx`

- [ ] Write failing Playwright assertions that each tab is reachable and exposes
  its required landmark content.
- [ ] Implement URL-query-backed tab state and preserve it when switching sites.
- [ ] Build tables/charts/lists with realistic complete data, topology with Aruba
  explicitly display-only, incident/SLA timeline, config metadata, redacted diff,
  jobs, audit/security checks, and settings.
- [ ] Use direct component imports, derive state during render, and keep heavy
  chart sections isolated to avoid unnecessary rerenders.

### Task 6: Implement Execute Permission And Working Operations

**Files:**
- Create: `src/components/network-center/ExecuteGuard.tsx`
- Create: `src/components/network-center/NetworkActionDialog.tsx`
- Create: `src/components/network-center/MaintenanceDialog.tsx`
- Create: `src/components/network-center/ConfigDiffDialog.tsx`
- Modify: `src/hooks/network-center/useNetworkCenter.ts`
- Modify: building tab files from Task 5
- Modify: `src/lib/__tests__/networkCenterModel.test.ts`

- [ ] Add failing tests for view-only rejection, incident acknowledgement,
  maintenance validation, distinct diff revisions, action reason requirement,
  router-identity confirmation for reboot, and direct queueing with no approval.
- [ ] Implement `canUse(perms, 'network_center', 'execute')` as the sole UI execute
  capability and remove all approval terminology.
- [ ] Implement typed action forms and structured previews. Do not expose a raw
  CLI/editor or any Aruba mutation.
- [ ] Execute demo jobs through validation -> backup -> execution -> post-check ->
  success and append local change/audit entries.
- [ ] Keep every mutation disabled with a reason for view-only callers.
- [ ] Re-run focused unit tests and interaction E2E.

### Task 7: Add Desktop And Mobile Launch Entries

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/pages/home/launcherTiles.ts`
- Modify: relevant navigation/permission tests if present

- [ ] Add a failing assertion that users with `network_center.view` see the
  launcher and users without it do not.
- [ ] Add `Trung tam mang` under operations on desktop and mobile, using the
  existing permission metadata so hidden/visible behavior remains centralized.
- [ ] Navigate in the same tab to the full-screen route; the route header supplies
  the return link.

### Task 8: Verification, Visual QA, Review, And Delivery

**Files:**
- Create: `.e2e-fleet/specs/network-center.spec.ts`
- Modify only implementation files required by findings

- [ ] Run focused unit tests, then `npm run typecheck:baseline`, then
  `npm run build`; fix all regressions.
- [ ] Start the app without a visible browser window and run the Network Center
  Playwright spec at desktop and mobile widths with console error tracking.
- [ ] Capture the accepted prototype and implementation at comparable desktop
  dimensions plus a mobile implementation screenshot.
- [ ] Inspect both images and keep a mismatch ledger for copy, layout, type,
  palette, borders, density, responsiveness, and core interactions. Fix all
  material mismatches.
- [ ] Request an independent spec/code review, resolve every critical or important
  finding, and re-run the full verification commands.
- [ ] Stage only Network Center, permission, route, navigation, tests, and design
  documentation files. Commit with the required Codex trailer and push according
  to repository policy.
