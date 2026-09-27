# Đối chiếu lại hiện trạng, mục tiêu và flow đã chốt trước audit

Đã đọc lại [plan trước audit, nguyên bản](plan-v1-reviewed.md), đặc biệt §1.1 R01–R13 và §4.2; đối chiếu [sơ đồ V03 nguyên bản](so-do-hop-dong-v3-reviewed.html) và toàn bộ chỉ dẫn nghiệp vụ của chủ trong cuộc trao đổi. Hai bản lưu giữ nguyên SHA256 trong reviewed-evidence-manifest.json/structure-check.json. Đây là đối chiếu đặc tả, không là chứng cứ CRM đã triển khai.

## Hiện trạng và mục tiêu ban đầu

Phòng online cập nhật chậm; thiếu cách báo ngày sẽ trả nhanh và nhắc khi lịch đó đã quá hạn. Khách đã đi nhưng hồ sơ còn bị giữ vì chưa đủ thông tin quyết toán, làm chậm ghi phòng trống và ký khách mới. Hợp đồng mới chưa có nháp lưu/tải gửi trước, gây nhập và chuẩn bị gấp lúc ký.

Mục tiêu là quản lý thao tác nhanh, dữ liệu phòng đúng thực tế và kế toán theo dõi được hồ sơ cũ. **Không có yêu cầu viết lại nghiệp vụ quyết toán tiền đang hoạt động đúng.**

## 13 yêu cầu gốc vẫn là tiêu chí nghiệm thu

| Gốc | Flow phải giữ | V2 chịu trách nhiệm |
|---|---|---|
| R01 | Báo ngày sẽ trả nhanh; đổi/hủy được; cập nhật sale. Không tự kết thúc hợp đồng theo ngày hẹn. | P2/P4 |
| R02 | Đến/quá ngày chưa trả phải có nhắc và hàng việc để xác nhận/dời lịch/ở tiếp; đọc thông báo không làm mất việc. | P5 |
| R03 | **Ngay bước đầu bắt buộc ngày bàn giao thực tế + loại thanh lý:** hết hạn/trước hạn/bỏ cọc. | P6/P8 |
| R04 | Hai nhánh: **thanh lý, quyết toán sau** hoặc **thanh lý và quyết toán ngay**. | P6/P7/P8 |
| R05 | Chọn sau: kết thúc lượt ở, nhả phòng, hồ sơ Chờ quyết toán; không bắt đủ số tiền, không suy chưa biết thành0. | P6 |
| R06 | Khi quyết toán **được chọn lại loại nếu cần**; giữ loại ban đầu, loại cuối, lý do, người và thời điểm để đối soát. | P7/P8 |
| R07 | Chốt số không có nghĩa đã thực thu/chi; còn hoàn/còn nợ vẫn theo dõi. | P7/P8 |
| R08 | Xử lý A sau khi B đã vào không sửa phòng/hợp đồng/cọc/nợ của B. | P6/P7 |
| R09 | Phòng đã trả đang dọn/sửa vẫn sale là trống, thêm ngày dự kiến nhận và việc nội bộ. | P3/P4 |
| R10 | Dọn/sửa trễ phải nhắc/sửa lịch; chưa có ngày rõ thì ghi cần xác nhận. Không tự ẩn phòng đã trống hoặc bỏ claim khách kế tiếp. | P3/P5 |
| R11 | Nháp lưu/sửa/tải gửi khách; **nháp không giữ phòng**. Giữ chỗ/nhận cọc riêng. | P9/P10 |
| R12 | Xác nhận đã ký từ đúng nháp, không nhập lại và không tạo trùng. | P11a |
| R13 | Giữ chỗ/cọc/hoàn/bỏ cọc và hồ sơ tồn đọng dễ theo dõi, đúng lượt khách/nguồn tiền. | P8/P9 |

**Flow thanh lý:** ngày thực trả + loại bắt buộc → chọn ngay/sau. Chọn sau → phòng trống, hồ sơ Chờ quyết toán → mở lại → kiểm dữ liệu, đổi loại nếu cần có lịch sử → quyết toán bằng cách hiện tại. Chọn ngay → tiếp tục quyết toán theo cách hiện tại. Không có flow “ban đầu chưa cần chọn loại”.

## Phạm vi được chủ xác nhận lại

Giữ nguyên13 yêu cầu gốc. **Chỉ nhượng hợp đồng EX01/P9.T là phần mở rộng mới.** Những chốt về giữ tiền/quyền hoặc chọn loại từ đầu là làm rõ/bảo toàn cách làm ban đầu, không là dự án thiết kế lại tài chính. Không tự đưa đề xuất thêm nút hoàn tác từ audit vào scope.

## Những chốt do chính chủ xác nhận sau audit

- Thiếu số lúc A đi vẫn ghi trả/sale ngay; B nhận phải có mốc nhận riêng rõ ràng.
- Giữ toàn bộ quyền và cách tạo/duyệt/chi tiền đang dùng. **Chủ đã đính chính:** bỏ cọc và xử lý hóa đơn nợ/credit giữ nguyên flow cũ, kể cả hủy nợ theo cơ chế hiện tại; mô tả trước yêu cầu giữ toàn bộ nợ khi bỏ cọc đã rút. DEFERRED chưa chạy tiền; đến quyết toán mới áp dụng theo loại cuối.
- Nhượng: hai hợp đồng riêng liên kết/cùng dấu nhượng, cũ quyết toán/new ký bình thường. Tự tìm người nhận có lựa chọn cọc như chủ mô tả, giữ hạn cũ hoặc chọn hạn mới. Môi giới: phí50% cọc cũ, phiếu hoa hồng gắn hợp đồng mới, khách mới đóng đủ cọc. Không tự thêm policy cấn/chuyển/duyệt mới ngoài cách đang dùng.

## Audit được thay gì và không được thay gì

Audit được làm rõ cách hiện thực: chặn ghi trùng/sai khách, giữ phân quyền hiện hành, thứ tự khóa, mốc điện/nước, scope public, nhắc việc bền, version tài liệu và kiểm thử. Các sửa này phải phục vụ đúng13 yêu cầu trên, có evidence và không thay kết quả tiền của luồng hợp lệ.

Các diễn giải đã rút: bỏ chọn loại ở bước đầu; yêu cầu giữ toàn bộ nợ khi bỏ cọc; thiết kế lại nút/tầng duyệt hoàn; yêu cầu chủ chọn lại tiền đang đúng. B2/B3/N2 giữ cơ chế hiện hành, không là quyền thiết kế lại policy tài chính.

Source UI và chuỗi wrapper/impl trong snapshot FORFEIT có đoạn hủy hóa đơn nợ; chủ đã xác nhận giữ flow cũ, nên [FC02](flow-control-review.md) rút trạng thái bất nhất cần sửa. Kiểm build/catalog/flags và hành vi trên TEST để giữ parity khi nối adapter, không thay policy tiền hoặc chạy lại phần phòng của A khi B đã vào. P11b ký trước ngày nhận là phần mở rộng riêng, không được làm treo nháp/ký nhận ngay hoặc trả phòng quyết toán sau.

Nguồn ưu tiên khi thi hành: chỉ dẫn trực tiếp của chủ và bảng13 yêu cầu này → master về giải pháp kỹ thuật → audit làm bằng chứng/phản biện. Review cũ không ghi đè nghiệp vụ đã chốt.
