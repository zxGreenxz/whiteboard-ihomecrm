# Tài liệu Yêu cầu - Đồng bộ Ứng dụng Web với Tài liệu Hướng dẫn Resident

> **Lifecycle:** historical Kiro spec. Cây `resident-docs/` đã được loại bỏ; mục lục hiện hành là `docs/README.md`, hướng dẫn xuất bản ở `docs/huong-dan-su-dung/` và tham chiếu hệ thống ở `docs/he-thong/`.

## Giới thiệu

Tài liệu này ghi lại yêu cầu đồng bộ với bộ Resident docs cũ. Khi tái sử dụng requirement, phải đối chiếu lại với `docs/huong-dan-su-dung/`, `docs/he-thong/` và code hiện tại; không dùng `resident-docs/SUMMARY.md` đã xoá.

## Bảng thuật ngữ

- **Hệ_Thống**: Ứng dụng web CRM/Resident
- **Sidebar**: Thanh điều hướng bên trái của ứng dụng
- **SUMMARY.md**: File mục lục tổng thể của tài liệu hướng dẫn Resident
- **Trang_Cài_Đặt**: Module cài đặt hệ thống trong ứng dụng
- **Trang_Báo_Cáo**: Module báo cáo trong ứng dụng
- **Danh_Mục_Khác**: Các danh mục phụ trong cài đặt hệ thống (Tài chính, Tài sản, Hotline, Loại công việc, Danh mục chung, Danh sách tầng)
- **Mẫu_Biểu**: Module quản lý các mẫu biểu (chữ ký, hợp đồng đặt cọc, hợp đồng thuê, biên bản bàn giao, mẫu hóa đơn, mẫu thu chi)
- **Ký_Điện_Tử**: Tính năng ký hợp đồng điện tử online
- **Trang_Tài_Khoản**: Module quản lý thông tin cá nhân và gói cước

## Yêu cầu

---

### Yêu cầu 1: Cấu trúc điều hướng (Sidebar/Menu) phải khớp 100% với SUMMARY.md

**User Story:** Là chủ nhà, tôi muốn menu điều hướng của ứng dụng phản ánh đúng cấu trúc trong tài liệu hướng dẫn, để tôi có thể tìm đúng tính năng theo hướng dẫn.

#### Tiêu chí chấp nhận

1. THE Sidebar SHALL hiển thị các nhóm menu chính theo đúng thứ tự trong SUMMARY.md: Theo dõi nhanh (Bảng tin, Sơ đồ toà nhà), Quản lý & Vận hành (Danh mục dữ liệu, Khách hàng, Tài chính, Thông báo, Công việc), Báo cáo, Cài đặt hệ thống, Tài khoản
2. THE Sidebar SHALL hiển thị mục "Danh mục dữ liệu" với các mục con: Toà nhà, Căn hộ (hiện đang gọi là "Phòng"), Giường, Dịch vụ, Tài sản
3. THE Sidebar SHALL hiển thị mục "Khách hàng" với các mục con: Khách hẹn, Đặt cọc, Hợp đồng, Khách hàng, Phương tiện
4. THE Sidebar SHALL hiển thị mục "Tài chính" với các mục con: Ghi chỉ số, Hoá đơn, Thu chi
5. THE Sidebar SHALL hiển thị mục "Thông báo" như một mục riêng biệt trong nhóm "Quản lý & Vận hành"
6. THE Sidebar SHALL hiển thị mục "Công việc" như một mục riêng biệt trong nhóm "Quản lý & Vận hành"
7. THE Sidebar SHALL hiển thị mục "Cài đặt hệ thống" với các mục con: Cài đặt chung, Danh mục khác, Mẫu biểu, Nhân viên
8. THE Sidebar SHALL hiển thị mục "Tài khoản" với các mục con: Thông tin cá nhân, Gói cước
9. IF mục "Sổ quỹ" hiện đang nằm trong nhóm "Tài chính" nhưng không có trong SUMMARY.md ở vị trí đó, THEN THE Hệ_Thống SHALL di chuyển "Sổ quỹ" sang đúng vị trí theo tài liệu (nằm trong Báo cáo Tài chính)
10. THE Sidebar SHALL loại bỏ hoàn toàn mục "Khu vực" (Areas) khỏi sidebar và toàn bộ ứng dụng vì không có trong SUMMARY.md
11. THE Sidebar SHALL loại bỏ hoàn toàn mục "Trợ lý AI" (AI Assistant) khỏi sidebar và toàn bộ ứng dụng vì không có trong tài liệu hướng dẫn Resident gốc

---

### Yêu cầu 2: Module Đăng ký & Đăng nhập đồng bộ với tài liệu

**User Story:** Là người dùng mới, tôi muốn quy trình đăng ký và đăng nhập hoạt động đúng như mô tả trong tài liệu hướng dẫn.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cung cấp trang đăng ký với các trường thông tin theo tài liệu `dang-ky-and-dang-nhap.md`
2. THE Hệ_Thống SHALL cung cấp trang đăng nhập với giao diện và flow theo tài liệu
3. THE Hệ_Thống SHALL cung cấp tính năng quên mật khẩu và đặt lại mật khẩu
4. WHEN người dùng đăng ký thành công, THE Hệ_Thống SHALL hiển thị hướng dẫn khởi tạo dữ liệu cho người mới bắt đầu theo tài liệu `huong-dan-khoi-tao-du-lieu-tren-may-tinh-danh-cho-nguoi-moi-bat-dau.md`

---

### Yêu cầu 3: Module Theo dõi nhanh - Bảng tin (Dashboard)

**User Story:** Là chủ nhà, tôi muốn bảng tin tổng quan hiển thị đầy đủ thông tin theo tài liệu hướng dẫn, để tôi nắm bắt nhanh tình hình kinh doanh.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị Dashboard với các thẻ thống kê: Tổng số phòng, Phòng đang thuê, Phòng trống, Doanh thu tháng, Công nợ tổng
2. THE Hệ_Thống SHALL hiển thị biểu đồ doanh thu theo tháng (Line chart)
3. THE Hệ_Thống SHALL hiển thị biểu đồ tỷ lệ lấp đầy (Pie chart)
4. THE Hệ_Thống SHALL hiển thị danh sách cảnh báo: Hóa đơn quá hạn, Hợp đồng sắp hết hạn, Sự cố chưa xử lý
5. THE Hệ_Thống SHALL hiển thị hoạt động gần đây (Recent activities)
6. THE Hệ_Thống SHALL cho phép lọc Dashboard theo toà nhà

---

### Yêu cầu 4: Module Theo dõi nhanh - Sơ đồ Toà nhà

**User Story:** Là chủ nhà, tôi muốn xem sơ đồ trực quan các phòng theo tầng với mã màu trạng thái, để nhanh chóng nắm bắt tình trạng phòng.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị sơ đồ phòng theo tầng dạng lưới (Grid view) theo tài liệu `so-do-toa-nha.md`
2. THE Hệ_Thống SHALL sử dụng mã màu trạng thái: Xanh (Đang thuê), Cam (Đã đặt cọc), Đỏ (Trống), Tím (Sắp trống), Xám (Ngừng hoạt động)
3. WHEN người dùng click vào một phòng trên sơ đồ, THE Hệ_Thống SHALL hiển thị popup thông tin: Tên phòng, diện tích, giá, hợp đồng hiện tại, khách thuê, hóa đơn gần nhất
4. THE Hệ_Thống SHALL cho phép lọc sơ đồ theo toà nhà, tầng, trạng thái
5. THE Hệ_Thống SHALL cho phép tìm kiếm phòng trên sơ đồ

---

### Yêu cầu 5: Danh mục dữ liệu - Toà nhà

**User Story:** Là chủ nhà, tôi muốn quản lý thông tin toà nhà đúng theo hướng dẫn, bao gồm thêm/sửa/xóa và gán dịch vụ.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép thêm toà nhà với các trường: Tên toà nhà, Tỉnh/Thành phố, Quận/Huyện, Xã/Phường, Địa chỉ chi tiết, Tình trạng hoạt động theo tài liệu `toa-nha.md`
2. THE Hệ_Thống SHALL cho phép gán danh sách dịch vụ cho toà nhà khi tạo mới
3. THE Hệ_Thống SHALL hiển thị danh sách toà nhà với các cột thông tin và nút Thao tác (Cập nhật, Xóa)
4. WHEN tạo toà nhà thành công, THE Hệ_Thống SHALL hiển thị thông báo "Dữ liệu đã được TẠO thành công"
5. THE Hệ_Thống SHALL đánh dấu các trường bắt buộc bằng dấu (*)

---

### Yêu cầu 6: Danh mục dữ liệu - Căn hộ (Phòng)

**User Story:** Là chủ nhà, tôi muốn quản lý căn hộ/phòng theo đúng tài liệu hướng dẫn, bao gồm thông tin chi tiết và liên kết với toà nhà.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL sử dụng thuật ngữ "Căn hộ" thay vì "Phòng" trong giao diện để khớp với tài liệu `can-ho.md`
2. THE Hệ_Thống SHALL cho phép thêm căn hộ với các trường theo tài liệu: Toà nhà, Tầng, Tên căn hộ, Diện tích, Giá thuê, Số người tối đa, Tiện ích, Ảnh
3. THE Hệ_Thống SHALL hiển thị danh sách căn hộ với bộ lọc theo toà nhà, tầng, trạng thái
4. THE Hệ_Thống SHALL cho phép xem chi tiết căn hộ bao gồm: Thông tin cơ bản, Hợp đồng hiện tại, Tài sản trong phòng, Lịch sử hóa đơn

---

### Yêu cầu 7: Danh mục dữ liệu - Giường

**User Story:** Là chủ nhà quản lý ký túc xá/dorm, tôi muốn quản lý giường trong từng phòng theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép thêm giường với các trường theo tài liệu `giuong.md`: Căn hộ, Tên giường, Giá thuê, Trạng thái
2. THE Hệ_Thống SHALL hiển thị danh sách giường với bộ lọc theo toà nhà, căn hộ
3. THE Hệ_Thống SHALL cho phép liên kết giường với hợp đồng

---

### Yêu cầu 8: Danh mục dữ liệu - Dịch vụ

**User Story:** Là chủ nhà, tôi muốn quản lý danh sách dịch vụ (điện, nước, internet, vệ sinh...) theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép thêm dịch vụ với các trường theo tài liệu `dich-vu.md`: Tên dịch vụ, Đơn giá, Đơn vị tính, Loại tính phí (Cố định, Theo chỉ số, Theo người)
2. THE Hệ_Thống SHALL hiển thị danh sách dịch vụ với thao tác Cập nhật, Xóa
3. THE Hệ_Thống SHALL cho phép gán dịch vụ vào toà nhà và hợp đồng

---

### Yêu cầu 9: Danh mục dữ liệu - Tài sản

**User Story:** Là chủ nhà, tôi muốn quản lý tài sản/nội thất trong phòng theo tài liệu hướng dẫn.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép thêm tài sản với các trường theo tài liệu `tai-san.md`: Mã tài sản, Tên, Loại tài sản, Số lượng, Giá trị, Tình trạng, Vị trí (Toà nhà, Phòng), Nhà cung cấp, Ngày mua
2. THE Hệ_Thống SHALL hiển thị danh sách tài sản với bộ lọc theo toà nhà, phòng, loại, tình trạng
3. THE Hệ_Thống SHALL cho phép theo dõi lịch sử di chuyển tài sản (từ phòng sang phòng, từ kho sang phòng)
4. THE Hệ_Thống SHALL cho phép ghi nhận lịch sử sửa chữa tài sản

---

### Yêu cầu 10: Khách hàng - Khách hẹn (Leads)

**User Story:** Là chủ nhà, tôi muốn quản lý khách hẹn xem phòng theo đúng quy trình trong tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép tạo khách hẹn với các trường theo tài liệu `khach-hen.md`: Tên khách, SĐT, Email, Nguồn (Facebook, Zalo, Điện thoại, Giới thiệu, Walk-in), Toà nhà, Phòng quan tâm, Thời gian hẹn, Nhân viên phụ trách, Ghi chú
2. THE Hệ_Thống SHALL hiển thị danh sách khách hẹn với trạng thái: Mới, Đã hẹn, Đang tư vấn, Đã chuyển đổi, Thất bại
3. WHEN khách hẹn đồng ý thuê, THE Hệ_Thống SHALL cho phép chuyển đổi khách hẹn thành đặt cọc
4. THE Hệ_Thống SHALL cho phép ghi nhận lịch sử hoạt động (gọi điện, gặp mặt, ghi chú) cho từng khách hẹn

---

### Yêu cầu 11: Khách hàng - Đặt cọc

**User Story:** Là chủ nhà, tôi muốn quản lý đặt cọc theo đúng quy trình trong tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép tạo đặt cọc với các trường theo tài liệu `dat-coc.md`: Khách hàng, Phòng/Giường, Số tiền cọc, Ngày cọc, Giữ phòng đến ngày
2. THE Hệ_Thống SHALL hiển thị danh sách đặt cọc với trạng thái: Chờ xác nhận, Đã xác nhận, Đã chuyển thành HĐ, Đã hoàn cọc, Bị mất cọc
3. WHEN đặt cọc được xác nhận, THE Hệ_Thống SHALL cho phép chuyển đổi thành hợp đồng
4. THE Hệ_Thống SHALL cho phép in phiếu thu tiền cọc

---

### Yêu cầu 12: Khách hàng - Hợp đồng

**User Story:** Là chủ nhà, tôi muốn quản lý hợp đồng thuê với đầy đủ tính năng theo tài liệu, bao gồm ký điện tử.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép tạo hợp đồng với các trường theo tài liệu `hop-dong.md`: Khách thuê, Phòng/Giường, Ngày bắt đầu, Ngày kết thúc, Giá thuê, Tiền cọc, Dịch vụ kèm theo, Kỳ thanh toán
2. THE Hệ_Thống SHALL hiển thị danh sách hợp đồng với trạng thái: Mới, Đang hiệu lực, Sắp hết hạn, Đã hết hạn, Đã thanh lý
3. THE Hệ_Thống SHALL hỗ trợ gia hạn hợp đồng theo tài liệu
4. THE Hệ_Thống SHALL hỗ trợ chuyển nhượng hợp đồng theo tài liệu
5. THE Hệ_Thống SHALL hỗ trợ thanh lý hợp đồng với quy trình duyệt theo tài liệu
6. WHEN cài đặt "Ký hợp đồng online" được bật, THE Hệ_Thống SHALL hiển thị tính năng ký hợp đồng điện tử theo tài liệu `ky-hop-dong-dien-tu.md` với 2 flow: Dành cho chủ nhà và Dành cho khách thuê

---

### Yêu cầu 13: Khách hàng - Thông tin Khách hàng

**User Story:** Là chủ nhà, tôi muốn quản lý thông tin khách hàng (khách thuê) theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị danh sách khách hàng với các thông tin theo tài liệu `khach-hang.md`: Tên, SĐT, Email, CMND/CCCD, Phòng đang thuê, Trạng thái hợp đồng
2. THE Hệ_Thống SHALL cho phép xem chi tiết khách hàng bao gồm: Thông tin cá nhân, Lịch sử hợp đồng, Lịch sử thanh toán, Phương tiện
3. THE Hệ_Thống SHALL phân biệt rõ giữa "Khách hàng" (mục riêng trong Sidebar) và "Khách thuê" (Tenants) - đảm bảo đúng theo cấu trúc SUMMARY.md

---

### Yêu cầu 14: Khách hàng - Phương tiện

**User Story:** Là chủ nhà, tôi muốn quản lý phương tiện của khách thuê theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép thêm phương tiện với các trường theo tài liệu `phuong-tien.md`: Loại xe, Tên dòng xe, Biển số, Màu xe, Chủ xe (Khách thuê), Hợp đồng liên kết, Phí gửi xe
2. THE Hệ_Thống SHALL hiển thị danh sách phương tiện với bộ lọc theo toà nhà, khách thuê
3. THE Hệ_Thống SHALL cho phép liên kết phương tiện với hợp đồng để tính phí gửi xe vào hóa đơn

---

### Yêu cầu 15: Tài chính - Ghi chỉ số

**User Story:** Là chủ nhà, tôi muốn ghi chỉ số công tơ điện nước theo đúng quy trình trong tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép ghi chỉ số công tơ theo tài liệu `ghi-chi-so.md`: Chọn toà nhà, phòng, loại công tơ (Điện/Nước), chỉ số đầu kỳ, chỉ số cuối kỳ, ảnh chụp
2. THE Hệ_Thống SHALL tự động tính tiêu thụ = Chỉ số cuối - Chỉ số đầu
3. WHEN cài đặt "Tự động duyệt chỉ số" được bật, THE Hệ_Thống SHALL tự động duyệt chỉ số sau khi ghi
4. WHEN cài đặt "Cho phép cư dân chốt điện nước từ app" được bật, THE Hệ_Thống SHALL cho phép khách thuê tự nhập chỉ số

---

### Yêu cầu 16: Tài chính - Hoá đơn

**User Story:** Là chủ nhà, tôi muốn quản lý hóa đơn theo đúng quy trình trong tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép tạo hóa đơn với các trường theo tài liệu `hoa-don.md`: Hợp đồng, Kỳ thanh toán, Các dịch vụ, Tiền thuê, Tổng tiền, Hạn thanh toán
2. THE Hệ_Thống SHALL hiển thị danh sách hóa đơn với trạng thái: Nháp, Chờ duyệt, Đã duyệt, Đã thanh toán, Quá hạn
3. WHEN cài đặt "Tự động duyệt hóa đơn" được bật, THE Hệ_Thống SHALL tự động duyệt hóa đơn sau khi tạo
4. WHEN cài đặt "Sử dụng hệ số" được bật, THE Hệ_Thống SHALL hiển thị cột hệ số trong hóa đơn
5. THE Hệ_Thống SHALL hỗ trợ tính toán chu kỳ dịch vụ theo 3 cách: Theo chu kỳ trong tháng, Theo ngày bắt đầu tính tiền, Theo ngày chốt tiền
6. THE Hệ_Thống SHALL hỗ trợ chia tỷ lệ khi lẻ ngày: Theo số ngày trong tháng hoặc Chia cố định 30 ngày

---

### Yêu cầu 17: Tài chính - Thu chi

**User Story:** Là chủ nhà, tôi muốn quản lý thu chi theo đúng quy trình trong tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép tạo phiếu thu/chi theo tài liệu `thu-chi.md`: Loại (Thu/Chi), Số tiền, Phương thức thanh toán, Liên kết hóa đơn, Ghi chú
2. THE Hệ_Thống SHALL hiển thị danh sách thu chi với bộ lọc theo ngày, loại, trạng thái
3. WHEN cài đặt "Tự động duyệt thu chi" được bật, THE Hệ_Thống SHALL tự động duyệt phiếu thu/chi sau khi tạo
4. THE Hệ_Thống SHALL cho phép in phiếu thu/chi theo mẫu biểu đã cài đặt

---

### Yêu cầu 18: Thông báo

**User Story:** Là chủ nhà, tôi muốn gửi thông báo đến khách thuê theo đúng quy trình trong tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép tạo thông báo với các trường theo tài liệu `thong-bao.md`: Tiêu đề, Nội dung, Đính kèm (ảnh/file), Kênh gửi (App Resident, Email), Người nhận (theo toà nhà hoặc theo phòng)
2. THE Hệ_Thống SHALL hiển thị danh sách thông báo với cột Trạng thái gửi
3. THE Hệ_Thống SHALL cho phép sửa thông báo (chỉ Tiêu đề, Nội dung, Đính kèm - không sửa được Người nhận và Phương thức gửi)
4. THE Hệ_Thống SHALL cho phép xóa thông báo với xác nhận "Bạn có chắc chắn muốn xoá không?"
5. WHEN cài đặt thông báo tự động được bật, THE Hệ_Thống SHALL tự động gửi thông báo: Nhắc ngày lập hóa đơn, Nhắc hạn thanh toán

---

### Yêu cầu 19: Công việc (Tasks/Issues)

**User Story:** Là chủ nhà, tôi muốn quản lý công việc và sự cố theo đúng quy trình trong tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cho phép tạo công việc/sự cố theo tài liệu `cong-viec.md`: Tiêu đề, Mô tả, Loại công việc, Mức độ ưu tiên, Phòng/Toà nhà, Người phụ trách, Hạn hoàn thành, Ảnh đính kèm
2. THE Hệ_Thống SHALL hiển thị danh sách công việc với trạng thái: Mới, Đã phân công, Đang xử lý, Hoàn thành, Đã đóng
3. THE Hệ_Thống SHALL cho phép cập nhật tiến độ công việc với ghi chú và ảnh
4. THE Hệ_Thống SHALL cho phép ghi nhận chi phí phát sinh cho công việc
5. THE Hệ_Thống SHALL sử dụng thuật ngữ "Công việc" thay vì "Sự cố" (Issues) trong giao diện để khớp với SUMMARY.md

---


### Yêu cầu 20: Báo cáo BĐS - Căn hộ trống

**User Story:** Là chủ nhà, tôi muốn xem báo cáo căn hộ trống theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo căn hộ trống theo tài liệu `can-ho-trong.md`: Danh sách phòng trống, Thời gian trống, Giá thuê, Số ngày trống
2. THE Hệ_Thống SHALL cho phép lọc theo toà nhà, tầng
3. THE Hệ_Thống SHALL cho phép xuất báo cáo ra Excel/PDF

---

### Yêu cầu 21: Báo cáo BĐS - Căn hộ sắp trống

**User Story:** Là chủ nhà, tôi muốn xem báo cáo căn hộ sắp trống để chuẩn bị cho thuê lại.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo căn hộ sắp trống theo tài liệu `can-ho-sap-trong.md`: HĐ sắp hết hạn, Ngày kết thúc, Khách thuê, Trạng thái gia hạn
2. THE Hệ_Thống SHALL cho phép lọc theo khoảng thời gian (30, 15, 7 ngày)
3. THE Hệ_Thống SHALL cho phép xuất báo cáo ra Excel/PDF

---

### Yêu cầu 22: Báo cáo BĐS - Phòng gia hạn, chuyển nhượng

**User Story:** Là chủ nhà, tôi muốn xem báo cáo các hợp đồng gia hạn và chuyển nhượng.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo gia hạn/chuyển nhượng theo tài liệu `phong-gia-han-chuyen-nhuong.md`
2. THE Hệ_Thống SHALL cho phép lọc theo khoảng thời gian, toà nhà
3. THE Hệ_Thống SHALL cho phép xuất báo cáo ra Excel/PDF

---

### Yêu cầu 23: Báo cáo BĐS - Tỉ lệ lấp đầy

**User Story:** Là chủ nhà, tôi muốn xem tỉ lệ lấp đầy theo cả phiên bản cũ và mới.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo tỉ lệ lấp đầy phiên bản cũ theo tài liệu `ti-le-lap-day-cu.md`
2. THE Hệ_Thống SHALL hiển thị báo cáo tỉ lệ lấp đầy phiên bản mới theo tài liệu `ti-le-lap-day-moi.md`
3. THE Hệ_Thống SHALL cho phép lọc theo toà nhà, khoảng thời gian
4. THE Hệ_Thống SHALL hiển thị biểu đồ trend tỉ lệ lấp đầy theo tháng

---

### Yêu cầu 24: Báo cáo BĐS - Khuyến mại, Cho thuê, Bỏ trả

**User Story:** Là chủ nhà, tôi muốn xem các báo cáo khuyến mại, cho thuê mới và bỏ trả.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo khuyến mại theo tài liệu `bao-cao-khuyen-mai.md`: HĐ có giảm giá, Tổng giảm giá
2. THE Hệ_Thống SHALL hiển thị báo cáo cho thuê theo tài liệu `bao-cao-cho-thue.md`: HĐ mới trong kỳ, Doanh thu mới
3. THE Hệ_Thống SHALL hiển thị báo cáo bỏ trả theo tài liệu `bao-cao-bo-tra.md`: HĐ thanh lý, Lý do chấm dứt, Tỷ lệ bỏ trả
4. THE Hệ_Thống SHALL cho phép xuất tất cả báo cáo ra Excel/PDF

---

### Yêu cầu 25: Báo cáo Tài chính - Sổ quỹ theo ngày

**User Story:** Là chủ nhà, tôi muốn xem sổ quỹ theo ngày để theo dõi thu chi hàng ngày.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị sổ quỹ theo ngày theo tài liệu `so-quy-theo-ngay.md`: Thu chi hàng ngày, Số dư đầu kỳ, Tổng thu, Tổng chi, Số dư cuối kỳ
2. THE Hệ_Thống SHALL cho phép lọc theo khoảng ngày, toà nhà
3. THE Hệ_Thống SHALL cho phép xuất báo cáo ra Excel/PDF

---

### Yêu cầu 26: Báo cáo Tài chính - Dòng tiền

**User Story:** Là chủ nhà, tôi muốn xem báo cáo dòng tiền (Cash Flow).

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo dòng tiền theo tài liệu `dong-tien.md`
2. THE Hệ_Thống SHALL cho phép lọc theo khoảng thời gian, toà nhà
3. THE Hệ_Thống SHALL cho phép xuất báo cáo ra Excel/PDF

---

### Yêu cầu 27: Báo cáo Tài chính - Phân bổ lợi nhuận

**User Story:** Là chủ nhà, tôi muốn xem báo cáo phân bổ lợi nhuận.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo phân bổ lợi nhuận theo tài liệu `phan-bo-loi-nhuan.md`: Doanh thu, Chi phí, Lợi nhuận, Margin %
2. THE Hệ_Thống SHALL cho phép lọc theo khoảng thời gian, toà nhà
3. THE Hệ_Thống SHALL cho phép xuất báo cáo ra Excel/PDF

---

### Yêu cầu 28: Báo cáo Tài chính - Công nợ, Khách nợ, Lịch thanh toán, Tiền thừa, Tiền cọc

**User Story:** Là chủ nhà, tôi muốn xem đầy đủ các báo cáo tài chính liên quan đến công nợ.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo công nợ hợp đồng mới theo tài liệu `cong-no-hop-dong-moi.md`
2. THE Hệ_Thống SHALL hiển thị báo cáo khách nợ tiền theo tài liệu `khach-no-tien.md`: Top debtors, Tổng công nợ, Phân loại theo mức độ
3. THE Hệ_Thống SHALL hiển thị báo cáo lịch thanh toán theo tài liệu `lich-thanh-toan.md`: HĐ cần thu trong tháng, Ngày đáo hạn, Số tiền
4. THE Hệ_Thống SHALL hiển thị báo cáo tiền thừa theo tài liệu `tien-thua.md`: Khách trả thừa, Cần hoàn lại
5. THE Hệ_Thống SHALL hiển thị báo cáo danh sách tiền cọc theo tài liệu `danh-sach-tien-coc.md`: Tổng tiền cọc đang giữ, Phân theo trạng thái
6. THE Hệ_Thống SHALL cho phép xuất tất cả báo cáo ra Excel/PDF

---

### Yêu cầu 29: Báo cáo Công việc

**User Story:** Là chủ nhà, tôi muốn xem báo cáo công việc theo tổng quan, theo nhân viên và theo căn hộ.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị báo cáo tổng quan công việc theo tài liệu `tong-quan-cong-viec.md`: Tổng số task, Hoàn thành, Đang xử lý, Quá hạn
2. THE Hệ_Thống SHALL hiển thị báo cáo công việc theo nhân viên theo tài liệu `cv-theo-nhan-vien.md`: Assigned tasks, Performance, Completion rate
3. THE Hệ_Thống SHALL hiển thị báo cáo công việc theo căn hộ theo tài liệu `cv-theo-can-ho.md`: Sự cố theo phòng, Tần suất, Chi phí sửa chữa
4. THE Hệ_Thống SHALL cho phép xuất tất cả báo cáo ra Excel/PDF

---

### Yêu cầu 30: Cài đặt chung

**User Story:** Là chủ nhà, tôi muốn cài đặt hệ thống với đầy đủ tùy chọn theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Trang_Cài_Đặt SHALL hiển thị tab "Cài đặt cơ bản" với tính năng upload logo theo tài liệu `cai-dat-chung.md`
2. THE Trang_Cài_Đặt SHALL hiển thị tab "Hợp đồng" với đầy đủ 7 tùy chọn theo tài liệu: Tự cài số người dùng DV, Kiểm kê tài sản khi ký/thanh lý, Tự động lập HĐ mới khi gia hạn, Ký HĐ online, Cài đặt ngày thanh toán, Hiển thị trạng thái sắp hết hạn, Nhận thông báo quá hạn HĐ
3. THE Trang_Cài_Đặt SHALL hiển thị tab "Hóa đơn" với đầy đủ 10 tùy chọn theo tài liệu: Tự động duyệt chỉ số, Tự động duyệt hóa đơn, Sử dụng hệ số, Tự động tính hệ số theo ngày, Chu kỳ tính dịch vụ, Chia tỷ lệ lẻ ngày, Hạn thanh toán, Tự lập hóa đơn đặt cọc, Tự động sinh hóa đơn kỳ tiếp, Cho phép cư dân chốt điện nước
4. THE Trang_Cài_Đặt SHALL hiển thị tab "Thu chi" với tùy chọn: Tự động duyệt thu chi
5. THE Trang_Cài_Đặt SHALL hiển thị tab "Thông báo" với 2 tùy chọn: Nhắc ngày lập hóa đơn, Nhắc hạn thanh toán

---

### Yêu cầu 31: Cài đặt - Danh mục khác

**User Story:** Là chủ nhà, tôi muốn quản lý các danh mục phụ trong cài đặt theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cung cấp trang "Danh mục khác" trong Cài đặt với các mục con theo SUMMARY.md
2. THE Hệ_Thống SHALL cung cấp quản lý Tài chính: Tài khoản ngân hàng, Gạch nợ tự động, Hóa đơn điện tử, Loại thu chi, Định mức dịch vụ, Đồng hồ công tơ theo các tài liệu tương ứng
3. THE Hệ_Thống SHALL cung cấp quản lý Tài sản: Nhà cung cấp, Kho tài sản, Loại tài sản, Lịch sử di chuyển tài sản, Lịch sử sửa chữa theo các tài liệu tương ứng
4. THE Hệ_Thống SHALL cung cấp quản lý Hotline theo tài liệu `quan-ly-hotline.md`
5. THE Hệ_Thống SHALL cung cấp quản lý Loại công việc theo tài liệu `loai-cong-viec.md`
6. THE Hệ_Thống SHALL cung cấp quản lý Danh mục chung theo tài liệu `danh-muc-chung.md`
7. THE Hệ_Thống SHALL cung cấp quản lý Danh sách tầng theo tài liệu `danh-sach-tang.md`

---

### Yêu cầu 32: Cài đặt - Mẫu biểu

**User Story:** Là chủ nhà, tôi muốn quản lý các mẫu biểu (templates) theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cung cấp quản lý Mẫu chữ ký theo tài liệu `mau-chu-ky.md`
2. THE Hệ_Thống SHALL cung cấp quản lý Hợp đồng đặt cọc (template) theo tài liệu `hop-dong-dat-coc.md`
3. THE Hệ_Thống SHALL cung cấp quản lý Hợp đồng thuê (template) theo tài liệu `hop-dong-thue.md`
4. THE Hệ_Thống SHALL cung cấp quản lý Biên bản bàn giao (template) theo tài liệu `bien-ban-ban-giao.md`
5. THE Hệ_Thống SHALL cung cấp quản lý Mẫu hóa đơn theo tài liệu `mau-hoa-don.md`
6. THE Hệ_Thống SHALL cung cấp quản lý Mẫu thu chi theo tài liệu `mau-thu-chi.md`

---

### Yêu cầu 33: Cài đặt - Nhân viên

**User Story:** Là chủ nhà, tôi muốn quản lý nhân viên và phân quyền theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cung cấp quản lý Loại tài khoản (Roles) theo tài liệu `loai-tai-khoan.md`
2. THE Hệ_Thống SHALL cung cấp quản lý Người dùng (Users) theo tài liệu `nguoi-dung.md`: Thêm nhân viên, Thông tin cá nhân, Vai trò, Trạng thái
3. THE Hệ_Thống SHALL hỗ trợ phân quyền theo module: Buildings, Contracts, Invoices, Reports, Settings
4. THE Hệ_Thống SHALL hỗ trợ gán quyền theo toà nhà (Staff chỉ quản lý toà được gán)

---

### Yêu cầu 34: Tài khoản - Thông tin cá nhân & Gói cước

**User Story:** Là người dùng, tôi muốn quản lý thông tin cá nhân và xem gói cước đang sử dụng.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cung cấp trang Thông tin cá nhân theo tài liệu `thong-tin-ca-nhan.md`: Tên, Email, SĐT, Avatar, Đổi mật khẩu
2. THE Hệ_Thống SHALL cung cấp trang Gói cước theo tài liệu `goi-cuoc.md`: Gói hiện tại, Hạn sử dụng, Nâng cấp gói
3. THE Sidebar SHALL hiển thị mục "Tài khoản" với 2 mục con: Thông tin cá nhân, Gói cước

---

### Yêu cầu 35: Thông tin khác - Mã code

**User Story:** Là chủ nhà, tôi muốn hiểu và tùy chỉnh hệ thống mã code tự động theo tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hỗ trợ tự động tạo mã code cho: Đặt cọc, Hợp đồng, Hóa đơn, Biên bản bàn giao tài sản theo các tài liệu trong `thong-tin-khac/ma-code/`
2. THE Hệ_Thống SHALL cho phép tùy chỉnh format mã code: Tiền tố, Dấu phân cách, Thành phần ngày, Số thứ tự, Độ dài padding
3. THE Hệ_Thống SHALL hỗ trợ reset counter theo: Ngày, Tháng, Năm, Không reset

---

### Yêu cầu 36: Đồng bộ thuật ngữ và nhãn UI

**User Story:** Là người dùng, tôi muốn thuật ngữ trong ứng dụng khớp 100% với tài liệu hướng dẫn để không bị nhầm lẫn.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL sử dụng "Căn hộ" thay vì "Phòng" (Rooms) trong toàn bộ giao diện
2. THE Hệ_Thống SHALL sử dụng "Công việc" thay vì "Sự cố" (Issues) trong toàn bộ giao diện
3. THE Hệ_Thống SHALL sử dụng "Khách hẹn" thay vì "Leads" trong toàn bộ giao diện
4. THE Hệ_Thống SHALL sử dụng "Bảng tin" thay vì "Tổng quan" cho Dashboard
5. THE Hệ_Thống SHALL sử dụng "Danh mục dữ liệu" thay vì "Master Data" cho nhóm menu
6. THE Hệ_Thống SHALL loại bỏ hoàn toàn mục "Khu vực" (Areas) khỏi sidebar và toàn bộ ứng dụng vì không có trong SUMMARY.md
7. THE Hệ_Thống SHALL loại bỏ mục "Duyệt thanh lý" khỏi menu chính (tích hợp vào trong trang Hợp đồng)
8. THE Hệ_Thống SHALL hiển thị tất cả thông báo hệ thống bằng tiếng Việt theo đúng format trong tài liệu (ví dụ: "Dữ liệu đã được TẠO thành công")

---

### Yêu cầu 37: Bổ sung hình ảnh minh họa và giải thích tính năng

**User Story:** Là người dùng, tôi muốn ứng dụng có hình ảnh minh họa và giải thích tính năng rõ ràng tại các màn hình quan trọng.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL hiển thị tooltip hoặc hướng dẫn ngắn cho các tính năng phức tạp trong Cài đặt chung (mỗi toggle/switch cần có mô tả chức năng)
2. THE Hệ_Thống SHALL hiển thị placeholder text hướng dẫn trong các form nhập liệu quan trọng
3. THE Hệ_Thống SHALL hiển thị empty state với hướng dẫn khi danh sách trống (ví dụ: "Chưa có toà nhà nào. Hãy thêm toà nhà đầu tiên")
4. WHEN người dùng mới đăng nhập lần đầu, THE Hệ_Thống SHALL hiển thị hướng dẫn khởi tạo dữ liệu theo tài liệu `huong-dan-khoi-tao-du-lieu-tren-may-tinh-danh-cho-nguoi-moi-bat-dau.md`
5. THE Hệ_Thống SHALL hiển thị breadcrumb navigation đúng theo cấu trúc menu trong SUMMARY.md

---

### Yêu cầu 38: Database Schema đồng bộ với tính năng

**User Story:** Là developer, tôi muốn database schema hỗ trợ đầy đủ tất cả tính năng được mô tả trong tài liệu.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL có bảng `floors` (Danh sách tầng) để hỗ trợ quản lý tầng theo tài liệu `danh-sach-tang.md`
2. THE Hệ_Thống SHALL có bảng `hotlines` để hỗ trợ quản lý Hotline theo tài liệu `quan-ly-hotline.md`
3. THE Hệ_Thống SHALL có bảng `income_expense_types` (Loại thu chi) theo tài liệu `loai-thu-chi.md`
4. THE Hệ_Thống SHALL có bảng `service_quotas` (Định mức dịch vụ) theo tài liệu `dinh-muc-dich-vu.md`
5. THE Hệ_Thống SHALL có bảng `meters` (Đồng hồ công tơ) theo tài liệu `dong-ho-cong-to.md`
6. THE Hệ_Thống SHALL có bảng `auto_debt_config` (Gạch nợ tự động) theo tài liệu `gach-no-tu-dong.md`
7. THE Hệ_Thống SHALL có bảng `document_templates` với đầy đủ loại: Mẫu chữ ký, HĐ đặt cọc, HĐ thuê, BB bàn giao, Mẫu hóa đơn, Mẫu thu chi
8. THE Hệ_Thống SHALL có bảng `roles` và `permissions` để hỗ trợ phân quyền theo tài liệu `loai-tai-khoan.md`
9. THE Hệ_Thống SHALL có bảng `subscription_plans` (Gói cước) theo tài liệu `goi-cuoc.md`

---

### Yêu cầu 39: Trang Báo cáo BĐS phải có đầy đủ sub-reports

**User Story:** Là chủ nhà, tôi muốn trang tổng hợp Báo cáo BĐS liệt kê đầy đủ 8 loại báo cáo theo SUMMARY.md.

#### Tiêu chí chấp nhận

1. THE Trang_Báo_Cáo SHALL hiển thị 8 loại báo cáo BĐS theo SUMMARY.md: Căn hộ trống, Căn hộ sắp trống, Phòng gia hạn/chuyển nhượng, Tỉ lệ lấp đầy (cũ), Tỉ lệ lấp đầy (mới), Báo cáo khuyến mại, Báo cáo cho thuê, Báo cáo bỏ trả
2. IF hiện tại có báo cáo "Price History" hoặc "Contract Changes" không có trong SUMMARY.md, THEN THE Hệ_Thống SHALL đổi tên hoặc loại bỏ để khớp với tài liệu
3. THE Hệ_Thống SHALL tách "Tỉ lệ lấp đầy" thành 2 trang riêng: Phiên bản cũ và Phiên bản mới theo SUMMARY.md

---

### Yêu cầu 40: Trang Báo cáo Tài chính phải có đầy đủ sub-reports

**User Story:** Là chủ nhà, tôi muốn trang tổng hợp Báo cáo Tài chính liệt kê đầy đủ 8 loại báo cáo theo SUMMARY.md.

#### Tiêu chí chấp nhận

1. THE Trang_Báo_Cáo SHALL hiển thị 8 loại báo cáo Tài chính theo SUMMARY.md: Sổ quỹ theo ngày, Dòng tiền, Phân bổ lợi nhuận, Công nợ hợp đồng mới, Khách nợ tiền, Lịch thanh toán, Tiền thừa, Danh sách tiền cọc
2. THE Hệ_Thống SHALL đảm bảo tên các báo cáo khớp chính xác với tên trong SUMMARY.md

---

### Yêu cầu 41: Hướng dẫn sử dụng App Resident (Tham khảo)

**User Story:** Là chủ nhà/khách thuê, tôi muốn có tài liệu tham khảo về app mobile Resident.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cung cấp link hoặc trang tham khảo hướng dẫn sử dụng app Resident cho chủ nhà theo tài liệu `danh-cho-chu-nha.md`
2. THE Hệ_Thống SHALL cung cấp link hoặc trang tham khảo hướng dẫn sử dụng app Resident cho khách thuê theo tài liệu `danh-cho-khach-thue.md`

---

### Yêu cầu 42: FAQ và Lịch sử cập nhật

**User Story:** Là người dùng, tôi muốn truy cập FAQ và lịch sử cập nhật của hệ thống.

#### Tiêu chí chấp nhận

1. THE Hệ_Thống SHALL cung cấp trang FAQ theo tài liệu `faq-cau-hoi-thuong-gap.md`
2. THE Hệ_Thống SHALL cung cấp trang Lịch sử cập nhật theo tài liệu `lich-su-cap-nhat.md`
3. THE Hệ_Thống SHALL hiển thị các mục này trong phần "Thông tin khác" hoặc footer của ứng dụng
