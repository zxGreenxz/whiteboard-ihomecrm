# Nguồn phường xã cho mục Kính gửi CT01

Mục “Kính gửi” trên CT01 phải ưu tiên đơn vị hành chính nằm trong trường “Địa chỉ chi tiết” của tòa nhà. Hệ thống tìm phần bắt đầu bằng `Phường`, `Xã`, `Thị trấn` hoặc `Đặc khu`, lấy từ đó đến hết địa chỉ và tạo nội dung `Công an <phần địa chỉ hành chính>`.

Ví dụ, `111/46F Phạm Văn Chiêu, Phường An Hội Tây, TP Hồ Chí Minh` tạo ra `Công an Phường An Hội Tây, TP Hồ Chí Minh`. Nếu địa chỉ chi tiết không chứa thành phần hành chính phù hợp, hệ thống dùng trường Phường/Xã hiện có của tòa nhà để giữ khả năng tải hồ sơ cũ.

Thay đổi chỉ tác động đến `registration_authority`; địa chỉ tòa nhà trong CT01 và hợp đồng vẫn dùng nguyên trường “Địa chỉ chi tiết”. Kiểm thử phải chứng minh địa chỉ chi tiết thắng dữ liệu Phường/Xã cũ và nhánh dự phòng vẫn hoạt động.
