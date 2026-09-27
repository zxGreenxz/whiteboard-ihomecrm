# Review độc lập P0c — financial baseline

Phạm vi: task P0c, base `bc72e3703f1a86b549fc14b707886ce366ac9c6b`, head `54fc5857e5e7ec1d46fa22288a1115cf403ce6e2`. Đây không phải review merge, toàn P0 hay phát hành. Đã đọc Project Contract, brief/report, diff một lần và mã harness liên quan. Không sửa code/index, không chạy DB write, không lặp lại suite/gate đã báo cáo. Chỉ thêm các probe local vì phát hiện nghi vấn mới về oracle.

## Spec Compliance — CHƯA ĐẠT

Đúng phạm vi an toàn: chỉ thêm harness/test/evidence/registration; baseline gọi transaction không truyền commit (`baseline.mjs:45–54`), transport mặc định rollback (`transport.mjs:56,91`), kiểm roots riêng sau rollback (`financial-fixture.mjs:6–9`). Fixture chỉ INSERT room/customer và gọi writer tiền hiện hành; sổ mới initial 0, không default, chỉ gán khi chưa có personal book (`financial-fixture.mjs:48–62`). Parent đã cho phép chính fixture configuration này. Không thấy thay flags hoặc shared role state trong thay đổi. Các claims SQL được phân biệt rõ với JWT tại `baseline.mjs:39` và README:43–47.

Tuy nhiên brief yêu cầu nonempty exact sources/missing row fail và assert hiệu ứng thu thêm, credit, voucher state. Ba lỗ oracle dưới đây cho phép pass khi các nguồn/hiệu ứng này sai hoặc biến mất. Bản evidence 4 PASS hiện có không xóa được thiếu sót của reusable runner.

## Task Quality — CHƯA ĐẠT; cần sửa Important trước chấp nhận P0c

### Critical

Không phát hiện.

### Important 1 — Extra charge FORFEIT chỉ kiểm summary, không kiểm khoản phải thu thực

`scripts/tests/contract-lifecycle/financial-fixture.mjs:97–100` kiểm các hóa đơn ban đầu và `response.termination.extra_charges_total === 75000`. `assertForfeitInvoices` (`scripts/contract-lifecycle/baseline.mjs:22–29`) chỉ lặp các ID trước thanh lý; không yêu cầu hóa đơn mới. Nhánh FORFEIT không assert debt/receivable sau thanh lý. Vì vậy wrapper vẫn trả summary 75.000 nhưng engine không tạo hóa đơn extra hoặc làm mất khoản phải thu vẫn pass.

Tái hiện mới: replay toàn `runFinancialScenario` bằng fake query trả copied artifact FORFEIT, loại mọi `after.invoices` không có trong `invoiceIds` (chính hóa đơn extra), giữ response và các nguồn khác. Kết quả: `missing-extra-invoice: ACCEPTED by complete scenario oracle`. Đây là kiểm oracle local, không phải DB mutation hoặc bằng chứng live.

Cần assert exact nguồn extra invoice mới, giá trị 75.000, paid/remaining/status phù hợp baseline, và receivable delta mong đợi; thêm negative case mất hoặc sai nguồn này. Không chỉ assert response summary.

### Important 2 — Xóa toàn bộ credit lots sau FORFEIT vẫn được coi là đã tiêu credit đúng

`scripts/tests/contract-lifecycle/financial-fixture.mjs:105–107` yêu cầu before credit 50.000 nhưng chỉ tổng `after.credit.remaining_amount === 0`. Tổng mảng rỗng bằng 0 (`:28`), nên mất dòng nguồn credit được coi là thành công. Điều này trái yêu cầu missing source/row fail và bỏ lọt việc xóa lịch sử credit thay vì cập nhật lot đúng.

Tái hiện mới: replay toàn `runFinancialScenario` với copied artifact, thay `after.credit=[]`, còn response `applied_amount=50000`. Kết quả: `missing-credit-lot: ACCEPTED by complete scenario oracle`.

Cần đối chiếu identity của lot trước/sau, giữ amount gốc, assert remaining/status theo baseline và cardinality. Thêm negative case xóa/rekey lot để suite đỏ.

### Important 3 — REFUND không khóa posting mode/status đang cần giữ

`scripts/tests/contract-lifecycle/financial-fixture.mjs:125–128` chỉ assert nguồn `termination.refund`, amount, UNAPPROVED và account NULL. Snapshot có `posting_mode`/`posting_status` (`:19`) nhưng không assert chúng. Probe lỗi sau đó chỉ so snapshot đã sai với chính nó, không phát hiện thay đổi này. Một phiếu hoàn bị tạo thành NON_CASH/NOT_APPLICABLE thay vì CASHBOOK/UNPOSTED vẫn pass, mặc dù đây là trạng thái quyết định đường chi tiền sau duyệt.

Tái hiện mới: replay toàn REFUND scenario, đổi riêng refund thành `posting_mode=NON_CASH`, `posting_status=NOT_APPLICABLE`, giữ tiền thật delta 0, approval rejection và retry/conflict như observed. Kết quả: `refund NON_CASH/NOT_APPLICABLE: ACCEPTED by complete scenario oracle`.

Cần assert CASHBOOK/UNPOSTED cho refund và negative oracle đổi hai field. Với FORFEIT pair nên đồng thời assert đúng một nguồn offset và một nguồn revenue, type mỗi chân và NOT_APPLICABLE; hiện `:101–103` mới kiểm hai dòng thuộc tập source cùng một số field.

### Minor

Không có finding độc lập cần chặn thêm; không yêu cầu refactor diện rộng.

## Bằng chứng và giới hạn

- Đã đọc artifact committed `docs/generated/contract-lifecycle/2026-09-27T17-33-55.965Z-financial-baseline.json`: record current run không đồng nghĩa oracle bắt đủ hồi quy. Các probe ở trên dùng bản sao trong RAM, không sửa artifact hoặc engine.
- Ba probe chạy qua chính hàm `runFinancialScenario`, gồm assertion retry/conflict và snapshot của hàm; fake responses chỉ phục vụ kiểm độ nhạy của oracle, tuyệt đối không thay thế live baseline. Probe REFUND đầu tiên có sai index tham số trong fake conflict nên đỏ; sửa fake index theo chữ ký call hiện có rồi chạy lại chỉ probe này, cho kết quả chấp nhận sai posting state nêu trên.
- Không chạy lại 29 local tests, live baseline, reconcile hoặc mutation command đã báo cáo vì không có yêu cầu lặp lại chúng; không coi implementer report là bằng chứng độc lập đã rerun.
- Successful postcommit approval/payout, real JWT mutation đa vai trò, cross-tenant denial, concurrency, actual DB/permission mutations, E2E, reconcile/global catalog/drift và combined gate thuộc các task/gate tiếp theo. Chúng không phải lỗi phạm vi P0c rollback-only nhưng vẫn chưa được review này xác minh. SQL request claims không phải real-JWT authorization.
- Không kết luận P0 hoàn tất, không cho phép merge/release từ verdict này, không có production thay đổi.
