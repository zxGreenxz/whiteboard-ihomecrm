# Authorization tranche `T3` — Approval contract v2, non-callable helpers

> Trạng thái: `IN_DESIGN`
> Production mutation: **không được phép**. Apply/canary `BLOCKED` cho đến khi (a) recovery set `VERIFIED`, (b) T1a containment và T2 đạt gate phụ thuộc cùng `ORG_READY(APPROVAL)` (chứng nhận read-only phạm vi hẹp từ T6a-preflight — KHÔNG phải full T6a; thứ tự §27.3 là `T3 trước T6`, full T6 của approval domain chỉ là gate trước wire/canary ở T5/T7), và (c) owner cấp exact commit SHA + migration SHA-256 + maintenance window + canary count/VND cap (mặc định `0` = không flip). Phê duyệt tài liệu này KHÔNG phải phê duyệt áp production.

## 0. Vì sao tranche này tồn tại

Prototype approval engine Sprint 4 (`20260713130000_sprint4a_*`, `20260713130200_sprint4c_*`) đã `APPLIED` nhưng độc lập audit (`docs/Kết luận kiểm tra.md` §2–§3, `AUTHORIZATION-PLAN.md` §27.1) bác claim production-ready. T3 định nghĩa **contract v2** thay thế prototype: state machine đầy đủ, CAS/version, snapshot revalidation, idempotency có DB uniqueness, candidate materialization từ cấu hình thật, maker-checker + ngoại lệ tự duyệt theo hạn mức, posting affected-row assertions, audit append-only, và reversal. **Không wire vào UI và không cấp `EXECUTE` cho `authenticated` trong tranche này** (`AUTHORIZATION-PLAN.md` §27.3: "chưa expose/wire production trong tranche này"; §4.1: callable surface cần threat model + negative test + deploy approval riêng).

---

## 1. Scope và dependency

- **Deliverable/tranche ID:** T3 — Approval contract v2 + rule governance + self-limit policy + reversal, non-callable.
- **Domain:** Financial voucher approval (`income_expenses` posted ledger), rule governance, reversal. Subject-type resolver mở rộng cho `FINANCIAL_VOUCHER` (và khung cho `PAYMENT`/deposit về sau).
- **Normative plan section:** `AUTHORIZATION-PLAN.md` §12.1–§12.7 (target engine), §13 (RPC boundary), §27.2 (quyết định nghiệp vụ owner 2026-07-15), §27.3 (T3 định nghĩa). Bằng chứng audit: `docs/Kết luận kiểm tra.md` §2, §3, §5 (T1b/T1d/T1e).
- **Dependencies và trạng thái:**
  - Recovery local — `ACCEPTED_LOCAL` theo owner gate ngày 2026-07-16, nhưng không phải chuẩn `VERIFIED` chặt; production apply/cutover tiền vẫn cần exact tranche gate, disposable verification, canary/window/cap riêng.
  - T1a — containment prototype `submit_financial_voucher`/`decide_financial_voucher` đã `APPLIED` ngày 2026-07-16; còn observation trước `VERIFIED`. Hai RPC prototype vẫn phải giữ revoked, không được re-grant để chữa availability.
  - T2 — RBAC source-of-truth + `authorization_version` + staff lifecycle — `BLOCKED`; slice seed 4 permission key T3 đã `APPLIED`. Cần resolver v3, OWNER binding explicit và cashbook possession riêng trước callable path.
  - `ORG_READY(APPROVAL)` — chứng nhận phạm vi hẹp từ T6a-preflight (read-only): subject `income_expenses` + closure foreign-resource của approval domain (cashbook/account/building) đã có derivation org xác định, zero-null trên các bảng này. **KHÔNG phải full T6a**: T3 là contract non-callable nên không cần backfill/constraint/RLS-shadow của ~132 bảng; full T6 của approval domain chỉ là gate trước khi wire/canary (T5/T7). Giữ đúng thứ tự §27.3 `T3 trước T6`.
  - T4 harness (JWT/concurrency/reconciliation) — `IN_DESIGN`. Cần trước khi có evidence acceptance.
- **In scope:**
  1. Migration constraint: bổ sung `REVERSED` vào `approval_requests.state` CHECK; thêm reversal link columns/uniqueness; siết `authorization_audit_events.organization_id` non-null cho tenant event (hoặc guard tương đương).
  2. T3 sở hữu private, non-callable draft/state-machine routines và approval transitions: `submit_financial_request`, `self_approve_financial_within_limit`, `decide_financial_approval`, `emergency_approve_financial`, `cancel_financial_draft`/`withdraw_financial_request`, `reverse_financial_posting` (`AUTHORIZATION-PLAN.md` §13). T5 sở hữu public domain wrappers `create_income_expense_v1`/`update_income_expense_v1` và frontend routing. Nếu giữ tên `create_financial_draft`/`update_financial_draft`, chúng phải nằm trong private schema, không grant cho app role và chỉ được wrapper T5 gọi; không tồn tại hai callable canonical create/update writer cạnh tranh.
  3. Private helpers: rule matcher, candidate materializer, posting routine (thay `_eval_approval_rule`/`_post_financial_voucher`), audit-append với hash-chain.
  4. ~~Seed permission keys còn thiếu~~ → **thuộc T2, không thuộc scope T3** (xem §1 open items): T3 chỉ *consume* bốn key sau khi T2 seed. Trong scope T3 còn: versioned self-approve limit config + held-cashbook resolution + org setting cho voucher classification (server-derived).
  5. Rule governance: bootstrap org mới, `DRAFT→ACTIVE→RETIRED` publish atomic, fail-closed khi rule resolution không duy nhất.
  6. Shadow evaluation harness (T1e): so intended decision vs legacy trên dữ liệu hiện có, không ghi production.
- **Out of scope:** Wiring frontend/feature-flip (T5/T7); payment-v3 hardening (T1b); `record_invoice_payment_atomic`/bulk (T1b/T5); Storage/R2 (T8); deposit `create_reservation_deposit` domain writer (T5) — T3 chỉ định nghĩa 24h-hold state contract cho subject deposit, không wire writer; RLS v2 cutover (T6).
- **Business behavior TRƯỚC thay đổi:**
  - Prototype: `authenticated` là active member gọi trực tiếp PostgREST `submit_financial_voucher` được, gửi `p_system_source='internal_settlement'` → rule `AUTO_POST` → posting dưới SECURITY DEFINER, **không** kiểm exact permission, **không** maker-checker (`docs/Kết luận kiểm tra.md` §2.1, xác nhận từ code `20260713130200:96,101,111`).
  - `p_idempotency_key` và `payload_hash` là tham số/cột chết — nhận nhưng không dùng (`20260713130200:64,108`; audit §3.4).
  - `submit` không tính `submission_no` → resubmit sau terminal đụng UNIQUE `(org,subject_type,subject_id,submission_no)` (`20260713130000:95`; audit §3.7).
  - `_post_financial_voucher` UPDATE theo `id + deleted_at IS NULL`, không assert affected-row, không kiểm transition/version (`20260713130200:51–54`; audit §3.6).
  - Không có RPC ghi `authorization_audit_events` (audit §3.5). Không có `emergency_approve_financial` hay `reverse_financial_posting` thực (header comment `20260713130200:3` liệt kê `emergency_approve_financial` nhưng thân file KHÔNG định nghĩa; grep xác nhận chỉ xuất hiện trong comment/docs).
  - `approval_requests.state` CHECK không chứa `REVERSED` (`20260713130000:79`) → không thể biểu diễn reversal.
- **Business behavior SAU thay đổi:**
  - Client không chọn được classification internal auto-post; `transaction_type`/`system_source`/category/account/building/amount đều server-derive từ subject đã lock.
  - Maker-checker mặc định enforced; ngoại lệ đóng duy nhất là tự duyệt phiếu chi thông thường dưới hạn mức trên sổ quỹ maker nắm giữ, có exact permission + hậu kiểm. Force-approval (hoa hồng, thưởng, refund/cọc, lương, lợi nhuận, hợp đồng/thanh lý) luôn chờ người khác, bỏ qua hạn mức.
  - Retry cùng key/cùng payload trả response cũ; cùng key/khác payload báo conflict; hai request đồng thời cùng key tạo đúng một operation.
  - Sửa voucher sau submit bị chặn hoặc buộc tạo submission/version mới; decide recompute canonical hash và so snapshot, mismatch fail.
  - Posting assert đúng một affected row, kiểm transition/version, không re-post; `posted_event_id`/reversal link unique chống double-post/double-reverse.
  - Hoàn tác = bút toán đối ứng liên kết bản gốc ("Hủy giao dịch thu tiền (tạo bút toán hoàn tác)"), original immutable, không hard-delete.
- **Ảnh hưởng nghiệp vụ/người dùng:** Không thay đổi hành vi runtime cho tới khi wire (T5) — contract v2 deploy ở trạng thái không callable. Khi wire, người thiếu exact permission bị backend deny dù UI từng cho thao tác; maker không tự duyệt phiếu force-approval; hoàn tác giữ lịch sử thay vì xóa.

**Open items chặn prepare:** bốn permission key `income_expenses.self_approve_within_limit`, `cashbooks.post`, `approvals.emergency_override`, `income_expenses.reverse` đã được T2 seed bằng forward migration `20260716120100` và đang `APPLIED`; không còn là blocker. Blocker còn lại là: (1) resolver v3 + possession relation riêng của T2; (2) versioned self-approve limit mặc định `0` cho tới khi owner cấu hình; (3) server-owned classification; (4) canonical-flow provenance marker tồn tại ngay từ draft creation; (5) exact legacy transition containment và immutable audit.

---

## 2. Immutable release identity

Chưa được cấp — tranche `IN_DESIGN`. Không dùng branch name, "latest", glob migration hay broad `db push` làm release identity.

- Full commit SHA: `<chưa cấp — owner>`
- Exact migration path/signature: `<chưa cấp>` (timestamp migration mới; artifact SQL giữ NGOÀI `supabase/migrations/` cho tới khi review + gate đạt — `AUTHORIZATION-PLAN.md` §4.1/§27.3).
- Migration SHA-256: `<chưa cấp — owner>`
- Generated-types SHA-256: `<chưa cấp>` (bắt buộc regen `npm run gen:types` sau migration đụng schema — CLAUDE.md).
- Deployed frontend SHA: `n/a` (T3 không wire frontend).
- Recovery reference: `20260715T152622Z-online-unfrozen` + `20260716T045126Z-db-portable`, owner state `ACCEPTED_LOCAL`; strict `VERIFIED` certification vẫn `<chưa có>`
- Maintenance-window ID: `<chưa cấp — owner>`
- Operator / Reviewer / Owner approval reference: `<chưa cấp>`

---

## 3. Live precheck (bắt buộc chạy read-only ngay trước prepare/apply)

- UTC/local start time: `<ghi khi chạy>`
- **Exact live signatures/owners/search paths/grants** cho các object T3 đụng (refresh từ live catalog, không dùng tên trần):
  - `public._eval_approval_rule(uuid,numeric,text,text,uuid,uuid,uuid)` — STABLE SECURITY DEFINER, `search_path=pg_catalog,public`.
  - `public._post_financial_voucher(uuid,uuid,uuid)` — SECURITY DEFINER.
  - `public.submit_financial_voucher(uuid,text,text,text)` — kỳ vọng grant đã bị revoke bởi T1a; xác nhận `has_function_privilege` false cho `PUBLIC/anon/authenticated`.
  - `public.decide_financial_voucher(uuid,text,text,bigint)` — như trên.
  - Xác nhận `emergency_approve_financial`/`reverse_financial_posting` **không tồn tại** (`docs/Kết luận kiểm tra.md` đối chiếu 2026-07-14).
- Active callers/writers: PostgREST/DB logs cho prototype RPC (kỳ vọng 0 sau T1a); confirm `income_expenses` direct DML writers còn sống (guard Sprint 5a vẫn cho direct APPROVED — `docs/Kết luận kiểm tra.md` §1 Sprint 5a).
- Migration-ledger state: xác nhận `20260713130000`/`20260713130200`/`20260713140000_sprint5a_*`/`20260713150000_sprint6a_*` đã applied; không có migration T3 nào đang chờ trong path mặc định.
- Pre-state table/object/count/hash: đếm+hash `approval_requests` (kỳ vọng 0 request theo audit 2026-07-14), `approval_decisions` (0), `authorization_audit_events` (0), `approval_rule_sets` (2 ACTIVE), `approval_rules` (2 `internal_settlement`→AUTO_POST). Hash `income_expenses` posting-metadata columns.
- Financial reconciliation baseline: `node scripts/reconcile-money.mjs` (SUM SQL thật vs tổng-1000-dòng-đầu — CLAUDE.md), lưu baseline delta.
- Browser/runtime baseline: smoke các flow thu-chi hiện hữu, console/network sạch.
- Monitoring healthy + Managed backup reference: 7/7 physical backup `COMPLETED` (`AUTHORIZATION-IMPLEMENTATION-STATUS.md`); PITR off — ghi rõ.

---

## 4. Change contract

### 4.1 Server-derived organization/actor/resources
- `subject_type` allowlist + resolver: lock subject row thật, derive `organization_id` từ subject, từ chối subject không tồn tại/khác org (`AUTHORIZATION-PLAN.md` §12.4). Với `FINANCIAL_VOUCHER`: `SELECT ... FROM income_expenses WHERE id=? AND deleted_at IS NULL FOR UPDATE`.
- Actor = `auth.uid()`; membership resolve `(user_id, organization_id, status='ACTIVE')`.
- **Không nhận** `p_system_source`/`p_txn_type`/category/account/building/amount client-controlled cho classification (thay prototype `20260713130200:64,96`). Derive từ subject đã lock.
- **Super-admin attribution:** không mượn membership OWNER của người khác (prototype `20260713130200:84–85` gán `maker_membership_id` = OWNER bất kỳ nhưng giữ `maker_user_id` = super-admin → vi phạm composite FK `(org,maker_membership_id,maker_user_id)` `20260713130000:96`; audit §3.8). Contract v2 định nghĩa principal/membership attribution hợp lệ cho elevated action, audit riêng.

### 4.2 Exact permission và resource scope (`AUTHORIZATION-PLAN.md` §13)
| RPC | Exact permission | Ghi chú scope |
|---|---|---|
| Private draft-create routine, called only by T5 `create_income_expense_v1` | `income_expenses.create` | Voucher+items cùng org; DRAFT only; account có thể null; marker/provenance ghi atomically. |
| Private draft-update routine, called only by T5 `update_income_expense_v1` | `income_expenses.edit` | Maker/scope; expected version; DRAFT only. |
| `submit_financial_request` | create/submit | Rule snapshot + request hoặc auto-post atomic; force categories luôn chờ duyệt. |
| `self_approve_financial_within_limit` | `income_expenses.self_approve_within_limit` + `cashbooks.post` | Chỉ phiếu chi thông thường dưới hạn mức, account thuộc sổ maker nắm giữ. |
| `decide_financial_approval` | `income_expenses.approve` + approver eligibility | Maker-checker; approver chọn account + ảnh trước snapshot cuối. |
| `emergency_approve_financial` | `approvals.emergency_override` + `member_type='OWNER'` | Reason≥20 + re-auth; endpoint riêng, không client enum. |
| `cancel_financial_draft`/`withdraw_financial_request` | cancel/withdraw (`income_expenses.cancel`?) | Draft chỉ DRAFT; withdraw chỉ PENDING_APPROVAL; đóng request có audit. |
| `reverse_financial_posting` | `income_expenses.reverse` | Chứng từ đối ứng; original immutable. |

Permission resolution phải dùng private resolver v3 do T2 cung cấp; không gọi trực tiếp `effective_perms_v2` hoặc `authorize_v2` hiện tại cho elevated money action. Resolver v3 phải giữ deny precedence, scoped member override, resource-derived scope, organization-first witness/concurrency và cashbook-possession contract của T2 §4.1. Bốn permission key T3 đã được seed bằng migration `20260716120100`; blocker còn lại là resolver/lifecycle/possession, không phải seed key.

### 4.3 State/version/CAS rules
- State machine (`AUTHORIZATION-PLAN.md` §12.1): `DRAFT→PENDING_APPROVAL→POSTED|REJECTED|CANCELLED`; `DRAFT→POSTED` (AUTO_POST); `DRAFT→DENIED` (DENY rule); `POSTED→REVERSED` (chứng từ mới, row gốc bất biến). Không `POSTED→DRAFT`. `DENIED` (rule) ≠ `REJECTED` (người duyệt).
- **Migration bắt buộc:** thêm `REVERSED` vào `approval_requests.state` CHECK (hiện `20260713130000:79` thiếu). Không dựng reverse RPC trên enum/check hiện tại (audit §3.9).
- Mọi transition RPC nhận `expected_request_version`; update dùng CAS `version=version+1`; conflict → `ERRCODE 40001` (giữ pattern prototype `20260713130200:149`).
- `SELECT ... FOR UPDATE` subject + request theo **cùng lock order** cho `submit/decide/reject/withdraw/post/reverse`.

### 4.4 Idempotency scope, canonical payload hash và conflict behavior
- Bảng operation-idempotency riêng: unique `(organization_id, operation, key, request_hash, response_json)` (`AUTHORIZATION-PLAN.md` §12.5). Ghi atomic trong mọi nhánh.
- **Authorize subject/org/caller TRƯỚC khi lookup replay** (audit §3.3: prototype lookup key toàn bảng dưới SECURITY DEFINER trước authorize → có thể trả ID khác tenant). Lookup phải scope org+operation+subject+caller. Early authorize KHÔNG thay thế final evaluation: theo T2 §4.1, final resolver decision phải chạy lại SAU mọi conflict/advisory/lock wait (gồm wait trên idempotency row và subject lock) và trước effect — authorize-early chỉ chặn cross-tenant lookup, không phải quyết định cuối.
- Same key + same canonical payload → trả response cũ. Same key + different payload → conflict (không trả nhầm operation, không effect mới).
- `p_idempotency_key` không còn là tham số chết (prototype `20260713130200:64` nhận nhưng không đọc).

### 4.5 Subject immutability / snapshot revalidation (audit §3.4)
- Khi submit: snapshot payload + canonical hash. Trong khi PENDING, chặn/giới hạn mutation voucher (RLS/trigger hoặc lock).
- Khi decide/post: lock subject row, **recompute canonical hash và so snapshot đã submit**; mismatch → fail hoặc buộc submission/version mới (prototype không so lại — `20260713130200:108` chỉ tính `md5` rồi bỏ; decide `194` post row hiện tại không reload/so hash).

### 4.6 submission_no / resubmit atomic (audit §3.7)
- `submission_no` cấp atomic dưới subject lock; giữ terminal history; partial unique index `approval_requests_one_open_subject` (`20260713130000:99`) đảm bảo tối đa một request OPEN. Prototype không tính `submission_no` → resubmit sau REJECTED/DENIED/CANCELLED đụng UNIQUE.

### 4.7 Candidate materialization + multi-step (`AUTHORIZATION-PLAN.md` §12.3, §12.5)
- Materialize candidate từ `approval_step_approvers` thật (MEMBER/ROLE/PERMISSION/CASHBOOK/AREA/BUILDING_APPROVER), không hardcode `effective_perms_v2 ... income_expenses.approve` như prototype (`20260713130200:118–123`).
- `generation` tăng khi rematerialize; đóng validity row cũ, không overwrite history. Decide re-check membership ACTIVE + maker-checker + candidate current-generation còn hiệu lực.
- `mode`: `ANY` (min=1) / `ALL` (min=candidate_count) / `QUORUM` (min≤candidate_count). Submit fail-closed nếu step thiếu candidate/quorum bất khả thi. Suspend approver làm `eligible<min` → không âm thầm hạ quorum: reassign/escalate/reject qua elevated RPC có audit.

### 4.8 Maker-checker + ngoại lệ tự duyệt theo hạn mức (`AUTHORIZATION-PLAN.md` §12.6, §27.2)
- Mặc định: normal decision reject khi `actor_membership_id=maker_membership_id` OR `actor_user_id=maker_user_id`.
- **Ngoại lệ đóng** (`self_approve_financial_within_limit`) chỉ khi backend đồng thời xác minh: (1) rule/category/source = phiếu chi thông thường, KHÔNG force-approval; (2) tổng ≤ hạn mức versioned server-side, không chia nhỏ business event để lách (tính theo correlation/batch); (3) account thuộc tập sổ quỹ membership maker **đang nắm giữ** theo `cashbook_possession_bindings` active (`CUSTODIAN|OPERATOR` được registry chấp nhận) của T2 §4.1 — permission scope/binding KHÔNG chứng minh possession; building scope hoặc quyền xem/sửa sổ không đủ; (4) exact `income_expenses.create` + `income_expenses.self_approve_within_limit` + `cashbooks.post`; (5) payload/version/idempotency + evidence hợp lệ; (6) gắn `SELF_APPROVED_WITHIN_LIMIT`, đưa vào hàng hậu kiểm; hậu kiểm không sửa/xóa posting gốc.
- **Force-approval** (hoa hồng/thưởng/refund/cọc/lương/lợi nhuận/hợp đồng/thanh lý + mọi rule `REQUIRE_APPROVAL` bắt buộc) luôn chờ người khác, bỏ qua hạn mức.
- **Cashbook selection:** maker chỉ chọn sổ mình nắm giữ ở mọi phiếu chi. Không nắm sổ phù hợp → để trống account; phiếu để trống không đủ điều kiện tự duyệt. Tại final decision, kế toán/owner chọn sổ họ được post + thêm ảnh chứng từ → hệ thống snapshot/version/audit lại trước khi ghi tiền (`decide_financial_approval`). Approver chọn account không biến request thành maker self-approval.

### 4.9 Emergency owner override (`AUTHORIZATION-PLAN.md` §12.6)
- Endpoint riêng, không insert vào normal decision path bằng client enum. Chỉ khi: membership ACTIVE + OWNER; request PENDING_APPROVAL; `approvals.emergency_override`; reason trim ≥ 20 (giữ CHECK `20260713130000:156`); re-auth còn mới; ghi `EMERGENCY_APPROVE` decision + security notification + audit; metric/alert tần suất; không bulk. BYPASSED active step + step sau trước khi post cùng transaction. Owner-là-maker không dùng emergency để né force-approval.

### 4.10 Atomic effects + posting (`AUTHORIZATION-PLAN.md` §12.7)
- Posting routine (thay `_post_financial_voucher`): lock row, kiểm transition predicate đầy đủ (approval_status hiện tại, request state/version, org, posting_id cũ), **GET DIAGNOSTICS assert đúng một affected row** ở cả voucher + request update, fail transaction nếu invariant sai (prototype thiếu — `20260713130200:51–57`; audit §3.6).
- Double-post chặn tại posting source-of-truth; `approval_requests.posted_event_id UNIQUE` (`20260713130000:92`) là guard bổ sung; ưu tiên `posting_event.approval_request_id UNIQUE NOT NULL`.
- Trigger/RLS cấm sửa amount/items/account/category của row POSTED.

### 4.11 Reversal (`AUTHORIZATION-PLAN.md` §12.7, §13, §27.2 item 3)
- Reversal = posting mới `reverses_posting_id UNIQUE`, số tiền/legs đối ứng **server-derive từ original**, không nhận amount client. Anti-double-reversal: một original chỉ reverse một lần (unique). Original row/lines immutable; hiển thị REVERSED qua projection. Không hard-delete payment/voucher. UI label "Hủy giao dịch thu tiền (tạo bút toán hoàn tác)" + cảnh báo "không xóa lịch sử". Reconciliation chứng minh tổng ledger trung hòa.

### 4.12 Audit/provenance (audit §3.5, `AUTHORIZATION-PLAN.md` §12.4)
- **Một canonical audit destination duy nhất cho lifecycle income-expense:** semantic lifecycle events (submit/rule-match/auto-post/approve/reject/conflict/reversal/emergency) append qua MỘT private primitive duy nhất vào `income_expense_audit_log` đã nâng cấp (A.5) — SHA-256, chain-head `app_private.income_expense_audit_chain_heads`. `authorization_audit_events` (bảng applied của Sprint 4, có prev_hash/event_hash nhưng không head/writer/scheme) được declare **subordinate/deprecated cho lifecycle events** cho tới khi hoặc bị unify vào primitive chung có `chain_partition` discriminator, hoặc có head/writer/scheme riêng cho non-lifecycle authorization events; không RPC nào ghi cùng một event vào cả hai chain. Nếu một RPC phải append cả hai loại event, lock order giữa hai chain-head phải cố định (income-expense head trước, authorization head sau) và cả hai là lock CUỐI trước INSERT. Append-only (INSERT chỉ qua primitive; app roles không UPDATE/DELETE). **`organization_id` phải non-null cho tenant event** (hiện nullable `20260713130000:164`; migration siết hoặc guard — xem A.9 blocking #3 về live NULL-writers).

### 4.13 Rule governance (`AUTHORIZATION-PLAN.md` §12.2, §27.3)
- Org bootstrap rule set; `DRAFT→ACTIVE→RETIRED` publish atomic; published version bất biến (không UPDATE/DELETE); mỗi version đúng một `is_fallback=true` effect `REQUIRE_APPROVAL`; chỉ một version hiệu lực/thời điểm. Fail-closed khi không đúng một ACTIVE version hoặc resolution không duy nhất — tuyệt đối không auto-post. Request đang mở dùng snapshot/version cũ.

### 4.14 External outbox/side effects
- Không có trong T3 (không wire). Deposit 24h-hold state contract (`expires_at`, no double-hold, server-time) được **định nghĩa** cho subject deposit nhưng writer `create_reservation_deposit` thuộc T5.

### 4.15 Forward-fix/reversal behavior
- Với ledger đã post, không rollback bằng xóa/sửa row tiền; dùng forward-fix hoặc `reverse_financial_posting` có audit.

### 4.16 Feature flag default
- **`OFF`.** Helpers private (SECURITY DEFINER, **không** grant `authenticated`). Contract v2 deploy không callable; grant `EXECUTE` chỉ ở migration riêng SAU T5 gate + owner approval (`AUTHORIZATION-PLAN.md` §4.1, §27.3).

### 4.17 Containment tối thiểu trước khi T5 tạo draft có thể callable

Containment là security dependency riêng, không đợi full approval engine mới được mô tả. Exact repository inventory hiện tại:

- active `public.approve_voucher(uuid)` là bản `20260704090000`: cho phép creator (`ie.user_id=auth.uid()`), platform super-admin và building approver; không kiểm canonical provenance;
- active `public.unapprove_voucher(uuid)` là bản `20260703160000`, có cùng ba nhánh authority;
- `public.pay_draft_fee_voucher(uuid,uuid,jsonb)` gọi `approve_voucher` sau khi set account/attachments;
- FE gọi approve/unapprove trực tiếp ở `src/hooks/income-expenses/statusMutations.ts`, gọi restore ở cùng file, và gọi `pay_draft_fee_voucher` từ `src/hooks/usePeriodFees.ts`;
- `public.restore_income_expense(uuid)` đổi `CANCELLED→APPROVED`, có side effect tái tạo payment và migration hiện chỉ revoke `anon`, chưa normalize `PUBLIC` ACL;
- FE cancel hiện direct-update `approval_status='CANCELLED'` rồi có thể hard-delete payment; đây là legacy path phải giữ tương thích cho unmarked rows nhưng tuyệt đối không được chạm canonical rows;
- `public.update_income_expense_quick(uuid,uuid,jsonb,text)` hiện cho creator/super-admin đổi `account_id`/attachments/notes mà không kiểm organization hoặc cashbook authority. Đây là đường payload mutation độc lập: nếu canonical draft cho phép `account_id=NULL`, guard chỉ chặn status sẽ vẫn cho nối cashbook cross-tenant về sau;
- inventory source còn có `update_period_fee`, `cancel_period_fee`, `append_fee_attachment`, `cancel_utility_bill`, `confirm_cancel_handover`, batch cancel/account update, salary promotion, payment-method/delete hooks và các paired-forfeit trigger. Một `BEFORE` guard trên parent + items phải là catch-all; danh sách wrapper không được xem là ranh giới đầy đủ;
- `useUploadPaymentReceipt` hiện cập nhật `payments.receipt_image_url` ở request riêng **trước** khi sửa attachments của voucher. Guard trên `income_expenses` có thể reject request thứ hai nhưng không rollback payment đã commit. Full posting containment phải chuyển flow này sang một RPC atomic và/hoặc guard `payments` khi liên kết với canonical voucher; không được tuyên bố containment toàn bộ chỉ từ trigger voucher.

Trước bất kỳ grant nào cho `create_income_expense_v1`, forward migration T3 phải chứng minh:

1. mọi exact signature/SQL caller/FE caller ở inventory trên đã pin theo commit và live catalog; không giả định chỉ có hai button RPC;
2. thêm server-owned marker độc lập với T5 ledger, ví dụ typed `canonical_flow`/`canonical_flow_version` + typed lifecycle state. Marker phải được ghi atomically **ngay khi tạo draft**; `approval_request_id` không đủ vì còn NULL trước submit, `approval_status='UNAPPROVED'` không đủ vì legacy row dùng chung trạng thái;
3. marker không client-writable: direct INSERT không được tự đánh dấu canonical; once canonical thì không thể clear/downgrade; organization/provenance/version immutable ngoài private transition routine;
4. legacy `approve_voucher`, `unapprove_voucher`, `pay_draft_fee_voucher`, `restore_income_expense`, `update_income_expense_quick`, direct cancel/payload update, salary/recurring promotion và mọi state writer đã inventory phải reject canonical-marked row **trước mọi effect**. Cho tới khi private `update_income_expense_v1` tồn tại, marked draft phải đóng băng khỏi mọi legacy payload mutation (đặc biệt `account_id`, items, amount, building/room/contract, attachments), không chỉ `approval_status`. Legacy unmarked rows chỉ giữ compatibility trong path đã review;
5. guard canonical transition dựa vào marker/state trên subject, không join ngược `canonical_write_operations`; T3 không phụ thuộc T5;
6. `is_super_admin()` không là normal tenant approval bypass. Platform emergency endpoint tách riêng, có tenant membership/context, exact permission, reason/re-auth/audit;
7. normalize ACL exact-signature: revoke `PUBLIC` trước khi grant allowlist; helper internal vẫn non-callable. Có thể giữ wrapper legacy callable cho unmarked rows nếu compatibility yêu cầu — containment không đồng nghĩa bắt buộc global revoke, nhưng không path callable nào được promote canonical row;
8. transition canonical chỉ qua private state-machine routine, lock subject, compare expected version, assert one affected row, revalidate permission/possession/account lock/evidence/amount/maker-checker/classification và append durable audit atomically.

Nếu full T3 v2 chưa hoàn thành, mức tối đa cho T5 sau containment vẫn chỉ là **draft bất hoạt**: không có endpoint approve/post tạm, không maker tự approve, không wire frontend. Pending draft được `account_id = NULL`; final posting mới bắt buộc chọn account và revalidate `cashbooks.post`, possession, lock date, evidence, amount, maker-checker và force-classification.

**Test containment bắt buộc:**

- exact `has_function_privilege` phù hợp allowlist trên mọi signature; helper/private functions false cho `PUBLIC`, `anon`, `authenticated`, `service_role`;
- maker gọi legacy approve cho canonical draft do chính họ tạo bị deny/no-effect;
- legacy unapprove/pay/restore/cancel/quick-edit/direct PostgREST payload hoặc lifecycle update đều bị deny/no-effect trên canonical row; riêng quick-edit không thể gắn account khác org vào draft `account_id=NULL`;
- direct client insert không thể tự gắn marker, direct update không thể clear marker hoặc giả state/version;
- platform super-admin không có tenant authority không promote qua normal path;
- unmarked legacy draft đã review vẫn approve/unapprove/pay/restore đúng behavior để containment không tạo global regression;
- existing approved legacy rows không bị mutate bởi migration;
- rollback-injection chứng minh marker/header/audit atomic; money reconciliation pre/post bằng nhau và browser legacy flow ngoài scope không regression.

---

## 5. Test evidence trước production

- Project restore/staging ID: `<chưa cấp cho exact T3 source>`; recovery local `ACCEPTED_LOCAL` không thay thế disposable/direct JWT/concurrency test target.
- Unit/property tests (Vitest + fast-check): rule precedence `DENY > force REQUIRE_APPROVAL > priority > fallback`; canonical hash determinism; submission_no; quorum ANY/ALL/QUORUM; self-limit boundary; correlation-batch anti-split.
- Direct JWT REST/RPC matrix (`AUTHORIZATION-PLAN.md` §8.2 approval tests): member không có submit permission → deny; client giả `internal_settlement` → deny/không auto-post; maker tự approve → deny; candidate cũ sau revoke → deny; hai approver đồng thời → đúng quorum; retry same key/same payload → một effect; same key/different payload → conflict; hai request đồng thời cùng key → một operation; collision/reuse key khác org/subject/caller → không trả ID lạ; sửa voucher sau submit rồi decide → chặn hoặc submission mới; reject/cancel→sửa→resubmit + concurrent resubmit → một submission_no mới; posting khi subject xóa/đổi state/affected-row=0 → rollback toàn bộ; rule publish khi request mở; multi-step; emergency thiếu quyền/reason → deny; super-admin không membership → attribution hợp lệ không mượn OWNER; double reversal → chặn; `POSTED→REVERSED` giữ original immutable; audit row không UPDATE/DELETE được; cross-org voucher/account/building IDs → deny.
- Cross-org/foreign-resource tests: hai organization thật, non-null org, JWT thật (không disable trigger — `docs/Kết luận kiểm tra.md` §8.1).
- Concurrent/retry/rollback-injection: inject failure từng bước → rollback; chain-head fork test.
- `npm run typecheck:baseline`: phải không tăng lỗi.
- `npx tsc --noEmit -p tsconfig.app.json`: `<ghi>` (root `tsc` không check — CLAUDE.md).
- Related/full Vitest: `<ghi>`
- `npm run lint` / `npm run build`: `<ghi>`
- `node scripts/check-definer-acl.mjs`: mọi SECURITY DEFINER function T3 có explicit signature ACL + pinned search path; baseline exposure không tăng.
- `node scripts/check-view-invoker.mjs`: nếu đụng VIEW.
- Generated Supabase type drift: `npm run gen:types` không drift.
- Full money reconciliation: `node scripts/reconcile-money.mjs` + mở rộng INCOME/EXPENSE, invoice/payment/credit, reversal pairs (`docs/Kết luận kiểm tra.md` §8.3); delta ngoài transaction test = 0.
- Browser happy/edge/deny + console/network: `<sau khi có staging; T3 không wire nên chủ yếu direct API>`
- Shadow evaluation (T1e): so intended decision vs legacy, không mismatch chưa giải thích.
- Reviewer verdict: `<chưa cấp>`

---

## 6. Canary và production gate

- Canary organization/users: `<chưa cấp>`
- **Transaction count cap: `0`** (default — không flip).
- **VND cap: `0`** (default — không flip).
- Observation interval: tối thiểu một business cycle sau khi wire (T5), không áp trong T3.
- Expansion approval / Old writer drain proof / Exact revoke/policy/signature: `n/a` cho T3 (không wire; grant/callable review thuộc T5).

**Default nếu chưa được owner chốt: canary count = `0`, VND cap = `0`, flag = `OFF`, không apply/flip.** T3 chỉ được apply schema/function ở trạng thái non-callable sau khi recovery `VERIFIED` + T1a/T2 đạt gate + `ORG_READY(APPROVAL)` (không phải full T6a — xem §1) + owner cấp exact SHA/hash/window.

---

## 7. Mandatory abort

Abort ngay khi có một trong các điều kiện:

- unauthorized hoặc cross-org success (client post/decide không đủ exact permission, hoặc chạm subject/account/building khác org);
- client-supplied classification tạo auto-post;
- financial drift khác 0;
- duplicate payment/posting/reversal (double-post, double-reverse, same-key tạo >1 operation);
- orphan/split operation (request POSTED nhưng voucher không post, hoặc ngược lại);
- maker tự duyệt phiếu force-approval, hoặc self-limit bị lách bằng chia nhỏ;
- unexpected legacy writer trên `income_expenses` posting metadata;
- backup/object hash mismatch;
- canary happy path bị deny không giải thích;
- 3 RPC failure liên tiếp hoặc >1% trong 5 phút;
- p95 > 2× baseline trong 10 phút;
- mất monitoring/backup/audit telemetry (kể cả audit chain-head lock lỗi/fork).

Khi abort: disable canary, freeze domain, giữ evidence; **không xóa/sửa row tiền để rollback**. Reconcile, forward-fix và tạo compensating reversal khi cần. Không tự re-grant prototype `submit_financial_voucher`/`decide_financial_voucher` để chữa availability (T1a nguyên tắc).

---

## 8. Post-apply evidence

- Apply start/end UTC: `<ghi>`
- Catalog/signature/grant pre/post diff: xác nhận contract-v2 functions tồn tại với `has_function_privilege(authenticated) = false`; prototype vẫn revoked; `approval_requests.state` CHECK chứa `REVERSED`; `authorization_audit_events.organization_id` non-null enforced; permission keys mới có mặt.
- Direct API deny/allow result: JWT matrix §5 chạy trên restore project; deny cho mọi callable-surface test (vì chưa grant).
- Browser result: smoke flow thu-chi hiện hữu không regression (contract v2 chưa wire).
- Reconciliation delta: = 0 ngoài transaction test.
- Runtime error/latency/deny metrics: `<ghi>`
- Hidden caller/legacy writer result: 0 caller prototype; theo dõi tối thiểu một ngày làm việc.
- Observation completed at / Final reviewer: `<ghi>`
- Final state (`APPLIED` hoặc `VERIFIED`): mục tiêu tối đa `APPLIED` (non-callable); `VERIFIED` chỉ sau observation + evidence bắt buộc.
- Tracker update commit: cập nhật `AUTHORIZATION-IMPLEMENTATION-STATUS.md` T3.

Evidence không được chứa credential, JWT, signed URL, private object path hoặc PII.

---

## Phụ lục — SQL intent review-only (chưa phải migration được duyệt)

> **PREPARATION ONLY / NO-GO:** các block dưới đây là nguồn để review contract, không phải migration được phép chạy. Không copy vào `supabase/migrations/`, không grant, không route, không apply production. Exact migration chỉ được tách từ source đã review sau live-catalog preflight, disposable PostgreSQL 17/JWT/concurrency suite và gate recovery/owner. SQL dưới đây cố ý không tạo trusted bypass cho state machine tương lai; create-only containment đóng băng canonical row sau claim.

### A.1 Provenance sidecar độc lập T5 ledger

`canonical_write_operations` thuộc idempotency T5 và có thể được cleanup theo retention; nó không được dùng làm ownership marker. Sidecar T3 là server-owned, immutable và sống độc lập với `approval_request_id` còn NULL trước submit.

```sql
begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated, service_role;

-- Composite tenant FK target; preflight phải abort nếu organization_id còn NULL.
create unique index if not exists income_expenses_org_id_uidx
  on public.income_expenses(organization_id, id);

create table if not exists app_private.income_expense_flow_ownership (
  income_expense_id uuid primary key,
  organization_id uuid not null,
  flow_kind text not null default 'CANONICAL_INCOME_EXPENSE'
    check (flow_kind = 'CANONICAL_INCOME_EXPENSE'),
  flow_version smallint not null default 1 check (flow_version = 1),
  lifecycle_owner text not null default 'APPROVAL_ENGINE_V2'
    check (lifecycle_owner = 'APPROVAL_ENGINE_V2'),
  lifecycle_state text not null default 'DRAFT'
    check (lifecycle_state = 'DRAFT'),
  writer_operation text not null
    check (writer_operation = 'income_expense.create_draft.v1'),
  payload_hash_scheme text not null
    check (payload_hash_scheme = 'PG_MD5_JSONB_TEXT_V1'),
  payload_hash_value text not null
    check (payload_hash_value ~ '^[0-9a-f]{32}$'),
  maker_user_id uuid not null,
  claimed_by_user_id uuid not null,
  correlation_id uuid,
  claimed_at timestamptz not null default clock_timestamp(),
  unique (organization_id, income_expense_id),
  foreign key (organization_id, income_expense_id)
    references public.income_expenses(organization_id, id) on delete restrict
  -- Actor IDs là immutable logical identity; không FK auth.users để identity cleanup
  -- không xóa provenance hoặc chặn lifecycle user.
);

create table if not exists app_private.income_expense_flow_ownership_events (
  event_id uuid primary key default gen_random_uuid(),
  income_expense_id uuid not null,
  organization_id uuid not null,
  event_type text not null check (event_type = 'FLOW_CLAIMED'),
  flow_version smallint not null check (flow_version = 1),
  lifecycle_state text not null check (lifecycle_state = 'DRAFT'),
  writer_operation text not null,
  payload_hash_scheme text not null,
  payload_hash_value text not null check (payload_hash_value ~ '^[0-9a-f]{32}$'),
  actor_user_id uuid not null,
  correlation_id uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, income_expense_id)
    references app_private.income_expense_flow_ownership(
      organization_id, income_expense_id
    ) on delete restrict
);

revoke all on app_private.income_expense_flow_ownership,
  app_private.income_expense_flow_ownership_events
  from public, anon, authenticated, service_role;

commit;
```

Hash scheme `PG_MD5_JSONB_TEXT_V1` phải bằng exact writer computation `md5(v_canonical_payload::text)`; đây chỉ là equality token để phát hiện payload mismatch, không phải chữ ký ownership hoặc security capability.

### A.2 Claim helper: final construction → claim → audit → operation completion

Claim chạy **sau** item triggers, derived validation, deferred `contract_id` attach, side-effect assertions và final canary boundary; chạy **trước** canonical audit append và idempotency operation completion. Row unmarked chưa visible trước commit, nên claim muộn trong cùng transaction vẫn atomic khi draft trở nên visible.

```sql
create or replace function app_private.claim_canonical_income_expense_draft_v1(
  p_income_expense_id uuid,
  p_idempotency_key text
) returns void
language plpgsql
security invoker
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_row public.income_expenses%rowtype;
  v_actor uuid := auth.uid();
  v_operation app_private.canonical_write_operations%rowtype;
  v_inserted integer;
begin
  if current_user <> 'ie_canonical_writer' then
    raise exception 'canonical claim capability required' using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into v_row
    from public.income_expenses ie
   where ie.id = p_income_expense_id
   for update;
  if not found then
    raise exception 'income expense not found' using errcode = 'P0002';
  end if;

  if v_row.organization_id is null
     or v_row.user_id is distinct from v_actor
     or v_row.approval_status <> 'UNAPPROVED'
     or v_row.approval_request_id is not null
     or v_row.posting_id is not null
     or v_row.posted_at_v2 is not null
     or v_row.reversed_by_posting_id is not null
     or v_row.system_source is not null
     or v_row.source_payload_hash is null
     or v_row.source_payload_hash !~ '^[0-9a-f]{32}$' then
    raise exception 'row is not claimable as a canonical draft'
      using errcode = '23514';
  end if;

  select o.* into v_operation
    from app_private.canonical_write_operations o
   where o.organization_id = v_row.organization_id
     and o.operation = 'income_expense.create_draft.v1'
     and o.subject_scope = v_row.building_id::text
     and o.actor_id = v_actor
     and o.idempotency_key = p_idempotency_key
     and o.subject_id is null
     and o.response_payload is null
     and o.completed_at is null
     and o.payload_hash = v_row.source_payload_hash
   for update;
  if not found then
    raise exception 'matching in-progress canonical writer operation not found'
      using errcode = '23514';
  end if;

  insert into app_private.income_expense_flow_ownership (
    income_expense_id, organization_id, writer_operation,
    payload_hash_scheme, payload_hash_value,
    maker_user_id, claimed_by_user_id, correlation_id
  ) values (
    v_row.id, v_row.organization_id, v_operation.operation,
    'PG_MD5_JSONB_TEXT_V1', v_row.source_payload_hash,
    v_row.user_id, v_actor, v_row.correlation_id
  ) on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 1 then
    raise exception 'canonical draft provenance already exists or conflicted'
      using errcode = '23505';
  end if;

  insert into app_private.income_expense_flow_ownership_events (
    income_expense_id, organization_id, event_type, flow_version,
    lifecycle_state, writer_operation, payload_hash_scheme,
    payload_hash_value, actor_user_id, correlation_id
  ) values (
    v_row.id, v_row.organization_id, 'FLOW_CLAIMED', 1,
    'DRAFT', v_operation.operation, 'PG_MD5_JSONB_TEXT_V1',
    v_row.source_payload_hash, v_actor, v_row.correlation_id
  );
end;
$fn$;

revoke all on function app_private.claim_canonical_income_expense_draft_v1(uuid,text)
  from public, anon, authenticated, service_role;
```

Review exact-source phải đóng capability boundary của helper này. Helper claim phải là `SECURITY INVOKER`; guard lookup/freeze có thể là `SECURITY DEFINER` để đọc private marker dưới mọi caller nhưng không được có allow-bypass nào dựa trên identity. `SECURITY DEFINER` cùng owner `postgres` với legacy wrappers không tự tạo trust boundary. Acceptable release design phải chứng minh helper claim chỉ reachable từ exact T5 wrapper qua dedicated `NOLOGIN`, `NOBYPASSRLS`, non-table-owner role (ví dụ exact wrapper được own bởi `ie_canonical_writer`) hoặc cơ chế equivalent đã compile/test; không trust `postgres`, `service_role`, `current_user != authenticated`, session GUC, JWT claim, static secret, `session_user`, `application_name` hoặc `pg_trigger_depth()`.

Exact writer integration point:

```sql
-- Sau final invariant/canary checks, trước audit + operation completion:
perform app_private.claim_canonical_income_expense_draft_v1(
  v_row.id, v_idempotency_key
);
select * into v_row
  from public.income_expenses
 where id = v_row.id;
```

### A.3 Full-freeze parent/items và TRUNCATE containment

Containment create-only không có bypass hợp lệ. Một marked row không được UPDATE/DELETE; child của marked parent không được INSERT/UPDATE/DELETE. Điều này chặn direct PostgREST, legacy `SECURITY DEFINER`, owner/service-role/RLS bypass, FK `ON DELETE SET NULL/CASCADE` và wrapper chưa inventory. Future `update_financial_draft`/state transition phải thay bằng state-machine contract exact-role + CAS, không nới guard theo GUC hoặc owner role chung.

```sql
create or replace function app_private.is_income_expense_flow_owned(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
  select exists (
    select 1
      from app_private.income_expense_flow_ownership o
     where o.income_expense_id = p_id
  );
$fn$;

create or replace function app_private.reject_income_expense_flow_ownership_mutation()
returns trigger
language plpgsql
security invoker
set search_path to 'pg_catalog', 'app_private'
as $fn$
begin
  raise exception 'canonical provenance is immutable'
    using errcode = '55000';
end;
$fn$;

create or replace function app_private.reject_income_expense_flow_truncate()
returns trigger
language plpgsql
security invoker
set search_path to 'pg_catalog', 'app_private'
as $fn$
begin
  raise exception 'canonical provenance history cannot be truncated'
    using errcode = '55000';
end;
$fn$;

create or replace function app_private.guard_income_expense_owned_payload()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
begin
  if tg_op = 'INSERT' then
    return new;
  end if;

  if app_private.is_income_expense_flow_owned(old.id) then
    raise exception 'canonical income/expense is frozen for approval engine v2'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

create or replace function app_private.guard_income_expense_owned_items()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
declare
  v_old_parent uuid;
  v_new_parent uuid;
begin
  if tg_op <> 'INSERT' then v_old_parent := old.income_expense_id; end if;
  if tg_op <> 'DELETE' then v_new_parent := new.income_expense_id; end if;

  if (v_old_parent is not null
      and app_private.is_income_expense_flow_owned(v_old_parent))
     or (v_new_parent is not null
      and app_private.is_income_expense_flow_owned(v_new_parent)) then
    raise exception 'canonical income/expense items are frozen for approval engine v2'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$fn$;

create or replace function app_private.guard_income_expense_truncate()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private'
as $fn$
begin
  if exists (select 1 from app_private.income_expense_flow_ownership) then
    raise exception 'cannot truncate while canonical income/expense exists'
      using errcode = '55000';
  end if;
  return null;
end;
$fn$;

drop trigger if exists a00_ie_flow_ownership_immutable
  on app_private.income_expense_flow_ownership;
create trigger a00_ie_flow_ownership_immutable
before update or delete on app_private.income_expense_flow_ownership
for each row execute function
  app_private.reject_income_expense_flow_ownership_mutation();
alter table app_private.income_expense_flow_ownership
  enable always trigger a00_ie_flow_ownership_immutable;

drop trigger if exists a00_ie_flow_ownership_events_immutable
  on app_private.income_expense_flow_ownership_events;
create trigger a00_ie_flow_ownership_events_immutable
before update or delete on app_private.income_expense_flow_ownership_events
for each row execute function
  app_private.reject_income_expense_flow_ownership_mutation();
alter table app_private.income_expense_flow_ownership_events
  enable always trigger a00_ie_flow_ownership_events_immutable;

drop trigger if exists a00_ie_flow_ownership_truncate_immutable
  on app_private.income_expense_flow_ownership;
create trigger a00_ie_flow_ownership_truncate_immutable
before truncate on app_private.income_expense_flow_ownership
for each statement execute function
  app_private.reject_income_expense_flow_truncate();
alter table app_private.income_expense_flow_ownership
  enable always trigger a00_ie_flow_ownership_truncate_immutable;

drop trigger if exists a00_ie_flow_ownership_events_truncate_immutable
  on app_private.income_expense_flow_ownership_events;
create trigger a00_ie_flow_ownership_events_truncate_immutable
before truncate on app_private.income_expense_flow_ownership_events
for each statement execute function
  app_private.reject_income_expense_flow_truncate();
alter table app_private.income_expense_flow_ownership_events
  enable always trigger a00_ie_flow_ownership_events_truncate_immutable;

drop trigger if exists a00_ie_owned_payload_freeze
  on public.income_expenses;
create trigger a00_ie_owned_payload_freeze
before insert or update or delete on public.income_expenses
for each row execute function app_private.guard_income_expense_owned_payload();
alter table public.income_expenses
  enable always trigger a00_ie_owned_payload_freeze;

drop trigger if exists a00_ie_item_owned_payload_freeze
  on public.income_expense_items;
create trigger a00_ie_item_owned_payload_freeze
before insert or update or delete on public.income_expense_items
for each row execute function app_private.guard_income_expense_owned_items();
alter table public.income_expense_items
  enable always trigger a00_ie_item_owned_payload_freeze;

drop trigger if exists a00_ie_owned_truncate_freeze
  on public.income_expenses;
create trigger a00_ie_owned_truncate_freeze
before truncate on public.income_expenses
for each statement execute function app_private.guard_income_expense_truncate();
alter table public.income_expenses
  enable always trigger a00_ie_owned_truncate_freeze;

drop trigger if exists a00_ie_items_owned_truncate_freeze
  on public.income_expense_items;
create trigger a00_ie_items_owned_truncate_freeze
before truncate on public.income_expense_items
for each statement execute function app_private.guard_income_expense_truncate();
alter table public.income_expense_items
  enable always trigger a00_ie_items_owned_truncate_freeze;

revoke all on function app_private.is_income_expense_flow_owned(uuid),
  app_private.reject_income_expense_flow_ownership_mutation(),
  app_private.reject_income_expense_flow_truncate(),
  app_private.guard_income_expense_owned_payload(),
  app_private.guard_income_expense_owned_items(),
  app_private.guard_income_expense_truncate()
  from public, anon, authenticated, service_role;
```

`ENABLE ALWAYS` không bảo vệ trước DB owner/superuser chủ động disable trigger hoặc restore dùng `--disable-triggers`; restore runbook phải cấm điều đó cho canonical tables và assert catalog `tgenabled='A'` sau restore.

### A.4 Legacy wrapper pre-effect rejection và prototype fail-closed

Mỗi legacy wrapper phải `SELECT ... FOR UPDATE`, reject marker ngay sau lock và **trước** account/attachment/payment/invoice/audit effect. Global `ENABLE ALWAYS` trigger là backstop, không thay row-level precheck. Review exact bodies/signatures cho ít nhất:

```text
approve_voucher(uuid)
unapprove_voucher(uuid)
pay_draft_fee_voucher(uuid,uuid,jsonb)
restore_income_expense(uuid)
update_income_expense_quick(uuid,uuid,jsonb,text)
update_period_fee / cancel_period_fee / append_fee_attachment
cancel_utility_bill / confirm_cancel_handover
salary/recurring promotion, batch cancel/account update
all direct cancel/payload/status writers
```

Wrapper quick-edit của legacy unmarked row phải verify target account cùng organization; không còn `is_super_admin()` như tenant authorization shortcut. Prototype approval functions vẫn là fail-closed/non-callable stubs tới khi T3 v2 hoàn tất:

```sql
create or replace function public._post_financial_voucher(
  p_voucher uuid, p_request uuid, p_actor uuid
) returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
begin
  raise exception 'prototype posting disabled; approval engine v2 not callable'
    using errcode = '0A000';
end;
$fn$;

create or replace function public.submit_financial_voucher(
  p_voucher uuid, p_idempotency_key text default null,
  p_system_source text default null, p_txn_type text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
begin
  raise exception 'prototype approval submit disabled'
    using errcode = '0A000';
end;
$fn$;

create or replace function public.decide_financial_voucher(
  p_request uuid, p_decision text, p_reason text,
  p_expected_version bigint
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
begin
  raise exception 'prototype approval decide disabled'
    using errcode = '0A000';
end;
$fn$;

revoke all on function public._post_financial_voucher(uuid,uuid,uuid),
  public.submit_financial_voucher(uuid,text,text,text),
  public.decide_financial_voucher(uuid,text,text,bigint)
  from public, anon, authenticated, service_role;
```

Không re-grant prototype để chữa availability. Exact migration phải kiểm hidden/internal caller trước khi thay body; T1a revoke hiện chỉ contain submit/decide client surface, không chứng minh `_post_financial_voucher` hoặc nested caller an toàn.

### A.5 Durable canonical audit foundation

Nâng cấp `income_expense_audit_log` hiện hữu thành canonical source thay vì tạo lifecycle audit source thứ hai. Ownership event A.1 chỉ chứng minh provenance claim. Semantic create/submit/decide/post/reverse/cancel events phải append qua một private primitive duy nhất.

Review-only target:

```sql
begin;

-- Preflight: backfill organization_id từ subject phải zero unresolved trước NOT NULL.
-- Drop destructive subject FK sau khi lưu exact constraint name từ live catalog;
-- giữ income_expense_id như logical subject id để audit sống sau subject retention.
alter table public.income_expense_audit_log
  drop constraint if exists income_expense_audit_log_income_expense_id_fkey,
  alter column organization_id set not null,
  add column if not exists sequence_no bigint,
  add column if not exists event_type text,
  add column if not exists actor_membership_id uuid,
  add column if not exists before_state jsonb,
  add column if not exists after_state jsonb,
  add column if not exists changed_fields text[] not null default array[]::text[],
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists prev_event_hash text,
  add column if not exists event_hash text;

create unique index if not exists income_expense_audit_org_sequence_uidx
  on public.income_expense_audit_log(organization_id, sequence_no)
  where sequence_no is not null;

create table if not exists app_private.income_expense_audit_chain_heads (
  organization_id uuid primary key
    references public.organizations(id) on delete restrict,
  last_sequence_no bigint not null default 0,
  last_event_hash text,
  updated_at timestamptz not null default clock_timestamp()
);

revoke all on app_private.income_expense_audit_chain_heads
  from public, anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.income_expense_audit_log
  from public, anon, authenticated, service_role;

commit;
```

`app_private.append_income_expense_event_v1(...)` phải lock chain head `(organization_id) FOR UPDATE`, cấp `sequence_no`, snapshot actor/membership/building/account/restricted indicator, whitelist `before_state/after_state`, tính SHA-256 deterministic trên canonical event payload + `prev_event_hash`, insert đúng một event và update head cùng transaction. Exact implementation phải compile trong environment có digest primitive và prove no fork under concurrency; không dùng `md5` cho audit chain. `log_income_expense_action(uuid,text,text)` client-forgeable phải bị thay/revoke sau caller inventory. Audit mutation/TRUNCATE guard phải `ENABLE ALWAYS`; không policy `FOR ALL` cho super-admin.

### A.6 Approval-state target vẫn non-callable

```sql
-- State model target: REVERSED chỉ được apply cùng complete reversal contract.
alter table public.approval_requests
  drop constraint if exists approval_requests_state_check;
alter table public.approval_requests
  add constraint approval_requests_state_check
  check (state in (
    'PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED'
  ));

-- T3 private implementation, KHÔNG grant authenticated.
create or replace function app_private.decide_financial_approval_v2(
  p_request uuid, p_decision text, p_reason text,
  p_expected_version bigint, p_posting_cashbook uuid default null,
  p_evidence jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
begin
  -- organization+subject+request lock order; T2 resolver v3;
  -- CAS; maker-checker; current-generation candidate; hash revalidation;
  -- exact cashbook permission+possession; immutable audit; exactly-once posting.
  raise exception 'contract v2 review-only; not implemented or callable'
    using errcode = '0A000';
end;
$fn$;

revoke all on function app_private.decide_financial_approval_v2(
  uuid,text,text,bigint,uuid,jsonb
) from public, anon, authenticated, service_role;
```

### A.7 Payment-receipt cross-request boundary

`useUploadPaymentReceipt` hiện update payment trước rồi mới update voucher attachments ở request khác. Voucher guard không rollback request payment đã commit. Trước full containment/wire, phải có một trong hai (ưu tiên cả hai):

1. atomic RPC lock payment + linked voucher, revalidate org/permission/provenance, update receipt evidence + canonical voucher snapshot/audit cùng transaction; frontend chỉ gọi RPC đó. Design chi tiết (review 2026-07-17): `public.attach_payment_receipt_v1(p_payment_id, p_receipt_url, p_idempotency_key)` — SECURITY DEFINER pinned search_path; URL validate server-side + pin host/path vào storage endpoint của project và folder member đúng org (evidence resource-bound, không free-text); lock order khớp v3 `invoice → payment → voucher`; lock **mọi** voucher match theo `payment_id` (không LIMIT 1); reject khi voucher là canonical-marked nếu chưa qua private transition;
2. `payments` guard reject direct update/delete khi payment đang link canonical voucher, cộng FK-side-effect tests.

Các path liên quan cũng cần đóng trong cùng slice: `useUpdatePaymentMethod` (update `income_expenses.account_id` TRƯỚC rồi `payments.payment_method` — split-brain nếu request 2 fail; cashbook resolve bằng client-side name matching); `useDeletePayment` (3 commit riêng: soft-delete voucher → hard-delete excess → hard-delete payment — RLS count=0 ở bước 3 để lại voucher đã soft-delete và credit đã hủy); v3 replay keyed trên `income_expenses.idempotency_key` nên payment KHÔNG kèm voucher (`p_account_id IS NULL`) không có replay record — retry có thể double-insert payment đó.

Không nâng T3/T5 lên `PREPARED`, không grant create writer và không gọi posting containment đầy đủ cho tới khi test failure-injection chứng minh không còn partial receipt effect.

### A.8 Containment test matrix bắt buộc

- claim đúng vị trí sau construction và rollback cùng header/items/audit/operation khi inject failure;
- same row không claim hai lần; wrong actor/org/hash/operation không claim được;
- marker/event không UPDATE/DELETE/TRUNCATE được qua authenticated, service_role, table owner path và replica mode;
- marked parent UPDATE/DELETE, child INSERT/UPDATE/DELETE, parent/items TRUNCATE, FK CASCADE/SET NULL đều deny/no-effect;
- maker không promote canonical draft qua approve/unapprove/pay/restore/cancel/quick-edit/status/batch/salary/recurring wrapper;
- legacy unmarked rows đã review vẫn giữ behavior, quick-edit không gắn account cross-org;
- direct item DML không thay amount/derived fields; no blanket derived-update exception;
- `tgenabled='A'` cho mọi guard sau apply và sau restore rehearsal;
- exact ACL false cho `PUBLIC`, `anon`, `authenticated`, `service_role` trên helper/private/prototype;
- audit subject retention không cascade-delete event; audit UPDATE/DELETE/TRUNCATE deny; concurrent append không fork hash chain;
- upload receipt failure giữa các effect rollback toàn bộ;
- current PostgreSQL 17 exact-source compile + function/catalog fingerprint + rollback-only suite + independent zero-residue probe;
- money reconciliation pre/post delta 0 và browser legacy regression + console/network sạch.

### A.9 Kết quả vòng review đối kháng 2026-07-17 (40-luồng) — defects PHẢI đóng trước khi tách migration

Các appendix A.1–A.8 vẫn review-only. Vòng review độc lập xác nhận các defect sau; exact migration không được tách khi chưa xử lý hết:

**BLOCKING (claim path không thể chạy như đang viết):**

1. **Role `ie_canonical_writer` chưa từng được tạo và wrapper chưa re-own.** Doc chỉ nhắc tên role; không có `CREATE ROLE`, không `ALTER FUNCTION ... OWNER TO`. Wrapper hiện owner `postgres` → `current_user='postgres'` → claim luôn raise 42501. Exact migration phải: `CREATE ROLE ie_canonical_writer NOLOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;` + `ALTER FUNCTION public.create_income_expense_v1(...) OWNER TO ie_canonical_writer` (postgres cần transient `GRANT ie_canonical_writer TO postgres` + `CREATE` on schema public cho role lúc transfer, sau đó revoke; giữ ADMIN OPTION cho future `CREATE OR REPLACE`).
2. **Zero privilege/RLS path cho role — claim fail-closed kể cả có role.** Helper SECURITY INVOKER dưới `ie_canonical_writer`: (a) `SELECT ... FOR UPDATE` trên `income_expenses` trả 0 row vì RLS policies đều `TO authenticated`, role NOBYPASSRLS + không owner + không privilege (FOR UPDATE cần UPDATE privilege); (b) `app_private` bị revoke USAGE toàn bộ, không GRANT nào cho role. **Shape khuyến nghị (smallest secure executable):** thin wrapper owner `ie_canonical_writer` chỉ orchestrate 3 subroutine: `app_private.ie_create_validate_and_insert_v1` (DEFINER/postgres — mọi validation/lock/insert, EXECUTE chỉ grant cho role), claim helper INVOKER (row-lock delegate cho sub-helper DEFINER/postgres; INSERT ownership tables giữ invoker-side, grant INSERT CHỈ cho role → hai gate độc lập), `app_private.ie_complete_operation_v1` (DEFINER/postgres — completion + reread). Grants của role co lại: USAGE `app_private`+`auth`, EXECUTE 3 subroutine + `auth.uid()`, INSERT 2 ownership table, SELECT+UPDATE `canonical_write_operations` (hoặc delegate). KHÔNG grant/policy nào trên business table, KHÔNG `auth.users`.
3. **A.5 `SET NOT NULL` organization_id phá live cancel/restore:** `income_expense_audit_log` KHÔNG nằm trong trigger list `_autofill_org`; `log_income_expense_action` (gọi từ production FE mỗi lần cancel — `statusMutations.ts:97`) và `restore_income_expense` insert không có organization_id → NULL tiếp tục tích lũy sau backfill; ALTER hoặc fail lúc apply hoặc làm mọi cancel/restore sau đó raise 23502. Sửa trong CÙNG transaction: CREATE OR REPLACE cả hai function derive org từ parent voucher → backfill residual → assert zero NULL → mới SET NOT NULL.

**HIGH:**

4. **Thứ tự migration phải tường minh:** A.2 phụ thuộc `canonical_write_operations` (artifact T5 CHƯA apply). Order: T5 ledger table → A.1 sidecar → role+grants → A.2 helper → A.3 triggers → A.4/A.5/A.6.
5. **FK-name-mismatch silent no-op (A.5):** `DROP CONSTRAINT IF EXISTS` im lặng nếu tên live khác → CASCADE FK còn sống. Thêm assert fail-closed sau drop: không còn FK `confdeltype='c'` trên bảng audit.
6. **Non-concurrent `CREATE UNIQUE INDEX` trên `income_expenses` trong transaction:** SHARE lock bảng tiền nóng nhất suốt build. Tách thành `CREATE UNIQUE INDEX CONCURRENTLY` ở bước non-transactional riêng (sau NULL-org preflight), rồi `ALTER TABLE ... ADD CONSTRAINT income_expenses_org_id_key UNIQUE USING INDEX ...` để FK trỏ vào constraint được khai báo (không phải bare index).
7. **`user_id → auth.users ON DELETE CASCADE` trên `income_expenses` (live từ `20250120000001`):** hiện xóa auth user CASCADE-xóa voucher; sau freeze, xóa user tạo marked voucher abort 55000 vĩnh viễn. T3 phải migrate FK này sang RESTRICT/NO ACTION trước freeze rollout. Đồng thời enumerate blast radius SET NULL fan-in (account/contract/payment/invoice/handover/room/tenant/self-FK `repeat_parent_id`...) vào runbook + tests; quyết định tường minh cho `income_expense_batches` và bảng restore-audit (CASCADE, KHÔNG được freeze phủ — hoặc mở rộng guard hoặc ghi accepted gap.
8. **TOCTOU khi claim row đã visible:** flow hiện tại claim row cùng transaction (invisible → an toàn); nếu tương lai claim row pre-existing, thêm `PERFORM 1 FROM income_expenses WHERE id=... FOR UPDATE` trước INSERT ownership để concurrent UPDATE chờ rồi thấy marker.
9. **Trigger `canonical_write_operations_immutable`/`_no_truncate` của artifact T5 chưa `ENABLE ALWAYS`** — dưới `session_replication_role='replica'` chúng không fire. Forward fix bắt buộc khi artifact được rework.

**MEDIUM/LOW (đóng khi viết exact migration):** wrap A.2+A.3 (và DROP→ADD state check A.6 — dùng một statement `ALTER TABLE ... DROP CONSTRAINT ..., ADD CONSTRAINT ...`) trong một transaction; retrofit-assert shape khi `CREATE TABLE IF NOT EXISTS` gặp bảng pre-existing; A.4 giữ hay bỏ DEFAULTs của `decide_financial_voucher` phải là quyết định tường minh + caller inventory; A.5 phải DROP policy super-admin `FOR ALL` (không chỉ revoke); index cho events FK `(organization_id, income_expense_id)`; guard payload freeze chỉ cần `BEFORE UPDATE OR DELETE` (bỏ INSERT branch); preflight assert không có BEFORE trigger nào sort trước `a00_` (C-collation: digit/underscore/uppercase < 'a'); thêm regex CHECK `^[0-9a-f]{32}$` cho `canonical_write_operations.payload_hash`; cấm tường minh `DISABLE TRIGGER ALL` trong restore runbook (nó tắt cả RI constraint triggers).

**A.5 audit-chain — bổ sung contract trước implement:** (i) canonical serialization phải đặc tả byte-level: pin timezone/render timestamp UTC cố định, normalize numeric spelling (bài học writer), NULL-vs-absent, array ordering, separator preimage, genesis sentinel; thêm cột `hash_scheme text NOT NULL` (vd `PG_SHA256_CANONICAL_V1`); (ii) preimage phải bind `organization_id` + `sequence_no` (chống splice cross-org/swap); (iii) dùng `pg_catalog.sha256()` built-in, không pgcrypto (schema `extensions` vỡ pinned search_path); (iv) bootstrap head-row: `INSERT ... ON CONFLICT DO NOTHING` rồi `SELECT ... FOR UPDATE`; chain head là lock CUỐI CÙNG trước INSERT trong global lock order; (v) ghi rõ quan hệ với `authorization_audit_events` (bảng applied có prev_hash/event_hash NOT NULL nhưng không head/writer/scheme — phải declare subordinate/deprecated hoặc unify một primitive có `chain_partition`); (vi) CHECK ràng nullability `sequence_no`↔`event_hash` (không cho row half-chained); (vii) phải có chain-verify function (recompute từ genesis) — chain không có verifier là dead weight; (viii) inventory INSERT bypass: `restore_income_expense` direct INSERT và writer T5 direct INSERT phải chuyển về primitive; enforce bằng ENABLE ALWAYS trigger reject row `event_hash IS NULL` (không chỉ role grant).
