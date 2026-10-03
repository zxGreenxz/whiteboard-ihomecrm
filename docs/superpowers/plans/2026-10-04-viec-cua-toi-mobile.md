# Việc của tôi — bản lưu cục bộ trên mobile

Yêu cầu trực tiếp ngày 04/10/2026: hiện thực đặc tả N2Store trong iHomeCRM để
thử và lưu việc cá nhân, thêm icon mobile, không nối dữ liệu nghiệp vụ.

## Thiết kế đã chọn từ yêu cầu

- Route đăng nhập `/viec-cua-toi`; launcher có icon ListTodo, không yêu cầu quyền
  công việc vận hành. Dùng ID phiên hiện có chỉ để tách kho cục bộ theo tài khoản.
- Một mảng task chuẩn lưu localStorage có version. Không API, RPC, bảng mới,
  realtime server hoặc liên kết công việc vận hành. Nhãn chỉ rõ lưu theo thiết bị.
- Mobile <=600px ba tab; rộng hơn ba cột. CSS cô lập để giữ breakpoint, sheet,
  cử chỉ và safe area theo đặc tả. Không mount shell có dữ liệu nghiệp vụ.
- Tạo, hẹn/đổi/xóa hẹn, xong, trả lại; vuốt 72px, pointercancel không xác nhận.
  Dùng nút tương đương khi chuột và menu thao tác khi chạm để dễ tiếp cận.
- Ngày UTC+7; âm lịch dùng đúng gói 2.0.1 của nguồn. Cập nhật phút/foreground.
- Ghi thành công rồi mới cập nhật UI; đọc bản mới nhất trong Web Lock khi ghi.
  Lỗi storage hiển thị và giữ dữ liệu, không âm thầm thay dữ liệu hỏng bằng rỗng.
- Tải JSON sao lưu; bản đầu không đồng bộ thiết bị, không thông báo đẩy.

## Trình tự và kiểm chứng

1. Model, calendar, storage (`src/lib/personal-tasks/`) và hook
   `src/hooks/usePersonalTasks.ts`: test trước luật 12 task trong §17, đổi ngày,
   chuyển trạng thái, ngày không hợp lệ, storage hỏng/đầy và tách tài khoản.
2. UI (`src/components/personal-tasks/`, `src/pages/PersonalTasksPage.tsx`):
   sheet Radix + React Hook Form/Zod; các trạng thái rỗng, lỗi, focus, gestures.
3. Nối route lazy, launcher, khai trừ Copilot và ẩn nút nổi trên route cá nhân.
4. Vitest liên quan, E2E headless tại `.e2e-fleet/specs/personal-tasks.spec.ts`:
   tạo/hẹn/xong/trả lại/reload, mobile/desktop, gesture cancel, lỗi lưu, console.
   Build + bundle + gate trước push theo Project Contract, stage file cụ thể.
5. Báo URL để thử và phần chưa xác minh; phát hành theo Contract §3 khi gate đạt.

## Giới hạn lưu trữ

Cùng tài khoản ở trình duyệt/thiết bị/tên miền khác sẽ có kho khác. Xóa dữ liệu
trình duyệt sẽ xóa kho; JSON tải xuống là bản sao dự phòng. Không tuyên bố local
storage là kho dữ liệu bí mật hoặc cơ chế bảo vệ trước người dùng chung máy.
