# Cấu trúc codebase

> **Reviewed:** 2026-08-11  
> Tài liệu định hướng, không phải danh sách file đóng băng.
>
> Mọi con số ở đây đếm được bằng `git ls-files` và có `npm run gate:doc-counts` canh.
> Con số trong tài liệu mà không ai đếm lại sẽ sai trong im lặng — repo này đã có
> "371 migration" nằm trong ba tài liệu suốt nhiều tuần.

## Entry points

| Khu vực | Vị trí | Vai trò |
|---|---|---|
| Web app | `src/main.tsx`, `src/App.tsx` | Bootstrap React, route, auth/permission gates. |
| UI theo domain | `src/pages/**`, `src/components/**` | Trang và component nghiệp vụ. |
| Data layer | `src/hooks/**`, `src/lib/**` | Query/mutation, adapter canonical writer, permission catalog và tiện ích. |
| Supabase client/types | `src/integrations/supabase/**` | Client và generated public schema types. |
| AI Copilot | `src/copilot/**` | Chat, UI-control, registry tool, safety/entitlement. |
| Database | `supabase/migrations/**` | Lịch sử DDL/RPC/RLS đang hoạt động (677 file + 15 trong `migrations-archive/`). Legacy KHÔNG replay được; số đếm sinh bằng `npm run catalog:capture`. |
| Edge Functions | `supabase/functions/**` | LLM proxy, admin user, push, salary jobs và reset demo. |
| Workers/API | `worker/**` (6 file), `api/**` (1 file) | Zalo worker ngoài Vercel và endpoint cron/serverless. |
| Tài liệu | `docs/**`, `docs-site/**` | Hai trunk runtime: hướng dẫn VitePress (`docs-site/`, build riêng) và tham chiếu hệ thống cho Copilot (`docs/he-thong/`). |

### Ngoài `src/` — bốn cây mã có vòng đời riêng

Đây là phần hay bị bỏ sót nhất khi đọc repo: chúng **không** build cùng web app,
có `package.json`, lockfile và ràng buộc Node riêng, và test của chúng chạy ở job
CI khác. Tra runtime của từng cái ở `tooling/runtime-matrix.json`.

| Cây | Nội dung | Ghi chú |
|---|---|---|
| `services/**` | 5 package OpenClaw Zalo: `openclaw-egress-broker`, `openclaw-media-gateway`, `openclaw-zalo-bridge`, `openclaw-zalo-cell`, `openclaw-zalo-maintenance` | `openclaw-zalo-cell` chứa vendored upstream — **không** phải mã của dự án này, `verify:upstream` lo phần đó. |
| `infra/**` | 5 package: `network-center-worker`, `cloudflare-worker`, `openclaw-media-gateway`, `openclaw-zalo-watchdog`, `openclaw-zalo` | `network-center-worker` deploy bằng PowerShell; hai suite kiểm script đó chạy ở job Windows riêng. |
| `.e2e-fleet/**` | 48 spec Playwright | Chạy LOCAL, cần `FLEET_PASS_*`, chỉ ghi vào org DEMO. Không phải CI gate — xem `tooling/test-matrix.json`. |
| `contracts/**` | 13 file hợp đồng | Nguồn ưu tiên CAO NHẤT khi đối chiếu (trên cả graph tri thức). |

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

- Route/gate: `src/app/routes/**` (11 file theo domain, gom ở `index.tsx`).
  `src/App.tsx` **không còn khai route nào** — nó chỉ còn composition và Suspense.
  Nếu tài liệu hay test nào vẫn trỏ `App.tsx` để tìm route thì nó đã lỗi thời, và
  một assertion `not.toContain` trên file đó nay xanh vì không còn gì để tìm.
- Menu/navigation: `src/components/layout/**` và launcher catalog.
- Capability Registry: `src/app/capabilities/` (`registry.ts` khai, `types.ts` định
  nghĩa, `surfaceAdapters.ts` dẫn xuất). Chủ ý là khai MỘT LẦN rồi sinh/kiểm
  route–nav–launcher–permission từ đó. **Hiện mới phủ 2/146 route** — đọc nó như
  một cái mốc đang mở rộng, không phải nguồn sự thật đầy đủ.
- Quyền theo trang: `src/lib/permissionPages.ts`; permission map nền ở `src/lib/permissions.ts`.
- Thu chi/approval: `src/hooks/income-expenses/**`, `src/hooks/useApprovals.ts`, `src/pages/approvals/**`.
- AI: `src/copilot/**`, `supabase/functions/llm-proxy/**`.
- Schema hiện tại: `src/integrations/supabase/types.ts`; nguyên nhân thay đổi: migration gần nhất liên quan.

## Migration: baseline và làn forward

`supabase/migrations/**` là **lịch sử**, không phải đường apply. Legacy không replay
được từ database trắng — bốn nguyên nhân độc lập ghi ở đầu
`scripts/network-center-disposable-db.mjs`. Môi trường mới dựng từ baseline production
rồi chỉ apply phần SAU cutoff ("làn forward").

Bốn script trả lời bốn câu hỏi khác nhau; plan gọi gộp là `check-forward-migrations.mjs`
nhưng **không có file tên đó** và đừng tạo:

| Câu hỏi | Lệnh |
|---|---|
| File ↔ sổ bằng chứng ↔ ledger có lệch không, lệch chiều nào | `npm run migrations:list-forward` |
| Chạy lại một migration có an toàn không | `npm run gate:migration-idempotent` |
| Ledger có bị sửa ngoài làn forward không | `npm run gate:ledger-frozen` |
| Test ghim định nghĩa lỗi thời có phình ra không | `npm run gate:migration-test-liveness` |

Đổi schema production đi qua `npm run migrate:forward`. POST SQL thẳng qua Management
API là đi vòng cả cơ chế duyệt lẫn backup.

## Sổ sách máy đọc được (`tooling/`)

Mọi thứ được canh đều có một manifest và một gate đọc nó — bảng tra không ai kiểm sẽ
lệch trong im lặng và thành nguồn sai còn nguy hiểm hơn không có gì.

| Manifest | Trả lời | Gate |
|---|---|---|
| `runtime-matrix.json` | package/workflow nào chạy Node nào | `gate:runtime-matrix` |
| `test-matrix.json` | file test nào do suite nào chạy, ở job CI nào | `gate:test-matrix` |
| `known-gaps.yaml` | chỗ nào cố ý chưa gating, hết hạn khi nào | `gate:known-gaps` |
| `risk-map.json` | đổi file này thuộc tier nào, phải chạy gate nào | `npm run risk:classify` |
| `graph-policy.json`, `graph-manifests/` | graph tri thức còn dùng được không | `gate:graph-freshness` |
| `*-baseline.json` (9 file) | ratchet: nợ kỹ thuật chỉ được giảm | gate tương ứng |

## Kiểm thử

Test nằm cạnh module trong `__tests__` hoặc file `*.test.ts(x)`; gate chung được khai báo trong `package.json` và CI. Khi thay đổi database, kiểm cả SQL/RPC permission, generated types và caller frontend.

Test **không** chạy chung một lệnh: 9 suite, mỗi suite một runner và một job CI —
`tooling/test-matrix.json` là bản đồ, `npm run gate:test-matrix` canh nó khớp thực tế.
Muốn biết test nào đọc mã nguồn bằng `fs` thay vì import: `npm run inventory:repo`.

## Tài liệu liên quan

- [README tài liệu](README.md)
- [Database schema](DATABASE_SCHEMA.md)
- [Tổng quan hệ thống](he-thong/00-tong-quan.md)
- [Authorization](authorization/README.md)
