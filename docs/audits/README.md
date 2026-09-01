# Audit lịch sử

Các báo cáo trong thư mục này là snapshot theo commit/ngày, dùng làm đầu vào tái kiểm chứng.
**Audit là bằng chứng bất biến**: không sửa nội dung finding cũ; audit mới hơn của cùng chủ đề
được ghi bằng một dòng trỏ ở đầu file cũ. Không dùng severity, số đếm hoặc trạng thái cũ thay
cho code/runtime hiện hành.

Danh sách đầy đủ, mới → cũ:

- [Audit bảng DB mồ côi + phần chưa hoạt động 2026-09-02](AUDIT-DB-BANG-MO-COI-VA-PHAN-CHUA-HOAT-DONG-2026-09-02.md) —
  read-only trên production: 12/14 bảng nghi vấn hóa ra SỐNG; 2 bảng `legacy_owner_*` mồ côi thật
  (ứng viên DROP plan riêng); phát hiện bucket `avatars`/`documents` không tồn tại → đổi avatar hỏng 100%.
- [Audit thanh toán 2026-08-31](AUDIT-THANH-TOAN-2026-08-31.md) — trang `/thanh-toan` end-to-end;
  13 finding (2 P1 · 7 P2 · 4 P3). **13/13 đã vá 01/09** (commit `b8b3fe83`, 3 migration live prod).
- [Audit brief thanh toán 2026-08-31](AUDIT-BRIEF-THANH-TOAN-2026-08-31.md) — đề bài + phạm vi của
  audit trên, theo khuôn audit 13/08.
- [Audit Plan2 room lifecycle refund 2026-08-27](AUDIT-PLAN2-ROOM-LIFECYCLE-REFUND-2026-08-27.md) —
  soát chuỗi hoàn cọc/thanh lý trước khi ship đợt 28/08.
- [Audit vòng đời khách & dòng tiền 2026-08-13](AUDIT-CUSTOMER-LIFECYCLE-CASHFLOW-2026-08-13.md) —
  phòng trống → lead → cọc → hợp đồng → hoá đơn → thu → thanh lý. **Đã tái kiểm 2026-09-01**:
  22/26 finding còn nguyên; chỉ số trùng phình 8 → 57 nhóm (đang chảy máu).
- [Audit tiền: hoá đơn – thu chi – thanh toán 2026-08-13](AUDIT-TIEN-HOA-DON-THU-CHI-THANH-TOAN-2026-08-13.md) —
  **khuôn mẫu chính thức cho mọi audit sau**; 23 finding về 6 nguồn sự thật song song của tiền.
- [Audit realtime toàn hệ thống 2026-07-29](AUDIT-REALTIME-TOAN-HE-THONG-2026-07-29.md).
- [Audit hiệu năng 2026-07-26](AUDIT-HIEU-NANG-2026-07-26.md) — tại commit `bc68cc1`; 32 finding
  đã qua xác minh đối kháng.
- [Audit toàn trang 2026-07-08](AUDIT-TOAN-TRANG-2026-07-08.md) — snapshot codebase, test và findings.
- [Hội đồng cố vấn 2026-07-03](hoi-dong-co-van-2026-07-03.md) — tranh luận và action plan tại commit `98927ca`.

Trạng thái hiện hành xem [../README.md](../README.md), [../he-thong/README.md](../he-thong/README.md)
và audit mới nhất của từng chủ đề.
