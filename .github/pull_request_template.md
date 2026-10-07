## Thay đổi

<!-- Vấn đề cụ thể, hành vi sau sửa, phạm vi. Xoá mục không liên quan.
     Repo public: không dán secret, số tiền production, tên/tài khoản người dùng thật. -->

## Kiểm chứng

<!-- Contract §10: đọc `npm run gate:truoc-push -- --plan` (scope, gate, lý do chọn) rồi chạy
     `npm run gate:truoc-push`; dán receipt/kết quả, không chỉ tên lệnh. -->

- Scope và gate theo `--plan` (profile, fallback, required jobs):
- Receipt `gate:truoc-push` và test tập trung (đạt/tổng):
- E2E headless, ảnh chụp/console nếu chạm runtime/UX:
- Đột biến nếu chạm invariant high-risk hoặc gate có thể xanh rỗng:
- Review chéo (tier có `crossReview`): base SHA · head SHA · người/agent review · kết luận

## Phát hành

<!-- Quy trình tại docs/engineering/PROJECT_CONTRACT.md §3–6. -->

- Migration/backup/evidence nếu có:
- Feature flag, cách quay lui:
- Phần chưa xác minh và lý do:
