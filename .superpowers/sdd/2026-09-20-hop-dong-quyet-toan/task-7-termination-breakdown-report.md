# T7 — Chi tiết quyết toán thanh lý

## Phạm vi

- Bổ sung bằng chứng chi tiết cho modal hoàn khách: ngày trả phòng thực tế, cọc đã dùng, công nợ, phạt trả sớm, hoàn tiền phòng, từng khoản khấu trừ, tổng khấu trừ và số ròng khách được nhận/phải trả.
- Chỉ hiển thị số liệu khi reader xác minh đúng `organization_id + contract_id + termination_id`; dữ liệu thiếu trả `complete: false` cùng lý do, không tự điền số 0.
- Giữ nguyên state machine và writer. Thay đổi này chỉ mở rộng reader và lớp trình bày.

## Hiện thực

- Migration `20260921004455_contract_settlement_termination_breakdown.sql` tạo helper private `app_private.settlement_termination_breakdown_v1`, khóa ACL chỉ cho reader role và nhúng kết quả vào `get_contract_settlement_financial_context`.
- Helper lấy settlement invoice còn hiệu lực gần nhất, item khấu trừ và item hoàn tiền đúng phiếu; kiểm tra phạm vi tổ chức, tòa nhà, hợp đồng, thanh lý và liên kết nghĩa vụ hoàn cọc.
- Model TypeScript kiểm tra identity trước khi chấp nhận payload. UI dùng lại phép tính `buildTerminationCard`, hiện cảnh báo khi tổng lưu trong DB lệch với tổng item hoặc lệch với số tiền phiếu.

## Bằng chứng TDD và kiểm thử

- RED trước khi code: model chưa có `terminationBreakdown`, UI chưa có khối “Chi tiết quyết toán thanh lý”; thêm RED riêng cho `outstandingDebt` và cảnh báo lệch tổng khấu trừ.
- GREEN sau review: 22 test / 3 file PASS (`contractSettlementFinancialContext`, `terminationRefundNote`, `SettlementFinancialNote`), gồm số hoàn âm, lệch tổng item và ngày trả phòng thực tế.
- JWT/PostgREST thật PASS: 1.003 receipt đầy đủ trong một RPC; item điện/dọn phòng và item hoàn tiền đúng identity; invoice ở tòa nhà ẩn không rò mô tả/số tiền và làm breakdown unavailable; item 0đ thiếu category vẫn làm breakdown unavailable; tiền NULL không thành 0; ghi chú tự do xung đột không quyết định tiền/trạng thái; tổng phiếu lớn bất thường không tự sinh credit; trường hợp thiếu invoice trả `SETTLEMENT_ITEMS_UNAVAILABLE`; chặn membership thu hồi/hết hạn, org đình chỉ; không phát sinh ghi dữ liệu. Cleanup xóa child item tường minh khi replica trigger tắt và assert không còn fixture.
- Schema harness PASS: first apply bằng deployer không phải superuser, reapply, reader role/membership/owner/ACL drift và chuỗi hàm STABLE. Không có trigger dependency trong migration này.
- Mutation harness PASS: sửa nhánh thiếu invoice thành `WHEN false` làm JWT suite thất bại đúng kỳ vọng; source và database function đã được phục hồi. Hash cuối: link bridge `c5305a2c11de314dc4eb4b04d8cdfdaa`, RLS helper `a7e62c0b18de2e41dad077dc71e0c3cf`, public reader `37f886b6cf56450fa40c0e544999e2c4`.
- `git diff --check`, test matrix 770 file / 11 suite, RPC cast ratchet và RPC layer gate đều PASS. TypeScript app PASS bằng Node 24.18.0.

## Giới hạn đã chủ ý

- Nếu không đủ invoice/item nguồn để chứng minh tổng, modal báo chưa đủ dữ liệu thay vì suy đoán từ ghi chú cũ.
- Chưa áp migration lên shared schema hay production trong task này; chỉ chạy database/PostgREST dùng một lần ở local.

## Sửa sau review độc lập

- I1: projection invoice/item chạy dưới owner `ie_action_snapshot_reader` có `row_security=on`; bridge postgres chỉ trả boolean liên kết voucher–termination. Outer reader so count private/visible trước khi gọi breakdown. Ca invoice cùng hợp đồng nhưng ở tòa ẩn trả `INVOICES_INCOMPLETE` và không rò payload.
- I2: `outstanding_debt` hoặc `early_termination_fee` NULL trả `TERMINATION_INPUTS_UNAVAILABLE`.
- I3: bỏ toàn bộ regex tiền/chế độ từ `notes`; `excessRent` chỉ lấy từ item có loại hệ thống `Hoàn tiền thừa thanh lý`. Nếu khấu trừ vượt cọc mà item không chứng minh được phần credit đã cấn, breakdown trả unavailable. Tổng phiếu lớn bất thường không còn tự sinh credit để tự cân bằng; `shortfallMode` để null khi chưa có nguồn cấu trúc.
- I4: backend yêu cầu tổng settlement items khớp fee và refund items khớp phiếu; lớp thuần vẫn cảnh báo nếu payload lệch lọt tới UI.
- I5: guard và harness giữ lại invariant role/membership không BYPASSRLS. Hai minor về cleanup và ngày trả phòng cũng đã sửa.
