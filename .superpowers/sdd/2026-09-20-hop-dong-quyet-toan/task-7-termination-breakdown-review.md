# T7 termination breakdown — independent review

**Spec compliance: NEEDS CHANGES. Quality: NEEDS CHANGES.** Review đúng các file được giao ở WIP; không review T6/04515, không chạy lại suite, không đọc/ghi database hay sửa implementation. Các số dòng dưới đây ứng với bản review trước các sửa tiếp theo; riêng bản sửa signed `refundAmount` đã được đọc lại và chấp nhận.

## Điểm đã đạt

- Boundary kiểm `terminationId + contractId` với scope thực trước khi chấp nhận breakdown; partial payload không được nâng thành verified (`src/lib/contractSettlementFinancialContext.ts:31–42`). UI dùng cùng `buildTerminationCard`, không thêm writer hoặc đường duyệt/chi (`src/components/income-expenses/SettlementFinancialNote.tsx:9–25`).
- Helper private chỉ cấp EXECUTE cho reader role, public reader giữ owner `ie_action_snapshot_reader`, `row_security=on` và active-scope guard (`supabase/migrations/20260921004455_contract_settlement_termination_breakdown.sql:133–140`). Các lớp này có ích nhưng chưa đủ để bảo vệ phần projection chạy dưới postgres nêu ở I1.
- Mutation nhánh thiếu invoice yêu cầu suite đỏ đúng chuỗi assertion, phục hồi source qua `dot-bien` và phục hồi cả hai DB function trong `finally` (`scripts/test-settlement-termination-breakdown-mutation-local.mjs:25–33`). Không thấy mutation xanh rỗng trong luồng đã đọc.

## Important

### I1 — P1: helper postgres bỏ qua quyền xem invoice/item khi trả chi tiết

`supabase/migrations/20260921004455_contract_settlement_termination_breakdown.sql:73–84` lấy invoice theo org/contract rồi trả description/amount của toàn bộ items dưới SECURITY DEFINER postgres (`:38`, `:133`). Caller tại `:167` mới chứng minh quyền xem termination/contract/room, chưa chứng minh invoice được phép xem. Cùng hợp đồng có invoice tại building bị ẩn thì invoice đó bị loại khỏi phần `invoices` đọc bằng RLS, nhưng nội dung lại xuất hiện trong `terminationBreakdown`.

Named dependency đã đối chiếu: policy `invoices_select_rbac` ở `supabase/baseline/schema.sql:165660`, invoice items ở `:165421` và `accessible_invoice_ids` ở `:44475`. Projection refund item/type ở migration `:87–97` cũng chạy ngoài RLS tương ứng; không nên dùng helper private trả dữ liệu bị ẩn chỉ vì voucher cha hiện ra.

**Hướng xử lý:** reader không bypass phải xác minh tập invoice/items thực sự visible; helper chỉ đối chiếu completeness/identity với tập đã được chứng minh. Có hidden/mismatched items thì trả unavailable và không trả description, amount hoặc hidden IDs. Thêm actual JWT case một contract visible nhưng settlement invoice thuộc building hidden; kiểm không rò chuỗi/số tiền qua JSON breakdown, và item/category scope theo chính policy đang có.

### I2 — P2: tiền NULL bị biến thành verified zero

Migration `:109` chỉ kiểm hai tổng generated; `:123–126` dùng COALESCE cho input rồi trả `complete:true`. `outstanding_debt` và `early_termination_fee` thật sự nullable (`supabase/baseline/schema.sql:105499`, `:105503`), trong khi generated totals vẫn có số nhờ COALESCE (`:105512–105513`). Vì vậy debt NULL có thể hiện “Công nợ theo hồ sơ: Chưa xác minh” ở phần trên nhưng “Tổng công nợ: 0” trong khung verified mới.

**Hướng xử lý:** input cần thiết NULL phải làm breakdown unavailable hoặc tách field unavailable; không dùng số 0 mặc định làm bằng chứng. Thêm JWT trường hợp NULL debt/fee và assertion không có khung verified 0. `total_deposit` và `rent_refund_amount` có NOT NULL trong schema liên quan; không dùng chúng làm ví dụ dữ liệu NULL hợp lệ.

### I3 — P2: regex ghi chú tự do đang quyết định số tiền và tình trạng đã thu

Migration `:100–106` lấy credit từ lần regexp_match đầu tiên và suy PAID/DEBT bằng LIKE toàn `t.notes`, sau đó trả các giá trị này là verified (`:128`). Writer hiện hành lưu ghi chú người dùng trước đoạn breakdown: `supabase/migrations/20260915074638_coc_thanh_ly_va_cap_hoan_coc.sql:776` là `COALESCE(p_notes || newline, '') || v_breakdown`; đoạn hệ thống được tạo tại `:582–597`. Một ghi chú được dán lại chứa “Tiền thừa (credit) áp dụng: 9.000.000đ” có thể thắng số thực trong đoạn sau; chữ “GHI NỢ — chờ thu” trong ghi chú cũng có thể thắng PAID. Giá trị credit đó đi thẳng vào phép tính net của card.

**Hướng xử lý:** nguồn có provenance mới được dùng làm số tiền/chế độ thu đã xác minh; chưa có nguồn đó thì unavailable hoặc ghi rõ chỉ là tham khảo, giữ nguyên raw notes riêng. Không chỉ đổi từ match đầu sang match cuối và coi đã chứng minh được provenance. Thêm ca ghi chú tự do xung đột với đoạn hệ thống và ca thiếu bằng chứng credit/chế độ.

### I4 — P2: cảnh báo “tổng từ chi tiết” chưa thực sự đối chiếu tổng items

`src/lib/terminationRefundNote.ts:265` ưu tiên `early_termination_fee` để tính extra; warning mới ở `:299–300` so `total_deductions` với `s.charges` vốn được dựng từ header đó. Ví dụ debt 0, fee/header deduction 100.000, item vệ sinh 900.000, voucher 900.000 trên cọc 1.000.000: khung hiện tổng thu thêm 100.000 và dòng con 900.000 nhưng không có warning. Test mới chỉ đổi `total_deductions` độc lập (`src/lib/__tests__/terminationRefundNote.test.ts:161`), nên chưa chứng minh claim đối chiếu tổng item. Trường hợp invoice tồn tại nhưng rỗng cũng lọt kiểm completeness hiện tại.

**Hướng xử lý:** đối chiếu riêng tổng penalty/non-penalty items với các phần header mà chúng đại diện, và tổng refund items với phần hoàn tương ứng; cảnh báo/unavailable khi thiếu hoặc lệch. Không thay nguồn tiền bằng items một cách âm thầm. Thêm test giữ header/voucher khớp nhau nhưng đổi tổng items, cùng empty-item case.

### I5 — P2: migration mới chưa fail closed khi reader role drift

Guard migration `:4–26` ghim function/owner/ACL nhưng không kiểm attributes hoặc membership của `ie_action_snapshot_reader`. Function hash và owner không đổi khi role bị cấp BYPASSRLS hay membership đặc quyền, nên migration vẫn thay reader và chấp nhận trạng thái làm mất bảo vệ RLS. Migration gốc `supabase/migrations/20260920205323_contract_settlement_financial_context.sql:4–7` có kiểm role/membership; bước mới cần giữ invariant này khi apply/reapply.

**Hướng xử lý:** kiểm lại role attributes và membership có thể bypass; chạy các ca drift trong transaction rollback. `scripts/test-settlement-termination-breakdown-schema-local.mjs:23–26` hiện chỉ mutate search_path và hai ACL; `:27–39` assert owner hiện tại, chưa thử owner/role/trigger drift như report đang ghi. Bổ sung đúng các ca có invariant liên quan và sửa report theo bằng chứng thật, không thêm trigger test nếu thay đổi này không có trigger dependency cần kiểm.

## Minor

- **M1 — fixture cleanup còn sót items:** JWT script thêm hai `invoice_items` tại `scripts/test-settlement-financial-reader-local.mjs:69` nhưng finally chỉ xóa invoice tại `:106`. `fixture` bật `session_replication_role=replica` (`:12`), nên FK cascade bị tắt (`supabase/baseline/schema.sql:150769`). Xóa item theo đúng fixture IDs trước invoice và assert không còn fixture rows; hiện report “được dọn sạch” vượt bằng chứng.
- **M2 — ngày trả phòng chưa xuất hiện:** `actualMoveOutDate` được đọc và đưa vào adapter (`src/lib/terminationRefundNote.ts:228–232`) nhưng card không render ngày; `SettlementFinancialNote.tsx:12–25` chỉ hiện ngày thanh lý nghiệp vụ ở ngoài khung. Report scope có “ngày trả phòng thực tế”; thêm dòng nhãn riêng để không thay thế/lẫn hai ngày.

## Đã khép trong khi review

- **Signed refundAmount:** bản đầu dùng nonnegativeMoney, làm parser ném với quyết toán âm hợp lệ. WIP hiện tại dùng `money.nullable()` tại `src/lib/contractSettlementFinancialContext.ts:16`; regression mới ở `src/lib/__tests__/contractSettlementFinancialContext.test.ts:52–59` đưa `refundAmount:-300000` qua boundary và giữ nguyên giá trị. Root báo RED thực rồi GREEN 21 tests/3 files. Static rereview: **addressed**; reviewer không lặp suite.

## Giới hạn bằng chứng

- Đọc diff được giao, các file mới, report và đúng named dependencies cho RLS, nullable/generated money, writer notes provenance, cascade và reader-role guard. Không dùng giả thiết nhiều termination cùng contract: baseline có unique contract_id; chưa thấy bằng chứng để nêu finding đó.
- Kết quả 20 tests ban đầu, JWT/schema/mutation/app TS là bằng chứng implementer báo; reviewer đối chiếu assertions nhưng không tự chạy lại. Shared/production apply và browser UX chưa được kiểm trong review này. Cần scoped rereview sau các sửa I1–I5 trước khi chấp nhận task.
