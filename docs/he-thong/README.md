# Tham chiếu hệ thống

> **Reviewed:** 2026-07-20  
> Các file trong thư mục này được AI Copilot nạp bằng `import.meta.glob`; giữ tên ổn định và link hợp lệ.

## Core

| # | Domain |
|---:|---|
| 00 | [Tổng quan](00-tong-quan.md) |
| 01 | [Tổ chức, nhân sự và phân quyền](01-phan-quyen-nhan-su.md) |
| 02–18 | Cơ cấu BĐS, khách hàng, cọc, hợp đồng, công tơ, hóa đơn, thu chi, kho/tài sản/công việc, lợi nhuận, báo cáo/cài đặt, kênh công khai, thanh lý, lương và Zalo |
| 19 | [SOP tiền và sổ quỹ](19-sop-tien-va-so-quy.md) |
| 20 | [Phê duyệt tài chính](20-phe-duyet-tai-chinh.md) |
| 21 | [AI Copilot](21-ai-copilot.md) |
| 99 | [Quy trình tổng](99-quy-trinh-tong.md) |

Các file audit/performance/realtime là evidence hoặc cross-cutting reference; không thay thế domain canonical.

## Quy tắc cập nhật

- Mô tả hành vi hiện tại, không ghi snapshot row count/live data nếu không có ngày và phạm vi.
- Link source từ thư mục này dùng `../../src/**`, `../../supabase/**` hoặc link tương đối tới file cùng thư mục.
- Khi thêm/xóa domain, cập nhật README, 00 và 99; kiểm tra vì Copilot sẽ thấy mọi file `*.md`.
