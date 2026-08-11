# Database schema

> **Reviewed:** 2026-08-06
> **Source of truth:** catalog production đã chụp + generated types, **không phải số đếm trong prose**.

## Inventory hiện tại

**Số đếm không còn viết tay.** Chạy `npm run catalog:capture` (chỉ đọc `pg_catalog`) và đọc
[`docs/generated/database-inventory.json`](generated/database-inventory.json).

Ảnh chụp 2026-08-06, PostgreSQL 17.6, project `tryymsxyyckgbrmmvozx`:

| Object public | Số lượng |
|---|---:|
| Bảng **logic** | 316 |
| Phân mảnh runtime (child partition) | 82 |
| Views | 12 |
| Hàm trong `public` + `app_private` | 1527 (1057 SECURITY DEFINER) |
| Enums | 30 |
| Bảng bật realtime | 30 |

Ba cạm bẫy khi đọc bảng trên — bản cũ của tài liệu này dính cả ba:

1. **Bảng logic ≠ tổng số bảng.** Tổng `pg_class` là 398, nhưng 82 trong đó là child partition do
   Network Center sinh **mỗi ngày**. Con số thiết kế là 316. Bất kỳ số nào bao gồm partition sẽ tự
   tăng theo lịch mà không ai đổi schema.
2. **`pg_proc` ≠ số RPC.** 1527 là mọi hàm kể cả overload và hàm nội bộ; số RPC mà frontend gọi
   được nhỏ hơn nhiều. Đừng so trực tiếp con số này với số function trong generated types.
3. **Số file migration ≠ số migration đã deploy.** Repository hiện có 633 file trong
   `supabase/migrations/` + 15 file trong `migrations-archive/`; ledger `schema_migrations` dừng
   trước schema đang chạy. Xem `docs/whiteboard-ihomecrm-architecture-agent-plan-2026-08-05 (1).md`
   Phần VI, và **đừng coi số file là bằng chứng đã deploy**.

Ảnh chụp cũng kiểm luôn ba invariant an toàn (tại 2026-08-06 đều xanh): mọi bảng logic bật RLS,
mọi view có `security_invoker=true`, mọi hàm SECURITY DEFINER có `search_path`.

## Cách xác định schema đúng

1. Đọc type của table/view/function trong [src/integrations/supabase/types.ts](../src/integrations/supabase/types.ts).
2. Tìm migration mới nhất chạm object bằng `rg "<object_name>" supabase/migrations`.
3. Với incident/cutover, đối chiếu catalog live read-only; ghi rõ project ref, UTC, query và commit.
4. Sau thay đổi schema đã deploy, chạy `npm run gen:types` rồi review diff generated types.

Không dùng các con số inventory như API ổn định. Khi cần số mới, đếm lại trực tiếp từ generated types và `supabase/migrations/`, rồi cập nhật ngày/commit ở đầu tài liệu.

## Các cụm schema chính

- **Tổ chức và quyền:** `organizations`, `organization_memberships`, `organization_roles`, `role_bindings`, `role_binding_scopes`, `authorization_scopes`, member overrides và `authorization_audit_events`.
- **Approval tài chính:** `approval_rule_sets`, `approval_rules`, `approval_rule_steps`, approver/candidate tables, `approval_requests`, request steps và decisions.
- **Bất động sản:** areas/buildings/floors/rooms/services/meters, customers/leads/deposits/contracts.
- **Tài chính:** invoices/items/payments, `income_expenses` + items/types/templates, accounts/cashbooks, handover/reconciliation và profit/salary tables.
- **AI Copilot:** provider/settings/entitlements/usage/conversation/message tables và `ai_write_audit`.
- **Zalo:** accounts/conversations/messages/send queue/labels/templates/automations.

## RLS và writer

RLS bật trên dữ liệu nghiệp vụ; organization/scope là biên tenant. Helper `authorize_v2` và các RPC writer canonical phải fail closed. Không cho client tự tạo trạng thái tiền cuối cùng bằng REST insert/update nếu domain đã có writer.

15/15 canonical route flags đã ON ngày 19/07. Approval engine và inbox là luồng thật; maker không tự duyệt request engine. T7 drain quyền DML legacy vẫn là việc có điều kiện, vì vậy khi audit phải xem cả writer route lẫn fallback caller.

## Archive

`supabase/migrations-archive/20260617000001_forfeit_full_settlement.sql` là bản superseded, **không replay**. Luôn đọc README archive và các migration thay thế mới hơn.
