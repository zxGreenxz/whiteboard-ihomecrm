# Ẩn phiếu giữ chỗ lỗi khỏi Quản lý Cọc

> **For agentic workers:** thực hiện bằng các tác vụ độc lập, review thay đổi trước khi phát hành.

**Goal:** Theo yêu cầu trực tiếp ngày 28/09/2026, ẩn riêng phiếu PT2605043 (104/102LVT, 5.000.000đ) khỏi Quản lý Cọc.

**Architecture:** Bảng `deposit_management_exclusions` lưu dấu ẩn có lý do, ngoài chứng từ tài chính. Danh sách giữ chỗ và RPC tổng hợp loại dấu ẩn trước khi phân trang/tính tổng. Đây chỉ là quyết định hiển thị, không phải tất toán cọc.

**Tech Stack:** PostgreSQL/Supabase RLS, React Query, PostgREST, Vitest/PGlite.

## Ràng buộc

- Không thay phiếu thu, hạng mục, posting, hợp đồng, tiền quỹ hoặc kỳ lợi nhuận đã khóa.
- Không tạo hồ sơ bỏ/hoàn cọc, không tự gắn hợp đồng, không đổi nghiệp vụ giữ phòng.
- Bảng dấu ẩn chỉ cấp SELECT cho client, cùng phạm vi quyền đọc phiếu gốc.
- Migration chỉ seed UUID đã đối chiếu; sai định danh/trạng thái phải dừng.
- Người dùng đã cho phép thực hiện cách đánh dấu/ẩn; không cần phê duyệt lại phương án hiển thị này.

## Thực hiện và kiểm chứng

- [x] Test SQL trước: ẩn đúng phiếu, tổng giảm phần giữ chỗ 5 triệu, phiếu trùng mã khác vẫn còn; dữ liệu tiền không đổi; chạy lại không nhân dấu ẩn; RLS không rò tổ chức/phiếu.
- [x] Migration mới tạo overlay, policy SELECT, kiểm dữ kiện nguồn, seed một dấu ẩn, thêm NOT EXISTS vào `get_reservation_deposit_summary`.
- [x] Hook `useReservationDeposits` anti-join `management_exclusion` trước phân trang; kiểm request PostgREST trên mọi trang. Không đổi hook cọc dùng để lập hợp đồng.
- [x] Kiểm trên TEST, generated types/surfaces, gate phạm vi và đột biến; review độc lập; draft PR theo Contract.
- [ ] Apply production qua forward lane có backup, phát hành app qua promotion sau CI đạt.
- [ ] Đọc lại bằng JWT thật và trình duyệt: phiếu không hiện trong Quản lý Cọc; chứng từ gốc, cọc hợp đồng và posting không đổi.

## Phạm vi khôi phục

Khôi phục hiển thị bằng gỡ dấu ẩn qua thao tác quản trị có kiểm soát. Không có dữ liệu tài chính nào cần đảo lại.

## Bằng chứng trước áp dụng

- Unit hook 3/3, SQL PGlite 6/6; nhóm hook liên quan 37/37. Đột biến bỏ anti-join và bỏ lọc summary đều bị bắt; đã khôi phục digest. Fixture enum bắt và xác minh sửa lỗi so sánh enum/text.
- Review độc lập không có lỗi blocking; migration SHA-256 `501ed836340edf078bdab89a1cf4ffbee01da3cb9a8a4816b00f4c3282e46b94`.
- TEST đã apply; JWT owner thấy dấu ẩn, anti-join loại đúng UUID, summary 102LVT bằng 0; JWT org DEMO không đọc được phiếu/dấu ẩn của org thật.
- E2E headless desktop 1440px và mobile 390px đạt 2/2, console sạch. Auth/quyền, phiếu nguồn trước/sau, exclusion, reservation list/summary dùng TEST thật. Sáu reader ngoài phạm vi dùng fixture do TEST Nano timeout: cọc HĐ, thanh lý, phiếu hoàn, danh mục tòa, summary cọc HĐ và hoàn cọc. Không tính đây là E2E toàn dashboard.
- Typecheck app/e2e, build, bundle, stable function locks, view invoker đạt. Reconcile v1/v2 đạt; 44 gate trước push đạt, bao gồm đo rò tổ chức bằng credential thật.
- Dry-run production rollback đạt; production chưa thay đổi tại thời điểm ghi bằng chứng này.

## Áp dụng production

- Forward lane đã áp dụng tại commit đã review `f6500bca31f812ebf2c64358ae0f306e20eb94ad`, sau backup đầy đủ 565 bảng. Biên nhận: `docs/generated/schema-change-evidence/20260928161948_hide_resolved_deposit_management.json`.
- So sánh snapshot trước/sau: hash toàn phiếu, hạng mục, posting, dòng posting và hợp đồng không đổi. Số dư tài khoản vẫn 68.285.975đ, cọc hợp đồng vẫn 5.000.000đ; summary 102LVT giảm từ 5.000.000đ/1 phiếu xuống 0đ/0 phiếu.
- Readback production bằng JWT owner đạt: metadata đúng một dòng; query gốc vẫn đọc được phiếu, anti-join loại đúng UUID. Chưa kiểm cross-org bằng tài khoản DEMO production; đã kiểm JWT hai org trên TEST và hành vi RLS PGlite.
- Reconcile v1/v2 sau apply và catalog check đều đạt; RLS, security_invoker, search_path không có object hở. Generated types được sinh lại từ schema thật.
- Draft PR #89 đã mở trước tích hợp; phát hành app và xác minh trình duyệt production còn chờ.
