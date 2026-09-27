# Thanh lý: bằng chứng tiền và thiết kế giao dịch để audit

Mốc source: `e498f10d49f3548e72074095c955371d0cee41ab`, ngày 27/09/2026. **OBSERVED** nghĩa là đã đọc source tại mốc này; không chứng minh database đang chạy. **PROPOSED** là thiết kế, chưa triển khai. **UNVERIFIED** gồm catalog/ACL/cờ sống, dữ liệu, concurrency và E2E; lần rà này không đọc vault, gọi production hay chạy SQL.

## 1. Bằng chứng và các chặn bắt buộc

Các đường dẫn dưới đây tính từ gốc repo; số dòng là điểm neo, cần đọc cả symbol.

| OBSERVED | Căn cứ source | Hệ quả thiết kế |
|---|---|---|
| UI gọi hai writer credit, tạo request key trong `mutationFn` | `src/hooks/useContractOperations.ts:194,256`; `src/lib/customerCreditRpc.ts:45` | Retry qua lần submit mới có thể tạo key mới; client phải giữ key cho cùng ý định. |
| Move-out khóa contract; từ chối `TERMINATED/EXPIRED`; cọc bị kẹp bằng `deposit_paid` | `supabase/migrations/20260915074638_coc_thanh_ly_va_cap_hoan_coc.sql:477,525,551` | Không thể gọi lại writer này sau bàn giao. Cọc thỏa thuận không phải tiền đang giữ. |
| Writer sinh hóa đơn SETTLEMENT, payments CT, cặp offset/revenue, phiếu hoàn UNAPPROVED và có thể thu thêm APPROVED | Cùng file: `597,627,701,729` | `PAID/DEBT` chỉ xử lý thiếu tiền; không phải IMMEDIATE/DEFERRED. |
| Writer ghi TERM + ngày thực kết thúc, audit COMPLETED; lỗi audit nay rollback | Cùng file: `746,755,767` | COMPLETED lịch sử không chứng minh đã trả tiền. Không reuse nó làm trạng thái chờ mới. |
| Credit wrapper khóa contract rồi operation; hash payload; replay response; burn FIFO trong cùng transaction | `supabase/migrations/20260822093000_termination_customer_refund_items.sql:590,621,644,671,693`; `supabase/baseline/schema.sql:1555,1710` | Phải giữ chống chi credit hai lần, kiểm lots/ledger và legacy credit chưa reconcile. |
| Credit route tắt: move-out có credit bị chặn; forfeit có thể trả `deferred:true` cho credit | File 22/08: `671`; `supabase/migrations/20260722160000_forfeit_defer_credit_when_writer_off.sql:108` | “deferred” này không phải hoãn toàn bộ quyết toán theo yêu cầu mới. |
| Forfeit hủy nợ hóa đơn chưa xong, giữ phần đã thu, sinh cặp nội bộ; bản định nghĩa còn nuốt lỗi audit | `supabase/migrations/20260731070000_current_date_to_org_today.sql:3839,3920,4069,4104`; baseline `92113` | DEFERRED tuyệt đối không chạy nhánh này. Khi chốt FORFEIT, snapshot phải liệt kê từng khoản hủy, không blanket UPDATE. Audit mới bắt buộc atomic. |
| Trigger ra khỏi ACTIVE/EXTENDED nhả phòng nếu không còn hợp đồng active khác | `supabase/baseline/schema.sql:95677` — `update_room_status_on_contract_change` | Cần sửa luồng cư trú/khả dụng có khóa; chưa có bằng chứng unlink khách trong writer đã rà. |
| Restore 21/09 trả lại 14 hàm, gỡ reader/capability settlement mới và role chuyên dụng | `supabase/migrations/20260921085952_restore_before_contract_settlement.sql:1,13,1721,1761` | Không thiết kế dựa trên RPC đã bị DROP chỉ vì migration/types còn nhắc tới. |
| Ngày 23/09 thu EXECUTE record nghĩa vụ hoàn và cặp Copilot hoàn cọc; create refund vẫn ghim ACL/md5 | `supabase/migrations/20260923161122_bo_duong_hoan_khach_thu_hai.sql:20,88` | Không mở lại đường hoàn thứ hai, không dùng nghĩa vụ cũ làm case mới. |

Baseline được chụp 06/08 (`supabase/baseline/manifest.json:3`), phải ghép forward lane; không gọi baseline là catalog hiện tại. `scripts/authz-prepared/` cũng không tự chứng minh đã deploy. Đặc biệt phải xác nhận thân forfeit sống, trigger hợp đồng, ACL tất cả overload và retirement witness trước implementation.

## 2. Bộ máy chi 26–27/09

**OBSERVED:** `20260926082454_bang_cam_ket_chi.sql:82` tạo cam kết theo toà/hạng mục/tháng. `20260926150000_bo_may_chi_so_tieu_va_quyet_dinh_bong.sql:269` khóa bucket đã sort; `:296` allowlist B0 có offset/revenue thanh lý, **không có `termination.refund`**. `:814` đồng bộ sổ tiêu, `:847` phân biệt DRAW/HOLD. `20260926160000_noi_writer_vao_bo_may_chi.sql:6` nối năm writer; v2/compat vốn sinh chờ, được trigger phủ. Migration `20260926172614_bat_bo_may_chi_ap_dung_sua_cong_an.sql` bật cờ và công tắc trong source; trạng thái sống chưa kiểm.

**PROPOSED:** Chốt không tự duyệt hoàn khách, không giả danh B0 cho phiếu chi thật. Dùng adapter canonical/provenance hiện có, đúng nguồn, accounting class, kỳ và owner. Phiếu hoàn chờ giữ nghĩa vụ; thu/chi thực tế đi writer hiện hành cùng quyền sổ, khóa sổ/kỳ, guard lifecycle, spend ledger. Hóa đơn hay phiếu thiếu mapping làm preview báo chặn; không tự gán để qua gate. Đối chiếu cả ledger tiền lẫn spend HOLD/DRAW/error-log; trigger nuốt lỗi không được coi là bằng chứng sạch.

G3 thêm `spend_mode/fee_category`; bản vá `20260926140000_va_guard_cot_luat_chi_canh_ghi_truc_tiep.sql:84` đổi guard sang INVOKER, kiểm `current_user` để helper DEFINER thanh lý tạo type được. Phải thử org chưa có type bằng quản lý thật, đồng thời chứng minh client không sửa cột luật. RPC trạng thái `20260926170000_bo_may_chi_trang_thai_va_canh_bao_so.sql:22` đọc cả lỗi bộ máy; dùng nó trong nghiệm thu.

## 3. Ranh giới dữ liệu và RPC đề xuất

**Tên chuẩn:** §3–4 của [master plan](../../superpowers/plans/2026-09-27-contract-lifecycle.md) là hợp đồng schema/API duy nhất giữa các task. Các tên nghiên cứu trước đây được ánh xạ như sau, không triển khai alias song song:

| Tên nghiên cứu cũ | Tên chuẩn master |
|---|---|
| `original_type/current_type`, `handover_date`, `room_at_handover` | `initial_kind/current_kind`, `actual_move_out_on`, `room_id` |
| `mode/state`, `SETTLED`, `settled_actor/settled_at` | `settlement_mode/settlement_state`, `FINALIZED`, `finalized_actor/finalized_at` |
| `contract_exit_events` | `contract_lifecycle_events` |
| `preview_contract_exit_v1`, `confirm_contract_exit_v1` | `preview_contract_exit_settlement_v1`, `confirm_contract_moveout_v1` |
| `finalize_contract_exit_v1`, `read_contract_exit_cases_v1` | `finalize_contract_exit_settlement_v1`, `get_contract_exit_cases_v1` |

Business cố định: bắt buộc ngày bàn giao và loại `NATURAL_EXPIRY/EARLY_RETURN/FORFEIT`, sau đó chọn `IMMEDIATE/DEFERRED`. Chốt số tiền khác thực thu/chi. DEFERRED kết thúc cư trú, nhả quyền chiếm phòng, giữ nguyên mọi phiếu/số dư/nợ/credit; có case chờ. IMMEDIATE làm bàn giao và chốt trong **một transaction, một xác nhận**.

**PROPOSED schema tối thiểu:** thêm case riêng, tránh kích hoạt trigger tiền/cột generated của `contract_terminations` khi chỉ bàn giao. Tái dùng canonical operations cho idempotency; không tạo ledger tiền song song.

```sql
-- Pseudocode, không phải migration thực thi
contract_exit_cases (
 id uuid primary key, organization_id uuid not null, building_id uuid not null,
 contract_id uuid not null unique, room_id uuid not null,
 actual_move_out_on date not null,
 initial_kind text not null, current_kind text not null,
 settlement_mode text not null, settlement_state text not null, version bigint not null,
 created_by uuid not null, created_at timestamptz not null,
 finalized_actor uuid, finalized_at timestamptz, accounting_on date,
 final_snapshot jsonb, financial_source_ids jsonb, legacy_termination_id uuid unique
);
contract_lifecycle_events (
 id uuid primary key, organization_id uuid not null, building_id uuid not null,
 contract_id uuid, draft_id uuid, reservation_id uuid,
 event_type text not null, entity_version bigint, before jsonb, after jsonb,
 reason text, actor_membership_id uuid not null, occurred_at timestamptz not null,
 operation_id uuid not null -- FK nguồn phụ thuộc milestone của master
);
app_private.contract_exit_previews (
 id uuid primary key, organization_id uuid not null, building_id uuid not null,
 actor_membership_id uuid not null, contract_id uuid not null, exit_case_id uuid,
 mode text not null, kind text not null, expected_case_version bigint,
 intent_hash text not null, facts_hash text not null, policy_version text not null,
 facts jsonb not null, calculated_lines jsonb not null,
 expires_at timestamptz not null, consumed_operation_id uuid
);
```

CHECK đóng tập loại/mode/state (`PENDING/FINALIZED`); initial bất biến, ngày/actor do server kiểm. FK bảo đảm cùng org/toà cho nguồn, không chỉ UUID. Event append-only. `FINALIZED` bắt buộc snapshot/actor/time/accounting_on; PENDING không chứa số tiền cuối. Snapshot bất biến; sửa sai bằng điều chỉnh riêng. Preview private TTL đề xuất 10 phút, bind membership/subject/version/mode/kind/full intent/facts/policy; replay đã commit không phụ thuộc expiry.

RPC mới:

1. `preview_contract_exit_settlement_v1(p_input jsonb)`: đọc server facts/capability, tính dòng tiền, trả preview ID/hash/expiry/blocker; hỗ trợ contract chưa bàn giao và case PENDING. Không tin tổng client.
2. `confirm_contract_moveout_v1(p_input jsonb)`: ngày/loại/mode/idempotency; DEFERRED chỉ handover + case/event. IMMEDIATE xác thực preview rồi gọi helper chốt **cùng transaction**; không tách hai request.
3. `finalize_contract_exit_settlement_v1(p_input jsonb)`: chỉ case PENDING, expected version + preview. Đổi loại cần reason, lưu initial/current/before/after/actor/time; không tác động lại status/phòng/khách; lỗi rollback cả loại lẫn tiền.
4. `get_contract_exit_cases_v1(p_input jsonb)`: case chờ/đã chốt/tiền còn thu chi/capability theo hành động. Phân trang ổn định, totals server; không cộng trang đầu ở client.

Helper tiền mới nhận **snapshot server + case**, tách khỏi helper kết thúc cư trú. Không bọc `terminate_*_impl` rồi bỏ guard: cả move-out lẫn forfeit chứa tác động cư trú và phép ghi tiền phụ thuộc trạng thái cũ. Tiền được tách thành hóa đơn/phạt, cọc áp dụng, credit FIFO, hoàn khác, nợ còn lại, phiếu hoàn và tiền thực thu/chi. Mặc định chốt giữ phần thiếu thành nợ. Nếu UI cung cấp thu ngay, dùng action tiền rõ ràng với số tiền thực nhận và quyền sổ; không ánh xạ IMMEDIATE thành `PAID`.

DEFERRED chỉ cần snapshot/capability cư trú; lỗi mapping tiền hoặc credit cũ không được chặn bàn giao. Snapshot tài chính chỉ bắt buộc khi chốt. Ngày bàn giao cắt dịch vụ; ngày chốt ghi quyết định; ngày phiếu/thu/chi theo kỳ kế toán hợp lệ. Không backdate phiếu vào kỳ đã khóa chỉ để khớp ngày trả phòng.

Loại FORFEIT giữ chính sách tiền hiện hành chỉ sau khi reviewer đối chiếu từng khoản: cọc thực nhận, khoản đã thu giữ lại, nợ được hủy, phí riêng, credit. Đây là chặn review, không tự suy rằng chọn FORFEIT được xóa mọi nợ. NATURAL_EXPIRY và EARLY_RETURN là phân loại nghiệp vụ rõ ràng, không suy chỉ từ ngày hay `NORMAL` cũ.

## 4. Khóa, snapshot, quyền và replay

**OBSERVED:** wrapper move-out khóa contract trước, rồi cashbook `FOR SHARE`, org authorization (`20260822093000:434,509,515`). Credit cũng contract trước org. `lock_org_for_decision_v1` đã đổi sang `FOR NO KEY UPDATE` (`20260731040000_fix_org_lock_upgrade_deadlock.sql:99`). Vì thế thêm “org-first” riêng trong RPC mới có thể tạo vòng chờ với legacy; sort ID không tự giải quyết đảo thứ tự này.

**PROPOSED:** lập wait graph từ mọi writer giao nhau và spend triggers; thêm adapter prelock cho cả legacy callable. Candidate chuẩn hiện nay là master §4.2: room → org → contracts → case/nguồn tiền, còn phải đóng G-LOCK. Ví dụ nghiên cứu cũ “org → contracts → room → case → invoices/vouchers/lots → spend buckets sort” chỉ là phương án thay thế **chưa duyệt**, không chỉ dẫn triển khai song song. Candidate nào cũng phải kiểm catalog và race toàn bộ participants trước rollout.

```text
BEGIN (VOLATILE RPC, bounded lock_timeout)
  authenticate; resolve subject org/building; check visibility
  acquire common prelocks; reread org/subject/permission after waits
  reserve canonical operation scoped by org+subject+actor+key
  same key/different intent => conflict
  completed same intent + current read permission => stored result
  lock case; enforce expected version; reject competing completed intent
  DEFERRED => validate residence capability/version;
              handover once + case PENDING + mandatory event
  IMMEDIATE/finalize => validate financial preview actor/subject/expiry/policy;
    lock source invoices/vouchers/credit lots; reread complete facts
    changed facts/hash => PREVIEW_STALE, no writes
    canonical money helper(snapshot)
    IMMEDIATE => handover once within this same transaction
    assert accounting/provenance totals; immutable final snapshot + FINALIZED
  finish operation + event atomically
COMMIT
```

Facts hash bao gồm nguồn/số dư/version/trạng thái của hóa đơn, cọc dẫn xuất từ phiếu, credit lots, khoản đã hoàn, khoản đang chờ, chỉ số cuối, kỳ/sổ/cờ luật; không chỉ `contracts.updated_at`. Recompute/đối chiếu dưới khóa; khoản phát sinh sau preview buộc xem lại. Snapshot ghi từng source ID và allocation, policy version, các effect IDs. Không retry âm thầm sau timeout; client tra/replay cùng key. Người khác dùng key khác vẫn bị unique case + row lock chặn chốt lần hai.

Quyền bàn giao dùng capability contracts theo toà; chốt cần capability tiền tương ứng từng effect, không suy từ được sửa hợp đồng. Thu thêm/hoàn cần quyền sổ và membership hiện hành. Preview capability không thay kiểm quyền execute. Không thêm `is_super_admin OR…`; reader/RLS giới hạn org/toà, sandbox-admin theo Contract §2. Revoke DML trực tiếp case/event/preview; helper private không public EXECUTE, fixed search_path; test cả anon/authenticated/service_role và PostgREST để bắt `25006`.

## 5. Tác động và tương thích

* Cư trú/phòng: handover đóng interval một lần; settlement cũ không sửa phòng hiện tại. Phòng dọn/sửa vẫn có listing và ngày nhận dự kiến; readiness tách occupancy và sale visibility. Khóa ngày/đối tượng, không lấy khách đang ở phòng làm người nhận hoàn.
* Billing/meter: `src/hooks/invoices/useExcelInvoiceData.ts:54,64` lọc ACTIVE và map meter theo phòng. Cần boundary chỉ số bàn giao gắn contract/interval; snapshot cũ không được lấy chỉ số khách mới. Billing dừng tại ngày bàn giao, late settlement chỉ đọc nguồn của contract cũ; không mang nợ sang contract mới.
* Báo cáo: `src/hooks/reports/realEstateReports.ts:836,868` nối contract với termination; `src/pages/reports/real-estate/TerminationsReport.tsx:57` dùng ngày kết thúc. Phân biệt ngày bàn giao/ngày chốt/ngày tiền; thêm case PENDING để không mất dòng. `src/hooks/useContractSettlement.ts:166,256` hiện đọc phiếu, không đủ cho case chưa có phiếu. Cache/realtime phải invalidate case, contract, invoice, credit, cashbook/report đúng scope (`src/hooks/realtime/settlementInvalidation.ts:8`).
* Lương/công việc: giữ `jobs.completion_time` làm căn cứ lương; không đổi thành ngày chốt (`scripts/check-salary-completion-date.mjs:3,74`). Dọn sửa, commission/bonus phải giữ contract/source gốc, không tái tạo khi finalize.
* Copilot: giữ `termination.hoan_coc` tắt. Audit cả action `contract.duyet_thanh_ly` còn bọc approval cũ (`20260903192634_copilot_action_contract_duyet_thanh_ly_v1.sql:13`). Case v2 phải bị legacy approval từ chối; action mới cần preview/consent/capability riêng và corpus cập nhật.

Legacy và rollout: server trước UI; routing xét identity v2 trước flag. Guard legacy/DML chặn ghi ngoài capability v2; không fallback khi v2 lỗi. Rollback bình thường chỉ ngừng enrollment mới, **giữ completion path** cho case đã tạo cùng đọc/replay/xử lý phiếu. Chặn finalize chỉ là emergency freeze của incident riêng, phải có lý do/phạm vi/chủ xử lý và đường khôi phục; không coi là hành vi rollback mặc định. Không xóa case, trả contract về ACTIVE hay mở lại refund đóng ngày 23/09. Giữ retirement hashes/ACL; thay đổi cần review provenance riêng.

Lịch sử: không tự backfill `NORMAL` thành NATURAL/EARLY hoặc COMPLETED thành đã chi. Dòng cũ thiếu ngày/audit/nguồn tiền giữ `LEGACY_UNCLASSIFIED` ở read model, danh sách ngoại lệ và provenance. Chỉ import case khi có bằng chứng đủ, mapping duy nhất và dry-run đối chiếu; không tái sinh bất kỳ effect tiền nào.

## 6. Matrix kiểm chứng bắt buộc cho implementation

| Ca | Bằng chứng yêu cầu |
|---|---|
| Ba loại × hai mode; thiếu ngày; ngày trước cư trú | Handover đúng, validation server, không ghi nửa chừng. |
| DEFERRED có nợ/cọc/credit/phiếu chờ | Fingerprint mọi bảng tiền trước/sau bằng nhau; chỉ cư trú/case/event đổi. |
| Khách B vào sau A; chốt A đổi loại | B/room/reservation/meter/billing không đổi; original/current/reason đầy đủ. |
| Replay, key đổi payload, hai actor chốt đồng thời | Một bộ effect; response ổn định; không duplicate refund/CT/burn. |
| Payment/credit/approve/cancel/billing chạy cùng finalize | Snapshot stale hoặc kết quả serial hợp lệ; không deadlock vòng, không số âm. |
| Cọc khai > thu, lot lệch, legacy credit, cap >1000 | Chặn/đối chiếu đúng; không lấy trang đầu làm tổng. |
| Đổi quyền/cờ/sổ/kỳ sau preview; cross-org/building | Từ chối bằng JWT thật; không rò capability/facts. |
| Fault injection giữa từng effect, audit, spend sync | Rollback đầy đủ; spend error được phát hiện; replay không nhân đôi. |
| Rollback UI + legacy API/Copilot gọi case v2 | Fail closed; case chờ còn truy cập; không tái thanh lý. |

Lệnh **đang tồn tại** để AI triển khai chọn và mở rộng, chưa chạy trong lượt tài liệu này:

```powershell
npx vitest run src/lib/__tests__/terminationSettlement.test.ts src/lib/__tests__/customerCreditRpc.test.ts src/lib/__tests__/cocThanhLyCapHoanCocMigration.test.ts src/hooks/__tests__/useContractSettlement.test.ts
npm run typecheck:baseline
npm run build
npm run gate:rpc-cast
npm run gate:stable-fn-locks
npm run gate:definer-acl
npm run gate:definer-body-authz
npm run gate:reconcile-money
npm run gate:reconcile-money-v2
npm run gate:copilot-docs
# Trong .e2e-fleet/, đúng TEST/DEMO:
npx playwright test specs/room-lifecycle.spec.ts specs/terminations-report.spec.ts specs/contract-settlement-screen.spec.ts
```

Các gate runtime chỉ chạy sau khi xác nhận TEST endpoint/org/role và đủ schema/dataset; reconcile v2 có nhánh bỏ qua khi thiếu schema nên exit 0 chưa đủ bằng chứng. Gate tồn tại `npm run gate:salary-completion-date` hiện đọc thẳng `.temp/project-ref` và vault trong cwd (`scripts/check-salary-completion-date.mjs:24`); cần adapter TEST nhận env hoặc chuyển SQL sang harness TEST trước khi dùng. Không sao chép vault hay chạy fixture trên org THẬT, dù script ROLLBACK.

Test hiện có không chứng minh v2: cần thêm harness SQL/PostgREST/concurrency và E2E cho matrix trên, mutation test qua `scripts/dot-bien.mjs`. Migration dùng baseline + forward lane, provenance/types/catalog/surfaces theo Contract §5–6; draft PR và cross-review tiền/RLS/migration trước tích hợp. Chưa kiểm: mọi ca runtime, catalog sống, browser, dữ liệu lịch sử và rollback thật.
