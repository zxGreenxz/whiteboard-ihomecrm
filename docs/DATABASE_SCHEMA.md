# Database schema

> **Reviewed:** 2026-07-20  
> **Source of truth:** generated types + ordered migrations, không phải dump prose tháng 5.

## Inventory hiện tại

Theo `src/integrations/supabase/types.ts`:

| Object public | Số lượng |
|---|---:|
| Tables | 159 |
| Views | 6 |
| Functions/RPC | 256 |
| Enums | 30 |

Repository hiện có **362** migration SQL hoạt động trong `supabase/migrations/` và một migration superseded trong `supabase/migrations-archive/`. Số này là inventory repository ngày review, không tự chứng minh mọi migration đã deploy lên một project cụ thể.

## Cách xác định schema đúng

1. Đọc type của table/view/function trong [src/integrations/supabase/types.ts](../src/integrations/supabase/types.ts).
2. Tìm migration mới nhất chạm object bằng `rg "<object_name>" supabase/migrations`.
3. Với incident/cutover, đối chiếu catalog live read-only; ghi rõ project ref, UTC, query và commit.
4. Sau thay đổi schema đã deploy, chạy `npm run gen:types` rồi review diff generated types.

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
