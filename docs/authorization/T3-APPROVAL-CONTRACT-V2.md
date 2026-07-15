# Authorization tranche `T3` — Approval contract v2, non-callable helpers

> Trạng thái: `IN_DESIGN`
> Production mutation: **không được phép**. Apply/canary `BLOCKED` cho đến khi (a) recovery set `VERIFIED`, (b) T1a containment và T2/T6a đạt gate phụ thuộc, và (c) owner cấp exact commit SHA + migration SHA-256 + maintenance window + canary count/VND cap (mặc định `0` = không flip). Phê duyệt tài liệu này KHÔNG phải phê duyệt áp production.

## 0. Vì sao tranche này tồn tại

Prototype approval engine Sprint 4 (`20260713130000_sprint4a_*`, `20260713130200_sprint4c_*`) đã `APPLIED` nhưng độc lập audit (`docs/Kết luận kiểm tra.md` §2–§3, `AUTHORIZATION-PLAN.md` §27.1) bác claim production-ready. T3 định nghĩa **contract v2** thay thế prototype: state machine đầy đủ, CAS/version, snapshot revalidation, idempotency có DB uniqueness, candidate materialization từ cấu hình thật, maker-checker + ngoại lệ tự duyệt theo hạn mức, posting affected-row assertions, audit append-only, và reversal. **Không wire vào UI và không cấp `EXECUTE` cho `authenticated` trong tranche này** (`AUTHORIZATION-PLAN.md` §27.3: "chưa expose/wire production trong tranche này"; §4.1: callable surface cần threat model + negative test + deploy approval riêng).

---

## 1. Scope và dependency

- **Deliverable/tranche ID:** T3 — Approval contract v2 + rule governance + self-limit policy + reversal, non-callable.
- **Domain:** Financial voucher approval (`income_expenses` posted ledger), rule governance, reversal. Subject-type resolver mở rộng cho `FINANCIAL_VOUCHER` (và khung cho `PAYMENT`/deposit về sau).
- **Normative plan section:** `AUTHORIZATION-PLAN.md` §12.1–§12.7 (target engine), §13 (RPC boundary), §27.2 (quyết định nghiệp vụ owner 2026-07-15), §27.3 (T3 định nghĩa). Bằng chứng audit: `docs/Kết luận kiểm tra.md` §2, §3, §5 (T1b/T1d/T1e).
- **Dependencies và trạng thái:**
  - T0a recovery certification — `BLOCKED` (`AUTHORIZATION-IMPLEMENTATION-STATUS.md` recovery gate: `ONLINE_UNFROZEN/PARTIAL`, không `VERIFIED`). Chặn mọi apply.
  - T1a — contain prototype `submit_financial_voucher`/`decide_financial_voucher` (`docs/authorization/T1A-CONTAIN-APPROVAL-RPCS.md`) — `BLOCKED`. Prototype grant `authenticated` phải bị revoke TRƯỚC khi contract v2 tồn tại song song, kẻo có hai đường post cùng lúc.
  - T2 — RBAC source-of-truth + `authorization_version` + staff lifecycle — `BLOCKED`. Cần cho exact-permission resolution (`effective_perms_v2`/`authorize_v2`), versioned self-approve limit config, và "cashbook maker đang nắm giữ".
  - T6a — organization integrity + RLS v2 shadow — `BLOCKED`. Cần derivation org non-null từ subject để fail-closed cross-tenant.
  - T4 harness (JWT/concurrency/reconciliation) — `IN_DESIGN`. Cần trước khi có evidence acceptance.
- **In scope:**
  1. Migration constraint: bổ sung `REVERSED` vào `approval_requests.state` CHECK; thêm reversal link columns/uniqueness; siết `authorization_audit_events.organization_id` non-null cho tenant event (hoặc guard tương đương).
  2. Contract-v2 RPC set (SECURITY DEFINER, **không** grant `authenticated`): `create_financial_draft`, `update_financial_draft`, `submit_financial_request`, `self_approve_financial_within_limit`, `decide_financial_approval`, `emergency_approve_financial`, `cancel_financial_draft`/`withdraw_financial_request`, `reverse_financial_posting` (`AUTHORIZATION-PLAN.md` §13).
  3. Private helpers: rule matcher, candidate materializer, posting routine (thay `_eval_approval_rule`/`_post_financial_voucher`), audit-append với hash-chain.
  4. Seed permission keys còn thiếu (xem §1 open items) + versioned self-approve limit config + held-cashbook resolution + `auto_approve_invoice`-style org setting cho voucher classification (server-derived).
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

**Open items chặn prepare (phải chốt với owner — xem §Open questions):** các permission key `income_expenses.self_approve_within_limit`, `cashbooks.post`, `approvals.emergency_override`, `income_expenses.reverse` **chưa tồn tại** trong `20260713110100_sprint2b_seed_permission_definitions.sql` (grep xác nhận có `income_expenses.approve/create/edit/cancel`, `thu_tien.collect/undo`, `cashbooks.create/edit/share`, nhưng KHÔNG có bốn key trên và không có namespace `approvals.*`). Versioned self-approve limit config, held-cashbook binding model, và org setting classification cũng chưa có trong schema.

---

## 2. Immutable release identity

Chưa được cấp — tranche `IN_DESIGN`. Không dùng branch name, "latest", glob migration hay broad `db push` làm release identity.

- Full commit SHA: `<chưa cấp — owner>`
- Exact migration path/signature: `<chưa cấp>` (timestamp migration mới; artifact SQL giữ NGOÀI `supabase/migrations/` cho tới khi review + gate đạt — `AUTHORIZATION-PLAN.md` §4.1/§27.3).
- Migration SHA-256: `<chưa cấp — owner>`
- Generated-types SHA-256: `<chưa cấp>` (bắt buộc regen `npm run gen:types` sau migration đụng schema — CLAUDE.md).
- Deployed frontend SHA: `n/a` (T3 không wire frontend).
- Recovery certification ID (`VERIFIED`): `<BLOCKED — T0a>`
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
| `create_financial_draft` | `income_expenses.create` | Voucher+items cùng org; DRAFT only; account có thể null. |
| `update_financial_draft` | `income_expenses.edit` | Maker/scope; expected version; DRAFT only. |
| `submit_financial_request` | create/submit | Rule snapshot + request hoặc auto-post atomic; force categories luôn chờ duyệt. |
| `self_approve_financial_within_limit` | `income_expenses.self_approve_within_limit` + `cashbooks.post` | Chỉ phiếu chi thông thường dưới hạn mức, account thuộc sổ maker nắm giữ. |
| `decide_financial_approval` | `income_expenses.approve` + approver eligibility | Maker-checker; approver chọn account + ảnh trước snapshot cuối. |
| `emergency_approve_financial` | `approvals.emergency_override` + `member_type='OWNER'` | Reason≥20 + re-auth; endpoint riêng, không client enum. |
| `cancel_financial_draft`/`withdraw_financial_request` | cancel/withdraw (`income_expenses.cancel`?) | Draft chỉ DRAFT; withdraw chỉ PENDING_APPROVAL; đóng request có audit. |
| `reverse_financial_posting` | `income_expenses.reverse` | Chứng từ đối ứng; original immutable. |

Permission resolve qua `effective_perms_v2(user_id, org)`/`authorize_v2` (nguồn T2), không dùng membership-only như prototype (`20260713130200:81`). **Bốn key `self_approve_within_limit`/`cashbooks.post`/`approvals.emergency_override`/`income_expenses.reverse` phải được seed trước** (FK `approval_step_approvers.permission_key → permission_definitions.key`, `AUTHORIZATION-PLAN.md` §12.3).

### 4.3 State/version/CAS rules
- State machine (`AUTHORIZATION-PLAN.md` §12.1): `DRAFT→PENDING_APPROVAL→POSTED|REJECTED|CANCELLED`; `DRAFT→POSTED` (AUTO_POST); `DRAFT→DENIED` (DENY rule); `POSTED→REVERSED` (chứng từ mới, row gốc bất biến). Không `POSTED→DRAFT`. `DENIED` (rule) ≠ `REJECTED` (người duyệt).
- **Migration bắt buộc:** thêm `REVERSED` vào `approval_requests.state` CHECK (hiện `20260713130000:79` thiếu). Không dựng reverse RPC trên enum/check hiện tại (audit §3.9).
- Mọi transition RPC nhận `expected_request_version`; update dùng CAS `version=version+1`; conflict → `ERRCODE 40001` (giữ pattern prototype `20260713130200:149`).
- `SELECT ... FOR UPDATE` subject + request theo **cùng lock order** cho `submit/decide/reject/withdraw/post/reverse`.

### 4.4 Idempotency scope, canonical payload hash và conflict behavior
- Bảng operation-idempotency riêng: unique `(organization_id, operation, key, request_hash, response_json)` (`AUTHORIZATION-PLAN.md` §12.5). Ghi atomic trong mọi nhánh.
- **Authorize subject/org/caller TRƯỚC khi lookup replay** (audit §3.3: prototype lookup key toàn bảng dưới SECURITY DEFINER trước authorize → có thể trả ID khác tenant). Lookup phải scope org+operation+subject+caller.
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
- **Ngoại lệ đóng** (`self_approve_financial_within_limit`) chỉ khi backend đồng thời xác minh: (1) rule/category/source = phiếu chi thông thường, KHÔNG force-approval; (2) tổng ≤ hạn mức versioned server-side, không chia nhỏ business event để lách (tính theo correlation/batch); (3) account thuộc tập sổ quỹ membership maker **đang nắm giữ** theo binding/scope canonical (building scope hoặc quyền xem/sửa sổ không đủ); (4) exact `income_expenses.create` + `income_expenses.self_approve_within_limit` + `cashbooks.post`; (5) payload/version/idempotency + evidence hợp lệ; (6) gắn `SELF_APPROVED_WITHIN_LIMIT`, đưa vào hàng hậu kiểm; hậu kiểm không sửa/xóa posting gốc.
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
- Mọi RPC ghi `authorization_audit_events`: submit, rule match, auto-post, approve/reject, conflict, reversal, emergency. Append-only (INSERT chỉ qua definer/internal role; app roles không UPDATE/DELETE). Hash-chain: lock chain-head `(organization_id, chain_partition)` khi append (chống fork), canonical JSON serialize. **`organization_id` phải non-null cho tenant event** (hiện nullable `20260713130000:164`; migration siết hoặc guard).

### 4.13 Rule governance (`AUTHORIZATION-PLAN.md` §12.2, §27.3)
- Org bootstrap rule set; `DRAFT→ACTIVE→RETIRED` publish atomic; published version bất biến (không UPDATE/DELETE); mỗi version đúng một `is_fallback=true` effect `REQUIRE_APPROVAL`; chỉ một version hiệu lực/thời điểm. Fail-closed khi không đúng một ACTIVE version hoặc resolution không duy nhất — tuyệt đối không auto-post. Request đang mở dùng snapshot/version cũ.

### 4.14 External outbox/side effects
- Không có trong T3 (không wire). Deposit 24h-hold state contract (`expires_at`, no double-hold, server-time) được **định nghĩa** cho subject deposit nhưng writer `create_reservation_deposit` thuộc T5.

### 4.15 Forward-fix/reversal behavior
- Với ledger đã post, không rollback bằng xóa/sửa row tiền; dùng forward-fix hoặc `reverse_financial_posting` có audit.

### 4.16 Feature flag default
- **`OFF`.** Helpers private (SECURITY DEFINER, **không** grant `authenticated`). Contract v2 deploy không callable; grant `EXECUTE` chỉ ở migration riêng SAU T5 gate + owner approval (`AUTHORIZATION-PLAN.md` §4.1, §27.3).

---

## 5. Test evidence trước production

- Project restore/staging ID: `<chưa cấp — cần restore project cho direct test>`
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

**Default nếu chưa được owner chốt: canary count = `0`, VND cap = `0`, flag = `OFF`, không apply/flip.** T3 chỉ được apply schema/function ở trạng thái non-callable sau khi recovery `VERIFIED` + T1a/T2/T6a đạt + owner cấp exact SHA/hash/window.

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

## Phụ lục — SQL intent (chưa phải migration được duyệt)

> Chỉ minh hoạ contract; **không đặt vào `supabase/migrations/`** trước review + gate (path auto-deploy). Signatures/ACL lấy từ live catalog khi prepare.

```sql
-- (1) State model: cho phép REVERSED (hiện CHECK thiếu — 20260713130000:79).
begin;
alter table public.approval_requests
  drop constraint if exists approval_requests_state_check;
alter table public.approval_requests
  add constraint approval_requests_state_check
  check (state in ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED'));

-- (2) Reversal link + anti-double-reversal (posting source of truth).
-- reverses_posting_id UNIQUE để một original chỉ bị reverse một lần.

-- (3) Tenant audit event phải non-null org (hiện nullable — 20260713130000:164).
-- Áp guard/constraint tương thích với event global (nếu giữ nullable cho non-tenant).
commit;
```

```sql
-- Contract-v2 functions: SECURITY DEFINER, pinned search_path, KHÔNG grant authenticated.
-- Ví dụ khung (không grant EXECUTE — flag OFF, wire ở T5 migration riêng).
create or replace function public.decide_financial_approval(
  p_request uuid, p_decision text, p_reason text, p_expected_version bigint,
  p_posting_cashbook uuid default null, p_evidence jsonb default null)
 returns jsonb language plpgsql security definer set search_path to 'pg_catalog','public'
as $fn$
begin
  -- lock subject+request cùng lock order; CAS expected_version;
  -- maker-checker; candidate current-generation; recompute canonical hash vs snapshot;
  -- approver chọn posting cashbook + evidence -> snapshot/version mới;
  -- posting assert đúng một affected row; append audit event (chain-head lock).
  raise exception 'contract v2 — chưa duyệt, chưa grant';
end; $fn$;

revoke all on function public.decide_financial_approval(uuid,text,text,bigint,uuid,jsonb)
  from public, anon, authenticated;
-- GRANT EXECUTE chỉ ở migration riêng sau T5 gate + owner approval.
```
