# AUTHORIZATION-PLAN — Trạng thái triển khai (Sprint 0→7)

> Cập nhật: 2026-07-13. Live DB `tryymsxyyckgbrmmvozx`. Nguồn: [AUTHORIZATION-PLAN.md](./AUTHORIZATION-PLAN.md).
> **Nguyên tắc xuyên suốt**: mọi thay đổi enforcement đều *tightening-only* hoặc additive-inert, verify live + browser, và **giữ nguyên dữ liệu** (đối chiếu sums/counts trước-sau). Backup đầy đủ trước khi bắt đầu phần enforcement.

## Backup (điều kiện tiên quyết)
- **Logical export**: `.backups/20260713_full/` — 142 bảng, 36.800 dòng, 32MB (gitignored). Manifest `_manifest.json`.
- **Supabase**: daily physical backup (walg) — mới nhất trước phiên: 2026-07-12. (PITR off.)

## Reconciliation cuối (chứng minh KHÔNG mất dữ liệu)
Đối chiếu sau toàn bộ Sprint 0–6 vs baseline Sprint 0:

| Chỉ số | Baseline | Sau cùng | Ghi chú |
|---|---|---|---|
| INCOME APPROVED (n / sum) | 1016 / 4.726.473.718 | 1016 / 4.726.473.718 | **khớp tuyệt đối** |
| EXPENSE APPROVED (n / sum) | 649 / 4.675.048.694 | 650 / 4.677.268.694 | +1 phiếu HH 2.220.000 — **nathan duyệt tay 06:05 UTC qua flow app** (organic, không phải migration) |
| invoices total | 4.231.317.493 | 4.231.317.493 | khớp |
| payments total | 3.855.366.563 | 3.855.366.563 | khớp |
| income_expense_items / invoice_items / payments / accounts / contracts / customers (rows) | 1946/3236/945/50/319/496 | 1946/3236/945/50/319/496 | khớp backup manifest |

Delta duy nhất = 1 phiếu hoa hồng nathan duyệt tay qua app **trong lúc enforcement đã live** ⇒ đồng thời chứng minh app vẫn hoạt động đúng (guard cho qua approved_by=self, org-boundary + RBAC không chặn).

---

## Sprint 0 — Containment P0 ✅ (deployed + verified production)
Xem chi tiết [AUTHORIZATION-SPRINT0-STATUS.md](./AUTHORIZATION-SPRINT0-STATUS.md). Tóm tắt: fail-closed `get_my_permissions`/`ai_copilot_perms_for` (orphan⇒`{}`, `legacy_owner_allowlist`); revoke 8 internal/recompute helper; disable project signup (422); provisioning qua edge fn `admin-create-user`; R2 worker contained (cần wrangler deploy); salary-cron Bearer auth (401 verified).

## Sprint 1 — Organization foundation ✅ (additive)
`organizations` (prod `ihome-prod` + demo `ihome-demo` tách qua `demo_user_ids()`), `organization_memberships` (nguyentamca OWNER, bosshuy PARTNER, joey/nathan STAFF, demo.chunha OWNER+5 demo STAFF; **phanboichauthcs orphan KHÔNG membership**), invitations, `legacy_owner_organization_map`, exceptions. `organization_id` NULLABLE + UNIQUE(org,id) cho buildings/areas/accounts/roles, backfill 0 null / 0 mismatch.

## Sprint 2 — Normalized RBAC ✅ (additive, shadow-verified)
8 bảng (permission_definitions 208 key, organization_roles, role_permissions, role_bindings, authorization_scopes, role_binding_scopes, member_permission_overrides, member_override_scopes). Materialize từ roles+staff_assignments: 7 org_roles / 315 role_permissions / 61 bindings / 35 scopes / 55+ overrides. `authorize_v2` (scope-aware) + `effective_perms_v2` (shadow). **Shadow-compare vs get_my_permissions = 0 mismatch** trên 208 key × 8 staff.

## Sprint 3 — org_id rollout + org-boundary enforcement ✅ (verified)
- **3a additive**: `organization_id` cho 132 bảng + profiles, derive theo dependency graph (parent > user_id-via-membership > PROD). 0 null, 0 parent-child mismatch, sums khớp baseline.
- **3b enforcement (tightening-only)**: `_autofill_org` trigger BEFORE INSERT + RESTRICTIVE org-boundary policy `(org IS NULL OR super_admin OR org ∈ my_org_ids())` trên 28 bảng core financial/entity/PII. Impersonation: nathan thấy prod, 0 demo leak, không over-block; super_admin autofill INSERT pass; browser income-expense/invoices/contracts render đủ data, 0 console error.

## Sprint 4 — Approval engine ✅ (additive, end-to-end tested)
9 bảng approval (rule_sets/rules/steps/approvers/requests/request_steps/candidates/decisions/audit) + posting metadata trên income_expenses. Rule seed/org: AUTO_POST internal_settlement, force REQUIRE_APPROVAL SENSITIVE, fallback. RPCs `_eval_approval_rule` (precedence DENY>force>priority>fallback), `submit_financial_voucher`, `decide_financial_voucher` (maker-checker + quorum + post). **Test ROLLBACK**: fallback→PENDING→maker self-approve BỊ CHẶN→owner→POSTED; AUTO_POST→POSTED ngay.

## Sprint 5 — Financial column guard ✅ (deployed, code-verified safe)
Trigger SECURITY INVOKER phân biệt client (`current_user='authenticated'`) vs RPC (owner): client KHÔNG được đặt `approved_by ≠ auth.uid()` (chống giả mạo audit) / ghi posting metadata. Đối chiếu code: mọi flow client set approved_by ∈ {NULL, user.id} ⇒ không phá. Test: forge/posting BỊ CHẶN, normal PASS, RPC PASS.

## Sprint 6 — Hardening ✅ (một phần) + còn lại
- **6a ✅**: revoke anon/auth `_autofill_org`/`_guard_*` (secdef anon-executable→100); **CI gate** `scripts/check-definer-acl.mjs` + baseline (§9.3.9) chống regress ACL.
- Staff lifecycle (invite/suspend/revoke), R2/cron/edge separation: phần lớn đã ở Sprint 0.

## Sprint 7 — Cutover/reconciliation ✅ (reconciliation core) + còn lại
Reconciliation (bảng trên) = 0 mất dữ liệu. Observability/alert dashboard + drop legacy sau retention: còn lại.

---

## Phần enforcement lớn CÒN LẠI (integration, cần staged + browser test từng flow)
Các phần này đổi HÀNH VI write path của app ⇒ phải migrate hook→RPC rồi mới revoke, test từng flow trên browser (rủi ro availability nếu big-bang):

1. **Hợp nhất 20+ hook financial write** (usePayments/useInvoices/useBulkRecordPayment/useManagerSalary/…) vào canonical RPC (`record_invoice_payment_atomic`, `request_salary_payout`, …) rồi **revoke direct DML** cột state (§8.1, Sprint 5 core). Engine (Sprint 4) đã sẵn để wire.
2. **RLS v2 thay thế** 552 policy owner-graph bằng org-boundary thuần (hiện dùng RESTRICTIVE bổ sung — an toàn hơn, giữ policy cũ). §17 Sprint 3.
3. **Storage**: re-path object theo `<org>/<resource>/…` + `storage_object_links` + scoped policy (7 bucket authenticated-wide). §14.
4. **Function ACL allowlist toàn schema** + private impl schema + pinned search_path (§9.3). Hiện đã revoke các helper trọng yếu + CI gate.
5. **Permission cache version** (`authorization_version` đã có ở organizations) wiring FE invalidation.
6. **Emergency approve + reversal RPC** wiring (schema đã có).

Toàn bộ foundation (org boundary, RBAC chuẩn hoá, approval engine, guard, CI gate) đã sẵn sàng để các integration trên bám vào, theo đúng thứ tự gate của plan.
