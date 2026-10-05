---
status: active
source_paths:
  - src/lib/personalFinance/
  - src/hooks/personal-finance/
  - src/pages/finance/PersonalWalletPage.tsx
risk: financial
---

# Ví thu chi cá nhân

Route `/finance/personal-wallet` dành cho người có `personal_finance.view`.
Dữ liệu thuộc tài khoản đăng nhập trên mọi tổ chức; đồng nghiệp, chủ công ty và
quản trị hệ thống không được đọc ví của người khác. Quyền tạo, sửa, xóa điều khiển
thao tác trên giao diện; mọi tham chiếu dữ liệu ở RPC vẫn kiểm chủ sở hữu.

## Số dư và giao dịch

- Mỗi tài khoản bắt đầu với một **Ví chính** có số dư ban đầu bằng 0 và danh mục
  thu/chi cơ bản. Không tạo tiền, giao dịch, ngân sách hoặc mục tiêu mẫu.
- Số dư mỗi ví = số dư ban đầu + toàn bộ thu − toàn bộ chi + chuyển vào − chuyển ra.
  Bộ lọc tháng chỉ ảnh hưởng thu/chi, giao dịch, ngân sách và báo cáo của tháng đó.
- Giao dịch lịch sử chưa có ví được tính vào Ví chính, giữ nguyên số tiền và ngày.
  Số tiền mới là số nguyên VND dương, tối đa 1.000 tỷ mỗi khoản. Không làm tròn lịch sử.
- Ẩn ví chỉ bỏ thẻ ví khỏi Tổng quan; số dư và lịch sử vẫn được tính. Ví đang dùng,
  Ví chính hoặc ví gắn mục tiêu không thể xóa.
- Danh mục phân biệt Thu và Chi. Có thể thêm, đổi tên, đổi biểu tượng hoặc ẩn;
  danh mục chuẩn, đã sử dụng hoặc gắn ngân sách có ràng buộc xóa. Không ẩn hết
  danh mục hiện có của một loại. Danh mục ẩn vẫn hiện trong lịch sử và ô đang sửa.

## Ngân sách và mục tiêu

Ngân sách tổng tháng và từng danh mục là các **hạn mức độc lập**, lặp lại mỗi tháng,
áp dụng cho mọi ví cá nhân. Chỉ tính giao dịch Chi; không cộng Thu, chuyển nội bộ
hoặc phiếu công ty. Chạm/vượt hạn mức là cảnh báo, không tự cấm ghi chi.

Mục tiêu gắn một ví đích. **Đã góp** là tổng các lần chuyển tiền từ ví khác vào
mục tiêu, không phải số dư còn lại của ví đích. Một lần góp làm giảm ví nguồn và
tăng ví đích cùng số tiền, không tạo thu nhập. Lần góp đã xác nhận không sửa/xóa;
mục tiêu có lần góp không thể xóa hoặc đổi ví đích. Chuyển nội bộ thông thường
có thể sửa/xóa theo phiên bản đã đọc.

## Ghi nhanh và xác nhận

Tổng quan dùng chung engine với `/chi-tieu`: nhập chữ, ảnh kèm nội dung, chụp ảnh,
chọn ảnh hoặc ghi âm. Dừng ghi âm tự gửi để xử lý thành thẻ nháp; phải soát thẻ
và bấm Lưu mới ghi sổ. Một câu có Thu và Chi được tách đúng loại. Chọn Cá nhân
hoặc Công ty trước khi gửi; nơi nhận của thẻ đã gửi không đổi theo nút gạt sau đó.

Ảnh cá nhân chỉ dùng để đọc; không tải lên R2. Ảnh công ty đi theo luồng chứng từ
hiện có. Nút Công ty chỉ hiện khi có `income_expenses.create`; lỗi tải dữ liệu
công ty không chặn việc nhập cá nhân.

Một thẻ cá nhân được lưu nguyên khối qua `personal_finance_mutate` với UUID
yêu cầu cố định. Khi mất mạng hoặc chưa xác minh được phản hồi, giữ nguyên UUID
và nội dung để **Gửi lại y nguyên**; không báo thành công hoặc tạo khóa mới.
Hai lần nhập riêng có nội dung giống nhau vẫn là hai khoản riêng. Sửa/xóa gửi
phiên bản đã đọc; xung đột không âm thầm ghi đè bản mới hơn.

Sổ tiền lấy từ snapshot máy chủ, không lấy localStorage làm nguồn số dư.
LocalStorage chỉ giữ nháp và yêu cầu chưa xác nhận theo chủ ví. Nháp cũ lưu dở
không được tự ghi lại những dòng đã xác nhận hoặc đoán kết quả theo nội dung.

## Dữ liệu và phát hành

Bảng nghiệp vụ: `personal_transactions`, `personal_wallets`, `personal_categories`,
`personal_legacy_category_map`, `personal_budget_limits`, `personal_goals`,
`personal_wallet_transfers`; `personal_finance_requests` giữ biên nhận chống trùng.
Snapshot tổng hợp phía máy chủ, không giới hạn ở trang 1.000 dòng đầu tiên.
Tài khoản đăng nhập chỉ đọc dữ liệu của mình và ghi qua RPC; helper
`personal_finance_apply` không được gọi trực tiếp.

Foundation được phát hành trước ứng dụng, giữ đường ghi cũ trong cửa sổ chuyển
phiên bản. Khi ứng dụng mới đã hoạt động, migration riêng thu hồi quyền ghi trực
tiếp vào bảng cũ. Sau bước này, client cũ phải tải lại. Rollback ứng dụng cũ cần
migration tương thích ACL đã review; không rollback schema phá hủy.

Ví cá nhân không cộng vào `income_expenses`, sổ quỹ, KQKD hay chia lợi nhuận.
Thông tin lợi nhuận cổ đông là đường xem riêng; việc được chia không tự tạo một
khoản Thu cá nhân. Xem [Cổ đông và lợi nhuận](12-co-dong-loi-nhuan.md).
