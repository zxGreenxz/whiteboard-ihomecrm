# Database schema

> **Reviewed:** 2026-07-20 tại commit `1d2c9d9`
> **Source of truth:** generated types + ordered migrations, không phải số đếm trong prose.

## Inventory hiện tại

Theo `src/integrations/supabase/types.ts`:

| Object public | Số lượng |
|---|---:|
| Tables | 164 |
| Views | 6 |
| Functions/RPC | 322 |
| Enums | 30 |

Repository có **371** migration SQL hoạt động trong `supabase/migrations/` tại mốc review và một migration superseded trong `supabase/migrations-archive/`. Đây là inventory của repository, không tự chứng minh mọi migration đã deploy lên một project cụ thể.

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
