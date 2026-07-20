# Trung tâm tài liệu ptcrm

> **Last reviewed:** 2026-07-20  
> Đây là cổng vào duy nhất cho tài liệu trong repository.

## Tài liệu canonical

| Nhóm | Nguồn | Dùng khi |
|---|---|---|
| Hướng dẫn người dùng đã xuất bản | [huong-dan-su-dung/](huong-dan-su-dung/) | Thao tác trên giao diện; nội dung được VitePress xuất bản. |
| Tham chiếu hệ thống | [he-thong/README.md](he-thong/README.md) | Luồng nghiệp vụ, bảng/RPC chính, route và ranh giới module. Các file `docs/he-thong/*.md` cũng được AI Copilot nạp ở runtime. |
| Cấu trúc code | [CODEBASE_STRUCTURE.md](CODEBASE_STRUCTURE.md) | Tìm entry point, module, backend và vị trí kiểm thử. |
| Schema database | [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | Cách đọc schema hiện tại và nguồn sự thật cho type/migration. |
| Runbook | [bang-luong/README.md](bang-luong/README.md), [zalo/README.md](zalo/README.md), [supabase/README.md](../supabase/README.md) | Vận hành, kiểm tra và xử lý sự cố. |
| Kế hoạch đang hoạt động | [plans/README.md](plans/README.md), [ai-copilot/README.md](ai-copilot/README.md), [authorization/README.md](authorization/README.md) | Việc chưa đóng hoặc tài liệu thiết kế cần đối chiếu với trạng thái hiện tại. |
| Bằng chứng audit | [authorization/](authorization/), [refactor-2026-07/](refactor-2026-07/) và các file audit/đối chiếu có ngày | Lưu bằng chứng theo mốc; không dùng thay cho tài liệu canonical. |
| Prompt nghiên cứu | [prompts/README.md](prompts/README.md) | Đầu vào tái sử dụng cho các vòng phân tích; không phải đặc tả sản phẩm. |

## Quy tắc vòng đời

- Mỗi tài liệu phải được hiểu theo một trong các trạng thái: `canonical`, `active-plan`, `runbook`, `audit-evidence` hoặc `historical`.
- Không nhân bản cùng một nội dung ở nhiều nơi. Tài liệu phụ chỉ tóm tắt và liên kết tới nguồn canonical.
- Code chạy, generated types và migration mới hơn luôn thắng prose cũ. Snapshot live phải ghi rõ ngày, project và phạm vi.
- Tài liệu đã bị thay thế phải được xóa hoặc có banner chỉ rõ nguồn thay thế; không để nhiều file cùng tự nhận là “nguồn sự thật”.
- Hai trunk `docs/huong-dan-su-dung/**` và `docs/he-thong/**` giữ đường dẫn ổn định vì VitePress và AI Copilot sử dụng trực tiếp.

## Nguồn sự thật kỹ thuật

- Database public types: [src/integrations/supabase/types.ts](../src/integrations/supabase/types.ts).
- Lịch sử thay đổi database: [supabase/migrations/](../supabase/migrations/) theo thứ tự tên file; archive chỉ để tra cứu.
- Route và gate giao diện: [src/App.tsx](../src/App.tsx), catalog quyền ở [src/lib/permissionPages.ts](../src/lib/permissionPages.ts).
- Tài liệu xuất bản: `docs/huong-dan-su-dung`; cấu hình site ở [docs-site/](../docs-site/).

## Kiểm tra tài liệu

```powershell
npm run docs:check:links
npm --prefix docs-site run images:check
npm --prefix docs-site run build
git diff --check
```

Lần cài mới dùng `npm --prefix docs-site ci` trước khi build. Không sửa `package-lock.json` bằng tay.
