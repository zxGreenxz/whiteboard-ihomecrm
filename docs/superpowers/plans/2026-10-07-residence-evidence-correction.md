# Residence evidence correction implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Show the known contract dates and residence actions without presenting imported placeholders or contract dates as confirmed personal arrival/departure.

**Architecture:** Keep the immutable ledger and the existing customer column. A forward migration adds scoped contract context to the JSON history reader and a separately labelled contract-end fallback to summaries. Correct proven writer defects without reconstructing unsupported personal history.

**Tech Stack:** PostgreSQL/Supabase, React/TypeScript/Zod, Vitest/PGlite.

## Global constraints

- Keep the applied 20261007064802 migration unchanged.
- Real organization data is read-only except the reviewed official forward-migration lane.
- Keep organization, contracts.view, and per-building authorization on every returned fact.
- Contract dates describe the contract; current membership does not prove historical personal presence.
- Preserve main-workspace WIP. Work in the existing customer-residence-history worktree.
- Release through exact-main CI and the official production promotion script.

## Shared JSON interfaces

Existing RPC arguments and event pagination stay unchanged. Add optional fields for rolling deployment compatibility (the new server always emits them):

```ts
type ContractContext = {
  contract_id: string; contract_number: string | null; status: string;
  building_id: string | null; room_id: string | null;
  building_name: string | null; room_name: string | null;
  signed_date: string | null; start_date: string | null;
  end_date: string | null; actual_end_date: string | null;
  room_segments: Array<{
    room_id: string; room_name: string | null; building_name: string | null;
    from_date: string | null; to_date: string | null;
    source_path: string; trusted: boolean; diagnostic: string | null;
  }>;
};
type HistoryAddition = { contract_contexts: ContractContext[] };
type SummaryAddition = {
  last_contract_end: { contract_id: string; date: string } | null;
  departure_kind: string | null;
};
```

Contract context is bounded to contracts referenced by the returned event page plus current memberships on the first page. Deduplicate by contract_id in the UI. Room segments describe HĐ-to-room, never personal presence, and are filtered through the residence reader's historical building scope. Dates must be finite ISO dates or null.

`last_contract_end` is allowed only with no current accommodation and no non-OBSERVED personal event and a visible terminal linked contract with actual_end_date. It is displayed as `Kết thúc HĐ · dd/mm/yyyy`, never `Đã rời`. Do not use scheduled end_date as departure.

Restricted/UNKNOWN summaries must not expose last_contract_end. Context requires permission on the current contract location independently of visibility of an old event; null rooms do not bypass scope. `departure_kind` comes from the same selected departure event and lets the UI label administrative removal, deletion and contract termination without asserting a physical move-out. Mixed historical CHECKED_IN entries use conservative wording. Generic DRAFT activation without a signing snapshot records CONTRACT_ACTIVATED, and counts as a new stint boundary when preventing stale departure-date reuse.

### Task 1: SQL evidence and writers

**Files:** New `supabase/migrations/20261007160000_customer_residence_evidence.sql`; new `src/lib/__tests__/customerResidenceEvidenceMigration.test.ts`.

**Consumes:** Existing ledger, source writer functions, scoped reader helpers and get_room_residence_segments_v1.

**Produces:** The JSON additions above; no new externally callable RPC arguments.

- [x] Add failing PGlite tests for known ACTIVE contract dates with OBSERVED-only history; terminated contract actual vs scheduled end; scoped context and segments; no fabricated customer arrival/departure.
- [x] Add failing regression cases for final-source metadata updates assigning old events to new members, delayed transfer approval duplicate events, and an EXPIRED predecessor with a real linked successor.
- [x] Implement forward replacements. Metadata updates after final approval do not reingest current members. Pending-to-approved completion does ingest once. Transfer fallback recognizes approved_at in the applying transaction. Direct contract creation without signing confirmation records an administrative membership action. Exclude a proven replaced predecessor from current-state predicates without excluding all EXPIRED contracts.
- [x] Run new and existing SQL suites; require green and keep production data untouched. Final SQL result: 47/47, including all original cases on the corrected schema.

### Task 2: Evidence-labelled customer UI

**Files:** `src/lib/customerResidenceHistory.ts`, `src/components/customers/CustomerResidenceHistoryDialog.tsx`, `src/components/customers/CustomerResidenceCell.tsx`, related existing tests, `src/hooks/useCustomers.ts` and its focused create test if needed.

**Consumes:** Shared JSON interfaces above. Missing new fields parse to []/null for compatibility.

**Produces:** Known contract facts, real actions, and precise explanations in the existing column/dialog.

- [x] Add failing parser/label/dialog tests: ACTIVE HĐ with start 2026-10-03 and end 2027-08-30; terminal HĐ actual 2026-06-27 vs scheduled 2026-06-30; no contract evidence; page merging; no blanket incomplete warning; error/retry retention.
- [x] Show contract cards with separate `Ngày ký HĐ`, `Bắt đầu HĐ`, `Hết hạn HĐ`, `Kết thúc thực tế ghi trên HĐ` labels. Label room segments as contract room history. Keep migration-only OBSERVED out of the action timeline when its contract context exists.
- [x] Remove generic incomplete text from the summary cell. Explain missing physical arrival/departure confirmation specifically inside the dialog. Do not display migration recording time as stay date.
- [x] Display last_contract_end distinctly. NONE means no recorded contract linkage, not proof the person never stayed. A new unattached customer defaults to WALK_IN rather than RENTING; leave existing production statuses untouched.
- [x] Run focused domain, UI and hook tests; preserve lazy loading, keyboard access, pagination and retry. Final focused result: 40/40, plus CUA desktop and mobile review.

### Task 3: Review, release, and verify

**Files:** Generated release evidence only via repository scripts.

- [x] Independently review SQL authorization, date provenance, writer transitions and UI claims. Fix findings and rerun affected tests only. Approved SQL digest: 8d5c3f984ae3897c335633dc263f3ff9d8c69b60df85e97dbc1ce15e7bf6a102.
- [ ] Stage named files, inspect gate plan, run required gate. Generate types only if needed through the official generator.
- [ ] Back up and apply the reviewed forward migration through the official lane; check the four reported customers read-only.
- [ ] Commit with Codex trailer, create/attach PR, merge, wait for exact-main successful CI, promote using the official script.
- [ ] Verify production build SHA and browser UI for reported cases; report dates, publication status, and remaining unavailable historical evidence plainly.
