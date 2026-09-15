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

- `bridge.js` (trang CRM): đặt `data-ihome-tamtru-ext` lên `<html>` để CRM biết extension
  có mặt; nhận gói dữ liệu qua `window.postMessage`, chuyển cho `background.js`.
- `background.js`: giữ gói trong `chrome.storage.session` (hết hạn sau 1 giờ), mở tab form,
  tải ảnh từ signed URL (1 giờ) của CRM.
- `panel.js` + `panel.css` (trang cổng, isolated world): bảng nổi, tiến độ từng bước.
- `fill-engine.js` (trang cổng, MAIN world): điền bằng chính `FormUtil.setObjectToFormV2`,
  jQuery/select2 của cổng; gắn ảnh vào `input[type=file]` bằng `DataTransfer` rồi phát
  `change` để trang tự đưa vào hàng đợi upload.

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
