# Email ACB: nhận tiền và đối soát hóa đơn

## Phạm vi đã chọn

Người dùng chọn ngày 05/10/2026: tự ghi thu khi đúng tài khoản, đúng một mã hóa đơn và đúng số tiền còn phải thu; mọi trường hợp khác chờ kiểm tra. Gmail Grab/Shopee (PR #120) vẫn là nhập phiếu chi có xác nhận, độc lập với luồng này.

Luồng: ACB → Gmail → máy chủ nhận thông báo → xác minh thư → giao dịch chờ đối soát → writer thu hóa đơn V5 → phiếu thu/công nợ và thông báo trên ứng dụng. Chọn Gmail watch + Pub/Sub, có kiểm tra bù định kỳ; chỉ polling sẽ chậm hơn, chỉ chạy trong trình duyệt sẽ ngừng khi đóng trang.

## Ranh giới dữ liệu và tiền

- Một kết nối thuộc một tổ chức, người ủy quyền và tài khoản ACB/sổ nhận đã chọn. Không suy tổ chức hoặc sổ từ nội dung thư. Một tài khoản ACB chỉ có một cấu hình trong hệ thống để tránh ghi chéo tổ chức.
- Người cấu hình phải có quyền cấu hình gạch nợ và thu tiền trên sổ. Người ủy quyền chính là người đăng nhập tạo kết nối; quyền, membership, khả năng đọc hóa đơn và sổ nhận được kiểm lại mỗi lần ghi. Thu hồi quyền/ngắt kết nối dừng tự động.
- Máy chủ giữ refresh token mã hóa; trình duyệt không nhận token Gmail dài hạn hay service key. OAuth state dùng một lần, có hạn, gắn kết nối; callback không nhận actor/org do người gọi tự khai.
- Email phải có đúng một From mailalert@acb.com.vn và chữ ký DKIM hợp lệ từ acb.com.vn, phủ toàn bộ thân thư. Không tin tên hiển thị hoặc Authentication-Results do thư mang tới. Không tải ảnh/liên kết/attachment trong thư. Bản đầu xử lý body plain text/HTML; không OCR PDF.
- Đọc số giao dịch (khác số dư), CREDIT/DEBIT, VND, tài khoản, ngày giờ Việt Nam, mã GD và nội dung. Hai đoạn Việt/Anh phải đồng nhất và chỉ tạo một giao dịch. Thiếu/mâu thuẫn không tự ghi. Dữ liệu mẫu trong test là giả lập đã thay danh tính, không commit thư khách.
- Tự khớp chỉ khi đúng một invoice_number nguyên vẹn xuất hiện theo ranh giới từ trong nội dung, đúng tổ chức, hóa đơn còn nợ đúng số tiền và sổ nhận được phép cho tòa đó. Không khớp bằng tên/số tiền đơn thuần. Thiếu/thừa, nhiều hóa đơn, ghi nợ, thiếu mã giao dịch, thư cũ, xác minh thất bại: hàng chờ.
- Chốt tự động chỉ áp dụng cho giao dịch ngân hàng có thời điểm từ lúc bật tự động trở đi. Nhập bù/history hết hạn không tự ghi các khoản trước mốc bật.
- Claim nguồn ngân hàng độc lập người thu/hóa đơn, khóa giao dịch nguồn và hóa đơn; gọi record_invoice_collection_v5 trong cùng transaction với TK, REJECT, allow_rounding=false. Không UPDATE paid_amount trực tiếp. Lưu receipt V5; replay không thu lần hai, đảo thu không xóa dấu nguồn.
- Người có quyền có thể chọn mã hóa đơn và xác nhận cho giao dịch chưa khớp, vẫn kiểm tài khoản, CREDIT/VND, chữ ký và số tiền còn nợ. Không hỗ trợ chia/gộp hoặc tự làm tròn. Bỏ qua phải lưu trạng thái, không xóa nguồn.

## Giao vận và trải nghiệm

Máy chủ Node chạy độc lập, giới hạn body/timeout và URL cố định. Gmail push chỉ báo lịch sử thay đổi; worker tải raw message từ Gmail, xác minh DKIM và parse. Webhook kiểm JWT Google (signature/issuer/audience/email/email_verified), nhận việc bền vững rồi ACK. Hàng đợi có lease, retry; cursor chỉ tiến sau khi lưu xong mọi thư. Gia hạn watch hằng ngày, kiểm tra bù mỗi 5 phút; nếu history cũ không còn thì quét lại có phân trang, khử trùng và giữ mốc tự ghi. Lỗi OAuth hiển thị yêu cầu kết nối lại, không làm mất cursor.

Thêm mục ACB tại Cài đặt → Gạch nợ tự động: cấu hình số tài khoản, sổ nhận, kết nối Gmail, bật/tắt tự ghi, trạng thái kết nối/đồng bộ và danh sách giao dịch phân trang. Thông báo phân biệt “đã ghi thu” và “chờ đối soát”; cập nhật thu chi/hóa đơn dùng realtime hiện có. Không hứa thời gian tức thì từ ngân hàng: push thường nhanh sau khi thư đến Gmail nhưng ACB có thể gửi chậm.

## Kiểm chứng và kích hoạt

Kiểm parser, giả mạo chữ ký, bilingual conflict, số dư/số giao dịch, webhook/OAuth/retry/cursor; SQL TEST với actor thật, replay/cạnh tranh, mất quyền, cross-org, sổ sai, thanh toán thủ công cạnh tranh. Gate theo Project Contract, build/bundle, UI desktop/mobile và review độc lập trước draft PR. Không ghi tiền production hay triển khai chưa có cấu hình Google Cloud và thư gốc ACB. Ảnh người dùng là mẫu hình thức, chưa là bằng chứng xác thực định dạng MIME/chữ ký thật.
