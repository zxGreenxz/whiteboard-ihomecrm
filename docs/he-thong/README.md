# Mục lục tham chiếu hệ thống

> **Reviewed:** 2026-07-20  
> `src/copilot/tools/registry.ts` nạp mọi `docs/he-thong/*.md` cho AI Copilot. Chỉ giữ hành vi hiện hành hoặc cảnh báo current trong thư mục này; audit lịch sử nằm ở `docs/audits/` và `docs/refactor-2026-07/`.

## Domain canonical

| # | Tài liệu | Phạm vi |
|---:|---|---|
| 00 | [Tổng quan](00-tong-quan.md) | Kiến trúc, route, tenant và các khối chức năng |
| 01 | [Phân quyền & nhân sự](01-phan-quyen-nhan-su.md) | Organization, membership, role/binding/scope, RLS |
| 02 | [Toà nhà, phòng & dịch vụ](02-co-cau-toa-nha-phong-dich-vu.md) | Cơ cấu bất động sản và danh mục nền |
| 03 | [Khách hàng, lead & hồ sơ](03-khach-hang-lead-ho-so.md) | Lead, customer, tenant, hồ sơ và chuyển đổi |
| 04 | [Cọc & giữ chỗ](04-coc-giu-cho.md) | Cọc dạng phiếu thu, reservation và liên kết hợp đồng |
| 05 | [Hợp đồng](05-hop-dong.md) | Tạo, trạng thái, gia hạn/chuyển và dữ liệu hợp đồng |
| 06 | [Công tơ & chỉ số](06-cong-to-chi-so.md) | Meter, reading, ảnh và sinh tiền điện/nước |
| 07 | [Hoá đơn & thanh toán](07-hoa-don-thanh-toan.md) | Invoice writer, payment v4/v3, recompute và hoàn tác |
| 08 | [Thu chi & sổ quỹ](08-thu-chi-so-quy.md) | Phiếu, hạng mục, account, balance và cashbook |
| 09 | [Kho & vật tư](09-kho-vat-tu.md) | Kho, nhập/xuất, nhà cung cấp và luồng vật tư |
| 10 | [Tài sản](10-tai-san.md) | Danh mục, cấp phát, bảo trì và kiểm kê tài sản |
| 11 | [Công việc & sự cố](11-cong-viec-su-co.md) | Job lifecycle, bằng chứng, ảnh/GPS và inspection |
| 12 | [Cổ đông & Profit Close V2](12-co-dong-loi-nhuan.md) | Preview/hash/revision, allocations và chi lợi nhuận |
| 13 | [Báo cáo, dashboard & thông báo](13-bao-cao-dashboard-thong-bao.md) | Báo cáo tổng hợp, notification và Web Push |
| 14 | [Cài đặt, danh mục & tài liệu](14-cai-dat-danh-muc-tai-lieu.md) | Settings, template và ranh giới cấu hình |
| 15 | [Kênh công khai, Sale phòng & Thu tiền](15-kenh-cong-khai-sale-thu-tien.md) | `/r/:token`, `/sale-phong`, `/thu-tien` |
| 16 | [Thanh lý hợp đồng](16-thanh-ly-hop-dong.md) | Move-out, forfeit, settlement và chứng từ |
| 17 | [Bảng lương & thưởng](17-luong-thuong.md) | Ledger, snapshot, V5, hardening thời gian/ảnh |
| 18 | [Zalo Chat](18-zalo-chat.md) | Worker, queue, hội thoại và Realtime |
| 19 | [SOP tiền & sổ quỹ](19-sop-tien-va-so-quy.md) | Quy tắc vận hành tiền xuyên domain |
| 20 | [Phê duyệt tài chính](20-phe-duyet-tai-chinh.md) | Rule, request, inbox, quyết định và posting |
| 21 | [AI Copilot](21-ai-copilot.md) | Runtime, tool, UI-control, safety và giới hạn |
| 99 | [Quy trình tổng end-to-end](99-quy-trinh-tong.md) | Luồng xuyên domain và nguồn sự thật |

## Tham chiếu cắt ngang

- [Realtime sync](realtime-sync.md) — chiến lược đồng bộ, invalidation và cập nhật giao diện.
- [Audit hiệu năng 30/06](perf-2026-06-30-toi-uu-hieu-nang.md) — bằng chứng theo mốc, không thay tài liệu domain hiện hành.

## Quy tắc cập nhật

- Mô tả hành vi hiện tại; snapshot lịch sử phải chuyển sang `docs/audits/`, `docs/refactor-2026-07/` hoặc evidence domain.
- Khi thêm/xoá domain, cập nhật README này, [00](00-tong-quan.md) và [99](99-quy-trinh-tong.md).
- Link code dùng đường dẫn hợp lệ và chạy `npm run docs:check`.
- Sau thay đổi payment/profit/salary/approval, cập nhật cả tài liệu hướng dẫn người dùng tương ứng.
