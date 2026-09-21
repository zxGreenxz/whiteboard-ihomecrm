# T7 termination breakdown — rereview 1

**Spec compliance: NEEDS CHANGES. Quality: NEEDS CHANGES.** Còn một Important thuộc I3: tiền thừa chưa có bằng chứng độc lập. Các finding khác đã khép trong phạm vi bản sửa. Review tĩnh WIP, không chạy lại suite, không ghi DB hay sửa mã.

## Đã khép

- **I1 — addressed:** breakdown chạy bằng `ie_action_snapshot_reader`, `row_security=on`; postgres bridge chỉ trả boolean xác nhận chính xác org/contract/termination/voucher (`supabase/migrations/20260921004455_contract_settlement_termination_breakdown.sql:49–65`, `:78–80`, `:188`). Outer reader so tập private với dữ liệu visible trước khi gọi breakdown (`:225–232`). Projection item/type ở trong RLS, không còn helper postgres trả nội dung bị ẩn. Actual JWT regression đọc invoice ở building hidden, yêu cầu unavailable và không có secret trong JSON (`scripts/test-settlement-financial-reader-local.mjs:93–94`).
- **I2 — addressed:** NULL debt/fee chặn bởi `TERMINATION_INPUTS_UNAVAILABLE` trước `complete:true` (migration `:162–164`); JWT có ca NULL thực (`scripts/test-settlement-financial-reader-local.mjs:90–92`). Signed `refundAmount` vẫn giữ bản sửa đã chấp nhận ở review trước (`src/lib/contractSettlementFinancialContext.ts:16`).
- **I4 — addressed cho tổng items:** SQL kiểm tổng settlement items với fee, refund item types đầy đủ và tổng refund items với header (`:165–168`). Lớp thuần có warning độc lập về item/header (`src/lib/terminationRefundNote.ts:299–307`), regression giữ header/voucher tự khớp nhưng đổi item (`src/lib/__tests__/terminationRefundNote.test.ts:168`). Vấn đề phép cân bằng ngược làm mất khả năng nhận biết credit thật được giữ riêng ở I3 dưới đây.
- **I5 — addressed:** migration kiểm attributes, membership và CREATE privilege của reader role (`:6–14`), helper/public owner/ACL/hash giữ nguyên dạng fail closed. Schema harness thử role BYPASSRLS, membership, owner, ACL trong rollback, cùng first apply nonsuperuser/reapply (`scripts/test-settlement-termination-breakdown-schema-local.mjs:24–38`, `:50–64`). Report đã bỏ claim trigger drift không có dependency.
- **M1 — addressed:** xóa invoice child items trước parent dưới replica và assert không còn rows fixture (`scripts/test-settlement-financial-reader-local.mjs:124–125`, `:145–146`).
- **M2 — addressed:** ngày trả phòng thực tế hiển thị riêng, định dạng ngày đã qua boundary, không thay ngày thanh lý nghiệp vụ (`src/components/income-expenses/SettlementFinancialNote.tsx:19`; test `src/components/income-expenses/__tests__/SettlementFinancialNote.test.tsx:25–26`).

## Important còn lại

### I3 — P2: giải tiền thừa từ chênh lệch phiếu chưa chứng minh được nguồn tiền thừa

Regex raw notes đã được bỏ; `shortfallMode:null` là cách giữ unknown đúng. Tuy nhiên migration `:160` thay bằng:

`excess_rent := v.total_amount + t.total_deductions - t.total_deposit - t.rent_refund_amount`

Đây là số dư để phương trình tự khớp số phiếu. Ví dụ cọc 1.000.000, khấu trừ 100.000, hoàn tiền phòng 0, invoice items 100.000, phiếu và refund items đều 1.200.000: helper suy ra tiền thừa 300.000 rồi trả `complete:true` dù không có nguồn hoặc dòng credit nào. Bridge `:58–60` chỉ chứng minh liên kết obligation tồn tại; guard `:168` chỉ chứng minh tổng items bằng header, không chứng minh khoản credit. Card sau đó tính net đúng 1.200.000 theo khoản credit vừa suy ra, che chính chênh lệch mà trang cần rà soát.

**Hướng xử lý:** dùng snapshot hoặc thành phần credit có provenance/identity đã kiểm chứng để dựng tiền thừa và tính lại tổng độc lập với header phiếu. Nếu chưa có đủ nguồn để chứng minh số tiền thừa áp dụng, giữ phần đó unavailable hoặc hạ khung tổng ròng xuống chưa xác minh; không đặt tên “tiền thừa” cho số chênh chỉ nhằm cân phương trình. Giữ kiểm tra header so với số tính độc lập. Bổ sung actual JWT regression có header/items lệch khỏi quyết toán nhưng không có nguồn credit: không được sinh `excessRent:300000, complete:true`; thêm ca credit có bằng chứng nếu chọn hỗ trợ nó trong task này.

## Bằng chứng và giới hạn

- Đã đọc lại đúng fix của I1–I5/M1/M2, report, helper/public reader, schema/JWT/mutation assertions, TS/UI và regression liên quan. Child reviewer độc lập xác nhận các closure SQL và cùng kết luận về I3. Không mở rộng tìm lỗi ngoài delta.
- Root báo 22 Vitest, actual JWT/schema/mutation và app TS/gates PASS. Reviewer không lặp các lệnh đó; test conflict notes hiện có chứng minh không tin notes nhưng chưa thử header chênh mà không có nguồn credit.
- Shared/production migration và browser UX vẫn ngoài bằng chứng của lần rereview này. Cần khép I3 trước khi đánh dấu task APPROVED.
