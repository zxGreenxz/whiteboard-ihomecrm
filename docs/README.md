# Tài liệu iHomeCRM

Chọn nguồn theo câu hỏi. Index này không yêu cầu đọc hết các tài liệu được dẫn.
Agent mặc định đọc adapter + [Project Contract](engineering/PROJECT_CONTRACT.md); thêm một tài liệu đúng phạm vi khi cần, rồi tra source.

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
- Zalo/Copilot vẫn deferred; không tự mở lại context hoặc kiểm chuyên biệt.

## Duy trì

- Một chủ sở hữu cho mỗi luật. Kết luận mới cập nhật nguồn hiện hành, audit cũ giữ nguyên bằng chứng.
- Phân biệt tài liệu vận hành, kế hoạch được giao và snapshot; ngày gần đây không tự chứng minh còn hiệu lực.
- `docs/he-thong/` và `docs/huong-dan-su-dung/` là đầu vào runtime/site: không di chuyển/xoá để dọn context agent.
- Generated Markdown sửa ở generator/manifest; untracked và file đang dở không tự nhập vào đợt dọn tài liệu.
- Khi chuyển file, giữ provenance và inbound links; không nhân bản toàn bộ nội dung làm status thứ hai.
