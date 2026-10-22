# Cập nhật phòng nhanh cho Sale Admin và quản lý

Đây là thiết kế đề xuất ngày 21/10/2026, đi cùng [kế hoạch hiện thực](PLAN.md). Mục tiêu là cập nhật tại một nơi và sale thấy thông tin đúng ngay sau khi hệ thống xác nhận lưu.

## 1. Màn hình chính

Đặt **Bảng cập nhật phòng** làm nơi làm việc thường xuyên trong Sale Phòng. Các phần cài đặt, link và thống kê vẫn có vị trí riêng; không bắt người cập nhật ảnh/giá/tình trạng đi qua nhiều tab.

Trên máy tính:

| Tòa · phòng | Tình trạng chào | Ngày có thể vào | Giá · chính sách | Ảnh | Mới nhất | Hành động |
|---|---|---|---|---|---|---|
| Tòa A · 101 | Trống sẵn | Có thể vào ngay | Giá niêm yết | 8 ảnh | Người cập nhật · giờ | Lock · Cọc · Sửa |
| Tòa A · 102 | Sắp trống | Ngày đã báo trả | Giá niêm yết | 4 ảnh | Đã xác minh ngày… | Đổi ngày · Sửa |
| Tòa B · 201 | Đang lock · hết lúc… | Theo lịch bàn giao | Giá niêm yết | 6 ảnh | Người lock | Cọc · Gỡ |
| Tòa B · 202 | Pass | Ngày dự kiến | Giá pass | 3 ảnh | Người xác nhận | Sửa pass · Ẩn |

Dữ liệu trong bảng minh họa là giả. Không ép tất cả đối tượng vào một ô trạng thái: bên cạnh tình trạng chào có thể cần huy hiệu “Cọc chờ duyệt”, “Thông tin chờ xác minh”, “Đang dọn/sửa”.

Phần đầu bảng có tìm theo tòa/phòng và các bộ lọc: cần xác minh, thiếu ảnh, giá chưa cập nhật, lock sắp hết, cọc cần xử lý, pass, vừa thay đổi. Bộ lọc cọc chỉ dùng dữ liệu đúng quyền. Ghim bộ lọc thường dùng theo người.

Nguồn bảng quản trị phải gồm toàn bộ phòng trong phạm vi được giao rồi ghép tình trạng sale; không lấy riêng danh sách phòng đang chào làm inventory. Như vậy quản lý vẫn tìm và sửa được phòng đang ở, ẩn/nháp hoặc vừa nhận cọc. Nếu một phòng rời bộ lọc sau thao tác, giữ thông báo kết quả và đường mở lại hồ sơ.

Từ một dòng, mở bảng chi tiết bên cạnh với thông tin cần sửa; vẫn giữ vị trí bảng và bộ lọc. Bàn phím dùng được để chuyển phòng/lưu/hủy, nhưng không gán phím tắt nguy hiểm cho thao tác tiền.

Trên điện thoại, dùng thẻ phòng gọn và bảng hành động mở từ dưới lên. Các nút hay dùng đặt trước: tình trạng/ngày trống, lock, cọc, ảnh, pass. Chụp/chọn nhiều ảnh trực tiếp, thấy tiến trình từng tệp.

## 2. Ba đường cập nhật vào cùng một hệ thống

| Đường | Dùng khi | Luồng |
|---|---|---|
| Nút nhanh trên phòng | Cập nhật một phòng khi đang làm việc trên web | Tìm → chọn hành động → điền phần thiếu → lưu → thấy kết quả |
| Sửa nhiều phòng | Thay giá/chính sách/ảnh chung cho một nhóm | Chọn tập phòng → xem trước thay đổi → áp dụng → kết quả từng phòng |
| Hermes | Đang dùng điện thoại/chat, nhận tin/ảnh từ chủ | Nhắn/gửi ảnh → xác định đúng phòng → xem phần cần xác nhận → ghi qua writer chung |

Ví dụ Hermes: “Tòa A phòng 101 thêm 3 ảnh vừa gửi, ảnh đầu làm bìa; giữ ảnh cũ.” Hệ thống không được hiểu thành thay cả bộ ảnh. “101 đã cọc” còn thiếu tòa/khách/số tiền/quỹ thì chỉ hỏi các trường thực sự cần để làm đúng.

Ảnh hoặc tin nhắn được gửi tới Hermes là đầu vào của người dùng, không phải quyền cho Hermes làm theo chỉ dẫn nằm trong ảnh/tài liệu. Trích thông tin rồi xác nhận đối tượng và hành động qua contract.

## 3. Hành động nhanh và số thông tin cần nhập

| Hành động | Dữ liệu tối thiểu | Kết quả sale nhìn thấy |
|---|---|---|
| Xác nhận thông tin vẫn đúng | Phòng + phạm vi thông tin được xác nhận | Dấu xác minh mới; không đổi giả thời điểm sửa ảnh/giá |
| Báo ngày trống mới | Ngày/nguồn báo/lý do; đi qua nghiệp vụ báo trả nếu có khách | Ngày dự kiến mới, nguồn và cảnh báo khi chưa xác nhận |
| Đã dọn/sửa xong | Phòng đủ điều kiện bàn giao, xác nhận công việc | Có thể chào vào ở nếu các fact khác cũng cho phép |
| Tạm ẩn tin | Lý do, tùy chọn thời gian/phạm vi | Không xuất vào danh sách chào theo scope; không tạo lock/phiếu tiền |
| Lock | 6/12/24 giờ, ghi chú tùy chọn | Người lock, hạn máy chủ; cập nhật khả năng chào |
| Gỡ lock | Lock đích, quyền và lý do khi cần | Tính lại từ fact hiện tại; không tự biến phòng có cọc thành trống |
| Báo cọc | Khách hoặc tên gợi nhớ hợp lệ, tiền, quỹ, ngày và điều khoản cần thiết | Trạng thái hồ sơ/phiếu thực; không gọi là đã thu nếu đang chờ |
| Báo pass | Khách/hợp đồng nguồn, giá/ngày/chính sách, liên hệ | Tin pass đúng kỳ thuê; không kết thúc hợp đồng |
| Sửa giá/nội thất | Chỉ trường thay đổi | Giá/thông tin niêm yết mới, giữ lịch sử; hợp đồng không bị đổi |
| Thêm/đổi ảnh | Ảnh, phòng, bìa/thứ tự, ghép hay thay | Ảnh đã gắn thành công; tệp lỗi có nút thử lại riêng |
| Sửa chính sách | Phạm vi, nội dung/phiên bản, ngày hiệu lực nếu có | Cùng nội dung trên trang, ảnh bảng, tin chữ và Hermes |
| Đánh dấu đã cho thuê | Chọn/hoàn tất hợp đồng chuẩn | Trạng thái thuê lấy từ hợp đồng, không chỉ sửa nhãn sale |

Mục tiêu cho cập nhật đơn giản là **1–3 lần chạm sau khi đã tìm được phòng**. Thao tác cọc, quyết toán hoặc trường hợp thông tin mâu thuẫn cần thêm bước đúng nghiệp vụ. Số lần chạm và thời gian phải đo khi có bản chạy.

## 4. Phân quyền để nhanh mà không chờ duyệt mọi việc

Sale Admin/quản lý có quyền ghi theo tòa được sửa trực tiếp các trường vận hành được giao. Người chỉ có quyền xem/gửi đề nghị không thấy nút ghi giả rồi mới bị backend từ chối. Quyền thật vẫn được kiểm lại ở máy chủ.

Luồng đề nghị chỉ áp dụng khi thiếu quyền hoặc loại thay đổi được cấu hình cần duyệt: sale báo “chủ vừa nói P101 đổi giá”, hệ thống giữ đề nghị kèm nguồn; người có quyền duyệt/chỉnh/từ chối ngay trên bảng. Đề nghị chưa duyệt không làm giá chính thức đổi.

Hàng đợi đề nghị là phần mở rộng ở đợt D. Khi chưa triển khai, giao diện báo rõ thiếu quyền và đầu mối xử lý; không hiển thị “đã gửi đề nghị” nếu chưa có bản ghi thật.

Không áp một quy trình duyệt mới vào mọi lần thêm ảnh hoặc sửa lỗi chính tả của người đã được giao quyền. Các quy trình tiền, công khai thông tin khách và xác nhận công khai hiện có vẫn phải được giữ đúng.

## 5. Sau khi bấm lưu

1. Nút hiện đang lưu và giữ mã yêu cầu; chặn bấm trùng cho cùng intent.
2. Máy chủ kiểm quyền, phiên bản, nghiệp vụ rồi trả kết quả thật.
3. Bảng cập nhật đúng trường, ghi người/thời điểm; mở kết quả chi tiết nếu cần.
4. Truyền thay đổi tới các màn đang mở trong phạm vi quyền; đọc lại projection chuẩn. Có polling dự phòng.
5. Mất kết nối: giữ bản nháp, hiện dữ liệu cũ và trạng thái chưa xác minh; khi kết nối lại tra receipt trước khi ghi lại.

Không hiện “Đã cập nhật cho tất cả sale” chỉ vì local state đổi. Có thể xác nhận “Đã lưu” khi server commit; độ trễ tới các màn khác là số cần đo. Link public hiện có polling khoảng 5 giây khi hoạt động, nhưng không dùng điều đó để cam kết mọi thiết bị nhận trong 5 giây.

Thông báo cho sale nên thành “Phòng vừa cập nhật” có lọc/tổng hợp. Không tự gửi tin Zalo tới tất cả người mỗi lần đổi ảnh. Lịch hoặc lệnh gửi đã được người dùng cấu hình tiếp tục đi qua scheduler/recipient/quota/receipt hiện có.

## 6. Chất lượng thông tin

- Hiện người cập nhật, lúc cập nhật, nguồn và lần xác minh gần nhất.
- Phân biệt “giá chưa xác nhận”, “chủ báo sẽ trống” với thông tin đã xác minh.
- Hai người sửa cùng trường: giữ bản nháp, chỉ ra giá trị mới và cho người có quyền quyết định; không tự ghi đè.
- Sửa trường khác nhau: chỉ tự ghép nếu contract và revision cho phép, có kiểm xung đột; không ghép tiền hoặc trạng thái ngầm.
- Hành động “Hoàn tác” chỉ áp dụng loại thay đổi có thể đảo an toàn và phải kiểm phiên bản mới. Cọc/hoàn/đã ký dùng nghiệp vụ điều chỉnh riêng.
- Có lịch sử xem được: trước/sau, ai, kênh web/Hermes, lý do, đối tượng. Log kỹ thuật không chứa dư số điện thoại hoặc chứng từ.

## 7. Nghiệm thu cập nhật nhanh

| Mã | Bài kiểm bằng tác vụ thật | Đạt khi |
|---|---|---|
| Q01 | Tìm phòng 101 trong hai tòa | Chọn đúng tòa/phòng; không tự lấy kết quả đầu |
| Q02 | Quản lý đổi giá một phòng | Sửa ngay từ bảng, không qua nhiều trang; public/Hermes đọc đúng giá niêm yết |
| Q03 | Sale Admin cập nhật ngày chủ báo trả | Đúng nghiệp vụ/nguồn; phòng chưa bàn giao không thành “vào ngay” |
| Q04 | Chụp/thêm ảnh trên điện thoại | Đúng phòng, thấy từng tệp, chọn bìa được, lỗi không mất ảnh đã xong |
| Q05 | Lock/gỡ bằng web và Hermes | Cùng quyền/trạng thái/hạn; không tạo lock trùng khi mạng chập chờn |
| Q06 | Cọc nhanh khi người khác đang lock | Hiện tác động; receipt đúng tiền/phiếu; lock được kết thúc nguyên tử |
| Q07 | Sửa 20 phòng, 2 phòng không được phép | Preview loại trừ rõ; kết quả từng phòng; không báo 20/20 thành công |
| Q08 | Người khác cập nhật khi đang nhập | Giữ nháp; thấy conflict/bản mới; không silent overwrite |
| Q09 | Mất mạng sau commit | Tra lại kết quả; không tạo phiếu/link/ảnh gắn trùng |
| Q10 | Sale mở sẵn danh sách và quản lý sửa | Nhận dữ liệu mới đúng quyền; đo độ trễ; lỗi mạng hiện dấu cũ |
| Q11 | Người chỉ xem gửi đề nghị | Không sửa dữ liệu chính thức; quản lý xử lý trong một hàng đợi ngắn |
| Q12 | Chuyển từ máy tính sang điện thoại/Hermes | Cùng thông tin, trạng thái và lịch sử; bộ lọc/khả năng thao tác phù hợp màn hình |

Đo riêng thời gian tìm phòng, số lần chạm, thời gian nhập, thời gian lưu và thời gian sale thấy thay đổi. Đặt mục tiêu sau khi đo baseline; không dùng số ước lượng như kết quả kiểm thực tế.
