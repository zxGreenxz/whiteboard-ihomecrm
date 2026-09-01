# Integrated MikroTik Center Design

> **[LỊCH SỬ — ĐÃ SHIP 07-08/2026]** Tài liệu hiện hành: `docs/he-thong/22-network-center.md`. Giữ làm bằng chứng, không cập nhật nữa.

## Goal

Add a full-screen Network Center to iHomeCRM for monitoring and operating the
MikroTik and Aruba network at every rental building. The Network Center shares
the existing login, tenant scope, employee permissions, Supabase client, React
Query cache, and building records, but it owns a visually independent shell.

## Locked Product Decisions

- The app serves 15 buildings initially, one MikroTik per building, and up to
  ten Aruba access points per building.
- Aruba devices are display-only. No Aruba configuration action is exposed.
- The route is part of iHomeCRM, not a separate package or deployment.
- The page does not render the normal CRM header or sidebar after navigation.
- A visible `Ve iHomeCRM` action returns the user to the CRM dashboard.
- Employee access has exactly two permissions:
  - `network_center.view`: open and read the Network Center.
  - `network_center.execute`: run allowed actions immediately after validation
    and confirmation.
- There is no request, approval, approve, reject, or maker-checker workflow.
- Every execution remains auditable and must show who acted, what changed, the
  target building, time, reason, validation, and outcome.

## Delivery Boundary

This implementation delivers the complete integrated frontend surface and a
typed service boundary. It reads real iHomeCRM building records and derives a
deterministic network demo state until the Supabase/VPS worker endpoints from
the A+ infrastructure plan are deployed. Demo execution updates local UI state
only and is visibly identified as simulation; it must never imply that a real
router changed.

The production worker remains responsible for SSH/SNMP/WireGuard connectivity,
server-side permission checks, secret storage, command allowlisting, backups,
post-checks, rollback, and immutable audit persistence. Browser code never
receives router credentials or arbitrary CLI capability.

## Routes And Shell

- `/network-center`: fleet overview.
- `/network-center/buildings/:buildingId`: one building's network workspace.
- Both routes use `ProtectedRoute` and
  `RequirePermission module="network_center" action="view"`.
- Both routes lazy-load through the existing retry wrapper in `src/App.tsx`.
- The route component does not use `MainLayout`; it renders a scoped
  `.network-center` shell with its own header, site switcher, primary navigation,
  and mobile navigation.
- Desktop and mobile CRM launchers show `Trung tam mang` only when the caller
  has `network_center.view`.

## Information Architecture

### Fleet Overview

- KPI strip: online, degraded, offline, active incidents, stale backups, active
  maintenance.
- Search and filters: building, device health, incident severity, backup age,
  and firmware drift.
- Building fleet table on desktop and complete building cards on mobile.
- Each row includes router reachability, WAN, CPU/RAM, active clients, Aruba
  availability, incidents, backup age, and firmware.
- An incident rail highlights unresolved events and links to the affected site.
- Fleet execution controls are limited to clearly typed operations such as
  pausing or resuming demo changes.

### Building Workspace

The building selector preserves the active tab when switching sites.

1. `Tong quan`: router freshness, WAN, resources, sessions, incidents, backup,
   firmware, topology summary, and recent activity.
2. `Cong giao tiep`: interface state, traffic, utilization, errors, and protected
   ports.
3. `Thiet bi ket noi`: clients/hotspot presence, IP, MAC, hostname, user, room
   hint, traffic, and randomized-MAC warning.
4. `Aruba & so do`: display-only Aruba inventory and a clear MikroTik-to-switch-
   to-AP topology.
5. `Su co & SLA`: active/recovered incident timeline, acknowledgement,
   maintenance windows, availability, outage duration, and MTTR.
6. `Cau hinh`: desired-state summary and allowlisted typed MikroTik actions.
7. `Sao luu & Diff`: revisions, freshness, change counts, redacted pairwise
   comparison, and simulated config capture.
8. `Thay doi`: action jobs, progress, structured result, compensation/rollback
   status, and reconciliation state. It contains no approval controls.
9. `Audit & Bao mat`: actor timeline, exposure checks, NTP, firmware, backup,
   worker freshness, and audit integrity status.
10. `Cai dat`: polling, alerts, sensors, maintenance, dependency behavior,
    rollout mode, and pause controls.

## Interaction Model

- Every tab, selector, search field, filter, row, drawer, and dialog changes real
  local state; no inert controls are shipped.
- View-only users see a persistent `Chi xem` notice. Mutation controls remain
  visible where context matters but are disabled with an explanatory tooltip.
- Execute users may acknowledge incidents, schedule/cancel maintenance, capture
  a configuration snapshot, and run an allowlisted typed action.
- Typed action flow: choose action -> complete schema fields -> inspect target,
  risk, before/after preview, backup rule, post-check, and rollback class -> enter
  a reason -> confirm `Kiem tra va chay ngay`.
- Reboot and similarly disruptive actions require typing the router identity.
- Demo jobs progress deterministically through validation, backup, execution,
  post-check, and success, then append an audit/history item.
- Arbitrary CLI, default-route/WAN redesign, firewall reordering, full restore,
  and all Aruba mutation remain unavailable.

## Visual System

The accepted information architecture is the local prototype at
`.superpowers/brainstorm/ui-1784779023/content/network-center-page-structure.html`.
The implementation intentionally replaces its warm/grid treatment with the
user-approved high-contrast direction:

- True white canvas and surfaces (`#ffffff`).
- Near-black primary text (`#0a0a0a`) and readable gray secondary text
  (`#404040`).
- Two-pixel black borders; three pixels for major boundaries.
- No shadows, glass, blur, translucent text layers, or cream/off-white canvas.
- Large, bold typography for important labels and values.
- Square or minimally rounded geometry.
- Semantic fills remain pale enough for black text; icons and labels supplement
  every color signal.
- Wide layout uses six KPI columns and table-first density.
- Compact layout uses three KPI columns and stacked main/rail regions.
- Mobile uses two KPI columns, horizontally scrollable tabs, complete site cards,
  minimum 44px controls, and no page-level horizontal overflow.

## Data And Service Boundary

- `useBuildings()` supplies the building ID, name, area metadata, and room count
  under current Supabase RLS.
- Pure demo generation maps each building ID to stable network values so refresh
  and navigation do not randomly change the fleet.
- A typed `NetworkCenterService` separates overview queries, site queries, and
  execution. UI components do not import Supabase directly.
- `DemoNetworkCenterService` is the initial provider.
- A future `SupabaseNetworkCenterService` will call narrow RPCs/Edge Functions.
  Every execute endpoint must recheck
  `can_do_on_building('network_center', 'execute', building_id)` server-side.

## Error, Empty, And Loading States

- Route loading uses the root suspense fallback, followed by page-level skeletons.
- Building query errors show a retry action and never silently become demo data.
- An organization with no physical buildings receives a useful empty state and
  a link back to building management.
- Unknown building IDs show a not-found state with a link to the fleet overview.
- Failed demo actions preserve form input, show the stage/error, and append no
  success audit entry.

## Verification Contract

- Unit tests prove the exact two-permission registry, page catalog coverage,
  view-only behavior, deterministic data generation, filtering, summaries, and
  typed action validation.
- TypeScript baseline must not gain fingerprints.
- The root production build must pass.
- Headless Playwright verifies desktop and mobile route rendering, navigation,
  all building tabs, view-only disabled actions, execute confirmation, updated
  local job/audit state, and zero unexpected console errors.
- Visual QA compares screenshots of the accepted prototype and implementation,
  explicitly checking layout, typography, true-white palette, borders, density,
  responsiveness, and interaction states.

