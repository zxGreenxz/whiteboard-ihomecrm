# Bằng chứng triển khai vòng đời hợp đồng

Ngày 28/09/2026. Đây là bằng chứng nền P0; **chưa phải sản phẩm đã triển khai hoặc đã phát hành**.

Quyết định nghiệp vụ còn hiệu lực: giữ toàn bộ cách quyết toán/bỏ cọc hiện tại, gồm xử lý và hủy hóa đơn nợ, credit, hoàn, duyệt/chi và quyền thao tác. Yêu cầu cũ “bỏ cọc vẫn giữ nợ” đã được rút. Bước trả phòng trước sẽ không có tác động tiền; loại thanh lý bắt buộc ngay bước đầu và có lịch sử khi đổi lúc quyết toán.

| Bằng chứng | Phạm vi đã kiểm | Giới hạn |
|---|---|---|
| [Catalog](2026-09-28-baseline-catalog.json) | TEST đồng bộ production; 220 chữ ký được đối chiếu chính xác, 14 witness; catalog/ACL/flags/triggers/RLS và khác biệt TEST có giải thích | Đối chiếu catalog không chứng minh nghiệp vụ/race |
| [Writer inventory](2026-09-28-writer-inventory.json) | 220 chữ ký có callers, quyết định xử lý và test dự kiến; 19 cửa ghi trực tiếp; route duyệt checked/revision đã ghi nhận | Đây là phân tích tĩnh, chưa thực thi các adapter |
| [Baseline tiền sau fix1](2026-09-27T17-54-00.899Z-financial-baseline.json) | 4 ca FORFEIT/REFUND/DEBT/PAID; cọc/thu/credit thực qua writer, retry và payload conflict; rollback và kiểm không còn fixture | SQL claims, chưa phải JWT mutation; chưa có duyệt/chi hoàn thành công sau commit hoặc concurrency |
| [Hai đối chiếu theo org](2026-09-28-p0d-adapter-runtime.json) | TEST v1: 2.115 phiếu/3 trang REST với JWT thật; v2: 17 sổ/3.722 dòng posting | V1 kiểm drift ở hai snapshot đầu/cuối, không phải HTTP snapshot isolation; v2 chứng minh SQL pagination |

Baseline [lượt trước fix1](2026-09-27T17-33-55.965Z-financial-baseline.json) giữ nguyên để truy nguyên. Review tìm thấy oracle chưa bắt đủ mất hóa đơn thu thêm, mất credit lot và sai trạng thái phiếu hoàn; đã sửa và chạy lại trong artifact sau fix1. Không dùng kết quả cũ thay cho bản đã sửa.

Các hướng dẫn chạy nằm ở [scripts/contract-lifecycle/README.md](../../../scripts/contract-lifecycle/README.md). Hai lệnh đối chiếu hiện có bổ sung chế độ TEST rõ đích; không có fallback sang production trong chế độ đó. CA/TLS, TEST marker và credential binding được kiểm trước thao tác. Credential chỉ nạp từ môi trường hoặc vault gốc theo opt-in, không nằm trong artifacts.

Review task P0a–P0d và báo cáo giới hạn được lưu ở [hồ sơ implementation](../../audits/2026-09-27-contract-lifecycle/implementation/README.md). Các phép mutation local chỉ chứng minh độ nhạy của harness/oracle; không được đổi tên thành mutation SQL/RLS thực tế.

Vẫn còn: baseline các nhánh tiền/quyền còn lại theo slice, real JWT mutation, concurrency, guards và các tính năng mới, kiểm toàn repo/PR/rollout/rollback và E2E CRM. Ký trước ngày nhận vẫn là phần tùy chọn có gate riêng. Chưa áp migration tính năng hoặc thay đổi dữ liệu nghiệp vụ production trong giai đoạn bằng chứng nền này.
