# Bằng chứng triển khai xử lý bỏ cọc giữ chỗ

Trạng thái: đang kiểm tra tích hợp, chưa xác nhận phát hành.

## Phạm vi và căn cứ

- Thiết kế: `docs/superpowers/specs/2026-09-10-reservation-deposit-settlement-design.md`.
- Base khảo sát triển khai: `30d086750b5e1ca6980b877a8be7eabc88091ca5`.
- Đã đọc catalog live của 37 hàm nguồn cùng các helper Finance V2; chỉ truy vấn đọc. Graph được refresh và kiểm freshness trước impact của hai hook cọc.
- Dùng lõi `finance_v2_post_voucher_with_source_v1` cho chi thật, không giả provenance hoặc bỏ ranh giới commit của phiếu thủ công. Reversal giữ RPC tài chính hiện hành và kiểm lại quyền trước replay đối với nguồn mới.
- Hạng mục thu chi dùng `PNL` cho doanh thu; từ REVENUE trong thiết kế là khái niệm nghiệp vụ, không phải giá trị hợp lệ của `income_expense_items.accounting_class`.
- Khóa 24h không có FK hoặc audit liên kết phiếu nguồn. Giữ khóa chưa xác định được và trả `UNRELATED_HOLD`, không hủy theo phòng/số tiền.

## Kiểm thử đang thực hiện

- PostgreSQL 17 riêng trên loopback; phục hồi schema, chỉ nạp phạm vi DEMO và quyền cần cho fixtures. Không nạp dữ liệu sổ sách của tổ chức thật. Extension vector/cron/vault không có ở máy; các bảng và hàm của luồng tiền đã dựng và chạy được.
- Migration được áp từ đầu trên database thử mới, không chỉ thay lẻ hàm. Ca thành công ép kiểm FK hoãn trước khi rollback. Ca đồng thời dùng database thử riêng rồi dọn cả database.
- Đã chứng minh bỏ toàn bộ không đổi quỹ; partial NOW/LATER và full refund; nguồn trộn chỉ dùng phần cọc; không nhận tiền chưa posting hoặc đã đảo; replay; kỳ khóa; sổ ảo; thiếu quyền; bảo vệ phiếu nguồn và loại cọc; đảo/hoàn lại; phòng còn cọc hoặc hold; explicit/legacy contract.
- Suite SQL hiện đạt **33/33 ca** (41,25 giây), gồm role authenticated và kiểm private helper/DML bị chặn. Hai settlement đồng thời và hai lần chi đồng thời chỉ tạo một kết quả. Cạnh tranh tạo hợp đồng với settlement chỉ có một bên tiêu dùng cọc.
- Kiểm tổng và phân trang trên 1.105 hồ sơ chờ hoàn, có tra cứu trực tiếp theo phiếu nguồn.
- PostgREST **14.17** thật trên loopback đạt **1/1 ca HTTP**: FK embed chỉ rõ nguồn, anti-join trước/sau settlement, history 1:1, preview, settlement, summary/list ở transaction đọc, hoàn tiền và actor thiếu quyền. Chỉ dùng JWT ký riêng cho server thử; không dùng token này trên môi trường dùng chung.
- Ba đột biến **bảo vệ phiếu nguồn / chia số giữ lại / kiểm quyền** đều làm đúng test đỏ; đã khôi phục SHA-256 migration về tiền tố `32008e7d10b7`. Công cụ `scripts/dot-bien.mjs` trả 0 cả ba lần.
- `migrate:forward` dry-run trên catalog dùng chung đạt, đã ROLLBACK (1 giây). Chưa áp migration thật ở thời điểm ghi số đo này.
- Build đầu tiên sau cài dependency riêng: 4.798 module, bundle thành công. Typecheck thật phát hiện lỗi kiểu dữ liệu giao diện đang được sửa; `tsc` tại root không được tính là bằng chứng.

## Review độc lập

Đã sửa các phát hiện: cọc nguồn lẻ VND bị làm tròn; thứ tự khóa tổ chức/phòng; bỏ sót hold APPROVED; quyền chi trên NOW replay; ngày chi NOW bị gắn với ngày doanh thu. Review giao diện đang yêu cầu sửa FK embed/anti-join, retry sau đảo, phân trang và lịch sử đầy đủ.

## Phát hành

Chưa chạy forward migration trên database dùng chung, chưa mở PR hoặc promote. Các số đo gate và liên kết PR được bổ sung sau khi xác minh xong; không coi kiểm thử local là E2E production.
