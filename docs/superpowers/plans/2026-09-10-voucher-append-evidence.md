# Bổ sung chứng từ và ghi chú Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Admin và người có quyền bổ sung được ảnh/ghi chú vào phiếu ở mọi trạng thái, giữ nguyên nội dung cũ và ghi rõ người bổ sung.

**Architecture:** Lưu từng lần bổ sung trong sổ riêng, chỉ cho thêm; không UPDATE phiếu thu/chi. Khi xem, ghép phần bổ sung vào ghi chú và bộ ảnh của phiếu. Không nối vào cột `income_expenses.notes`: một số nghiệp vụ cũ so sánh chính xác chuỗi đó nên nối mô tả có thể làm thay đổi hành vi hoàn tác tiền.

**Tech Stack:** React, React Query, React Hook Form, Zod, Supabase PostgreSQL, Vitest, Playwright.

## Global Constraints

- Nội dung người dùng đã chốt: ảnh cũ chỉ xem, ghi chú cũ chỉ đọc, ảnh bổ sung chọn riêng, ghi chú bổ sung nhập riêng, nút **Lưu bổ sung**.
- Hiện nút bổ sung cho Admin, dùng `FilePlus2`, tên **Bổ sung chứng từ / ghi chú**; nút sửa phiếu giữ biểu tượng `Pencil`.
- Không đổi tiền, sổ quỹ, ngày phiếu, người tạo, duyệt, ghi sổ hoặc trạng thái xử lý cọc khi bổ sung.
- Cho bổ sung ở mọi trạng thái/kỳ, gồm phiếu cọc, phiếu hoàn cọc, nội bộ, thanh lý, chia lợi nhuận. Giữ xác thực, quyền xem phiếu, giới hạn tổ chức/toà và hạng mục hạn chế.
- Ghi chú mới nằm dưới phần cũ, kèm **Người bổ sung: tên · ngày giờ** lấy từ server. Lần chỉ thêm ảnh cũng ghi nhận người bổ sung.
- Không sửa migration lịch sử. Migration mới cấp tên bằng `scripts/tao-ten-migration.mjs`.
- Tổ chức THẬT chỉ đọc. Test ghi chỉ fixture DEMO/TEST hoặc PostgreSQL loopback; fixture phải tự dọn.
- Sổ bổ sung không có API sửa/xoá. Không đưa ảnh bổ sung vào payload sửa tài chính. Không thay đổi hành vi RPC annotate cũ đang phục vụ Copilot và chứng từ ghi sổ.
- Không có điều khiển đổi sổ quỹ trong màn bổ sung.

## Task 1: Sổ bổ sung và cổng ghi độc lập

**Files:** New allocated `supabase/migrations/*_income_expense_supplements_v1.sql`; `scripts/test-income-expense-supplements.mjs`; related restore/SQL test integration if required.

**Interfaces:**

```sql
-- Public read model, client has SELECT under RLS only.
public.income_expense_supplements (
  id uuid, organization_id uuid, income_expense_id uuid,
  note text, attachments jsonb, actor_id uuid, actor_name text,
  created_at timestamptz
)
public.append_income_expense_supplement_v1(
  p_voucher uuid,
  p_note text DEFAULT NULL,
  p_attachments jsonb DEFAULT '[]',
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
-- {id, income_expense_id, changed, replayed?}
```

- [ ] Reproduce current reservation REFUND annotation rejection in an owned local fixture; record other blanket guards and exact-equality note readers in audit.
- [ ] Write failing SQL behavior tests for arbitrary note text, notes-only/images-only, old row byte-for-byte preservation, actor snapshot, replay, concurrent distinct appends, same-key conflicting payload, unauthorized/cross-org/restricted voucher access, and storage ownership/deletion protection.
- [ ] Add table with mandatory organization FK/parent FK, immutable entries, client SELECT only, safe access policy and `_hide_sandbox_admin`; no client insertion/update/delete and no PUBLIC/anon/service_role function execute.
- [ ] RPC authenticates, authorizes against existing voucher visibility and supplementation rights, locks parent only to serialize appends, takes actor from `auth.uid()` and profile, inserts immutable entry. Empty additions rejected; note input max 5000 chars, attachments max 20 per addition, idempotency key max 200 chars. Do not cap historical accumulated notes/images.
- [ ] Validate real current-uploader-owned attachment objects, supported bucket/path, and tenant binding atomically. Prevent deleting/replacing committed supplemental storage evidence. Invalid reference rolls back entire operation. Existing files remain untouched.
- [ ] Preserve all financial guards: no UPDATE to income_expenses, no new financial bypass tokens. Existing old annotate API remains compatible.
- [ ] Add realtime publication for supplements and appropriate indexes. Read ordering is `(created_at,id)` and pagination must not silently truncate at 1000 rows.
- [ ] Run actual authenticated-role SQL harness and mutation checks for authorization/immutability; record digest/output, then commit exact task files with Codex trailer for independent review.

## Task 2: Giao diện chỉ thêm và hiển thị đồng nhất

**Files:** `src/lib/incomeExpenseSupplement.ts`; `src/hooks/income-expenses/supplements.ts`; `src/hooks/income-expenses/queries.ts`; `src/hooks/income-expenses/types.ts`; `src/hooks/useVoucherDetail.ts`; `src/hooks/useReservationRefundEvidence.ts`; `src/hooks/realtime/finance.ts`; `src/components/income-expenses/IncomeExpenseQuickEditDialog.tsx`; `VoucherNote.tsx`; `IncomeExpenseList.tsx`; `IncomeExpenseDetailDialog.tsx`; `IncomeExpenseDetailMobile.tsx`; `src/pages/payments/VoucherDetailPage.tsx`; `IncomeExpensePrintPage.tsx`; `src/lib/voucherAnnotate.ts`; focused adjacent tests.

**Interfaces:**

```ts
interface IncomeExpenseSupplement {
  id: string; organization_id: string; income_expense_id: string;
  note: string | null; attachments: string[];
  actor_id: string; actor_name: string; created_at: string;
}
// Add only an optional presentation property to voucher domain type.
// Raw notes and attachments are NEVER overwritten by hydration.
interface SupplementedVoucher {
  attachments?: string[] | null;
  supplements?: IncomeExpenseSupplement[];
}
// Pure presentation helpers and batch read boundary.
getVoucherDisplayAttachments(voucher: SupplementedVoucher): string[];
hydrateIncomeExpenseSupplements<T extends {id: string}>(rows: T[]): Promise<(T & {supplements: IncomeExpenseSupplement[]})[]>;
// Mutation sends only new content and a stable retry key.
useAppendIncomeExpenseSupplement(): UseMutationResult;
```

- [ ] Write focused failing tests: Admin visibility distinct from edit; no handler/unauthorized hidden; approved/posted/cancelled supported; old note is not editable; old images have no remove; new note starts empty; outgoing RPC has only new content; save disabled empty/uploading/pending; retries retain key; no financial mutation invoked.
- [ ] Use a typed/Zod boundary for new RPC. Parse result as unknown and map permission/validation/conflict errors to readable messages. Batch load supplements in bounded ID chunks with paginated rows; no silent fallback to an empty successful result on read errors.
- [ ] Hydrate list/batch/detail/sibling queries with a separate `supplements` property. Keep raw `notes` and `attachments` intact for money writers and legacy parsers.
- [ ] Implement read-only original evidence section, separate new uploader and controlled note form, `Lưu bổ sung`. Disable close/save/edit while upload or mutation is in progress. Remove selected new files only locally (`deleteOnRemove=false`) so an uncertain successful save cannot lose evidence.
- [ ] Give Admin the additional `FilePlus2` action on list and detail surfaces, same accessible label everywhere, colour distinguishable from edit. Exclude financial fields from the supplementation dialog.
- [ ] Compose supplemental notes after original content in VoucherNote, including vouchers with no original note and system-derived commission/termination notes. Preserve line breaks and always show immutable actor/time.
- [ ] Display merged photo thumbnails/lightbox in list/detail/print surfaces. Preserve original data arrays for editing/posting. Refund evidence read also merges REFUND supplements, so source receipt shows new refund proof.
- [ ] Invalidate supplements, income-expenses, batches, voucher-with-batch and reservation-refund-evidence on append and realtime insert. Verify an already-open detail receives new content.
- [ ] Run focused UI/boundary tests, meaningful authorization/append mutations, typecheck and build; inspect production bundle for new action/RPC; commit task files for independent review.

## Task 3: Kiểm tra thực tế và phát hành

**Files:** `.e2e-fleet/specs/income-expense-supplements.spec.ts`; owned fixture helper as needed; existing user guide in `docs/he-thong/`; generated artifacts via owning scripts.

- [ ] Desktop/mobile headless DEMO: Admin sees both edit and FilePlus2, opens posted refund, sees old evidence read-only, uploads a synthetic proof and note, saves and reopens. Verify actor/time, prior content intact, photos preview, source cọc shows refund proof.
- [ ] Test independent notes-only addition and a second staff session reading saved proof; check parent voucher JSON, financial postings and balances unchanged. Never submit on user's real voucher.
- [ ] Independently review migration/authorization/storage, apply forward migration only via reviewed lane with automatic backup, then generate canonical types/surfaces/provenance.
- [ ] Run required gates, root-owned test selection, typecheck/build, graph detect-changes, reconciliation and sandbox leak checks. Update user guide to explain append-only evidence and distinct Admin button.
- [ ] Open draft PR with measured evidence, get required cross-review, merge after CI green, promote exact verified SHA through controlled production script. Re-run owned DEMO smoke on actual production and clean fixtures/files.
