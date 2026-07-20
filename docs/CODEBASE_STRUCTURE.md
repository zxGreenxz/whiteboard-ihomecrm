# Cấu trúc codebase

> **Reviewed:** 2026-07-20  
> Tài liệu định hướng, không phải danh sách file đóng băng.

## Entry points

| Khu vực | Vị trí | Vai trò |
|---|---|---|
| Web app | `src/main.tsx`, `src/App.tsx` | Bootstrap React, route, auth/permission gates. |
| UI theo domain | `src/pages/**`, `src/components/**` | Trang và component nghiệp vụ. |
| Data layer | `src/hooks/**`, `src/lib/**` | Query/mutation, adapter canonical writer, permission catalog và tiện ích. |
| Supabase client/types | `src/integrations/supabase/**` | Client và generated public schema types. |
| AI Copilot | `src/copilot/**` | Chat, UI-control, registry tool, safety/entitlement. |
| Database | `supabase/migrations/**` | Lịch sử DDL/RPC/RLS đang hoạt động; 371 file SQL tại mốc review 20/07. |
| Edge Functions | `supabase/functions/**` | LLM proxy, admin user, push, salary jobs và reset demo. |
| Workers/API | `worker/**`, `api/**` | Zalo worker ngoài Vercel và endpoint cron/serverless. |
| Tài liệu | `docs/**`, `docs-site/**` | Hai trunk runtime: hướng dẫn VitePress và tham chiếu hệ thống cho Copilot. |

## Luồng phụ thuộc chính

```text
route/page
  -> hook hoặc domain adapter
  -> Supabase query/RPC
  -> RLS + authorize_v2 + approval/canonical writer
  -> Postgres tables/audit
```

Client chỉ phản chiếu quyền để cải thiện UX. Quyết định cuối thuộc RPC/RLS/backend. Luồng tiền mới dùng writer atomic + idempotency; fallback legacy chỉ tồn tại ở những nơi chưa đủ parity hoặc chưa qua T7 drain.

## Tìm nơi cần sửa

- Route/gate: `src/App.tsx`.
- Menu/navigation: `src/components/layout/**` và launcher catalog.
- Quyền theo trang: `src/lib/permissionPages.ts`; permission map nền ở `src/lib/permissions.ts`.
- Thu chi/approval: `src/hooks/income-expenses/**`, `src/hooks/useApprovals.ts`, `src/pages/approvals/**`.
- AI: `src/copilot/**`, `supabase/functions/llm-proxy/**`.
- Schema hiện tại: `src/integrations/supabase/types.ts`; nguyên nhân thay đổi: migration gần nhất liên quan.

## Kiểm thử

Test nằm cạnh module trong `__tests__` hoặc file `*.test.ts(x)`; gate chung được khai báo trong `package.json` và CI. Khi thay đổi database, kiểm cả SQL/RPC permission, generated types và caller frontend.

## Tài liệu liên quan

- [README tài liệu](README.md)
- [Database schema](DATABASE_SCHEMA.md)
- [Tổng quan hệ thống](he-thong/00-tong-quan.md)
- [Authorization](authorization/README.md)
