# CT01 và hợp đồng thuê Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Independent file scopes may be delegated under dispatching-parallel-agents.

**Goal:** Download one Word with CT01 first and the supplied lease beginning on page 2, preserving original typefaces and sizes, with 12/24 month selection and legal building owner entry.

**Architecture:** Keep original Word sections/styles in one templated DOCX. Resolve active customer tenancy including room, then read legal owner from private building-scoped storage. Shared owner form is used in building create/edit; the download maps party A to legal owner and party B to customer.

**Tech Stack:** React, TypeScript, Zod, Supabase/Postgres, Docxtemplater, OOXML, Vitest, Playwright, Word/PDF visual QA.

## Global Constraints

- Both CT01 and lease use Times New Roman per user's follow-up; retain original run/style font sizes (lease body 11pt, title 14pt); do not shrink to force pagination.
- CT01 request: Đăng ký tạm trú {duration_months} tháng tại {building_address}.
- Dropdown choices only 12 or 24 months; default 24 matches supplied lease. Same duration in both documents.
- Download date uses Asia/Ho_Chi_Minh at click time. Do not prefill signatures.
- Legal owner is the title owner, not logged-in user or CRM organization. Missing owner must be reported rather than invented.
- Only active, nondeleted tenancy/room/building; multiple rooms require explicit selection even in the same building.
- Private PII storage, org/building scope and authorized read/write. No business writes outside DEMO/TEST; E2E only DEMO with cleanup.
- Preserve originals; attached document notes describe field mappings only.
- Follow Project Contract for generated types, migration backup lane, draft PR, independent review, gates and release.

### Task 1: Legal owner persistence and building forms

**Files:** New migration, owner schema/service/hook/form, BuildingFormDialog.tsx and active EditBuildingDialog.tsx, scoped tests and RLS harness. Do not touch ct01Document/download component/service/template or their tests.

**Interface:** Export `BuildingLegalOwner` in `src/lib/buildingLegalOwner.ts` with `full_name: string`, `birth_year: number | null`, `id_number: string`, `id_issue_date: string | null`, `id_issue_place: string`, `permanent_address: string`. Export `loadBuildingLegalOwner(buildingId: string): Promise<BuildingLegalOwner | null>` from that module or report final module path. Fields may be incomplete when saved; download validates required owner data. Preserve initial zero in CCCD.

- [ ] Inspect existing RLS and public surfaces, define private 1:1 storage with organization scope and sandbox admin policy.
- [ ] Write meaningful validation/persistence and real-role permission/cross-org tests before implementation.
- [ ] Add idempotent migration via naming tool, schema/service and shared owner fields in create/edit. Handle partial save failures visibly and retry safely.
- [ ] Test and mutation-test permission/migration invariants; report required schema/types lane steps, no direct apply.
- [ ] Independent review prior to schema application and merge.

### Task 2: Word template, tenancy selection and duration

**Files:** public/templates/ct01.docx, src/lib/ct01Document.ts, src/lib/ct01DownloadService.ts, src/components/customers/CT01DownloadButton.tsx, associated unit/browser tests.

- [ ] Extract original fonts/styles/numbering/page settings and build combined template with separate sections.
- [ ] Write failing tests for owner/customer/room mapping, duration, two sections and font preservation.
- [ ] Implement mapping and dropdown; keep room choices distinct, load legal owner on selected building only.
- [ ] Render samples using Word to PDF and inspect every page. CT01 must fit page 1 with original font sizes, lease starts page 2.
- [ ] Browser checks for 12/24, busy guard, multiple rooms, missing data and permissions; console errors zero.

### Task 3: Integrate and release

- [ ] Review changes; stage only explicit files. Open draft PR for migration review.
- [ ] Reviewed clean schema SHA, provenance/catalog, backup + forward migration lane; regenerate types through generator only.
- [ ] Typecheck, scoped tests, build, bundle and required prepush gates.
- [ ] Rebase latest main, inspect staged generators and merge according to Contract.
- [ ] Verify exact SHA CI, promote via approved script and verify production artifact. Report remaining unverified scope.
