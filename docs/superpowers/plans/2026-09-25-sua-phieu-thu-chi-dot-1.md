# Sửa phiếu thu chi — đợt 1 · Plan thi hành

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Cho sửa phiếu thu chi đang chờ duyệt (có lưu vết, người duyệt thấy), đổi hình thức thu của khoản thu
hoá đơn theo danh sách sổ nhận tiền do máy chủ bắt luật, mã phiếu duy nhất, và khoá tháng lợi nhuận tuyệt đối.

**Architecture:** 5 migration forward-only (4 thêm khả năng trước khi web lên, 1 đóng đường cũ sau khi web lên),
mọi ghi tiền qua RPC SECURITY DEFINER có kiểm quyền + khoá kỳ; giao diện React đổi sang RPC mới, xoá đường chết.
Thiết kế: `docs/superpowers/specs/2026-09-25-sua-phieu-thu-chi-dot-1-design.md`.

**Tech Stack:** PostgreSQL 15 (Supabase, plpgsql), React 18 + Vite + TanStack Query + shadcn/ui, Vitest,
Playwright (.e2e-fleet, môi trường TEST).

## Global Constraints

- **Không thay đổi dữ liệu đang tồn tại** (chủ, 25/09): migration không UPDATE/DELETE phiếu, hạng mục, mã, sổ,
  khoản thu, hoá đơn; không thêm cột vào `income_expenses`. Chỉ thêm bảng/hàm/trigger/chỉ mục và seed bảng mới.
- **Không đụng hàm/trigger đã ghim** trong `supabase/migration-policy.json › idempotencyRetirements[].witness`
  (vd `app_private.guard_income_expense_owned_payload()`, `finance_v2_birth_provenance_bridge()`,
  `create_commission_voucher`, `list_cashbooks_for_expense_v2`, trigger `a00_ie_owned_payload_freeze`,
  `a86_finance_v2_birth_provenance`); không tạo lại chữ ký đã gỡ (`update_income_expense_recipient_v1(uuid,uuid,jsonb,jsonb)`…).
- Tên migration cấp bằng `node scripts/tao-ten-migration.mjs <slug>`; file có `BEGIN; … COMMIT; NOTIFY pgrst,
  'reload schema';`, chạy hai lượt liên tiếp được, chạy được trên DB Restore Drill (gác bằng `to_regclass` /
  `to_regprocedure`), preflight md5 `IN (trước, sau)` cho mọi hàm bị thay, khối nghiệm thu cuối file.
- Hàm SECURITY DEFINER mới: `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role;` rồi `GRANT EXECUTE …
  TO authenticated` nếu giao diện gọi. Hàm lấy khoá dòng không được STABLE/IMMUTABLE.
- Sửa `.sql` bằng Write/Edit hoặc Node (LF, không CRLF). Stage migration trước `provenance:generate`.
- Lỗi trả người dùng bằng tiếng Việt, nói cách sửa (spec mục 3).
- Test E2E chỉ trên môi trường TEST (web nhánh `test-env`); production chỉ đọc cho tới bước phát hành.
- Phát hành: M1–M4 qua `npm run migrate:forward -- <file> --apply` TRƯỚC web; M5 SAU web. Hỏi chủ một câu kèm
  số đo trước lần apply production đầu tiên.
- Giao diện: shadcn/ui + Lucide; dữ liệu qua hook; không cast RPC `any`; mock trong test không đặt tên spy là `rpc`.

---

## Bản đồ file

| File | Việc |
|---|---|
| `supabase/migrations/<ts>_ma_phieu_duy_nhat.sql` | M1 — bộ đếm mã chung tổ chức + chỉ mục duy nhất |
| `supabase/migrations/<ts>_khoa_thang_loi_nhuan_tuyet_doi.sql` | M2 — khoá tháng tuyệt đối, chốt chặn phiếu chờ duyệt, mở khoá có lý do |
| `supabase/migrations/<ts>_sua_phieu_cho_duyet.sql` | M3 — bảng lịch sử sửa, writer revise, nới niêm phong trong scope REVISE, trigger kiểm delta |
| `supabase/migrations/<ts>_so_nhan_tien.sql` | M4 — sổ tiền mặt riêng, sổ phụ theo toà, RPC đọc/cài, đổi hình thức thu |
| `supabase/migrations/<ts>_dong_duong_cu_sua_phieu.sql` | M5 — compat chỉ metadata, thu tiền bắt danh sách sổ, xoá RPC cũ |
| `src/lib/__tests__/suaPhieuDot1Migrations.test.ts` | test tĩnh 5 migration |
| `src/lib/incomeExpenseRevision.ts` (+test) | diff/nhãn/luật lý do/điều kiện sửa |
| `src/hooks/income-expenses/revisions.ts` | hook revise + đọc lịch sử |
| `src/components/income-expenses/RevisionSummary.tsx` | bảng so sánh + các lần sửa |
| `src/hooks/useReceivingCashbooks.ts` | đọc/cài sổ nhận tiền, đổi hình thức thu |
| `src/components/invoices/ChangeCollectionMethodDialog.tsx` | hộp đổi hình thức thu |
| `src/components/cashbooks/ReceivingCashbookSettings.tsx` | màn "Sổ nhận tiền" |
| sửa | `IncomeExpenseForm`, `IncomeExpenseList`, `IncomeExpenseDetailDialog/Mobile`, `IncomeExpensePage/MobilePage`, `IncomeExpensePostingDialog`, `AttachmentUpload`, `mutations.ts`, `queries.ts`, `batch.ts`, `useSettlementActions.ts`, `PaymentsSummaryDialog`, `useDeletePayment`, `RecordPaymentDialog`, `BulkRecordPaymentDialog`, `useBulkRecordPayment`, `useQuickCollect`, `CollectDrawer/CollectPayForm`, `useCashHandovers`, `HandoverSheet`, `BuildingFormDialog`, `ProfitLockTab`, `useShareholderProfit`, `VoucherHistoryDialog` |
| xoá | `src/hooks/useUpdatePaymentMethod.ts`, `src/hooks/income-expenses/incomeVoucherCashbook.ts`, các hàm resolve trong `src/lib/cashAccount.ts` (+test) |

---

## Phase 0 — Chuẩn bị

### Task 0: Worktree dùng được

- [ ] Nối `node_modules` bằng PowerShell `New-Item -ItemType Junction -Path node_modules -Target "<checkout chính>\node_modules"`.
- [ ] `git status` sạch trừ file CRLF-phantom `20260528000007_drop_beds_fix_rpcs.sql` (không stage).
- [ ] `npx vitest run src/lib/__tests__/cashAccount.test.ts` xanh (mốc).
- [ ] Commit spec + plan: `docs(sua-phieu): spec + plan dot 1`.

## Phase 1 — Máy chủ (người chính viết, không giao subagent)

Mỗi task: cấp tên → viết SQL → test tĩnh (vitest đọc file) → chạy thử trên TEST trong ROLLBACK
(`npm run test-env:thu-sql -- <bản-không-BEGIN/COMMIT>`) → sửa → chụp md5 "sau" trên TEST → ghi vào preflight →
chạy lại → commit.

### Task 1: M1 — mã phiếu duy nhất
**Files:** tạo migration M1; test `suaPhieuDot1Migrations.test.ts` (describe M1).
**Interfaces — Produces:** bảng `app_private.voucher_code_counters(organization_id uuid, prefix text, yymm text,
last_value int, updated_at timestamptz, PK(organization_id,prefix,yymm))`; trigger function
`public.auto_generate_voucher_code()` (giữ tên, trigger `trigger_auto_generate_voucher_code` giữ nguyên); chỉ mục
`public.income_expenses_org_code_duy_nhat`.
- [ ] Test tĩnh: file có preflight md5 `auto_generate_voucher_code`; thân hàm mới không còn `user_id`, có
  `voucher_code_counters`, `org_today_v1(NULL)`, `lpad(`; chỉ mục tạo trong `DO` bằng `EXECUTE format(… created_at
  >= %L …, clock_timestamp())`; không có `UPDATE public.income_expenses`.
- [ ] Thân hàm: `code` có sẵn thì giữ; `UPDATE counters … RETURNING`; không có dòng thì `INSERT … SELECT COALESCE(max(
  substring(code FROM 7)::int),0) … WHERE code ~ '^'||prefix||yymm||'[0-9]{1,9}$' ON CONFLICT DO NOTHING` rồi
  UPDATE lại; `NEW.code := prefix||yymm||lpad(n::text,3,'0')`.
- [ ] Thử trên TEST (ROLLBACK): sau migration, INSERT 2 phiếu chi chờ duyệt (hai `user_id` khác nhau, cùng org, toà
  thật, ngày tháng mở) → hai mã khác nhau, số đuôi = max hiện có + 1, +2.
- [ ] Commit `feat(ma-phieu): dem ma chung to chuc, chi muc duy nhat cho phieu moi`.

### Task 2: M2 — khoá tháng lợi nhuận tuyệt đối
**Produces:** `app_private.profit_month_locked_v1(uuid, date) → boolean` (STABLE);
`app_private.assert_profit_month_open_v2(uuid, date, text) → void`; thân mới `public.income_expenses_check_profit_lock()`,
`public.income_expense_items_check_profit_lock()`, `app_private.assert_period_open_for_edit_v1(uuid,text)`;
`app_private.guard_profit_month_lock_pending_v1()` + trigger `a10_profit_month_lock_requires_no_pending` trên
`public.profit_monthly`. (Đổi so với bản đầu, 25/09: màn Chốt lợi nhuận thật đi `profit_close_v2`/`profit_reclose_v2`,
mở khoá có lý do đã có `profit_unlock_v2` ⇒ không sửa `lock_profit_month_v1`, không tạo hàm mở khoá/bảng log mới.)
- [x] Test tĩnh: hai trigger function không còn `is_super_admin`/`is_org_owner`/`business_result_accounting`/
  `auth.uid`; tập miễn đúng 9 cột + NULL→giá trị 3 cột vòng đời + nhánh `STOP_RECURRING` + `LINK_CONTRACT`;
  `assert_period_open_for_edit_v1` không còn `billing_month`/`item_row`; trigger profit_monthly đếm
  `approval_status = 'UNAPPROVED'`; không đụng hàm `profit_*`/`lock_profit_month_v1`/`unlock_profit_month_v1`.
- [x] Thử trên TEST (ROLLBACK, hai lượt): sửa tên phiếu 07/2026 toà đã chốt → `[PROFIT_LOCKED]`; chỉ đánh dấu đã kiểm →
  qua; lập phiếu lùi ngày, sửa hạng mục, xoá mềm, xoá hẳn, dời ngày vào tháng chốt → chặn; LINK_CONTRACT / tắt lặp /
  cột miễn → qua; `profit_close_v2` tháng 08 toà 102LVT (21 phiếu chờ duyệt) → 55000; toà hết phiếu chờ duyệt → chốt
  được; `profit_unlock_v2` lý do ngắn → 22023, đủ lý do → mở + ghi `profit_close_runs`, sau đó sửa phiếu được.
- [ ] Commit `feat(khoa-thang): khoa thang loi nhuan tuyet doi, chan chot khi con phieu cho duyet`.

### Task 3: M3 — sửa phiếu chờ duyệt (máy chủ)
**Produces:**
- `ALTER TABLE app_private.ie_flex_writer_xids` — CHECK scope thêm `'REVISE'`.
- `public.income_expense_revisions` (spec A1) + RLS (select `app_private.ie_supplement_can_read_v1(income_expense_id)`,
  `_hide_sandbox_admin` RESTRICTIVE; org_boundary do event trigger), trigger chặn UPDATE/TRUNCATE, `GRANT SELECT`.
- `app_private.ie_revision_snapshot_v1(uuid) → jsonb` (tên toà/phòng/khách/HĐ/sổ/hạng mục, hạng mục sắp xếp ổn định).
- `app_private.is_income_expense_flow_owned(uuid)` — thêm vế: false khi CHÍNH transaction đang có scope `REVISE`
  cho phiếu (dùng `pg_current_xact_id_if_assigned()`); guard đã ghim không đổi byte nào.
- `app_private.ie_revise_scope_delta_guard()` + trigger `a01_ie_revise_scope_delta` BEFORE UPDATE: trong scope REVISE
  chỉ cho đổi cột nội dung/suy ra (spec A2), OLD/NEW `UNAPPROVED`, OLD chưa `POSTED`.
- `public.revise_pending_income_expense_v1(p_voucher uuid, p_expected_approval_version bigint, p_patch jsonb,
  p_items jsonb DEFAULT NULL, p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL) → jsonb`
  `{id, changed, replayed?, revision_no, approval_version, changed_fields}`; mã lỗi: 42501 quyền/loại phiếu,
  55000 trạng thái, 40001 phiên bản, 22023 dữ liệu/lý do, P0002 không có phiếu. Patch nhận đúng các khoá
  `type, name, building_id, room_id, tenant_id, contract_id, payer_name, receive_bank_account, receive_bank_name,
  account_id, attachments, notes, voucher_date, business_result_accounting, repeat_cycle, repeat_count,
  repeat_infinity, repeat_auto_approve` (bỏ qua `repeat_remaining`, `repeat_next_date` — máy chủ tự tính; khoá lạ ⇒
  22023). Hạng mục: `income_expense_type_id, description, quantity, unit_price, start_date, end_date` (bỏ qua
  `accounting_class`, `id`, `amount`); kỳ hạng mục được để trống cả hai ngày.
- `public.approve_pending_income_expense_checked_v1(p_voucher uuid, p_expected_approval_version bigint) → jsonb`
  `{id, approved, already, mode: 'VOUCHER'|'FORFEIT_PAIR'}` (thêm khi thi hành: nút Duyệt không có CAS — spec A4).
- `public.approve_income_expense_v1(uuid)` — chỉ đổi câu báo thiếu sổ quỹ.
- [x] Test tĩnh (25 ca M1–M3): không định nghĩa lại guard/trigger đã ghim; preflight ghim md5 hai guard; scope CHECK
  8 giá trị; helper chỉ nhường `REVISE` cùng xid/pid/phiếu; delta đúng 27 cột; writer khoá org → phiếu → CAS 40001,
  mở/đóng REVISE, không ghi `birth_*`/hash/`approval_status`/`posting_status`; luật lý do; phiếu hệ thống khoá khung;
  bảng lịch sử RLS + bất biến; duyệt-có-phiên-bản rẽ cặp bỏ cọc trước khoá.
- [x] Thử trên TEST (ROLLBACK, hai lượt): phiếu niêm phong PC2609105 tăng đơn giá có lý do → OK (1.791.000 →
  1.792.000, v2, còn Chờ duyệt, hash sinh không đổi); thiếu lý do 22023; phiên bản cũ 40001; chỉ đổi tên → OK; gửi y
  nguyên → changed=false; gọi lại khoá cũ → replayed; phiếu đã duyệt 55000; hoa hồng đổi loại / đổi toà 42501, đổi
  tiền có lý do OK; trả khách đổi tiền + người nhận OK; đổi Thu/Chi không gửi hạng mục 22023; phiếu tay cũ đổi ngày +
  tên OK; UPDATE thẳng phiếu niêm phong vẫn frozen; cửa REVISE đổi `code` bị trigger delta chặn; sổ không giữ 42501;
  người ngoài tổ chức 42501; RLS: người lập đọc được, anon bị từ chối; duyệt phiên bản cũ 40001, đúng phiên bản →
  APPROVED + POSTED (cả phiếu niêm phong lẫn phiếu cũ), duyệt lại → already; cặp bỏ cọc đi cửa chuyên trách.
- [ ] Commit `feat(sua-phieu): sua phieu cho duyet co luu vet (may chu)`.

### Task 4: M4 — sổ nhận tiền + đổi hình thức thu (máy chủ)
**Produces:** bảng `app_private.personal_cash_books`, `app_private.building_receiving_cashbooks` (+ seed spec 1.9);
`app_private.receiving_cashbook_ids_v1(uuid org, uuid building, text method, uuid membership) → uuid[]`;
`app_private.receiving_cashbook_allowed_v1(uuid, uuid, text, uuid, uuid) → boolean`;
`app_private.move_posted_income_cashbook_v1(uuid voucher, uuid new_account) → void`;
`public.get_receiving_cashbooks_v1(p_organization_id uuid, p_building_id uuid DEFAULT NULL,
p_collector_user_id uuid DEFAULT NULL) → jsonb` `{collectorUserId, personalCashBook:{id,name}|null,
TK:[{id,name,isDefault}], TT:[…]}`;
`public.list_receiving_cashbook_settings_v1(p_organization_id uuid) → jsonb`;
`public.set_personal_cash_book_v1(p_membership_id uuid, p_account_id uuid) → jsonb`;
`public.set_building_receiving_cashbooks_v1(p_building_id uuid, p_method text, p_default_account_id uuid,
p_extra_account_ids uuid[]) → jsonb`;
`public.change_collection_tender_method_v1(p_tender_id uuid, p_new_method text, p_new_account_id uuid DEFAULT NULL,
p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL) → jsonb`.
Thêm khi thi hành: `app_private.member_of_org_v1(uuid org, uuid user) → uuid` (membership đang hoạt động, hoặc gần
nhất). `list_receiving_cashbook_settings_v1` trả `{members:[{membershipId,userId,name,memberType,personalCashBook}],
buildings:[{id,name,TK:{defaultAccountId,extraAccountIds},TT:{…}}], accounts:[{id,name,custodianMembershipIds}]}`.
Cổng "chủ công ty" = `ie_actor_is_company_owner_v1` (xem memory vai-chu-cong-ty). Đổi hình thức chặn cả làm tròn.
- [x] Test tĩnh (7 ca M4): seed chỉ ghi bảng mới (NOT EXISTS / ON CONFLICT), không UPDATE bảng cũ; danh sách sổ đúng
  thứ tự + giao possession; cổng chủ công ty neo vai; đổi hình thức khoá đúng thứ tự hoàn tác, chặn thối/làm tròn, sổ
  theo người đã thu, `begin_accounting_chain_write_v1`, lịch sử `COLLECTION_METHOD`; lõi đổi sổ hậu kiểm.
- [x] Thử trên TEST (ROLLBACK, hai lượt): khởi tạo 4 sổ riêng + 6 sổ phụ; NATHAN ở 403PVB → TM Hiệp Thu, TK [MBHIEP mặc
  định, TKHIEP]; JOEY ở 950NK → TK [TK939, CGIANG8818]; NATHAN xem của JOEY 42501; chủ xem màn cài đặt; NATHAN tự cài
  42501; chủ đặt sổ NATHAN chỉ "biết" 42501; chủ cài TT 102LVT → NATHAN thấy HKDTAM; đổi TK MBHIEP → TKHIEP → TM → TK
  mặc định (sổ cũ 0, sổ mới đủ); lý do ngắn 22023; JOEY đổi hộ 42501; chủ đổi sang sổ ngoài danh sách 42501; có tiền
  thối 55000; đã bàn giao HANDOVER_LOCKED; trùng hiện tại 22023; TT ở toà chưa cài 55000; 3 dòng lịch sử + 3 sự kiện;
  hoàn tác cả đợt sau khi đổi (bằng chủ) → REVERSED, tổng bút toán phiếu 0.
- [ ] Commit `feat(so-nhan-tien): so nhan tien theo hinh thuc thu, doi hinh thuc thu (may chu)`.

### Task 5: M5 — đóng đường cũ (áp SAU web)
**Produces:** `public.ie_compat_update_pending_v2` chỉ còn tên/ghi chú/ảnh (khoá tiền, `p_items` ⇒ 0A000);
`public.record_invoice_collection_v5` thêm kiểm `receiving_cashbook_allowed_v1` sau chốt possession (dựng từ bản
production bằng chèn đúng một chỗ, md5 ghim); DROP `public.update_invoice_payment_method_v1(uuid, payment_method)`,
`public.move_income_voucher_cashbook_v1(uuid, uuid, text)`, `public.unlock_profit_month_v1(text, uuid[])`,
`public.lock_profit_month_v1(text, jsonb)` (giao diện đã sang `profit_unlock_v2`; không hàm SQL nào gọi hai hàm này —
đo lại trước khi viết); REVOKE EXECUTE `record_invoice_payment_v4` khỏi authenticated (kiểm không hàm nào gọi).
- [ ] Test tĩnh + thử trên TEST (ROLLBACK): compat gửi `account_id` → 0A000; gửi `attachments` → OK; thu tiền TK vào
  sổ ngoài danh sách → 42501 câu tiếng Việt.
- [ ] Commit `feat(sua-phieu): dong duong sua cu va bat luat so nhan tien khi thu`.

### Task 6: TEST env + types
- [ ] `npm run test-env:thu-sql -- <M1..M5 không BEGIN/COMMIT> --ghi` theo thứ tự (TEST là bản sao, ghi được).
- [ ] Sinh types từ TEST (CLI `supabase gen types typescript --project-id <TEST ref>`, rồi `npm run types:normalize`),
  kiểm diff chỉ gồm bảng/hàm mới + bỏ 2 hàm; commit `chore(types): types cho dot 1 (sinh tu TEST)`.
  Sau khi apply production sẽ sinh lại từ production và so khớp.

## Phase 2 — Giao diện (subagent theo nhóm file rời nhau; người chính review từng nhóm)

### Task 7: thư viện sửa phiếu
**Files:** `src/lib/incomeExpenseRevision.ts`, `src/lib/__tests__/incomeExpenseRevision.test.ts`.
**Produces:** `REVISABLE_SYSTEM_SOURCES`, `canReviseVoucher(v)`, `requiresRevisionReason(before, after)`,
`describeRevisionChanges(beforeSnapshot, afterSnapshot): RevisionLine[]`, `summarizeRevisions(rows)`,
kiểu `RevisionSnapshot`, `RevisionRow`, `RevisionLine {field,label,before,after}`.
- [ ] Test trước: đổi đơn giá ⇒ cần lý do; chỉ đổi tên ⇒ không; nhãn tiếng Việt + định dạng tiền `1.867.000 đ`;
  phiếu `contract.commission` chờ duyệt ⇒ sửa được; `invoice_id` có ⇒ không; đã duyệt ⇒ không.

### Task 8: hook + danh sách + chi tiết (A2, A4 badge, E3, E4, E5)
**Files:** `src/hooks/income-expenses/revisions.ts`, `mutations.ts` (bỏ nhánh sửa cũ + toast canonical),
`queries.ts` (nhúng `income_expense_revisions(revision_no)`), `IncomeExpenseList.tsx`, `IncomeExpenseDetailDialog.tsx`,
`IncomeExpenseDetailMobile.tsx`, `IncomeExpenseBatchDetailDialog/Mobile`, `VoucherHistoryDialog.tsx` (nhãn `REVISED`).
- [ ] Bút chì chỉ hiện khi `canReviseVoucher` (giữ chế độ KQKD phiếu bỏ cọc cho chủ/quản trị); badge "Đã sửa N lần";
  chú thích Mở lại bỏ "sửa được".

### Task 9: form sửa + AttachmentUpload (A3, E1)
**Files:** `IncomeExpenseForm.tsx`, `AttachmentUpload.tsx`, trang Thu chi desktop/mobile (chỗ gọi form).
- [ ] Ô "Lý do sửa" hiện khi `requiresRevisionReason`; lưu gọi `revise_pending_income_expense_v1` kèm
  `approval_version` đang xem; lỗi 40001 ⇒ tải lại. X chỉ xoá file tải lên trong lần mở form này.

### Task 10: hộp Duyệt + so sánh (A4, A5)
**Files:** `RevisionSummary.tsx`, `IncomeExpensePage.tsx`, `IncomeExpenseMobilePage.tsx`, `IncomeExpensePostingDialog.tsx`
(chế độ APPROVE_AND_POST), `ApprovalsPage.tsx`.
- [ ] Bảng so sánh + từng lần sửa; cảnh báo lệch hoa hồng/trả khách; lỗi `approval_version mismatch` ⇒ "Phiếu vừa được
  người khác sửa — tải lại" + refetch.
- [ ] `useApproveVoucher` (và mọi nút Duyệt / duyệt hàng loạt) gọi `approve_pending_income_expense_checked_v1(id,
  approval_version đang hiển thị)` thay cho thang ba bậc phía client; dịch 40001 ⇒ "tải lại". Rà các chỗ duyệt khác
  (`approve_and_post_income_expense_v2` đã CAS — chỉ cần dịch lỗi).
- [ ] "Sửa nhanh" (`update_income_expense_quick`, đổi sổ/ảnh/ghi chú) trên phiếu Chờ duyệt: chuyển sang
  `revise_pending_income_expense_v1` để có lịch sử; phiếu đã duyệt giữ đường cũ (ảnh chỉ nối thêm).

### Task 11: caller khác của compat (A3)
**Files:** `hooks/income-expenses/batch.ts` + UI đổi sổ cả đợt (thêm ô lý do), `hooks/useSettlementActions.ts`.

### Task 12: hộp Thu/Chi gom ảnh (E2)
**Files:** `IncomeExpensePostingDialog.tsx`, `financeV2Mutations.ts`.
- [ ] Dán/thêm ảnh: tải lên kho, chỉ hiện xem trước; gỡ ảnh cũ: đánh dấu; xác nhận ⇒ annotate thêm/gỡ + adopt rồi mới
  post; Huỷ bỏ ⇒ xoá file vừa tải, không annotate.

### Task 13: sổ nhận tiền trong luồng thu + bàn giao (B1)
**Files:** `src/hooks/useReceivingCashbooks.ts`, `useQuickCollect.ts`, `CollectDrawer.tsx`, `CollectPayForm.tsx`,
`RecordPaymentDialog.tsx`, `BulkRecordPaymentDialog.tsx`, `useBulkRecordPayment.ts`, `useCashHandovers.ts`,
`HandoverSheet.tsx`, `src/lib/cashAccount.ts` (+test).
- [ ] Ô sổ chỉ liệt kê danh sách cho phép (mặc định chọn sẵn; 1 sổ thì khoá); chưa cài ⇒ chặn nút thu + câu hướng dẫn;
  xoá `ownCashAccountId/resolveTmAccountId/resolveAccountIdForMethod`.

### Task 14: thu trùng + lý do hoàn tác (B4)
**Files:** các hộp thu ở Task 13, `useDeletePayment.ts`, `PaymentsSummaryDialog.tsx`, chỗ hoàn tác ở trang Thu tiền.

### Task 15: đổi hình thức thu (B3, B5) + xoá đường chết
**Files:** `ChangeCollectionMethodDialog.tsx`, `PaymentsSummaryDialog.tsx`, danh sách/chi tiết Thu chi; xoá
`useUpdatePaymentMethod.ts`, `incomeVoucherCashbook.ts` (+ mock trong test).

### Task 16: màn "Sổ nhận tiền" (B1) + bỏ 2 ô trong form toà
**Files:** `ReceivingCashbookSettings.tsx`, trang Sổ quỹ (thêm mục), `BuildingFormDialog.tsx`.

### Task 17: mở khoá tháng có lý do (D5)
**Files:** `useShareholderProfit.ts`, `ProfitLockTab.tsx`, `src/lib/cashbookClosing.ts` (+test).
- `useUnlockProfitMonth` gọi `profit_unlock_v2(p_organization_id, p_period_month 'YYYY-MM-01', p_reason, p_idempotency_key,
  p_building_ids, p_expected_source_hash null)`; hộp mở khoá bắt lý do 8..1000 ký tự; sửa comment "NỢ" cũ.
- Câu `PERIOD_BLOCK_DETAIL.PROFIT_LOCKED` + các câu PROFIT_LOCKED ở `incomeVoucherCancel.ts`, `useDeletePayment.ts`:
  "…mọi phiếu của tháng bị khoá, nhờ chủ công ty mở khoá tháng" (bỏ "lập phiếu điều chỉnh ở tháng hiện tại" cho khoá
  lợi nhuận); `ANNOTATE_STILL_ALLOWED_NOTE` không hiện cho phiếu tháng đã chốt lợi nhuận (chỉ còn đúng với sổ quỹ đã chốt).

## Phase 3 — Kiểm chứng

### Task 18: gate
- [ ] `npx tsc --noEmit -p tsconfig.app.json`, `npm run typecheck:baseline`, vitest liên quan, `npm run build`.
- [ ] `npm run surface:rpc`, `npm run org-inventory:build`, `git add` migration → `npm run provenance:generate`,
  `npm run gate:truoc-push -- --khong-dao-strict`, 15 gate security chạy tay, `gate:definer-body-authz`,
  `gate:money-table-dml`, `gate:ie-guard-gates` (ghi rõ nếu đỏ sẵn ở main).

### Task 19: E2E trên TEST
- [ ] `git push origin HEAD:test-env`; spec mới `.e2e-fleet/specs/sua-phieu-dot-1.spec.ts` (vai thật TEST): quản lý
  toà sửa phiếu chờ duyệt → chủ thấy "Đã sửa 1 lần" + bảng so sánh → duyệt; đổi hình thức thu CK MBHIEP→TKHIEP;
  chốt tháng bị chặn; mở khoá bắt lý do. `FLEET_WORKERS=1`, console không lỗi.

### Task 20: review độc lập + draft PR
- [ ] Subagent review (code-reviewer) toàn diff; sửa; draft PR ghi số đo + gate đã chạy + phần chưa kiểm.

## Phase 4 — Phát hành (hỏi chủ trước bước đầu)

### Task 21: M1–M4 lên production
- [ ] Hỏi chủ một câu kèm số đo (TEST xanh, gate). `npm run migrate:forward -- <M1>` (dry-run) rồi `--apply`; lần
  lượt M2, M3, M4. Commit evidence + provenance. Sinh lại types từ production, so khớp bản TEST.

### Task 22: web lên + M5
- [ ] Merge main (rebase, gate), CI xanh, `npm run promote:production -- --sha <40 ký tự> --apply`, kiểm Vercel READY.
- [ ] `migrate:forward` M5 `--apply`; kiểm bằng nick thật (chỉ đọc): sửa được phiếu chờ duyệt, thu tiền đúng sổ.
- [ ] Cập nhật trang hướng dẫn "Sửa phiếu thu chi" + trí nhớ.
