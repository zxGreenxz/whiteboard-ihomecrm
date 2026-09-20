# T0 — Capability preflight Hợp đồng & quyết toán

Ngày đọc: 21/09/2026; nguồn ở `e663afdb92d63a79a4ef6db76e7d9b4c7f2492f0`, checkout trên base `beca6ee8` (không dùng kết luận c22 làm bằng chứng mới). Worktree `C:/Users/Nguyen Tam/codex-worktrees/hop-dong-quyet-toan`, nhánh `codex/hop-dong-quyet-toan`. Project đã đọc: `tryymsxyyckgbrmmvozx`.

## Kết luận và giới hạn

**Frontend read-only hiện có chưa đủ; cần capability backend dùng chung trước cutover writer.** Chưa chạy writer, chưa tạo fixture, chưa apply schema hoặc ghi nghiệp vụ THẬT. T0 hoàn thành phần quyết định/catalog/harness an toàn; **chưa đạt điều kiện writer proof**. T1 có thể tiến hành typed contract; T6/T11 phải chặn release cho đến khi có fixture lifecycle và role/PostgREST evidence thật.

Bằng chứng lâu dài: `docs/engineering/contract-settlement-capability-evidence.json` chứa signature chính xác, SHA-256 của `pg_get_functiondef`, ACL, volatility, search_path, mã lỗi và trigger definition/hash. Bản đầy đủ chỉ ở workspace `task-0-live-catalog.json`; không có credential. Tất cả truy vấn live dùng Management API SELECT; quyền này không chứng minh RLS của user. Credential chỉ được nạp trong process từ vault checkout chính, không sao chép.

## Route, quyền và ownership

- THẬT `aaaa...0001` và DEMO `dddd...0001`: workflow/posting đều `CANONICAL`. Truy vấn organizations không trả org TEST `cccc...0001`; **chưa xác minh route TEST**, không mặc định.
- `/thanh-toan`: `thu_tien.collect`; `/income-expense`: module `income_expenses` (`src/app/routes/financeWorkRoutes.tsx:39,44`). Giữ gate Thanh toán. Nếu reviewer không có collect, thêm điểm vào có scope income_expenses riêng hoặc entry từ Thu chi; không suy collect thành approve/custodian.
- Action dialog phải đọc lại route + snapshot/version khi mở và ngay trước submit; route đổi/FROZEN/không đọc được thì từ chối và yêu cầu tải lại. Không fallback approve-only mới sang approve_voucher legacy vì legacy có thể ghi quỹ.
- `is_income_expense_flow_owned(uuid)` = tồn tại ownership row, quyết định freeze. `assert_income_expense_flow_owner_v2(uuid,text)` cho phép no-row manual và chỉ cho matching owner nếu có row. Không suy ownership từ system_source/commission_kind.
- Aggregate live THẬT, phiếu chưa xoá: broker 150 (147 maker NULL), sale 28 (22 NULL), termination.refund 87 (87 NULL), reservation.refund 1 (1 NULL). Tất cả các nhóm đó không có ownership row. DEMO có 3 termination.refund, cả 3 maker NULL/no ownership. Đây là snapshot dữ liệu, không hardcode trong app.

## Ma trận action hiện có

Signature/ACL/error codes chính xác trong JSON. Public writers được kiểm trong artifact đều VOLATILE, SECURITY DEFINER, authenticated có EXECUTE, không có PUBLIC/anon EXECUTE. Search_path khác nhau theo hàm, giữ nguyên khi tạo migration có chủ đích. Không kết luận role test đạt từ ACL catalog.

| Action | Input/output hiện có | Guard/cách lấy eligibility | Quyết định |
|---|---|---|---|
| Duyệt chờ chi | approve_income_expense_v2(voucher, expectedApprovalVersion, idempotencyKey) → json | actor theo org, approve scope, owner, state/CAS; owned dispatcher khi đúng flow | Dùng máy Thu chi; loại fallback version=1 hiện có trong hook |
| Duyệt & Chi | approve_and_post_income_expense_v2(input jsonb) → json | approve + CUSTODIAN, evidence, posting policy, version và lock | Giữ atomic RPC, không approve trước modal |
| Ghi nhận chi | post_approved_income_expense_v2(input jsonb) → json | APPROVED, sổ/custodian, versions, kỳ và evidence | Không suy approve permission là được chi |
| Hoàn tác | reverse_posted_income_expense_v2(voucher,cashbook,postedOn,reason,key) → json | active posting, custody, kỳ | Bút toán đảo, không sửa tiền header |
| Bỏ duyệt | unapprove_voucher(voucher_id) → void | guard/backend legacy | Không đánh đồng với reverse; chưa có shared snapshot eligibility hoàn chỉnh |
| Huỷ thu | can_cancel_income_voucher_v1(uuid[]) / cancel_income_voucher_v1(voucher,reason) | reader trả khả năng/guard domain | Giữ domain command; không generic cancel |
| Huỷ flex | can_flex_cancel_v1(uuid[]) / cancel_income_expense_flex_v1(voucher,reason,expectedApprovalVersion,expectedPostingVersion) → json | scope, posting/cashbook/close, CAS | dùng eligibility thật; fallback chỉ tín hiệu semantic cho phép trong flexMutations/statusMutations |
| Huỷ canonical unposted | cancel_unposted_income_expense_v2 / decide_owned_income_expense_v2 | owner/approve/state/birth boundary | dispatcher public chỉ expose approve/cancel và flow INVOICE_REFUND/TERMINATION_REFUND |
| Bổ sung | append_income_expense_supplement_v1(voucher,note,attachments,key) → entry/replayed | permission + linked uploaded objects; additive | Không chuyển review, không tạo phiếu; giữ đường Thu chi |
| Sửa ghi chú/chứng từ | annotate_income_expense_v1 | ANNOTATE allowlist chỉ notes/attachments/updated_at | Không dùng sửa người nhận/ngân hàng |
| Sửa thông tin người nhận | sparse/header patch hiện tại | RLS/quyền + freeze + khóa kỳ; flow-owned không cho bank/name delta | Chưa role-write xác minh tập sửa được; cần shared command riêng nếu yêu cầu sửa phiếu frozen, giữ allowlist/token riêng |
| Cần bổ sung để rà soát | request_income_expense_changes_v2(voucher,expectedReviewVersion,reason,fieldMask,key) → CHANGES_REQUESTED | approve scope, PENDING/DISPUTED + UNAPPROVED, owner/CAS | Có RPC, chưa hook chung; cần kiểm và sửa token/freeze như dưới |
| Chuyển chờ duyệt | resubmit_income_expense_v2(voucher,expectedReviewVersion,patch,key) → PENDING | **maker_user_id phải bằng actor**, CHANGES_REQUESTED/UNAPPROVED, không open request, owner/CAS | Giữ cùng ID/code/amount/source. p_patch chỉ vào idempotency hash, không apply dữ liệu. Gửi {} và không hứa nó sửa tiền |

**Review backend gaps cần xử lý chung:**

1. Existing resubmit từ chối mọi maker NULL. Đề nghị giữ original-maker restriction khi maker tồn tại; với legacy maker NULL, xác thực actor ACTIVE trong org, `income_expenses.edit` trong scope tòa và guard/source permission của owning adapter. Đây là đề nghị policy cần review, chưa triển khai; không gán maker giả, không dùng user_id của owner làm maker, không nới toàn bộ writer. Kết quả trả authorization reason/capability cho UI.
2. Request changes/resubmit gọi assert owner manual; dispatcher owned chỉ approve/cancel. Bổ sung quyết định review vào máy/backend chung cho nguồn được hỗ trợ; source-owned khác phải fail closed.
3. Live freeze `a00_ie_owned_payload_freeze` thiếu `change_field_mask` trong lifecycle allowlist; request changes viết field này, resubmit clear. Đối với flow-owned, cần kiểm thêm per-transaction token của 2 RPC; hiện body 2 RPC không trực tiếp tạo token. Đây là blocker phân tích catalog, **chưa reproduction role-write**. Sửa với scoped review token cho đúng review_state/reason/mask/version/updated_at, không mở guard tiền/ngân hàng.
4. CAS hiện nhiều chỗ dùng SQL `<>`, NULL input có thể bỏ kiểm. Shared contract bắt version có thật; migration review phải reject NULL expected version và giữ idempotency payload-bound. Ca stale race cần test thực.

## Ma trận nguồn tạo phiếu

| Nguồn | Capability hiện tại | Kết luận |
|---|---|---|
| Hoa hồng môi giới | create_commission_voucher(contract,kind,amount,date,account,payer,recipient,bank,accountNumber,description,attachments) → `{id,code}` | Advisory lock + duplicate guard + claim Sale. **Còn inline autopay** khi broker check VALID và account không virtual. Không dùng create với real account làm create-only |
| Hoa hồng NULL account | cùng RPC | Mã inline không gọi autopay nếu account null. **Chưa chứng minh toàn bộ trigger qua PostgREST**; không coi đã an toàn. Đo null-account trên nguồn đủ autopay + positive control real-account trước quyết định sửa writer |
| Thưởng theo hợp đồng | create_commission_voucher(kind=sale) | Không có inline broker autopay; khóa/claim ngăn trùng qua nguồn cọc. Chưa writer đo |
| Thưởng từ cọc | create_sale_bonus_from_deposit_v1(...) → `{voucherId,code,amount,depositVoucherId,note}` | Claim riêng app_private, guard trùng/amount cap/scope, có bank fields; không đọc claim private từ browser. Chưa writer đo |
| Hoàn thanh lý | preview_termination_refund_v1 → basis/fingerprint; record_termination_refund_obligation_v1 → version; create_termination_refund_voucher_v1(obligation,account,force,reason) → `{voucherId,code,...}` | Duyệt hồ sơ trước, khóa obligation + termination, reuse phiếu sống xuyên version; force owner+reason >=8; không có params người nhận/bank. Cần capability lưu người nhận dùng chung, không generic create né guard |
| Hoàn giữ chỗ | settle_reservation_deposit_v1 / pay_reservation_refund_v1 | LATER là nghĩa vụ, không phải pending voucher. NOW/pay đi reservation_pay_refund_v1 tạo/duyệt/post. **Thiếu pending creation chung**; không dùng làm Chuyển chờ duyệt |

**Hợp đồng backend pending reservation đề nghị:** `create_reservation_refund_pending_v1(input)` với settlementId, expectedVersion/basisFingerprint có thật, recipient/bank fields, idempotencyKey; amount lấy từ nghĩa vụ backend, không nhận số do UI tự tính. Lock room → source voucher → settlement giống domain hiện hữu; authorize scope + quyền nghiệp vụ đang dùng; kiểm chưa hoàn hết, không có pending/active refund cạnh tranh, không thay nguồn/tiền. Một pending voucher duy nhất cho settlement, trả existing ID khi replay đúng payload; payload khác cùng key lỗi. Không account/posting/evidence posting ở bước tạo; giữ obligation source link bất biến và update reservation reader. Tạo xong trả voucher snapshot (ID/code/source/amount/maker/reviewVersion/approvalVersion/postingVersion, PENDING/UNAPPROVED/UNPOSTED); approve/post sau commit đi shared Thu chi với source adapter. Test idempotency + concurrent create + approve/post + reversal/refund debt + cross-tenant denial. Không đổi ngữ nghĩa NOW/pay caller cũ âm thầm.

## Reader contract để T1 triển khai

Các reader v2 list/detail hiện có đọc RLS-visible voucher; `list_income_expenses_v2` chỉ type/approval/posting/account/date + limit<=200/offset, không đủ settlement source filters; `get_income_expense_stats_v2` thậm chí không áp approvalStatus/postingStatus và sum header theo voucher_date, **không dùng làm actual net-posted totals**. Query public paginated có thể dùng cho voucher/detail đơn lẻ, nhưng union nguồn chưa tạo + private Sale claim + global totals + source ownership cần reader auth chung.

Đề nghị output typed (tên RPC do T1/backend quyết định):

```ts
type SettlementPage = {
  asOf: string; scopeFingerprint: string; nextCursor: string | null;
  rows: SettlementRow[];
  totals: { sourceCount: number; sourceAmount: string | null; unknownBasisCount: number;
    pendingAmount: string; approvedUnpostedAmount: string; effectiveNetPaid: string;
    displayedVoucherAmount: string; countsByState: Record<string, number> };
};
type SettlementRow = {
  rowKey: string; organizationId: string; buildingId: string; roomId: string | null;
  kind: 'broker'|'sale'|'termination_refund'|'reservation_refund';
  source: { kind: 'contract'|'deposit'|'termination'|'reservation'; id: string;
    contractId: string | null; depositVoucherId: string | null; obligationId: string | null;
    settlementId: string | null; eventDate: string | null };
  voucher: null | { id: string; code: string; amount: string; approvalStatus: string;
    reviewState: string; postingMode: string; postingStatus: string;
    reviewVersion: number; approvalVersion: number; postingVersion: number;
    makerUserId: string | null; flowOwner: string | null; activePostingId: string | null;
    postedOn: string | null; effectiveNetPaid: string };
  basis: { status: string; expectedAmount: string | null; actualDeposit: string | null;
    fingerprint: string | null; missingFacts: string[] };
  recipient: { name: string | null; bankName: string | null; bankAccount: string | null };
  eligibility: { create: boolean; reasonCodes: string[] };
};
```

`null`/missing facts không thành 0 hoặc version 1. Full-filter aggregate và rows chung org/building/RLS + scope fingerprint; cursor ổn định với ID tiebreaker. Mọi kỳ/tồn cũ không buộc fromDate. Dates tách source event/voucher/posting day. Các tổng money dùng decimal string hoặc numeric-safe boundary, không float arithmetic client.

Action snapshot riêng đọc mới trước dialog/submit: voucherId, all 3 versions, route workflow/posting/access, owner, actor membership, capabilities cho approve/post/reverse/cancel/review/resubmit/edit/supplement + reasonCodes. UI không đọc app_private; quyền read không suy quyền action. Eligibility server không thay quyền writer tự kiểm lại.

Lifecycle/events reader cần contract lanes previous → source → current theo room, event kind SIGN/RENEW/TERMINATE/FORFEIT/RESERVATION, immutable source ID/date/status, linked voucher IDs, actual posted deposit/rent/fees, debt basis + unknown reasons. Reservation public list+summary đã có cursor/scope, có thể reuse; **chưa chứng minh public queries hiện hữu bao phủ đủ 5 event loại và aggregate full-filter**, cần reader auth minimal hoặc chứng minh pagination public đủ trước viết RPC.

Cashbook: `list_cashbooks_for_expense_v2()` chỉ id/name từ CUSTODIAN ACTIVE + account nondeleted, không org_id/is_virtual; `list_my_cashbook_access_v2()` thiếu filter deleted và org metadata; `list_cashbook_visibility_v2()` có visibility nhưng không custody metadata. Không filter bằng owner/shared rồi làm mất custodian-only. Cần authenticated org/account metadata join hoặc mở reader shared trả organizationId/isVirtual/deleted/custody/scope. Kiểm actor nhiều org, custodian không owner/shared, virtual/deleted, loading/error bằng role thật còn thiếu.

Ba phiếu hoàn NON_CASH trong spec chỉ là ca rà soát lịch sử. Không chuyển tiền, không hardcode số mẫu thành logic.

## Harness, fixture và kiểm chứng

- `scripts/test-contract-settlement-money.mjs`: default dry-run không network; `--fixture` in digest code+plan; chỉ execute nếu digest review khớp. Fixed project, DEMO-only, verified auth user role authenticated, source label + room/building org linkage + account nonvirtual/nondeleted. Không service role, không schema, không retry writer.
- Kinds broker/sale_contract/sale_deposit/refund, expectation CREATE_ONLY hoặc broker LEGACY_AUTOPAY control. Đọc voucher và ledger PostgREST, pagination không mất cap-1000; assert trạng thái/tiền/postings. In ID ngay khi RPC trả để recover fixture; không tự xóa ledger.
- **Chưa có factory setup/cleanup và chưa chạy writer.** CleanupOwner/label/digest là chốt chạy, không thay bằng chứng fixture lifecycle. Không gọi đây là integration test đạt. Harness chưa kiểm recipient persistence, ACL negative, retries/concurrency, full account balance, review state cycle; T6/T11 mở rộng.
- Chuẩn bị cụ thể: dùng isolated database theo MIGRATION_STRATEGY và fixture pattern `scripts/test-reservation-deposit-settlement.mjs` để phát triển factory trước; cấm mang `session_replication_role=replica` trong test local sang production. Live DEMO cần factory/recovery journal được review, tạo tòa/phòng/hợp đồng riêng có label. Hai hợp đồng broker ACTIVE, start <= org_today-7, đã thực thu đủ deposit bằng real posted source, tier hiệu lực phù hợp và amount = round(rent*rate/100); SELECT commission_autopay_check_v1 phải VALID. Một case account NULL expected CREATE_ONLY, một case nonvirtual CUSTODIAN expected LEGACY_AUTOPAY. Hai nguồn Sale riêng chưa claim (contract và orphan deposit); hồ sơ termination APPROVED/COMPLETED + obligation OK/chưa voucher, số hoàn >0. Không force trên live fixture mặc định. Chạy từng case độc lập; recovery IDs phải được reverse/cancel domain đúng thứ tự, kiểm net delta và dọn fixture sau. Nếu reader không thấy postings do RLS thì không được ghi pass chỉ từ array rỗng: trước chạy phải chứng minh role đọc ledger đúng sổ bằng positive control.
- TDD đã quan sát RED 4 assertions khi guard/outcome/pagination chưa implement; GREEN 5/5 sau thêm autopay-control (RED riêng). `node --test scripts/test-contract-settlement-money.test.mjs`: 5 passed, 0 skipped.
- `node scripts/test-contract-settlement-money.mjs`: DRY RUN đúng, không credential/network.
- Mutation `scripts/dot-bien.mjs`: bỏ DEMO assert, SHA `2364f11d1576` → `2a3e0e3712f1`; suite đỏ Missing expected exception; helper khôi phục digest đúng, exit 0.
- `node scripts/check-test-matrix.mjs`: 729 tests / 11 suites, không mồ côi. Offline suite đăng ký CI quality-gates; không chạy live harness trên CI.
- Chưa chạy role/PostgREST writers, reconcile v1/v2, concurrency hoặc browser E2E; không thay UI nên không cần E2E cho commit harness này. Gate trước push/review độc lập do controller tiếp tục.
