# Hệ lương thưởng v5

> **Current through:** 2026-07-20  
> **Lifecycle:** implementation complete; vận hành theo stage/feature flags.

- [../he-thong/17-luong-thuong.md](../he-thong/17-luong-thuong.md) — hành vi code/DB hiện tại, gồm hardening 20/07.
- [V5-RUNBOOK.md](V5-RUNBOOK.md) — runbook vận hành hiện hành.
- [V5-HE-THONG-LUONG-THUONG-THONG-NHAT.md](V5-HE-THONG-LUONG-THUONG-THONG-NHAT.md) — đặc tả nghiệp vụ hợp nhất; code/migration mới hơn thắng khi có khác biệt.
- [V5-PLAN-THUC-HIEN.md](V5-PLAN-THUC-HIEN.md) — kế hoạch giao hàng đã thực thi, giữ làm lịch sử quyết định.
- [V5-IMPLEMENTATION-LOG.md](V5-IMPLEMENTATION-LOG.md) — bằng chứng S0–S5 và bản đồ revert, không phải status live.

Không suy trạng thái live từ câu “mặc định OFF” trong tài liệu lịch sử. Đọc `system_v5.stage`, `feature_flags` và `effective_from` từ UI `/reports/coverage` hoặc DB. Forward-fix 20/07 đã thêm loại từng việc khỏi thưởng, server-stamp thời gian hoàn thành, kiểm ảnh thống nhất và guard ngày/kỳ V5. Worker watchdog trong thiết kế ban đầu đã bị gỡ; fallback vận hành hiện tại là nút admin chạy lại job.
