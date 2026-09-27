# P0c fix1 — review độc lập có giới hạn

Base `449de52e11400b8f2df48d011d6dcf229683b624`; head `c016e9c5886a8417e67873582ef7caa4f5f6d7ce`. Đã đọc fix1 brief/report và diff; đối chiếu riêng ba Important của review trước, yêu cầu cặp phiếu FORFEIT và hồi quy do bản sửa. Không review lại toàn goal/merge/release.

## Spec Compliance — ĐẠT trong phạm vi P0c fix1

Cả ba Important đã được sửa trong oracle thực sự được live runner gọi; không chỉ sửa báo cáo hoặc response summary.

1. **Extra invoice — đóng.** `scripts/tests/contract-lifecycle/financial-fixture.mjs:50–60` lấy tập hóa đơn mới theo before/after, đòi đúng hai ID phân biệt từ writer (extra và settlement), khóa extra thành APPROVED/SETTLEMENT với total 75.000, paid 0, remaining 75.000 và receivable delta -175.000. Mất/đổi ID/trùng nguồn không vượt được so sánh tập ID có cardinality. Bộ test âm dùng chung oracle có các ca này tại `baseline-sources.test.mjs:31–37`.
2. **Credit lot — đóng.** `financial-fixture.mjs:62–69` đòi một lot gốc, tập ID sau giữ đúng cardinality/identity, amount 50.000 không đổi; trạng thái trước ACTIVE/remaining 50.000, sau CONSUMED/remaining 0. Không còn chấp nhận `sum([])=0`. Tests mất/rekey/trùng/đổi amount/status nằm tại `baseline-sources.test.mjs:38–42`.
3. **Refund state — đóng.** `financial-fixture.mjs:36–47,81–85` đòi một nguồn mới khớp refund ID writer, EXPENSE/CASHBOOK/UNPOSTED, amount 800.000, UNAPPROVED/account NULL/no joined account và cash delta 0. Tests tại `baseline-sources.test.mjs:48–53` kiểm NON_CASH, sai posting/type, mất/trùng/rekey.
4. **FORFEIT pair specificity — đạt.** `financial-fixture.mjs:71–79` đòi riêng một offset EXPENSE và một revenue INCOME; mỗi nguồn mới đúng ID writer, hai ID khác nhau, APPROVED/NON_CASH/NOT_APPLICABLE, amount 1.000.000, account tồn tại và virtual. Helper `newVoucher` kiểm cardinality riêng từng source nên không còn chấp nhận hai offset thay revenue. Test âm tương ứng tại `baseline-sources.test.mjs:43–47`.

`financial-fixture.mjs:149–156` lưu source IDs từ response thật và gọi shared assertion trước đánh dấu scenario hoàn tất. Tests gọi chính assertion tại `baseline-sources.test.mjs:22,57`; phần dựng response pointers từ artifact lịch sử được ghi rõ chỉ phục vụ copied-result oracle (`:6–18`).

## Task Quality — ĐẠT trong phạm vi bản sửa

Không có Critical, Important hoặc Minor mới trong diff cần yêu cầu sửa. Các assertion cũ bị bỏ được thay thế bằng điều kiện chặt hơn trong shared helper; cancellation/kept-paid/credit applied amount, DEBT/PAID, retry/conflict và approval probe vẫn giữ. Fixture setup, transport, flags, role state, engine tiền và SQL nghiệp vụ không thay đổi trong bản sửa.

Thay đổi có phạm vi gọn, nối test với đúng oracle live và không dùng mock làm bằng chứng DB. Không thấy hồi quy mới đủ căn cứ để yêu cầu probe bổ sung hay chạy lại suite.

## Bằng chứng đọc được và giới hạn xác minh

- Đã đọc source/test trong diff và trích line hiện tại để đối chiếu các điều kiện trên. Đã đọc metadata/evidence mới `docs/generated/contract-lifecycle/2026-09-27T17-54-00.899Z-financial-baseline.json`: run `p0c-ce8ea93d-151a-42ce-aaf7-6c754841c513`, 4 PASS/0 FAIL, cả bốn rollbackAbsent=true; source pointers FORFEIT và REFUND được lưu rõ. Deltas: FORFEIT cash 0/debt -175.000; REFUND cash 0/debt -200.000; DEBT cash 0/debt -1.000.000; PAID cash +500.000/debt -1.500.000.
- Report implementer ghi local 64 PASS, focused 24 PASS, live rollback 4 PASS và hai mutation oracle đỏ đúng lý do rồi restore hash. Review này kiểm source/evidence được cung cấp, **không tuyên bố tự rerun** các lệnh đó. Theo scope, không chạy lại routine tests/live, không DB write, không sửa code/index; chỉ tạo báo cáo review này.
- Verdict chỉ đóng các finding P0c và chấp nhận bản sửa oracle. Không có kết luận P0/toàn lifecycle hoàn tất, không phải phê duyệt merge hay production release.
- Successful postcommit approval/payout, real JWT mutations theo vai trò, cross-tenant denial, concurrency, actual DB/permission mutations, E2E và combined/global credentialed gates vẫn thuộc công việc tiếp theo và chưa được review này xác minh. SQL claims tiếp tục không được coi là authorization qua JWT.
