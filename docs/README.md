# Tài liệu iHomeCRM

Chọn nguồn theo câu hỏi. Index này không yêu cầu đọc hết các tài liệu được dẫn.
Agent bắt đầu từ adapter và [Project Contract](engineering/PROJECT_CONTRACT.md). Tra thêm các nguồn dưới đây theo phạm vi của tác vụ.

## Nguồn hiện hành

| Cần biết | Nguồn |
|---|---|
| Luật, scope kiểm, review, phát hành | [Project Contract](engineering/PROJECT_CONTRACT.md) |
| Hành vi nghiệp vụ của một domain | [Mục lục hệ thống](he-thong/README.md) |
| Route, hook, RPC, runner và quy ước kỹ thuật | [Bản đồ code](CODEBASE_STRUCTURE.md) |
| Schema/migration và backup | [Migration runbook](engineering/MIGRATION_STRATEGY.md) |
| Dữ liệu, JWT/RLS, DEMO/TEST | [Data environments](engineering/DATA_ENVIRONMENTS.md) |
| Authorization đang áp dụng | [Authorization](authorization/README.md) |
| Lương V5 | [Lương thưởng](bang-luong/README.md) |
| Thao tác đối chiếu được giao | [Đối chiếu](doi-chieu/README.md) |
| Tài liệu xuất bản cho người dùng | [Hướng dẫn](huong-dan-su-dung/index.md), [docs-site](../docs-site/README.md) |

Cấu hình, số đo và generated views ở `tooling/`, `contracts/surfaces/`, `docs/generated/`; không tạo bản luật thứ hai trong Markdown.

## Hồ sơ theo yêu cầu

- [Plan/spec](plans/README.md): chỉ đọc plan được giao; checkbox cũ không phải backlog hiện tại.
- [Audit](audits/README.md): evidence theo commit/ngày, không mặc định đọc audit mới nhất.
- [Prompt nghiên cứu](prompts/README.md): mẫu tùy chọn khi task yêu cầu, không áp cho mọi việc.
- [Kho lưu](archive/2026-10/README.md): bản đã thay thế/lịch sử, giữ để tra cứu; đường cũ có redirect.
- Trợ lý CRM hiện hành là Hermes. Giao diện chat và client gọi model của Copilot đã gỡ. Một số đường dẫn và ID kiểm tra nội bộ vẫn giữ tên `copilot`.
- Test đơn vị Zalo chạy trong bộ thường. Tra [manifest phần tạm hoãn](../tooling/deferred-modules.json) khi cần xác định phạm vi E2E Zalo và các kiểm tra cũ.

## Duy trì

- Một chủ sở hữu cho mỗi luật. Kết luận mới cập nhật nguồn hiện hành, audit cũ giữ nguyên bằng chứng.
- Phân biệt tài liệu vận hành, kế hoạch được giao và snapshot; ngày gần đây không tự chứng minh còn hiệu lực.
- `docs/he-thong/` và `docs/huong-dan-su-dung/` là đầu vào runtime/site: không di chuyển/xoá để dọn context agent.
- Generated Markdown sửa ở generator/manifest; untracked và file đang dở không tự nhập vào đợt dọn tài liệu.
- Khi chuyển file, giữ provenance và inbound links; không nhân bản toàn bộ nội dung làm status thứ hai.
