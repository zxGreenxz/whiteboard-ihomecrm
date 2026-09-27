# P0c — báo cáo baseline tài chính hiện hành

## Phạm vi và kết quả

Base `bc72e3703f1a86b549fc14b707886ce366ac9c6b`. Chỉ thêm harness/test/evidence/đăng ký lệnh; không sửa business code, migration/schema, production, policy FORFEIT hay feature flags.

Live TEST: 4 PASS / 0 FAIL, run `p0c-03fcd402-d142-49fe-8b0a-7ab0aea726dc` trong artifact `docs/generated/contract-lifecycle/2026-09-27T17-33-55.965Z-financial-baseline.json`. Node v24.18.0. Harness digest `e5ef5f2a2818e37ad4d086973dbf1c9871f829ba78ad5afbcab0b383315580b8` đã kiểm khớp hai file source; mỗi ca có server clock, TEST ref, live SQL definition hashes, flags/routes và SHA256 riêng. Không có JWT/password/email/tên khách thật trong artifact.

Mỗi ca gọi transport đã review trên cùng kết nối có TEST marker rồi ROLLBACK; transaction read-only mới xác nhận không còn roots (room/customer/contract/account/personal-cashbook/possession). Cả4 đều rollbackAbsent=true. Root room/customer deterministic theo run+scenario, financial IDs do canonical writers sinh.

## Fixture và các phát hiện

- Fixture room/customer mới tại DEMO; create_contract_v2 nhận cọc thực1.000.000 qua phiếu và posting thật, không PATCH deposit_paid.
- Dựng hóa đơn qua create_invoice_v1, thu qua record_invoice_collection_v5, không PATCH paid_amount hay tắt trigger.
- Lần đầu setup23514 do phone fixture có ký tự hex: sửa thành10digits đúng constraint. Snapshot42703 vì canonical operations không có cột id: dùng operation/idempotency_key đúng catalog.
- Collection lần đầu42501: receiving-cashbook guard hiện tại không cho thu vào sổ bất kỳ. Read-only aggregate cho DEMO owner: TM0/TK0 eligible buildings. Parent cho phép cấu hình fixture mới qua canonical setup writer.
- Tạo sổ mới initial_amount=0, is_default=false bằng create_cashbook_v1; writer cấp CUSTODIAN của chính sổ mới. set_personal_cash_book_v1 chỉ sau assert chưa có personal book; không thay existing personal book/flags/role/shared possession. Tất cả cấu hình mới rollback.
- Không sao chép/vạch secret: chỉ load credential TEST từ vault gốc qua loader; CA explicit, TLS rejectUnauthorized=true.
- Các báo cáo debug lỗi fixture trước đó được giữ ở ignored SDD, không gọi chúng là engine failure.

## Hành vi đã quan sát và assert

FORFEIT: cọc1m, invoice unpaid100k, partial200k/paid50k, fully-paid300k, collection CREDIT50k, extra charge75k. Hai invoice nợ thành CANCELLED với total0 và50k; fully paid vẫn PAID/300k. kept_paid_amount50k, forfeit_amount1m. Cặp forfeit offset/revenue APPROVED/NON_CASH/NOT_APPLICABLE trên sổảo1m mỗi chân. Credit lot từ50k về0 và wrapper applied_amount50k. Extra invoice75k còn phải thu. Tiền thật delta0; receivable delta-175k.

REFUND: nợ200k được CT200k; cọc còn800k tạo termination.refund UNAPPROVED/CASHBOOK/UNPOSTED, accountNULL, chưa chi tiền; cashdelta0. Probe approve_income_expense_v2 trả55000: chỉ là V2 boundary rejection, chưa chứng minh nguyên nhân duy nhất cùng transaction (source còn kiểm birth provenance). Đường UI hiện tại theo statusMutations/revisions là approve_pending_income_expense_checked_v1: probe trả P0001 đúng accountNULL. Cả2 rollback savepoint và snapshot không đổi. Không tuyên bố successful approval.

DEBT: nợ1.5m, CT1m trong poolcọc, effective remaining500k; không có termination.extra_receipt; cashdelta0.

PAID: CT1.5m, remaining0; termination.extra_receipt500k APPROVED/CASHBOOK/POSTED, realaccount; cashdelta+500k.

Cả4: contractTERMINATED, roomAVAILABLE, một termination auditCOMPLETED. Snapshot gồm invoices/payments, voucher/items/postings/lines, canonical operations vàcreditlots. Wrapper retry cùngkey trả cùngresponse/snapshot không đổi; khácpayload SQLSTATE23505, rollback savepoint không đổi.

Flags ghi từ live từngca: creditapply, collection, contractcreate, spend.engine.v1/spend.cashbook_chi.v1 hiện ON/CANONICAL; không chuyển ON/OFF. Chỉ chứng minh credit FORFEIT route hiện tại, chưa chứng minh mọi permutation hoặc moveout credit/refundcredit.

## Kiểm chứng và lệnh

Prefix mọi lệnh runtime: `npm exec --yes --package=node@24.18.0 -- node`.

- RED ban đầu `--test scripts/tests/contract-lifecycle/baseline.test.mjs`: 2fail vì thiếu exported contract/oracle.
- GREEN ban đầu2/2.
- RED thêm all4PASS nhưng thiếuevidence:1fail Missing expected exception. Thêm nonempty/rollback/retry evidence contract; GREEN.
- Final `--test scripts/tests/contract-lifecycle/*.test.mjs`:29pass0fail0skip.
- Live `scripts/contract-lifecycle/baseline.mjs --test --vault --ca-file .superpowers/sdd/2026-09-27-contract-lifecycle/supabase-ca.crt`:4pass0fail, exit0. Thời gian2026-09-27T17:33:55.965Z, file evidence ở trên.
- `scripts/dot-bien.mjs --file scripts/contract-lifecycle/baseline.mjs --tim 'assert.equal(next.status,' --thay 'void (' --suite 'node --test scripts/tests/contract-lifecycle/baseline.test.mjs' --mong-doi-chua 'Missing expected exception'`:PASS exit0. Digest0cedf866e982→9248d9a4411f→0cedf866e982; suite đỏ exit1 đúng expected missing exception.
- Copy observed FORFEIT snapshot, sửa unpaid cancellation từCANCELLED sangAPPROVED: oracle throw được assert trong live run. Đây là độtbiến copied result/localoracle, không phải SQL/permission mutation.
- `scripts/check-test-matrix.mjs`:PASS789files/13suites. CI glob hiệncó tự nhận test mới, không thêm credential livejob.
- Khôngargs `scripts/contract-lifecycle/baseline.mjs`:NOT_READY exit1 trước loadvault/socket.
- `git diff --cached --check`:PASS.
- Re-read final artifact và tính harness digest:khớp, statusPASS4/4, rollbacktrue.

## File và tích hợp

Owned files: scripts/contract-lifecycle/baseline.mjs, README.md; scripts/tests/contract-lifecycle/baseline.test.mjs, financial-fixture.mjs; package.json; tooling/test-matrix.json; timestamped baseline JSON. Stage exact7files. Parent untracked audit/plan/artifacts untouched. Commit trailer theo Contract; không push/deploy.

## Chưa kiểm / không tuyên bố

SQL chạy với claims DEMO owner không phải authorization qua JWT. Parent đã có JWTreadsmoke nhưng điều đó không chứng minh mutation ở đây. Successful postcommit refund approval/payout, multi-roleJWTmutations, cross-tenant denial, concurrency, actualDB/permission mutations, E2E, reconcilev1/v2, current-catalog/drift full global gates và gate:truoc-push chưa do task này chạy. Parent sở hữu global credentialed gates/inventory theo brief. Independent review trước tích hợp/release còn chờ. P0 chưa hoàn tất và production không đổi.

Commit: 54fc5857e5e7ec1d46fa22288a1115cf403ce6e2 (named7files, no push). Parent explicitly confirmed no redundant uncredentialed global gate required before this commit; parent owns combined credentialed gate. Parent independently reports both existing reconcile scripts PASS on TEST in existing-reconciles-test.json; this P0c report does not substitute that receipt for JWT mutation/concurrency proof.


Correction after independent review: prior 4 observed live outcomes remain historical observations; reusable oracle was not approved due to three source/state gaps. See task-P0c-fix1-report.md for exact source-oracle fixes, new live run and remaining review gate.
