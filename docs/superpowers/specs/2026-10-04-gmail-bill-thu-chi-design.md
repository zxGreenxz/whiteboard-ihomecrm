# Lấy bill Gmail để điền sẵn phiếu chi

Người dùng chọn Gmail và phương án 1: điền sẵn, kiểm tra rồi bấm lưu. Đây là phạm vi đã chốt trong cuộc trò chuyện ngày 04/10/2026.

## Luồng sử dụng

Trong Thu chi (desktop và mobile), người có quyền tạo phiếu bấm **Lấy hóa đơn Gmail**. Người dùng cấp quyền đọc Gmail qua cửa sổ Google, chọn khoảng ngày rồi bấm tìm. Danh sách hiển thị thư Grab/Shopee, số tiền/ngày/mã giao dịch nếu nhận diện được, và lỗi/thiếu dữ liệu rõ ràng. Chọn thư, chọn hạng mục chi, rồi mở form phiếu chi hiện có đã điền sẵn nội dung, ngày, số tiền. Người dùng chọn tòa, sổ quỹ, kiểm tra và bấm lưu. Đóng màn hình hoặc chỉ xem thư không tạo phiếu.

Gmail được đọc theo thao tác người dùng, không quét nền. Thông báo đặt hàng chưa thanh toán, hủy/hoàn tiền hoặc thiếu mã giao dịch không được coi là bill hoàn chỉnh. Trường chưa xác định được cần người dùng bổ sung, không suy số tiền từ số đầu tiên trong email. Mẫu email chưa hỗ trợ được báo rõ để mở thư gốc/nhập tay.

## Kiến trúc

- Google Identity Services token model, scope `https://www.googleapis.com/auth/gmail.readonly`; access token chỉ ở bộ nhớ của màn hình đang mở, không localStorage, sessionStorage, log hoặc server. Không refresh token hay mật khẩu Gmail.
- Gmail REST qua trình duyệt: profile, messages.list có phân trang và khoảng ngày, messages.get format full. Xử lý MIME text/plain hoặc HTML chuyển thành chữ; không render HTML thư hay tải ảnh/link ngoài. Không tự theo URL trong email. Chỉ lấy nội dung nhà gửi Grab/Shopee đã cho phép. PDF/ảnh đính kèm chưa đọc tự động trong bản này; báo cần đối chiếu thư gốc.
- `src/lib/emailBills/` giữ kiểu, parser, Gmail transport, Google authorization. `src/hooks/useEmailBillImport.ts` quản lý trạng thái đọc và lookup phiếu đã nhập. UI lazy load để không tăng tải trang thu chi ban đầu.
- Form dùng lại schema và bộ máy thu chi hiện có. Nguồn email được gửi cùng payload đã được người dùng kiểm tra tới RPC riêng. RPC claim nguồn và gọi writer hiện có trong cùng transaction; không có hai lần ghi rời nhau.
- Bảng nguồn riêng lưu tối thiểu tổ chức, nhà cung cấp, mã đơn/chuyến, message ID, mailbox, voucher ID và hash yêu cầu. Không lưu toàn bộ thư hoặc token. Unique `(organization_id, provider, receipt_id)` chống gửi lại/forward và thao tác đồng thời. Retry cùng payload trả kết quả cũ; payload khác trên bill đã nhập bị từ chối. Việc hủy phiếu không tự giải phóng bill để nhập lại.
- Phân quyền, scope tòa, tổ chức kiểm tại server, cả khi replay. Giao diện không được tự chọn tòa/sổ từ nội dung email. Ghi sổ sau lưu tuân theo writer hiện tại, không có đường ghi tiền mới.

## Kiểm chứng và triển khai

Unit tests MIME/parser tiền Việt, HTML không thực thi, domain giả, thư hủy/hoàn, dữ liệu thiếu, OAuth hết hạn/đóng popup, phân trang, lỗi từng thư. UI tests chứng minh chỉ Lưu mới gọi writer. SQL harness thực thi migration và quyền/cross-tenant/idempotency/rollback; concurrency trên TEST nếu có kết nối. Mutation test invariant chống trùng. Typecheck, build, bundle, gate:truoc-push và cả reconcile tiền v1/v2; E2E luồng/console trên TEST hoặc mock transport headless nếu chưa thể cấp quyền Gmail thật, báo rõ giới hạn.

Cần cấu hình OAuth client ID công khai `VITE_GMAIL_CLIENT_ID`, Gmail API và authorized JavaScript origins trong Google Cloud. Chưa có cấu hình/mẫu email thật trong phiên; không tuyên bố kết nối Gmail thật đã đạt khi chưa kiểm. Thay đổi tiền/schema phát hành bằng draft PR theo Project Contract; không apply schema production trong lúc phát triển.

Nguồn Google: [token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [lọc thư](https://developers.google.com/workspace/gmail/api/guides/filtering).
