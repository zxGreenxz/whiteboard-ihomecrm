# iHome Tạm trú — extension Chrome

Điền sẵn hồ sơ **Đăng ký tạm trú** trên Cổng DVC Bộ Công an
(`dichvucong.dancuquocgia.gov.vn`) từ dữ liệu iHome CRM. Extension chỉ điền và
gắn ảnh; **không tự bấm Lưu nháp hay Nộp hồ sơ**, không giữ mật khẩu hay khoá nào của CRM.

## Cài (một lần, mỗi máy)

1. Mở Chrome, vào `chrome://extensions`.
2. Bật **Developer mode** (góc phải trên).
3. Bấm **Load unpacked**, chọn thư mục `extensions/tam-tru` của mã nguồn CRM.
4. Tải lại trang CRM. Nếu cập nhật mã extension, bấm nút tải lại (↻) ở thẻ extension.

## Dùng

1. Trên CRM, mở **Khách hàng → chi tiết khách → Hồ sơ tạm trú**: tải ảnh tờ khai CT01 đã ký
   và hợp đồng thuê đã ký (chụp thẳng bằng điện thoại hoặc chọn tệp). Ảnh giấy tờ chứng minh
   chỗ ở hợp pháp tải một lần trong **Sửa toà nhà**.
2. Bấm **Đăng ký tạm trú trên DVC** (chọn 12/24 tháng). Extension mở tab cổng DVC.
3. Đăng nhập VNeID nếu cổng yêu cầu. Khi form hiện ra, bảng nổi góc phải dưới hiện
   "iHome Tạm trú" → bấm **Điền ngay**.
4. Kiểm tra lại từng mục, tick "Tôi xin chịu trách nhiệm trước pháp luật về lời khai trên",
   bấm **Nộp hồ sơ** (hoặc Lưu nháp).

## Cách hoạt động

- `bridge.js` (trang CRM): chỉ đặt `data-ihome-tamtru-ext` và `data-ihome-tamtru-id` lên
  `<html>` để CRM biết extension có mặt. Không có dữ liệu nào đi qua đây.
- **Gói dữ liệu đi thẳng**: trang CRM gọi `chrome.runtime.sendMessage(<id extension>, …)`
  nhờ `externally_connectable` trong manifest. Không dùng `window.postMessage` vì tin trên
  window đến mọi listener cùng cửa sổ, kể cả content script của extension khác — mà gói này
  có CCCD, ngày sinh và signed URL tới ảnh giấy tờ. Id extension cố định
  (`kaleeijefebjdhcmkfdbbffmielfjjgf`) nhờ khoá `key` trong `manifest.json`.
- `background.js`: kiểm tin đến từ đúng origin CRM và mọi URL ảnh thuộc host Supabase của
  dự án, giữ gói trong `chrome.storage.session` (hết hạn sau 1 giờ), mở tab form, tải ảnh
  từ signed URL (1 giờ) của CRM.
- `panel.js` + `panel.css` (trang cổng, isolated world): bảng nổi, tiến độ từng bước.
- `fill-engine.js` (trang cổng, MAIN world): điền bằng chính `FormUtil.setObjectToFormV2`,
  jQuery/select2 của cổng; gắn ảnh vào `input[type=file]` bằng `DataTransfer` rồi phát
  `change` để trang tự đưa vào hàng đợi upload.

## Bẫy của cổng đã xử

- **Đổi "Định dạng" ngày xoá trắng ô Ngày sinh.** `setObjectToFormV2` đi theo thứ tự
  `txt` rồi `cbo`, mà handler `cboDATE_FORMAT` của cổng gọi `datePickerWithPattern()` →
  `$('#txtDOB').val('')`. Vì vậy engine đặt lại ô ngày SAU CÙNG rồi đọc lại để xác nhận;
  ô bắt buộc nào cổng không nhận thì báo đỏ ngay thay vì để người dùng nộp thiếu.
- **Lịch của cổng giữ "ngày nội bộ" riêng, không nghe sự kiện `change`.** bootstrap-datepicker
  chỉ nghe `keyup`/`paste`, nên đặt `value` bằng mã thì ô hiện đúng mà ngày nội bộ vẫn là giá
  trị cũ. Người dùng bấm vào ô ngày rồi bấm ra là cổng ghi ngày nội bộ đè lên ô: ngày sinh
  trắng lại, hạn tạm trú lùi về mặc định +2 năm. Engine vì thế gọi `datepicker('update')` sau
  khi đặt ngày, đúng cách chính cổng làm, và báo "CẦN KIỂM LẠI" nếu lịch từ chối ngày đó.
- **Cổng chỉ nhận pdf, jpg, jpeg, tiff, png** (`validFileAttachAll`), từ chối WebP. CRM vì
  thế lưu ảnh hồ sơ tạm trú nguyên byte gốc và chỉ cho chọn JPG/PNG.
- Tên tệp cổng hiển thị chính là tên CRM đặt: `chuquyen950nk1.jpg`,
  `nguyengiabinhct011.jpg` — nhìn cột Đính kèm là biết ảnh của toà nào, khách nào.

## Giới hạn

- Chỉ thủ tục Đăng ký tạm trú, lập hộ mới, khách là chủ hộ, trường hợp "chỗ ở hợp pháp do
  thuê, mượn, ở nhờ". Không điền bảng xin ý kiến VNeID, không điền thành viên cùng thay đổi.
- Trang mở lại từ hồ sơ nháp (`?id=`) không tự điền.
- Cổng đổi giao diện thì bước tương ứng báo lỗi rõ; phần đã điền giữ nguyên.

## Kiểm thử

- Đơn vị: `npx vitest run src/lib/__tests__/tamTruFillEngine.test.ts` (nạp `fill-engine.js`
  vào jsdom với form giả lập).
- Sống trên cổng thật (không lưu): `node extensions/tam-tru/test/live-fill.mjs` — cần Chrome
  đã đăng nhập VNeID do `~/tamtru-recorder/recorder.cjs` mở (cổng CDP 9333).
